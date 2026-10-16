// Helpers for the WP2 tests (access control, HTTP, assets). Not a test file: it lives here, not in test/, because
// `node --test` runs every .js file under a directory named "test".
//
//   const t = makeAccess({ site });                        access over a fake clock and a temp folder
//   const res = await call(t.access, { method:'POST', url:'/__realm/join', ... })      no sockets: a fake request
//   const phone = createPhone(t.access, { ip });  await phone.join();  await phone.connect();   a phone as design 4.3
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PROTOCOL_VERSION, authProtocol } from '../src/net/protocol.js';
import { deriveDk, hmac, inviteKey, joinProof, randomHex, srvProof, wsProof } from '../src/net/hmac.js';
import { createAccess } from '../server/net/access.js';
import { createFakeClock } from '../server/net/clock.js';
import { createHostGuard } from '../server/net/hostGuard.js';

export const sha = buffer => createHash('sha256').update(buffer).digest('hex');
export const HOST = '192.168.1.10:5173';        // the GM computer as the phones see it
export const GM_HOST = 'localhost:5173';
export const LAN = { Wi_Fi: [{ family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0', internal: false }] };

/** A PNG header (signature + IHDR) with the given size, padded with `extra` bytes: enough for sniffing and sizing. */
export function makePng(width = 64, height = 64, extra = 0, fill = 7) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra, fill)]);
}

/** A temp folder that cleanup() removes. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'realm-wp2-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** An access object over a fake clock, a temp data folder and a described network. */
export function makeAccess({ site = null, dataDir, clock = createFakeClock(), hostname = 'GM-PC', cspMode, ...rest } = {}) {
  const folder = dataDir === undefined ? tempDir() : null;
  const dir = dataDir === undefined ? folder.dir : dataDir;
  const access = createAccess({
    dataDir: dir, clock, site, cspMode, hostname, lanInterfaces: LAN, ...rest,
    hostGuard: createHostGuard({ hostname, getAddresses: () => [{ address: '192.168.1.10' }] }),
  });
  return { access, clock, dir, cleanup: () => { access.close(); folder?.cleanup(); } };
}

/** A fake Node request: a Readable with the properties the router reads. */
export function fakeReq({ ip = '192.168.1.50', host = HOST, origin, method = 'GET', url = '/', headers = {}, body, cookie, localPort = 5173 } = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { ...(host === null ? {} : { host }), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...lower(headers) };
  if (body !== undefined && !req.headers['content-length']) req.headers['content-length'] = String(chunks[0].length);
  req.socket = { remoteAddress: ip, localPort };
  return req;
}
const lower = headers => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

/** A fake response collecting status, headers and body; `done` resolves when end() is called. */
export function fakeRes() {
  const headers = {};
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const chunks = [];
  const res = {
    statusCode: 200, headersSent: false, writableEnded: false, destroyed: false,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader: name => headers[name.toLowerCase()],
    removeHeader(name) { delete headers[name.toLowerCase()]; },
    writeHead(status, extra = {}) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(extra)) headers[k.toLowerCase()] = v;
      res.headersSent = true;
      return res;
    },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      resolve();
    },
    once() { return res; },
    on() { return res; },
    done,
    get headers() { return headers; },
    get buffer() { return Buffer.concat(chunks); },
  };
  return res;
}

/** Runs a fake request through the router. Resolves with { status, headers, body, buffer, json(), nextCalled }. */
export async function call(access, options) {
  const req = fakeReq(options);
  const res = fakeRes();
  let nextCalled = false;
  const finished = new Promise(resolve => {
    access.router(req, res, () => { nextCalled = true; res.statusCode = 404; res.end(); });
    res.done.then(resolve);
  });
  await finished;
  const buffer = res.buffer;
  return {
    status: res.statusCode, headers: res.headers, buffer, body: buffer.toString('utf8'), nextCalled,
    json: () => JSON.parse(buffer.toString('utf8')),
  };
}

export const jsonPost = (url, body, extra = {}) => ({
  method: 'POST', url, body, headers: { 'content-type': 'application/json' }, ...extra,
});

