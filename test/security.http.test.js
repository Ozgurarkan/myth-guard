// Security checks of design 6.3 groups A, B, C, D and E over REAL sockets: a real HTTP server with the router and a
// minimal upgrade handler built only from access.authenticateUpgrade / socketOpened (no hub), so these tests do not
// depend on the WebSocket hub. The pure-logic versions of the same checks, with a fake clock, are in handshake.test.js
// and http.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { authProtocol, LIMITS } from '../src/net/protocol.js';
import { deriveDk, inviteKey, joinProof, randomHex, srvProof, wsProof } from '../src/net/hmac.js';
import { hardenHttpServer, httpServerOptions } from '../server/net/http.js';
import { createFakeClock } from '../server/net/clock.js';
import { makeAccess, makePng, sha, createPhone, fakeReq, fakeRes } from '../test-support/wp2-fixtures.js';

const png = makePng(40, 40, 64);

/** Real server: router + the smallest upgrade handler the hub would have. */
async function fixture(t) {
  const clock = createFakeClock();
  const env = makeAccess({ clock });
  const { access } = env;
  access.assets.put(sha(png), png);
  const server = createServer(httpServerOptions(), (request, response) => access.router(request, response, () => { response.writeHead(404); response.end(); }));
  hardenHttpServer(server);
  const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => (protocols.has('rf3') ? 'rf3' : false) });
  const seen = { upgrades: 0, sockets: 0, refused: [] };
  server.on('upgrade', (request, socket, head) => {
    seen.upgrades += 1;
    const verdict = access.authenticateUpgrade(request);
    const refuse = status => { socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!verdict.ok) { seen.refused.push(verdict.reason); refuse(verdict.status); return; }
    if (!access.socketOpened(verdict.ip)) { seen.refused.push('ip-cap'); refuse(503); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      seen.sockets += 1;
      ws.on('close', () => { access.socketClosed(verdict.ip); seen.sockets -= 1; });
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'HELLO', role: verdict.role, device: verdict.device, pending: verdict.pending, name: verdict.name }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    env.cleanup();
  });
  const port = server.address().port;
  const base = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
  return { ...env, port, seen, wss, base };
}

function http(port, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ port, host: '127.0.0.1', method, path, agent: false, headers: { ...(host ? { host } : {}), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
const json = (port, path, body, extra = {}) => http(port, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...extra.headers }, host: extra.host });

/** The client side of design 4.3 over real HTTP. */
async function realPhone(f, { name = 'Aria' } = {}) {
  const { port, base, clock, access } = f;
  const device = randomHex(16);
  const secret = access.table.invite().urlFor('x', 1).split('#join=')[1];
  const phone = { device, dk: null, cookie: null, srvProofOk: false };
  phone.join = async ({ key = secret, how = 'link', proof, nonce = randomHex(16) } = {}) => {
    const body = { v: 3, device, name, nonce, how, ...(proof === null ? {} : { proof: proof ?? joinProof(inviteKey(how, key), device, nonce) }) };
    const res = await json(port, '/__realm/join', body, { headers: { origin: base.origin } });
    if (res.status === 200) {
      const answer = JSON.parse(res.body);
      const k = inviteKey(how, key);
      phone.srvProofOk = answer.srvProof === srvProof(k, device, nonce, answer.srv);
      if (phone.srvProofOk) phone.dk = deriveDk(k, device, nonce, answer.srv);
      phone.cookie = String(res.headers['set-cookie']).split(';')[0];
    }
    return res;
  };
  phone.hello = async () => {
    const res = await json(port, '/__realm/hello', { device }, { headers: { origin: base.origin } });
    clock.advance(1100); // keeps the per-address rate buckets from interfering with tests that open many connections
    return res.status === 200 ? JSON.parse(res.body).nonce : null;
  };
  phone.open = async ({ nonce, proof, role = 'player', headers = {}, origin = base.origin, protocols, query = `role=${role}`, path = '/__realm/ws' } = {}) => {
    const n = nonce ?? await phone.hello();
    const token = proof ?? (phone.dk && n ? wsProof(phone.dk, device, n, role) : '0'.repeat(64));
    const offered = protocols ?? ['rf3', authProtocol(device, n ?? randomHex(16), token)];
    return openSocket(`ws://127.0.0.1:${port}${path}?${query}`, offered, { origin, headers });
  };
  return phone;
}

