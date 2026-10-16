// A fake `access` object for hub tests, written from design 7.2 (and shaped like WP2's handshake.authenticateUpgrade), so
// the hub can be tested before - and independently of - the real access layer. Also used by WP6.
//
//   const access = createFakeAccess({ clock });
//   const alice = access.fake.addDevice({ name: 'Alice' });            // { device, dk, playerId, name, label, status }
//   const [url, protocols, options] = access.fake.clientArgs(port, alice);      // for `new WebSocket(...)` from `ws`
//   const gm = access.fake.clientArgs(port, 'gm');
//   const client = openClient(access, port, alice);                    // a minimal raw `ws` test client (below)
//
// What it checks, like the real thing: Host allowed, Origin present and equal to the Host, 'rf3' offered, players: a
// one-time nonce + HMAC proof (wsProof) for a known, not revoked device; the GM: loopback address + Host + Origin + the
// rf-gm cookie, and NO auth token. A stale nonce / bad proof / removed device answer { ok:false, closeCode } like WP2.
// `table` follows 7.2: list() (revoked devices are not listed), kick, admit, deny, rename, lock, unlock, rotate, setMode,
// mode(), locked(), invite(), on('change'|'joinRequest', fn) -> unsubscribe.
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { LIMITS, CLOSE, PATHS, SUBPROTOCOL, ROLES, authProtocol, parseAuthProtocol, cleanName } from '../src/net/protocol.js';
import { randomHex, wsProof, playerIdOf, safeEqualHex } from '../src/net/hmac.js';

export function createFakeMetrics() {
  const counters = new Map();
  const logs = [];
  return {
    inc(name, n = 1) { counters.set(name, (counters.get(name) ?? 0) + n); },
    observe() {},
    gauge() {},
    log(line) { logs.push(String(line)); },
    count: name => counters.get(name) ?? 0,
    counters,
    logs,
  };
}

const loopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export function createFakeAccess({ clock = { now: () => Date.now() }, metrics = createFakeMetrics(), maxPerIp = LIMITS.maxSocketsPerIp, maxTotal = LIMITS.maxSocketsTotal } = {}) {
  const serverSecret = randomHex(32);
  const gmToken = randomHex(32);
  const devices = new Map();   // device -> { device, dk, playerId, name, label, ip, status }
  const nonces = new Map();    // nonce -> device
  const strikes = new Map();   // ip -> [at, ...]
  const open = new Map();      // ip -> count
  const events = new EventEmitter();
  const state = { mode: 'open', locked: false, code: 'ABCD2345', rotations: 0 };
  let total = 0;

  const emit = () => events.emit('change');
  const strikeCount = ip => {
    const list = (strikes.get(ip) ?? []).filter(at => clock.now() - at < LIMITS.strikeBanMs);
    strikes.set(ip, list);
    return list.length;
  };

  const table = {
    mode: () => state.mode,
    setMode(mode) { state.mode = mode; state.locked = mode === 'locked'; emit(); },
    locked: () => state.locked,
    lock() { state.locked = true; state.mode = 'locked'; emit(); },
    unlock() { state.locked = false; state.mode = 'open'; emit(); },
    rotate() { state.rotations += 1; state.code = `ROTA${String(1000 + state.rotations)}`.slice(0, 8); emit(); },
    invite: () => ({ code: state.code, urlFor: address => `http://${address}:5173/player.html#join=fake` }),
    list: () => [...devices.values()].filter(d => d.status !== 'revoked').map(({ dk: _dk, ...rest }) => ({ ...rest })),
    kick(device) { const d = devices.get(device); if (d) { d.status = 'revoked'; d.dk = null; emit(); } },
    admit(device) { const d = devices.get(device); if (d?.status === 'pending') { d.status = 'admitted'; emit(); } },
    deny(device) { if (devices.get(device)?.status === 'pending') { devices.delete(device); emit(); } },
    rename(device, name) { const d = devices.get(device); if (d) { d.name = cleanName(name); emit(); } },
    on(event, fn) { events.on(event, fn); return () => events.off(event, fn); },
  };

  const access = {
    metrics,
    table,
    assets: { has: () => false, pin() {} },
    router: (request, response, next) => next(),

    authenticateUpgrade(req) {
      const refuse = (status, reason, extra = {}) => { metrics.inc(`reject.${reason}`); return { ok: false, status, reason, ...extra }; };
      const ip = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (strikeCount(ip) >= LIMITS.strikesToClose) return refuse(403, 'banned');
      const host = String(req.headers?.host ?? '');
      if (!/^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?$/.test(host)) return refuse(421, 'host');
      if (req.headers?.origin !== `http://${host}`) return refuse(403, 'origin');
      let url;
      try { url = new URL(req.url, 'http://x'); } catch { return refuse(400, 'malformed'); }
      const kind = url.pathname === PATHS.ws ? 'control' : url.pathname === PATHS.audioWs ? 'audio' : null;
      const role = url.searchParams.get('role');
      if (!kind || !ROLES.has(role)) return refuse(400, 'malformed');
      const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map(p => p.trim());
      if (!offered.includes(SUBPROTOCOL)) return refuse(400, 'malformed');
      if (role === 'gm') {
        const cookie = String(req.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith('rf-gm='));
        const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
        if (!loopback(req.socket?.remoteAddress) || !loopbackHost || cookie !== `rf-gm=${gmToken}`) return refuse(403, 'gm');
        return { ok: true, role: 'gm', kind, device: 'gm', playerId: 'gm', name: 'GM', ip, label: 'GM', pending: false, protocol: SUBPROTOCOL };
      }
      const auth = parseAuthProtocol(req.headers['sec-websocket-protocol']);
      if (!auth) return refuse(401, 'proof');
      const nonceDevice = nonces.get(auth.nonce);
      nonces.delete(auth.nonce); // single use
      const record = devices.get(auth.device);
      if (nonceDevice !== auth.device) return refuse(401, 'nonce', { closeCode: CLOSE.AUTH });
      if (record?.status === 'revoked') return refuse(403, 'device', { closeCode: CLOSE.KICKED });
      if (!record?.dk || !safeEqualHex(wsProof(record.dk, auth.device, auth.nonce, role), auth.proof)) {
        access.strike(ip);
        return refuse(401, 'proof', { closeCode: CLOSE.AUTH });
      }
      return { ok: true, role: 'player', kind, device: record.device, playerId: record.playerId, name: record.name, ip, label: record.label, pending: record.status === 'pending', protocol: SUBPROTOCOL };
    },

    socketOpened(ip) {
      if (total >= maxTotal || (open.get(ip) ?? 0) >= maxPerIp) { metrics.inc('reject.ip-cap'); return false; }
      open.set(ip, (open.get(ip) ?? 0) + 1);
      total += 1;
      return true;
    },
    socketClosed(ip) {
      if (!(open.get(ip) > 0)) return;
      open.set(ip, open.get(ip) - 1);
      total -= 1;
    },
    strike(ip, n = 1) { const list = strikes.get(ip) ?? []; for (let i = 0; i < n; i++) list.push(clock.now()); strikes.set(ip, list); },
    banned: ip => strikeCount(ip) >= LIMITS.strikesToClose,

    /** Test controls (not part of 7.2). */
    fake: {
      gmToken,
      openSockets: () => total,
      addDevice({ name = 'Player', label = 'Chrome · Android', status = 'admitted', ip = '127.0.0.1' } = {}) {
        const device = randomHex(16);
        const record = { device, dk: randomHex(32), playerId: playerIdOf(serverSecret, device), name, label, ip, status };
        devices.set(device, record);
        if (status === 'pending') events.emit('joinRequest', { device, name, label, ip });
        return record;
      },
      issueNonce(device) { const nonce = randomHex(16); nonces.set(nonce, device); return nonce; },
      /** [url, protocols, options] for `new WebSocket(...)` as `who` (a device record or 'gm'). */
      clientArgs(port, who, { role, query = '', host = `127.0.0.1:${port}`, origin = `http://${host}`, path = PATHS.ws } = {}) {
        const asGm = who === 'gm';
        const chosen = role ?? (asGm ? 'gm' : 'player');
        const url = `ws://127.0.0.1:${port}${path}?role=${chosen}${query}`;
        const options = { origin, headers: { Host: host, ...(asGm ? { Cookie: `rf-gm=${gmToken}` } : {}) } };
        if (asGm) return [url, [SUBPROTOCOL], options];
        const nonce = access.fake.issueNonce(who.device);
        const proof = wsProof(who.dk ?? '0'.repeat(64), who.device, nonce, chosen);
        return [url, [SUBPROTOCOL, authProtocol(who.device, nonce, proof)], options];
      },
    },
  };
  return access;
}

