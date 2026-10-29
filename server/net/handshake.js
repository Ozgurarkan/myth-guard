// Admission logic as pure request -> result functions (design 4.3, test groups A, B, C). No sockets, no HTTP objects
// are written to: http.js turns results into responses and the hub turns authenticateUpgrade() into a WebSocket.
//
//   hello(ctx, body)               POST /__realm/hello   -> a one-time nonce for a known device
//   join(ctx, body)                POST /__realm/join    -> first-time admission with the invite
//   authenticateUpgrade(req)       the 'upgrade' event   -> who is this, or why not (before any socket exists)
//   identify(ctx)                  image requests        -> the GM, an admitted device, or nobody
//   isGm(ctx, options)             the GM rule: loopback address + loopback Host + Origin + the rf-gm cookie
//
// Every failure is counted in metrics as reject.<reason> and returns a status and a generic reason; nothing in a
// failure result depends on which of several secrets was wrong.
import { CLOSE, LIMITS, PATHS, PROTOCOL_VERSION, ROLES, SUBPROTOCOL, cleanName, isHex, parseAuthProtocol } from '../../src/net/protocol.js';
import { deriveDk, randomHex, safeEqual, srvProof, wsProof } from './crypto.js';
import { createBucket } from './ipLimiter.js';
import { cleanIp } from './lan.js';
import { deviceLabel } from './ua.js';

export const GM_COOKIE = 'rf-gm';
export const DEVICE_COOKIE = 'rf-d';

const MAX_NONCES_PER_IP = 16;
const DUMMY_DK = '0'.repeat(64);