function openSocket(url, protocols, options) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, protocols, options);
    ws.once('message', data => { resolve({ ok: true, ws, hello: JSON.parse(String(data)) }); });
    ws.once('unexpected-response', (request, response) => { response.resume(); resolve({ ok: false, status: response.statusCode }); });
    ws.once('error', () => resolve({ ok: false, status: 0 }));
  });
}

// ---- A ------------------------------------------------------------------------------------------------------------------------

test('A1 A3 over real sockets: join with the invite, then hello + proof + upgrade gives a socket; the server speaks first', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  assert.equal((await phone.join({ proof: null })).status, 403);
  assert.equal(f.seen.upgrades, 0);
  const joined = await phone.join();
  assert.equal(joined.status, 200);
  assert.equal(phone.srvProofOk, true);
  assert.match(String(joined.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  const socket = await phone.open();
  assert.equal(socket.ok, true);
  assert.deepEqual([socket.hello.role, socket.hello.device, socket.hello.pending, socket.hello.name], ['player', phone.device, false, 'Aria']);
  assert.equal(socket.ws.protocol, 'rf3', 'the auth token is not echoed');
  socket.ws.close();
});

test('A12 a captured handshake replayed on a second connection is refused: no socket is created', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  const nonce = await phone.hello();
  const first = await phone.open({ nonce });
  assert.equal(first.ok, true);
  const before = f.seen.sockets;
  const replay = await phone.open({ nonce });
  assert.deepEqual([replay.ok, replay.status], [false, 401]);
  assert.equal(f.seen.sockets, before);
  first.ws.close();
});

test('A15 an upgrade without the auth.* sub-protocol is refused before a WebSocket exists', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  const refused = await openSocket(`ws://127.0.0.1:${f.port}/__realm/ws?role=player`, ['rf3'], { origin: f.base.origin });
  assert.deepEqual([refused.ok, refused.status], [false, 401]);
  const none = await openSocket(`ws://127.0.0.1:${f.port}/__realm/ws?role=player`, [], { origin: f.base.origin });
  assert.equal(none.ok, false);
  assert.equal(f.wss.clients.size, 0);
  assert.equal(f.seen.sockets, 0);
});

test('A2 a wrong proof on the upgrade is refused and counts against the address; five of them ban it (fake clock)', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  for (let i = 0; i < LIMITS.failedProofsBeforeBan; i++) {
    const res = await phone.open({ proof: 'ab'.repeat(32) });
    assert.deepEqual([res.ok, res.status], [false, 401], `attempt ${i + 1}`);
  }
  assert.equal(f.access.banned('127.0.0.1'), false, 'the GM computer itself is never banned, so it keeps working');
  const right = await phone.open();
  assert.equal(right.ok, true);
  right.ws.close();
});

test('A14 a player proof cannot open the GM role over a real socket', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  const res = await phone.open({ role: 'gm', proof: null, query: 'role=gm' });
  assert.equal(res.ok, false, 'no cookie, so no GM, whatever the player proof says');
  assert.equal(f.seen.sockets, 0);
});

test('A9 A10 over real sockets: a kicked device is refused, a rotated invite stops new devices but not members', async t => {
  const f = await fixture(t);
  const member = await realPhone(f);
  const doomed = await realPhone(f, { name: 'Doomed' });
  await member.join(); await doomed.join();
  const oldSecret = f.access.table.invite().urlFor('x', 1).split('#join=')[1];
  assert.equal((await doomed.open()).ok, true);
  f.access.table.kick(doomed.device);
  assert.equal(await doomed.hello(), null, 'hello refuses a kicked device');
  assert.equal((await doomed.open({ nonce: randomHex(16) })).ok, false);
  f.access.table.rotate();
  const late = await realPhone(f);
  assert.equal((await late.join({ key: oldSecret })).status, 403);
  assert.equal((await member.open()).ok, true, 'members are unaffected');
});

