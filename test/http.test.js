import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { LIMITS, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { HTTP_LIMITS, buildCsp, hardenHttpServer, httpServerOptions, inlineScriptHashes, loadSite } from '../server/net/http.js';
import { startProductionServer } from '../server/net/serve.js';
import { call, createPhone, gmHeaders, gmLogin, jsonPost, makeAccess, makePng, sha, tempDir } from '../test-support/wp2-fixtures.js';

const INLINE = "import('/src/playerMain.jsx').catch(() => {});";
const INDEX = '<!doctype html><title>GM</title><script type="module" src="/assets/main-abc.js"></script>';
const PLAYER = `<!doctype html><title>Player</title><style>.a{}</style><button onclick="window.location.reload()">x</button><script type="module">${INLINE}</script>`;

/** A built site on disk, loaded the way the production server loads dist/. */
async function builtSite(t) {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const root = join(dir, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'brand'));
  writeFileSync(join(root, 'index.html'), INDEX);
  writeFileSync(join(root, 'player.html'), PLAYER);
  writeFileSync(join(root, 'manifest.webmanifest'), JSON.stringify({ name: 'Realm Forge', icons: [] }) + ' '.repeat(600));
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'assets', 'main-abc.js'), `console.log("hello");${'// padding\n'.repeat(200)}`);
  writeFileSync(join(root, 'assets', 'app.css'), 'body{margin:0}\n'.repeat(100));
  writeFileSync(join(root, 'brand', 'logo.png'), makePng(16, 16));
  return { root, site: await loadSite(root), dir };
}

async function served(t, over = {}) {
  const { site, root } = await builtSite(t);
  const env = makeAccess({ site, ...over });
  t.after(env.cleanup);
  return { ...env, site, root, get: (url, extra = {}) => call(env.access, { url, ...extra }) };
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin',
};

// ---- the built site --------------------------------------------------------------------------------------------------

test('loadSite keeps files in memory with ETags, types, cache rules and precompressed copies', async t => {
  const { site } = await builtSite(t);
  assert.equal(site.get('/assets/main-abc.js').cache, 'public, max-age=31536000, immutable');
  assert.equal(site.get('/index.html').cache, 'no-cache');
  assert.equal(site.get('/player.html').type, 'text/html; charset=utf-8');
  assert.equal(site.get('/brand/logo.png').type, 'image/png');
  assert.match(site.get('/assets/main-abc.js').etag, /^"[0-9a-f]{20}"$/);
  const js = site.get('/assets/main-abc.js');
  assert.equal(gunzipSync(js.gzip).toString(), js.identity.toString());
  assert.equal(brotliDecompressSync(js.br).toString(), js.identity.toString());
  assert.equal(site.get('/favicon.svg').br, undefined, 'tiny files are not compressed');
  assert.equal(site.has('/../package.json'), false);
});