/** Cookie header -> { name: value }. First occurrence wins; malformed pieces are ignored. */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length > 4096) return out;
  for (const piece of header.split(';')) {
    const at = piece.indexOf('=');
    if (at < 1) continue;
    const name = piece.slice(0, at).trim();
    if (!/^[\w-]{1,32}$/.test(name) || name in out) continue;
    out[name] = piece.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** The pieces of a Node request the guards look at. Header values are strings (Node joins repeated ones with ", "). */
export function describe(req) {
  const headers = req.headers ?? {};
  return {
    ip: cleanIp(req.socket?.remoteAddress),
    host: headers.host,
    origin: headers.origin,
    cookies: parseCookies(headers.cookie),
    userAgent: headers['user-agent'],
    url: req.url ?? '/',
    method: req.method,
  };
}

const setCookie = (name, value, attributes) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${attributes}`;

/**
 * @param {object} options
 * @param options.devices  createDevices(...)
 * @param options.invite   createInvite(...)
 * @param options.store    tableStore (mode lives in store.data.mode)
 * @param options.limiter  createIpLimiter(...)
 * @param options.hostGuard  createHostGuard(...)
 * @param options.clock    { now }
 * @param options.metrics  createMetrics(...)
 * @param {() => void} [options.onCodeFlood]  called once when too many wrong table codes arrive (the table should lock)
 */
export function createHandshake({ devices, invite, store, limiter, hostGuard, clock, metrics, onCodeFlood = () => {}, limits = LIMITS }) {
  const gmToken = randomHex(32);                       // regenerated at every server start; never written to disk
  const nonces = new Map();                            // nonce -> { device, ip, expires }
  const codeFlood = createBucket({ capacity: limits.wrongCodeGlobalPerMin, perSec: limits.wrongCodeGlobalPerMin / 60 }, clock);
  const mode = () => store.data.mode;

  const refuse = (status, reason, extra = {}) => {
    metrics.inc(`reject.${reason}`);
    return { ok: false, status, reason, ...extra };
  };
  const reply = (status, body, extra = {}) => ({ status, body, ...extra });
  const denied = (status, error, reason) => {
    metrics.inc(`reject.${reason ?? error}`);
    return { status, body: { error } };
  };

  // ---- nonces -------------------------------------------------------------------------------------------------
  const sweepNonces = () => {
    const now = clock.now();
    for (const [nonce, entry] of nonces) if (entry.expires <= now) nonces.delete(nonce);
  };
  const issueNonce = (device, ip) => {
    sweepNonces();
    let mine = 0;
    let oldest = null;
    for (const [nonce, entry] of nonces) {
      if (entry.ip !== ip) continue;
      mine += 1;
      oldest ??= nonce;
    }
    if (mine >= MAX_NONCES_PER_IP) nonces.delete(oldest);
    if (nonces.size >= limits.nonceMaxLive) return null;
    const nonce = randomHex(16);
    nonces.set(nonce, { device, ip, expires: clock.now() + limits.nonceTtlMs });
    return nonce;
  };
  /** Single use: the nonce is removed whether or not the caller then turns out to be right. */
  const consumeNonce = (nonce, device) => {
    const entry = nonces.get(nonce);
    nonces.delete(nonce);
    return Boolean(entry) && entry.expires > clock.now() && entry.device === device;
  };

  // ---- the GM -------------------------------------------------------------------------------------------------
  /**
   * The GM rule (design A.6): the peer is on this computer's loopback, the Host is localhost/127.0.0.1/[::1], the Origin
   * (when present, or always with `originRequired`) is that same host, and the rf-gm cookie is the one this server set.
   */
  const isGm = (ctx, { originRequired = false } = {}) => {
    if (!hostGuard.isLoopback(ctx.ip)) return { ok: false, detail: 'not-loopback' };
    if (!hostGuard.loopbackHostAllowed(ctx.host)) return { ok: false, detail: 'host' };
    if (!hostGuard.originAllowed(ctx.origin, ctx.host, { required: originRequired })) return { ok: false, detail: 'origin' };
    const cookie = ctx.cookies[GM_COOKIE];
    if (typeof cookie !== 'string' || !safeEqual(cookie, gmToken)) return { ok: false, detail: 'cookie' };
    return { ok: true };
  };

  // ---- common checks for the POST endpoints -------------------------------------------------------------------
  const front = (ctx, bucket) => {
    if (limiter.banned(ctx.ip)) return denied(403, 'banned');
    if (!hostGuard.hostAllowed(ctx.host)) return denied(421, 'host');
    if (!hostGuard.originAllowed(ctx.origin, ctx.host, { required: false })) return denied(403, 'origin');
    if (!limiter.hit(ctx.ip, bucket)) return denied(429, 'rate-limited', 'ratelimit');
    return null;
  };

  const handshake = {
    gmToken: () => gmToken,
    /** Set-Cookie value for the GM page (session cookie). */
    gmSetCookie: () => setCookie(GM_COOKIE, gmToken, ''),
    isGm,
    parseCookies,
    describe,
    liveNonces: () => { sweepNonces(); return nonces.size; },

    /** POST /__realm/hello { device } -> { nonce, ttl } */
    hello(ctx, body) {
      const early = front(ctx, 'hello');
      if (early) return early;
      const device = body && typeof body === 'object' ? body.device : null;
      if (!isHex(device, 16)) return denied(400, 'bad-request', 'malformed');
      const record = devices.find(device);
      if (!record) return denied(403, 'unknown-device', 'device');
      if (record.status === 'revoked') return denied(403, 'revoked', 'device');
      const nonce = issueNonce(device, ctx.ip);
      if (!nonce) return denied(429, 'rate-limited', 'ratelimit');
      return reply(200, { nonce, ttl: Math.round(limits.nonceTtlMs / 1000) });
    },

    /** POST /__realm/join -> { status, srv, srvProof } and the rf-d cookie */
    join(ctx, body) {
      const early = front(ctx, 'join');
      if (early) return early;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return denied(400, 'bad-request', 'malformed');
      if (body.v !== PROTOCOL_VERSION) return denied(400, 'version', 'malformed');
      const { device, nonce, how } = body;
      if (!isHex(device, 16) || !isHex(nonce, 16) || (how !== 'link' && how !== 'code' && how !== 'open')) return denied(400, 'bad-request', 'malformed');
      const proof = isHex(body.proof, 32) ? body.proof : '';

      const existing = devices.find(device);
      if (!existing && mode() === 'locked') return denied(403, 'locked');

      // Entering by just opening the address is allowed unless the GM asked for the QR code or typed code.
      if (how === 'open' && store.data.codeRequired === true) return denied(403, 'code-required', 'proof');

      const checked = invite.verify(how, device, nonce, proof);
      if (!checked.ok) {
        limiter.strike(ctx.ip);
        if (how === 'code' && !codeFlood.take()) {
          metrics.log('table: too many wrong table codes in a minute; locking the table');
          onCodeFlood();
        }
        return denied(403, 'bad-proof', 'proof');
      }
      const { key } = checked;

      let srv;
      let status;
      if (existing) {
        // An identical request again (a lost response, a double tap) gets the identical answer. Anything else aimed at a
        // device that already exists is refused: a device's key can never be replaced by whoever knows the invite.
        if (existing.status === 'revoked') return denied(403, 'bad-proof', 'device');
        if (existing.joinNonce !== nonce || !existing.srv) {
          limiter.strike(ctx.ip);
          return denied(403, 'bad-proof', 'device');
        }
        srv = existing.srv;
        status = existing.status;
      } else {
        srv = randomHex(16);
        const wanted = mode() === 'ask' ? 'pending' : 'admitted';
        const registered = devices.register({
          device, dk: deriveDk(key, device, nonce, srv), name: cleanName(body.name, limits.nameMax), label: deviceLabel(ctx.userAgent),
          ip: ctx.ip, how, nonce, srv, status: wanted,
        });
        if (!registered.ok) return registered.reason === 'cooldown' ? denied(429, 'rate-limited', 'ratelimit') : denied(403, 'full');
        status = registered.status;
      }
      return reply(200, { status, srv, srvProof: srvProof(key, device, nonce, srv) }, {
        setCookie: setCookie(DEVICE_COOKIE, devices.cookieValue(device), '; Max-Age=31536000'),
      });
    },

    /**
     * The 'upgrade' event, before any WebSocket exists. Returns
     *   { ok: true, role, kind: 'control'|'audio', device, playerId, name, ip, label, pending, protocol }
     *   { ok: false, status, reason, closeCode? }    -> answer `HTTP/1.1 <status>` with no body and destroy the socket
     * The caller claims the connection slot with socketOpened(ip) after ok.
     */
    authenticateUpgrade(req) {
      const ctx = describe(req);
      const { ip } = ctx;
      if (limiter.banned(ip)) return refuse(403, 'banned');
      if (!hostGuard.hostAllowed(ctx.host)) return refuse(421, 'host');
      if (!hostGuard.originAllowed(ctx.origin, ctx.host, { required: true })) return refuse(403, 'origin');
      let url;
      try { url = new URL(ctx.url, 'http://realm.invalid'); } catch { return refuse(400, 'malformed'); }
      const kind = url.pathname === PATHS.ws ? 'control' : url.pathname === PATHS.audioWs ? 'audio' : null;
      const role = url.searchParams.get('role');
      if (!kind || !ROLES.has(role)) return refuse(400, 'malformed');
      const offered = String(req.headers?.['sec-websocket-protocol'] ?? '').split(',').map(item => item.trim());
      if (!offered.includes(SUBPROTOCOL)) return refuse(400, 'malformed');
      if (!limiter.hit(ip, 'upgrade')) return refuse(429, 'ratelimit');
      if (!limiter.canOpen(ip)) return refuse(429, 'ip-cap');

      if (role === 'gm') {
        const gm = isGm(ctx, { originRequired: true });
        if (!gm.ok) {
          if (gm.detail === 'not-loopback') limiter.strike(ip);
          metrics.log(`upgrade: refused a GM connection (${gm.detail})`);
          return refuse(403, 'gm');
        }
        return { ok: true, role: 'gm', kind, device: 'gm', playerId: 'gm', name: 'GM', ip, label: 'GM', pending: false, protocol: SUBPROTOCOL };
      }

      const auth = parseAuthProtocol(req.headers?.['sec-websocket-protocol']);
      if (!auth) return refuse(401, 'proof');
      const nonceOk = consumeNonce(auth.nonce, auth.device);
      const record = devices.find(auth.device);
      // Always compute a proof, also for an unknown device, so the answer takes the same time.
      const expected = wsProof(record?.dk ?? DUMMY_DK, auth.device, auth.nonce, role);
      if (!nonceOk) return refuse(401, 'nonce', { closeCode: CLOSE.AUTH });
      if (record?.status === 'revoked') return refuse(403, 'device', { closeCode: CLOSE.KICKED });
      if (!record || !record.dk || !safeEqual(expected, auth.proof)) {
        limiter.strike(ip);
        return refuse(401, 'proof', { closeCode: CLOSE.AUTH });
      }
      if (kind === 'audio' && record.status !== 'admitted') return refuse(403, 'device');
      const label = deviceLabel(req.headers?.['user-agent']);
      devices.touch(auth.device, { ip, label });
      return {
        ok: true, role: 'player', kind, device: auth.device, playerId: devices.playerIdOf(auth.device), name: record.name,
        ip, label, pending: record.status === 'pending', protocol: SUBPROTOCOL,
      };
    },

    /**
     * Who is asking for an image? `{ kind: 'gm' }`, `{ kind: 'device', device }`, or null.
     * A pending, revoked or forged cookie is nobody.
     */
    identify(ctx) {
      if (isGm(ctx, { originRequired: false }).ok) return { kind: 'gm' };
      const device = devices.deviceFromCookie(ctx.cookies[DEVICE_COOKIE]);
      if (!device) return null;
      return devices.find(device)?.status === 'admitted' ? { kind: 'device', device } : null;
    },
  };
  return handshake;
}