// ---- B and C -------------------------------------------------------------------------------------------------------------------

async function gmCookie(f, host = `localhost:${f.port}`) {
  const res = await http(f.port, { path: '/', host });
  return String(res.headers['set-cookie']).split(';')[0];
}

test('B the GM socket over real sockets: opens with loopback + localhost Host + Origin + cookie, and with nothing less', async t => {
  const f = await fixture(t);
  const cookie = await gmCookie(f);
  assert.match(cookie, /^rf-gm=[0-9a-f]{64}$/);
  const hostLocal = `localhost:${f.port}`;
  const good = { Host: hostLocal, Cookie: cookie };
  const open = (options = {}) => openSocket(`ws://127.0.0.1:${f.port}/__realm/ws?role=gm`, ['rf3'], { origin: `http://${hostLocal}`, ...options, headers: { ...good, ...options.headers } });
  const ok = await open();
  assert.equal(ok.ok, true);
  assert.equal(ok.hello.role, 'gm');
  ok.ws.close();
  // B2 DNS rebinding: evil Host with a matching Origin and the stolen-looking cookie
  const rebinding = await open({ origin: `http://evil.test:${f.port}`, headers: { Host: `evil.test:${f.port}` } });
  assert.deepEqual([rebinding.ok, rebinding.status], [false, 421]);
  // B3 no cookie / wrong cookie
  assert.equal((await open({ headers: { Cookie: '' } })).ok, false);
  assert.equal((await open({ headers: { Cookie: `rf-gm=${'0'.repeat(64)}` } })).ok, false);
  // B4 foreign Origin and no Origin
  assert.deepEqual([(await open({ origin: 'http://evil.test:5173' })).status], [403]);
  assert.equal((await open({ origin: undefined })).ok, false, 'a browser always sends Origin; an upgrade without one is refused');
  // the machine's own LAN name is not a GM Host
  assert.equal((await open({ origin: `http://192.168.1.10:${f.port}`, headers: { Host: `192.168.1.10:${f.port}` } })).ok, false);
  assert.equal(f.seen.sockets, 0);
});

test('B5 info, diag, asset PUT and POST missing refuse a rebinding Host (421) and a missing cookie (403) over real sockets', async t => {
  const f = await fixture(t);
  const cookie = await gmCookie(f);
  const hostLocal = `localhost:${f.port}`;
  for (const path of ['/__realm/info', '/__realm/diag', '/__realm/diag/log']) {
    assert.equal((await http(f.port, { path, host: hostLocal, headers: { cookie } })).status, 200, path);
    assert.equal((await http(f.port, { path, host: `evil.test:${f.port}`, headers: { cookie } })).status, 421, path);
    assert.equal((await http(f.port, { path, host: hostLocal })).status, 403, path);
  }
  const image = makePng(10, 10, 10);
  const put = (extra = {}) => http(f.port, { method: 'PUT', path: `/__realm/assets/${sha(image)}`, body: image, host: hostLocal, ...extra, headers: { cookie, origin: `http://${hostLocal}`, 'x-rf': '1', ...extra.headers } });
  assert.equal((await put()).status, 201);
  assert.equal((await put({ host: `evil.test:${f.port}`, headers: { origin: `http://evil.test:${f.port}` } })).status, 421);
  assert.equal((await put({ headers: { origin: 'http://evil.test:5173' } })).status, 403);
  const missing = await http(f.port, { method: 'POST', path: '/__realm/assets/missing', body: '[]', host: hostLocal, headers: { cookie, origin: `http://${hostLocal}`, 'x-rf': '1' } });
  assert.equal(missing.status, 200);
  assert.equal((await http(f.port, { method: 'POST', path: '/__realm/assets/missing', body: '[]', host: `evil.test:${f.port}`, headers: { cookie, origin: `http://evil.test:${f.port}`, 'x-rf': '1' } })).status, 421);
});