/**
 * A minimal raw `ws` test client. It records every text frame (parsed in `frames`, raw in `texts`), and for players sends
 * RESUME right after the socket opens (set `resume: false` to behave like a client that never does).
 */
export function openClient(access, port, who, { resume = true, rev = null, aids = [], args = {}, autoPong = true } = {}) {
  const [url, protocols, options] = access.fake.clientArgs(port, who, args);
  const ws = new WebSocket(url, protocols, options);
  const client = {
    ws, frames: [], texts: [], closed: null, refused: null, opened: false,
    of: type => client.frames.filter(frame => frame.type === type),
    last: type => client.of(type).at(-1),
    send: object => ws.send(typeof object === 'string' ? object : JSON.stringify(object)),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    /** Resolves when `predicate(client)` holds (checked on every frame / close), or rejects after `ms`. */
    until(predicate, label = 'a condition', ms = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => { try { if (predicate(client)) { cleanup(); resolve(client); } } catch (error) { cleanup(); reject(error); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${label}`)); }, ms);
        const cleanup = () => { clearTimeout(timer); client.listeners.delete(check); };
        client.listeners.add(check);
        check();
      });
    },
    listeners: new Set(),
    done: new Promise(resolve => ws.once('close', (code, reason) => { client.closed = { code, reason: String(reason) }; client.notify(); resolve(client.closed); })),
    notify() { for (const fn of [...client.listeners]) fn(); },
  };
  ws.on('unexpected-response', (request, response) => { client.refused = response.statusCode; response.resume(); client.notify(); });
  ws.on('error', () => client.notify());
  ws.on('open', () => {
    client.opened = true;
    if (resume && who !== 'gm') client.send({ type: 'RESUME', rev, aids });
    client.notify();
  });
  ws.on('message', (data, binary) => {
    if (binary) return;
    const text = data.toString();
    client.texts.push(text);
    try { client.frames.push(JSON.parse(text)); } catch { /* not ours */ }
    client.notify();
  });
  if (!autoPong) ws.pong = () => {};
  return client;
}

/**
 * Start a hub on an ephemeral loopback port with a fake access object; everything is torn down with the test.
 *   const net = await startTable(t, createHub, { hubOptions: { limits: { resumeWaitMs: 100 } }, accessOptions: { maxPerIp: 2 } });
 *   net.player(device, openClientOptions), net.gm(), net.device(addDeviceOptions), net.access, net.hub, net.port, net.metrics
 */
export async function startTable(t, createHub, { hubOptions = {}, accessOptions = {} } = {}) {
  const metrics = createFakeMetrics();
  const access = createFakeAccess({ metrics, ...accessOptions });
  const hub = createHub({ access, metrics, ...hubOptions });
  const server = createServer();
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const clients = [];
  const track = client => { clients.push(client); return client; };
  t.after(async () => {
    for (const client of clients) { try { client.terminate(); } catch { /* already closed */ } }
    await hub.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    access, hub, server, port, metrics,
    player: (device, options) => track(openClient(access, port, device, options)),
    gm: options => track(openClient(access, port, 'gm', options)),
    device: options => access.fake.addDevice(options),
  };
}