test('E6 .webmanifest is served as application/manifest+json (it used to be application/octet-stream)', async t => {
  const { get, site } = await served(t);
  assert.equal(site.get('/manifest.webmanifest').type, 'application/manifest+json');
  const res = await get('/manifest.webmanifest', { ip: '192.168.1.50' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/manifest+json');
  assert.equal(JSON.parse(res.body).name, 'Realm Forge');
});

test('static files: 200 with the right type, 304 on ETag, br/gzip by Accept-Encoding, HEAD without a body', async t => {
  const { get, site } = await served(t);
  const plain = await get('/assets/main-abc.js');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.equal(plain.headers['content-encoding'], undefined);
  const file = site.get('/assets/main-abc.js');
  assert.equal((await get('/assets/main-abc.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } })).headers['content-encoding'], 'br');
  assert.deepEqual((await get('/assets/main-abc.js', { headers: { 'accept-encoding': 'gzip' } })).buffer, file.gzip);
  assert.equal((await get('/assets/main-abc.js', { headers: { 'if-none-match': file.etag } })).status, 304);
  const head = await get('/assets/main-abc.js', { method: 'HEAD' });
  assert.deepEqual([head.status, head.buffer.length], [200, 0]);
  assert.equal((await get('/nothing.js')).status, 404);
  assert.equal((await get('/assets')).status, 404, 'a directory is not a file');
});

test('static files: only GET and HEAD', async t => {
  const { get } = await served(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await get('/player.html', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
});

// ---- E1 traversal -----------------------------------------------------------------------------------------------------

test('E1 traversal variants give 404 or 400 and never any file content', async t => {
  const { get, root } = await served(t);
  writeFileSync(join(root, '..', 'secret.txt'), 'TOP-SECRET');
  const attempts = [
    '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/%00', '/index.html%00.png', '//etc/passwd',
    '/..\\package.json', '/assets/..\\..\\secret.txt', '/%5c..%5csecret.txt', '/assets/../../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt',
    '/%252e%252e/secret.txt', '/./index.html/../../secret.txt', '/.%2e/secret.txt', '/player.html/..', '/assets/', '/%', '/%zz', '/%c0%ae%c0%ae/secret.txt',
    '/secret.txt', '/..', '/.', '/%2e', '/....//secret.txt', '/assets/main-abc.js/', '/assets/main-abc.js%20', '/ASSETS/main-abc.js',
  ];
  for (const url of attempts) {
    const res = await get(url, { ip: '192.168.1.50' });
    assert.ok([400, 404].includes(res.status) || (res.status === 302 && url === '/.'), `${url} -> ${res.status}`);
    assert.ok(!res.body.includes('TOP-SECRET') && !res.body.includes('"name"') && !res.body.includes('hello'), url);
  }
});

// ---- E2 headers -------------------------------------------------------------------------------------------------------

test('E2 security headers are on HTML, JS, CSS, images, 404s, 421s, 405s, redirects and JSON endpoints', async t => {
  const { get, access } = await served(t);
  const phone = createPhone(access);
  await phone.join();
  access.assets.put(sha(makePng(8, 8)), makePng(8, 8));
  const checks = {
    'player.html': await get('/player.html'),
    'index.html (GM)': await get('/', { ip: '127.0.0.1', host: 'localhost:5173' }),
    js: await get('/assets/main-abc.js'),
    css: await get('/assets/app.css'),
    png: await get('/brand/logo.png'),
    '404': await get('/missing'),
    '405': await get('/player.html', { method: 'POST' }),
    '302': await get('/', { ip: '192.168.1.50' }),
    '421': await get('/player.html', { host: 'evil.test' }),
    'status JSON': await get('/__realm/status', { ip: '127.0.0.1', host: 'localhost:5173' }),
    'hello JSON': await call(access, jsonPost('/__realm/hello', { device: phone.device }, { ip: phone.ip, host: phone.host })),
    'realm 404': await get('/__realm/nothing'),
    'v2 path': await get('/session-sync'),
    'image': await call(access, { ip: phone.ip, host: phone.host, url: `/__realm/assets/${sha(makePng(8, 8))}`, cookie: phone.cookie }),
    'image 403': await call(access, { ip: phone.ip, host: phone.host, url: `/__realm/assets/${sha(makePng(8, 8))}` }),
  };
  for (const [name, res] of Object.entries(checks)) {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers[header], value, `${name}: ${header}`);
    assert.ok(res.headers['permissions-policy'], `${name}: permissions-policy`);
    if (name !== '421') assert.ok(res.headers['content-security-policy-report-only'] || res.headers['content-security-policy'], `${name}: CSP`);
  }
});

test('E2 CSP is report-only by default, carries the Host and the hashes of the page\'s inline script and handler; enforce and off work', async t => {
  const { get } = await served(t);
  const res = await get('/player.html', { host: '192.168.1.10:5173' });
  const csp = res.headers['content-security-policy-report-only'];
  assert.equal(res.headers['content-security-policy'], undefined);
  const hash = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  assert.match(csp, /^default-src 'self'; script-src 'self' /);
  assert.ok(csp.includes(hash(INLINE)), 'inline module script');
  assert.ok(csp.includes(`'unsafe-hashes' ${hash('window.location.reload()')}`) || (csp.includes("'unsafe-hashes'") && csp.includes(hash('window.location.reload()'))), 'inline onclick handler');
  assert.ok(csp.includes('connect-src \'self\' ws://192.168.1.10:5173 wss://192.168.1.10:5173'));
  for (const part of ["style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob: mediastream:", "worker-src 'self' blob:", "frame-src 'self' blob:",
    'object-src blob:', "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(part), part);
  const gmPage = await get('/', { ip: '127.0.0.1', host: 'localhost:5173' });
  assert.ok(!gmPage.headers['content-security-policy-report-only'].includes(hash(INLINE)), 'hashes are per page');

  const enforced = await served(t, { cspMode: 'enforce' });
  const e = await enforced.get('/player.html');
  assert.ok(e.headers['content-security-policy']);
  assert.equal(e.headers['content-security-policy-report-only'], undefined);
  const off = await served(t, { cspMode: 'off' });
  const o = await off.get('/player.html');
  assert.equal(o.headers['content-security-policy'], undefined);
  assert.equal(o.headers['content-security-policy-report-only'], undefined);
  assert.equal(o.headers['x-frame-options'], 'DENY', 'the other headers stay');
});

test('E2 the GM page may capture the display; the player page and everything else may not', async t => {
  const { get } = await served(t);
  assert.match((await get('/', { ip: '127.0.0.1', host: 'localhost:5173' })).headers['permissions-policy'], /display-capture=\(self\)/);
  assert.match((await get('/index.html', { ip: '127.0.0.1', host: 'localhost:5173' })).headers['permissions-policy'], /display-capture=\(self\)/);
  for (const url of ['/player.html', '/assets/main-abc.js']) {
    const policy = (await get(url)).headers['permissions-policy'];
    assert.match(policy, /display-capture=\(\)/, url);
    assert.match(policy, /camera=\(\), microphone=\(\), geolocation=\(\)/);
  }
});

test('buildCsp and inlineScriptHashes are pure and predictable', () => {
  assert.deepEqual(inlineScriptHashes('<script src="/a.js"></script><script type="module" src="/b.js"></script>'), []);
  assert.deepEqual(inlineScriptHashes('<script>   </script>'), [], 'empty scripts need no hash');
  const tokens = inlineScriptHashes('<script>alert(1)</script><p onclick=\'go("a")\'></p><b onmouseover="x &amp;&amp; y()"></b>');
  assert.equal(tokens.filter(token => token === "'unsafe-hashes'").length, 1);
  assert.equal(tokens.length, 4);
  assert.ok(tokens.includes(`'sha256-${createHash('sha256').update('x && y()').digest('base64')}'`), 'entities are decoded before hashing');
  const csp = buildCsp('10.0.0.5:5173', ["'sha256-abc='"]);
  assert.ok(csp.includes("script-src 'self' 'sha256-abc='"));
  assert.ok(csp.includes('ws://10.0.0.5:5173 wss://10.0.0.5:5173'));
});

// ---- C: Host and Origin -------------------------------------------------------------------------------------------------

test('C1 a Host that is not the user\'s own is a 421 with an empty body on every kind of request', async t => {
  const { get, access } = await served(t);
  const phone = createPhone(access);
  await phone.join();
  const requests = [
    { url: '/' }, { url: '/index.html' }, { url: '/player.html' }, { url: '/assets/main-abc.js' }, { url: '/__realm/status' }, { url: '/__realm/info' },
    { url: '/__realm/diag' }, { url: `/__realm/assets/${'a'.repeat(64)}` }, { url: '/nothing' }, { url: '/session-sync' },
    { method: 'POST', url: '/__realm/hello', body: { device: phone.device }, headers: { 'content-type': 'application/json' } },
    { method: 'POST', url: '/__realm/join', body: {}, headers: { 'content-type': 'application/json' } },
    { method: 'PUT', url: `/__realm/assets/${'a'.repeat(64)}`, body: 'x' },
  ];
  for (const host of ['evil.test', 'evil.test:5173', 'localhost.evil.test:5173', '', 'a b']) {
    for (const options of requests) {
      for (const ip of ['127.0.0.1', '192.168.1.50']) {
        const res = await get(options.url, { ...options, host, ip, origin: host ? `http://${host}` : undefined });
        assert.equal(res.status, 421, `${options.method ?? 'GET'} ${options.url} Host=${host} from ${ip}`);
        assert.equal(res.body, '');
        assert.equal(res.nextCalled, false);
      }
    }
  }
  const noHost = await get('/player.html', { host: null });
  assert.equal(noHost.status, 421);
  assert.ok(access.metrics.snapshot().rejects.host > 100);
});

test('C2 an IP literal, localhost, the machine name and name.local all reach the site', async t => {
  const { get } = await served(t);
  for (const host of ['192.168.1.10:5173', '192.168.1.10', '127.0.0.1:5173', 'localhost:5173', '[::1]:5173', 'GM-PC:5173', 'gm-pc.local:5173', 'GM-PC']) {
    assert.equal((await get('/player.html', { host })).status, 200, host);
  }
});

test('other devices asking for the GM page are sent to the player page; this computer gets the GM page', async t => {
  const { get } = await served(t);
  for (const url of ['/', '/index.html', '/?debug=1']) {
    const lan = await get(url, { ip: '192.168.1.50' });
    assert.equal(lan.status, 302, url);
    assert.equal(lan.headers.location, '/player.html');
    assert.equal(lan.headers['set-cookie'], undefined);
    const own = await get(url, { ip: '127.0.0.1', host: 'localhost:5173' });
    assert.equal(own.status, 200, url);
    assert.ok(own.body.includes('<title>GM</title>'));
    assert.match(own.headers['set-cookie'], /^rf-gm=/);
  }
  const sameMachineByLanName = await get('/', { ip: '127.0.0.1', host: '192.168.1.10:5173' });
  assert.equal(sameMachineByLanName.status, 200);
  assert.equal(sameMachineByLanName.headers['set-cookie'], undefined, 'only localhost Hosts get the GM cookie');
});

// ---- status, info, diag ---------------------------------------------------------------------------------------------------

test('the status endpoint answers { app, version } to this computer only and nothing more', async t => {
  const { get } = await served(t);
  const own = await get('/__realm/status', { ip: '127.0.0.1', host: '127.0.0.1:5173' });
  assert.deepEqual(own.json(), { app: 'realm-forge', version: PROTOCOL_VERSION });
  assert.equal((await get('/__realm/status', { ip: '::ffff:127.0.0.1', host: 'localhost:5173' })).status, 200);
  assert.equal((await get('/__realm/status', { ip: '192.168.1.50' })).status, 403);
  assert.equal((await get('/__realm/status', { ip: '127.0.0.1', host: 'localhost:5173', method: 'POST' })).status, 405);
  assert.equal((await get('/__realm/status', { ip: '127.0.0.1', host: 'localhost:5173', method: 'HEAD' })).buffer.length, 0);
});

test('B5 info and diag are GM only: not from the LAN, not with a rebinding Host, not without the cookie', async t => {
  const { get, access } = await served(t);
  const { cookie } = await gmLogin(access);
  for (const url of ['/__realm/info', '/__realm/diag', '/__realm/diag/log']) {
    assert.equal((await get(url, { ...gmHeaders(cookie), headers: {} })).status, 200, url);
    assert.equal((await get(url, { ip: '192.168.1.50', host: '192.168.1.10:5173', cookie })).status, 403, `${url} from the LAN, even with the cookie`);
    assert.equal((await get(url, { ip: '127.0.0.1', host: 'localhost:5173' })).status, 403, `${url} without the cookie`);
    assert.equal((await get(url, { ip: '127.0.0.1', host: 'evil.test:5173', cookie, origin: 'http://evil.test:5173' })).status, 421, `${url} rebinding`);
    assert.equal((await get(url, { ip: '127.0.0.1', host: 'localhost:5173', cookie, origin: 'http://evil.test:5173' })).status, 403, `${url} foreign Origin`);
    assert.equal((await get(url, { ip: '127.0.0.1', host: 'localhost:5173', cookie: 'rf-gm=wrong' })).status, 403);
    assert.equal((await get(url, { ...gmHeaders(cookie), method: 'POST' })).status, 405);
  }
});

test('info gives the GM what the invite dialog needs and nothing secret beyond the invite itself', async t => {
  const { get, access } = await served(t);
  const phone = createPhone(access, { name: 'Aria' });
  await phone.join();
  const { cookie } = await gmLogin(access);
  assert.equal(access.table.invite().codeFresh, false);
  const info = (await get('/__realm/info', { ...gmHeaders(cookie), headers: {} })).json();
  assert.equal(info.app, 'realm-forge');
  assert.equal(info.port, 5173, 'the port is the one the request arrived on');
  assert.equal(info.addresses.length, 1);
  const [address] = info.addresses;
  assert.equal(address.address, '192.168.1.10');
  assert.equal(address.url, 'http://192.168.1.10:5173/player.html');
  assert.equal(address.joinUrl, access.table.invite().urlFor('192.168.1.10', 5173));
  assert.match(address.joinUrl, /#join=[A-Za-z0-9_-]{22}$/);
  assert.match(info.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.equal(info.codeDisplay, `${info.code.slice(0, 4)}-${info.code.slice(4)}`);
  assert.deepEqual([info.mode, info.locked], ['open', false]);
  assert.equal(info.devices.length, 1);
  assert.equal(info.devices[0].name, 'Aria');
  assert.ok(!JSON.stringify(info).includes(phone.dk), 'no device key');
  assert.ok(!JSON.stringify(info).includes(access.internals.store.data.serverSecret), 'no server secret');
  assert.equal(access.table.invite().codeFresh, true, 'looking at the invite opens the typed-code window');
});

test('diag is the metrics snapshot plus the table summary; extendDiag merges more; no secret is in it', async t => {
  const { get, access } = await served(t);
  const phone = createPhone(access);
  await phone.join();
  await phone.join({ proof: 'ab'.repeat(32) });
  access.extendDiag(() => ({ rev: 41, gm: { connected: true } }));
  access.extendDiag(() => { throw new Error('a broken provider must not break /diag'); });
  const { cookie } = await gmLogin(access);
  const text = (await get('/__realm/diag', { ...gmHeaders(cookie), headers: {} })).body;
  const diag = JSON.parse(text);
  assert.equal(diag.app, 'realm-forge');
  assert.equal(diag.protocol, PROTOCOL_VERSION);
  assert.deepEqual(diag.table, { mode: 'open', locked: false, persist: true, devices: 1, pending: 0, revoked: 0 });
  assert.equal(diag.rev, 41);
  assert.deepEqual(diag.gm, { connected: true });
  assert.equal(diag.rejects.proof, 1);
  assert.equal(diag.assets.count, 0);
  assert.ok(diag.counters['http.requests'] >= 3);
  assert.ok(diag.memory.rssMB > 0);
  assert.equal(diag.counters['diag.providerErrors'], undefined, 'counted after the first call');
  for (const secret of [phone.dk, access.internals.store.data.serverSecret, access.table.invite().urlFor('x', 1).split('#join=')[1], access.internals.handshake.gmToken(), access.table.invite().code]) {
    assert.ok(!text.includes(secret));
  }
  const log = (await get('/__realm/diag/log', { ...gmHeaders(cookie), headers: {} })).json();
  assert.ok(Array.isArray(log.lines));
});

// ---- D6: limits of the HTTP layer -----------------------------------------------------------------------------------------

test('D6 a body over 512 bytes to /join or /hello is 413 and the connection is closed; the JSON-only rule is enforced', async t => {
  const { access } = await served(t);
  const phone = createPhone(access);
  const post = (url, body, headers = { 'content-type': 'application/json' }) => call(access, { method: 'POST', url, body, headers, ip: phone.ip, host: phone.host, origin: `http://${phone.host}` });
  const big = JSON.stringify({ v: 3, pad: 'x'.repeat(600) });
  for (const url of ['/__realm/join', '/__realm/hello']) {
    const res = await post(url, big);
    assert.equal(res.status, 413, url);
    assert.equal(res.headers.connection, 'close');
  }
  assert.equal(LIMITS.httpBodyMax, 512);
  const exactly = JSON.stringify({ v: 3, pad: 'x'.repeat(512 - JSON.stringify({ v: 3, pad: '' }).length) });
  assert.equal(exactly.length, 512);
  assert.notEqual((await post('/__realm/join', exactly)).status, 413, '512 bytes is allowed');
  assert.equal((await post('/__realm/join', exactly + ' ')).status, 413, '513 is not');
  // without a Content-Length the stream is counted
  const streamed = await call(access, { method: 'POST', url: '/__realm/join', body: big, headers: { 'content-type': 'application/json', 'content-length': '' }, ip: phone.ip, host: phone.host });
  assert.equal(streamed.status, 413);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '', 'application/jsonp', 'application/json-evil']) {
    assert.equal((await post('/__realm/join', '{}', { 'content-type': type })).status, 415, type);
  }
  assert.equal((await post('/__realm/join', '{}', { 'content-type': 'application/json; charset=utf-8' })).status, 400, 'a charset parameter is fine (the body is just not a join)');
  assert.equal((await call(access, { method: 'GET', url: '/__realm/join', ip: phone.ip, host: phone.host })).status, 405);
  assert.equal((await call(access, { method: 'PUT', url: '/__realm/hello', body: '{}', ip: phone.ip, host: phone.host })).status, 405);
});

test('D6 a foreign Origin on hello/join is refused before any proof is looked at', async t => {
  const { access } = await served(t);
  const phone = createPhone(access);
  const attempt = origin => call(access, jsonPost('/__realm/join', { v: 3, device: phone.device }, { ip: phone.ip, host: phone.host, origin }));
  for (const origin of ['http://evil.test', 'null', 'https://192.168.1.10:5173', 'http://192.168.1.10:9999']) {
    const res = await attempt(origin);
    assert.deepEqual([res.status, res.json()], [403, { error: 'origin' }], origin);
  }
  assert.equal(access.limiter.strikesOf(phone.ip), 0, 'a cross-site page cannot get an address struck');
});

test('a request line that is not a path, or a malformed escape, is a 400 without reaching any handler', async t => {
  const { get } = await served(t);
  for (const url of ['http://evil.test/', '*', 'player.html', '', '/%E0%A4%A']) {
    const res = await get(url);
    assert.equal(res.status, 400, url);
  }
});

test('/session-sync (the v2 WebSocket path) answers 426 with a plain "reload" text', async t => {
  const { get } = await served(t);
  const res = await get('/session-sync?role=player');
  assert.equal(res.status, 426);
  assert.equal(res.body, 'Myth Guard was updated. Reload this page.');
});

test('a handler that throws becomes a 500 with no detail and the server carries on', async t => {
  const { createHttpRouter } = await import('../server/net/http.js');
  const router = createHttpRouter({
    site: null, assetRoutes: { handle: () => { throw new Error('boom: secret detail'); } }, metrics: { inc() {}, log() {} },
    hostGuard: { hostAllowed: () => true, isLoopback: () => false, loopbackHostAllowed: () => false },
    limiter: { banned: () => false }, handshake: { describe: () => ({ ip: '1.2.3.4', host: 'x', cookies: {} }), isGm: () => ({ ok: false }) },
    info: () => ({}), diag: () => ({}),
  });
  const { fakeReq, fakeRes } = await import('../test-support/wp2-fixtures.js');
  const res = fakeRes();
  router(fakeReq({ url: `/__realm/assets/${'a'.repeat(64)}` }), res, () => {});
  await res.done;
  assert.equal(res.statusCode, 500);
  assert.ok(!res.buffer.toString().includes('boom'));
});

// ---- dev server (no built site): the router guards, Vite serves ---------------------------------------------------------------

test('dev mode: allowed requests fall through to Vite, the project folder is not served, the GM cookie is still set', async t => {
  const env = makeAccess({ cspMode: 'off' });
  t.after(env.cleanup);
  const fetchPath = (url, extra = {}) => call(env.access, { url, ...extra });
  for (const url of ['/src/main.jsx', '/@vite/client', '/@react-refresh', '/node_modules/.vite/deps/react.js?v=abc', '/player.html', '/favicon.svg', '/src/styles/a%20b.css']) {
    assert.equal((await fetchPath(url, { ip: '192.168.1.50' })).nextCalled, true, url);
  }
  for (const url of ['/server/net/access.js', '/server/sessionSync.js', '/.realm-data/table.json', '/.REALM-DATA/table.json', '/.backup-pre-network-rewrite/package.json', '/package.json',
    '/package-lock.json', '/.git/config', '/.env', '/test/hostGuard.test.js', '/docs/network-design.md', '/scripts/start.mjs', '/@fs/C:/Users/x/secret', '/dist/index.html',
    '/src/../server/net/access.js', '/src/%2e%2e/server/net/access.js', '/src/%2e%2e%2fserver/x.js', '/src%2f..%2fserver/x.js', '/src/..%5cserver\\x.js', '/%252e/x']) {
    const res = await fetchPath(url, { ip: '127.0.0.1', host: 'localhost:5173' });
    assert.equal(res.nextCalled, false, url);
    assert.ok([400, 404].includes(res.status), `${url} -> ${res.status}`);
  }
  const gmPage = await fetchPath('/', { ip: '127.0.0.1', host: 'localhost:5173' });
  assert.equal(gmPage.nextCalled, true);
  assert.match(gmPage.headers['set-cookie'], /^rf-gm=/);
  const lanPage = await fetchPath('/index.html', { ip: '192.168.1.50' });
  assert.equal(lanPage.status, 302);
  assert.equal((await fetchPath('/src/main.jsx', { host: 'evil.test' })).status, 421, 'Vite never sees a rebinding Host');
  assert.equal((await fetchPath('/__realm/nothing')).status, 404);
  assert.equal((await fetchPath('/__realm/nothing')).nextCalled, false);
});

// ---- real sockets ---------------------------------------------------------------------------------------------------------------

const requestRaw = (port, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({ port, host: '127.0.0.1', method, path, headers, agent: false }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end(body);
});

test('D6 a header block that never completes is closed by headersTimeout; the limits of 4.4 are the defaults', async t => {
  assert.deepEqual(
    [HTTP_LIMITS.headersTimeout, HTTP_LIMITS.requestTimeout, HTTP_LIMITS.keepAliveTimeout, HTTP_LIMITS.maxHeaderSize, HTTP_LIMITS.maxConnections],
    [10_000, 30_000, 5_000, 8192, 200]);
  const server = createServer(httpServerOptions({ headersTimeout: 300, requestTimeout: 1000, connectionsCheckingInterval: 50 }), (req, res) => res.end('ok'));
  hardenHttpServer(server, { headersTimeout: 300, requestTimeout: 1000 });
  assert.equal(server.maxConnections, 200);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const socket = connect(server.address().port, '127.0.0.1');
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');
  const started = Date.now();
  const closed = await new Promise(resolve => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', () => {});
    setTimeout(() => { socket.destroy(); resolve('NOT CLOSED'); }, 3000).unref();
  });
  assert.notEqual(closed, 'NOT CLOSED', 'the server hung up on its own');
  assert.ok(Date.now() - started < 2500);
  assert.match(closed, /^HTTP\/1\.1 408|^$/);
  // a request with a huge header is refused too
  const big = await requestRaw(server.address().port, { headers: { 'X-Big': 'a'.repeat(9000) } }).catch(error => ({ status: error.code }));
  assert.ok(big.status === 431 || big.status === 'ECONNRESET' || big.status === 'HPE_HEADER_OVERFLOW', String(big.status));
});

test('startProductionServer serves the built site with the guards on, refuses a second copy, and closes cleanly', async t => {
  const { root, dir } = await builtSite(t);
  const server = await startProductionServer({ port: 0, root, host: '127.0.0.1', dataDir: join(dir, 'data'), quiet: true });
  t.after(() => server.close());
  assert.ok(server.port > 0);
  const page = await requestRaw(server.port, { path: '/player.html', headers: { host: `127.0.0.1:${server.port}` } });
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.ok(page.headers['content-security-policy-report-only']);
  const status = await requestRaw(server.port, { path: '/__realm/status', headers: { host: `localhost:${server.port}` } });
  assert.deepEqual(JSON.parse(status.body), { app: 'realm-forge', version: PROTOCOL_VERSION });
  const rebinding = await requestRaw(server.port, { path: '/player.html', headers: { host: 'evil.test' } });
  assert.equal(rebinding.status, 421);
  const gm = await requestRaw(server.port, { path: '/', headers: { host: `localhost:${server.port}` } });
  assert.equal(gm.status, 200);
  assert.match(gm.headers['set-cookie'][0], /^rf-gm=/);
  assert.equal(await startProductionServer({ port: server.port, root, host: '127.0.0.1', dataDir: join(dir, 'data'), quiet: true }), null, 'already running');
  await assert.rejects(startProductionServer({ port: 0, root: join(dir, 'nothing'), quiet: true }));
});

test('startProductionServer needs index.html and player.html', async t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'half'));
  writeFileSync(join(dir, 'half', 'index.html'), '<html></html>');
  await assert.rejects(startProductionServer({ port: 0, root: join(dir, 'half'), quiet: true }), /built app is missing/);
});