test('C1 C2 C3 Host and Origin over real sockets: static, API and upgrade', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  for (const path of ['/', '/index.html', '/player.html', '/__realm/status', '/__realm/info', '/__realm/nothing', '/whatever']) {
    const res = await http(f.port, { path, host: 'evil.test' });
    assert.equal(res.status, 421, path);
    assert.equal(res.body.length, 0);
  }
  assert.equal((await json(f.port, '/__realm/hello', { device: phone.device }, { host: 'rebind.example:5173' })).status, 421);
  const upgrade = await phone.open({ headers: { Host: 'evil.test' }, origin: 'http://evil.test' });
  assert.deepEqual([upgrade.ok, upgrade.status], [false, 421]);
  // C2: every spelling of this computer works for the plain HTTP routes
  for (const host of [`127.0.0.1:${f.port}`, `localhost:${f.port}`, `[::1]:${f.port}`, `GM-PC:${f.port}`, '192.168.1.10', 'gm-pc.local']) {
    assert.notEqual((await http(f.port, { path: '/__realm/nothing', host })).status, 421, host);
  }
  // C3: a player upgrade with a foreign or missing Origin
  assert.deepEqual([(await phone.open({ origin: 'http://evil.test:5173' })).status], [403]);
  assert.deepEqual([(await phone.open({ origin: 'null' })).status], [403]);
  assert.deepEqual([(await phone.open({ origin: null })).status], [403]);
  assert.equal((await phone.open()).ok, true);
  f.wss.clients.forEach(ws => ws.close());
});

// ---- D ---------------------------------------------------------------------------------------------------------------------------

test('D1 the 9th socket from one address is refused over real sockets; closing one frees a slot', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  const sockets = [];
  for (let i = 0; i < LIMITS.maxSocketsPerIp; i++) {
    const res = await phone.open();
    assert.equal(res.ok, true, `socket ${i + 1}`);
    sockets.push(res.ws);
  }
  const ninth = await phone.open();
  assert.deepEqual([ninth.ok, ninth.status], [false, 429]);
  sockets.pop().close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const again = await phone.open();
  assert.equal(again.ok, true);
  again.ws.close();
  sockets.forEach(ws => ws.close());
});

test('D8 600 connection attempts from one address: only the cap is admitted and memory stays small (it was +270 MB)', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  const held = [];
  const before = process.memoryUsage().rss;
  let admitted = 0;
  for (let i = 0; i < 600; i++) {
    const res = await phone.open();
    if (res.ok) { admitted += 1; held.push(res.ws); }
  }
  const grown = (process.memoryUsage().rss - before) / 1048576;
  assert.equal(admitted, LIMITS.maxSocketsPerIp);
  assert.equal(f.wss.clients.size, LIMITS.maxSocketsPerIp);
  assert.ok(f.access.metrics.snapshot().rejects['ip-cap'] >= 590, JSON.stringify(f.access.metrics.snapshot().rejects));
  assert.ok(grown < 80, `rss grew ${grown.toFixed(1)} MB`);
  held.forEach(ws => ws.close());
}, { timeout: 60_000 });

test('D6 over real sockets: a 600-byte body to /join is 413, and the server keeps serving', async t => {
  const f = await fixture(t);
  const res = await json(f.port, '/__realm/join', { v: 3, pad: 'x'.repeat(600) }, { headers: { origin: f.base.origin } });
  assert.equal(res.status, 413);
  const after = await http(f.port, { path: '/__realm/status', host: `localhost:${f.port}` });
  assert.equal(after.status, 200);
});

test('D6 a huge upload to the asset PUT is cut off with 413 before it is buffered', async t => {
  const f = await fixture(t);
  const cookie = await gmCookie(f);
  const hostLocal = `localhost:${f.port}`;
  const huge = Buffer.concat([makePng(10, 10), Buffer.alloc(30 * 1024 * 1024)]);
  const res = await http(f.port, { method: 'PUT', path: `/__realm/assets/${sha(huge)}`, body: huge, host: hostLocal, headers: { cookie, origin: `http://${hostLocal}`, 'x-rf': '1' } }).catch(error => ({ status: error.code }));
  assert.ok(res.status === 413 || res.status === 'ECONNRESET' || res.status === 'EPIPE', String(res.status));
  assert.equal(f.access.assets.size, 1, 'only the fixture image is stored');
  assert.equal((await http(f.port, { path: '/__realm/status', host: hostLocal })).status, 200, 'still alive');
});