/** The rf-gm cookie, fetched like the GM browser does: GET / from loopback. */
export async function gmLogin(access) {
  const res = await call(access, { ip: '127.0.0.1', host: GM_HOST, url: '/' });
  const cookie = String(res.headers['set-cookie'] ?? '').split(';')[0];
  return { cookie, res };
}

export const gmHeaders = cookie => ({ ip: '127.0.0.1', host: GM_HOST, origin: `http://${GM_HOST}`, cookie, headers: { 'x-rf': '1' } });

/** A phone, following design 4.3 step by step. */
export function createPhone(access, { ip = '192.168.1.50', host = HOST, name = 'Aria', device = randomHex(16), agent = 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36' } = {}) {
  const origin = `http://${host}`;
  const phone = {
    device, ip, host, name, dk: null, cookie: null, status: null, srvProofOk: null, lastNonce: null,

    /** POST /__realm/join. `how` 'link' | 'code'; `value` defaults to the live secret / code. Returns the raw response. */
    async join({ how = 'link', value, nonce = randomHex(16), proof, device: id = device, version = PROTOCOL_VERSION } = {}) {
      const invite = access.table.invite();
      const secret = invite.urlFor('x', 1).split('#join=')[1];
      const key = inviteKey(how, value ?? (how === 'link' ? secret : invite.code));
      const body = { v: version, device: id, name, nonce, how };
      if (proof !== null) body.proof = proof ?? (key ? joinProof(key, id, nonce) : 'f'.repeat(64));
      const res = await call(access, jsonPost('/__realm/join', body, { ip, host, origin, headers: { 'content-type': 'application/json', 'user-agent': agent } }));
      phone.lastJoin = { nonce, key, body, res };
      if (res.status === 200) {
        const answer = res.json();
        phone.status = answer.status;
        // The client's side of design 4.3: a rogue server cannot produce this proof.
        phone.srvProofOk = key ? answer.srvProof === srvProof(key, id, nonce, answer.srv) : false;
        if (phone.srvProofOk) phone.dk = deriveDk(key, id, nonce, answer.srv);
        phone.cookie = String(res.headers['set-cookie'] ?? '').split(';')[0] || null;
      }
      return res;
    },

    async hello({ device: id = device } = {}) {
      const res = await call(access, jsonPost('/__realm/hello', { device: id }, { ip, host, origin }));
      phone.lastNonce = res.status === 200 ? res.json().nonce : null;
      return res;
    },

    /** The upgrade request a browser would make. Anything can be overridden to build an attack. */
    upgrade({ role = 'player', nonce = phone.lastNonce, dk = phone.dk, proof, id = device, protocols, hostHeader = host, originHeader = origin, path = '/__realm/ws', cookie, remote = ip } = {}) {
      const token = proof ?? (dk && nonce ? wsProof(dk, id, nonce, role) : 'a'.repeat(64));
      const offered = protocols ?? `rf3, ${authProtocol(id, nonce ?? 'b'.repeat(32), token)}`;
      return fakeReq({ ip: remote, host: hostHeader, origin: originHeader, url: `${path}?role=${role}`, cookie, headers: { 'sec-websocket-protocol': offered, 'user-agent': agent, upgrade: 'websocket' } });
    },

    /** hello + upgrade + authenticateUpgrade in one go. */
    async connect(options = {}) {
      await phone.hello();
      return access.authenticateUpgrade(phone.upgrade(options));
    },
  };
  return phone;
}

/** A GM upgrade request (no auth token, as decided in Appendix A.6). */
export function gmUpgrade({ cookie, ip = '127.0.0.1', host = GM_HOST, origin = `http://${GM_HOST}`, protocols = 'rf3', path = '/__realm/ws' } = {}) {
  return fakeReq({ ip, host, origin: origin === undefined ? undefined : origin, url: `${path}?role=gm`, cookie, headers: { 'sec-websocket-protocol': protocols } });
}

export { hmac, randomHex };