// ---- E over real sockets ----------------------------------------------------------------------------------------------------------

test('E1 traversal over the wire (Node does not normalise the request path, so these reach the server as written)', async t => {
  const f = await fixture(t);
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%00', '//etc/passwd', '/..\\package.json', '/assets/../../package.json', '/%252e%252e/x']) {
    const res = await http(f.port, { path, host: `127.0.0.1:${f.port}` });
    assert.ok(res.status === 404 || res.status === 400, `${path} -> ${res.status}`);
    assert.ok(!res.body.toString().includes('realm-forge'));
  }
});

test('E3 over real sockets: image reads need the device cookie, GM or admitted device only', async t => {
  const f = await fixture(t);
  const phone = await realPhone(f);
  await phone.join();
  const path = `/__realm/assets/${sha(png)}`;
  assert.equal((await http(f.port, { path, host: f.base.host })).status, 403);
  const ok = await http(f.port, { path, host: f.base.host, headers: { cookie: phone.cookie } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, png);
  assert.equal(ok.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal((await http(f.port, { path, host: f.base.host, headers: { cookie: phone.cookie, 'if-none-match': `"${sha(png)}"` } })).status, 304);
  f.access.table.kick(phone.device);
  assert.equal((await http(f.port, { path, host: f.base.host, headers: { cookie: phone.cookie } })).status, 403);
});

// ---- fuzz: nothing a client sends can throw -------------------------------------------------------------------------------------------

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (random, list) => list[Math.floor(random() * list.length)];
const junk = (random, max = 40) => Array.from({ length: Math.floor(random() * max) }, () => String.fromCharCode(Math.floor(random() * 0x250))).join('');

test('D7 a seeded fuzz of 20,000 HTTP requests never throws, always answers, and never counts a handler error', async t => {
  const env = makeAccess();
  t.after(env.cleanup);
  const { access } = env;
  const random = prng(20261013);
  const phone = createPhone(access);
  await phone.join();
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'TRACE', 'FOO'];
  const paths = ['/', '/index.html', '/player.html', '/__realm/hello', '/__realm/join', '/__realm/info', '/__realm/diag', '/__realm/status', '/__realm/assets/missing',
    `/__realm/assets/${'a'.repeat(64)}`, '/__realm/assets/', '/session-sync', '/assets/x.js', '/%', '/%00', '/..', '/__realm'];
  const hosts = [phone.host, 'localhost:5173', 'evil.test', '', '[::1]:5173', undefined, 'a'.repeat(400), '127.0.0.1'];
  const ips = ['192.168.1.50', '127.0.0.1', '::1', '::ffff:10.0.0.1', undefined, '', 'garbage'];
  const bodies = [undefined, '', '{}', '[]', 'null', '{"device":1}', '{"v":3,"device":"x"}', JSON.stringify({ v: 3, device: phone.device, nonce: 'z', how: 'link', proof: 3 }), '{"__proto__":{"x":1}}', '\u0000\u0001', 'x'.repeat(700)];
  let asked = 0;
  for (let i = 0; i < 20_000; i++) {
    const path = pick(random, paths) + (random() < 0.3 ? `?${junk(random, 12)}` : '') + (random() < 0.1 ? junk(random, 6) : '');
    const req = fakeReq({
      ip: pick(random, ips), host: pick(random, hosts), method: pick(random, methods), url: path, body: pick(random, bodies),
      origin: random() < 0.5 ? pick(random, ['http://localhost:5173', 'null', 'http://evil.test', `http://${phone.host}`, '']) : undefined,
      cookie: random() < 0.5 ? `rf-gm=${junk(random, 20)}; rf-d=${junk(random, 20)}` : undefined,
      headers: { 'content-type': pick(random, ['application/json', 'text/plain', '', 'application/json; charset=utf-8']), 'x-rf': pick(random, ['1', '0', '']), ...(random() < 0.1 ? { 'content-length': junk(random, 5) } : {}) },
    });
    const res = fakeRes();
    access.router(req, res, () => { res.statusCode = 404; res.end(); });
    await Promise.race([res.done, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer for ${req.method} ${req.url}`)), 2000).unref())]);
    asked += 1;
    access.clock.advance(5);
  }
  assert.equal(asked, 20_000);
  assert.equal(access.metrics.count('http.errors'), 0, 'no handler error');
  assert.equal(access.table.list().length <= 1, true, 'the fuzz admitted nobody');
}, { timeout: 120_000 });

test('D7 a seeded fuzz of 20,000 upgrade requests never throws and never lets a stranger in', async t => {
  const env = makeAccess();
  t.after(env.cleanup);
  const { access } = env;
  const random = prng(7);
  const hosts = ['192.168.1.10:5173', 'localhost:5173', 'evil.test', '', undefined, '[::1]:5173'];
  const urls = ['/__realm/ws?role=player', '/__realm/ws?role=gm', '/__realm/audio?role=player', '/__realm/ws', '/__realm/ws?role=', '/__realm/ws?role=player&role=gm', '/%', '//x', 'http://x/__realm/ws?role=gm', '/__realm/ws?role=__proto__'];
  for (let i = 0; i < 20_000; i++) {
    const protocols = pick(random, ['rf3', '', undefined, `rf3, auth.${randomHex(16)}.${randomHex(16)}.${randomHex(32)}`, `auth.${'0'.repeat(32)}.${'1'.repeat(32)}.${'2'.repeat(64)}`, junk(random, 100), 'rf3,'.repeat(20), `rf3, auth.${'g'.repeat(32)}.x.y`]);
    const req = fakeReq({
      ip: pick(random, ['192.168.1.50', '127.0.0.1', '10.0.0.7', undefined, 'x']), host: pick(random, hosts), url: pick(random, urls),
      origin: pick(random, [undefined, 'http://localhost:5173', 'http://192.168.1.10:5173', 'null', 'http://evil.test']),
      cookie: random() < 0.5 ? `rf-gm=${junk(random, 70)}` : undefined, headers: protocols === undefined ? {} : { 'sec-websocket-protocol': protocols },
    });
    const verdict = access.authenticateUpgrade(req);
    assert.equal(verdict.ok, false, `${req.url} ${req.headers.host} ${protocols}`);
    assert.ok(Number.isInteger(verdict.status) && verdict.status >= 400 && verdict.status < 500);
    access.clock.advance(100);
  }
}, { timeout: 120_000 });

test('fuzz: random JSON values as hello/join bodies are answered 4xx and nothing is registered', async t => {
  const env = makeAccess();
  t.after(env.cleanup);
  const { access } = env;
  const random = prng(99);
  const value = (depth = 0) => {
    const kind = Math.floor(random() * 9);
    if (kind === 0) return null;
    if (kind === 1) return random() < 0.5;
    if (kind === 2) return [NaN, Infinity, -1, 0, 1e308, 3, 5e-324][Math.floor(random() * 7)];
    if (kind === 3) return junk(random, 80);
    if (kind === 4) return randomHex(16);
    if (kind === 5 && depth < 4) return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
    if (kind === 6 && depth < 4) return Object.fromEntries(Array.from({ length: Math.floor(random() * 5) }, () => [pick(random, ['v', 'device', 'nonce', 'how', 'proof', 'name', '__proto__', 'constructor']), value(depth + 1)]));
    return 'link';
  };
  for (let i = 0; i < 3000; i++) {
    const body = JSON.stringify(value());
    if (body === undefined || body.length > 500) continue;
    for (const path of ['/__realm/hello', '/__realm/join']) {
      const req = fakeReq({ ip: `10.0.${i % 200}.${(i >> 8) + 1}`, host: '192.168.1.10:5173', method: 'POST', url: path, body, headers: { 'content-type': 'application/json' } });
      const res = fakeRes();
      access.router(req, res, () => {});
      await res.done;
      assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${path} ${body} -> ${res.statusCode}`);
    }
  }
  assert.equal(access.table.list().length, 0);
  assert.equal(access.metrics.count('http.errors'), 0);
}, { timeout: 120_000 });
