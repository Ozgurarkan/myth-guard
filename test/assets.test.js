import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../server/net/clock.js';
import { ASSET_LIMITS, createAssetStore, createEgressPacer, imageSize, sniffImage } from '../server/net/assets.js';
import { createPhone, call, fakeReq, fakeRes, gmHeaders, gmLogin, makeAccess, makePng, sha } from '../test-support/wp2-fixtures.js';

const MiB = 1024 * 1024;

// ---- the three guarantees of the old assetStore.test.js, kept -------------------------------------------------------

test('images are recognised by their bytes, never by their claimed type', () => {
  assert.equal(sniffImage(makePng()), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('<svg onload="alert(1)"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html></html>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('the store verifies content hashes and evicts the least recently used image', () => {
  const store = createAssetStore({ maxBytes: 100, maxAsset: 200 });
  const png = makePng(8, 8);
  assert.equal(store.put(sha(png), png).ok, true);
  assert.equal(store.put('0'.repeat(64), png).status, 400, 'hash must match the bytes');
  assert.equal(store.put(sha(Buffer.from('nope')), Buffer.from('nope')).status, 415);
  assert.equal(store.put('zz', png).status, 400);
  const second = makePng(8, 8, 30, 1);
  const third = makePng(8, 8, 30, 2);
  assert.equal(store.put(sha(second), second).ok, true);
  store.get(sha(png)); // used recently, so `second` goes first
  assert.equal(store.put(sha(third), third).ok, true);
  assert.equal(store.has(sha(second)), false);
  assert.equal(store.has(sha(png)), true);
  assert.equal(store.has(sha(third)), true);
  assert.equal(store.stats().evicted, 1);
  assert.equal(store.bytes, png.length + third.length);
});

test('uploading the same image twice is harmless and reports it', () => {
  const store = createAssetStore();
  const png = makePng(8, 8);
  assert.deepEqual(store.put(sha(png), png), { ok: true, existed: false });
  assert.deepEqual(store.put(sha(png), png), { ok: true, existed: true });
  assert.equal(store.size, 1);
});

// ---- E4/E5 at the store level ----------------------------------------------------------------------------------------

test('E4 the store refuses oversize images (413), SVG and HTML (415) and decompression bombs (415)', () => {
  const store = createAssetStore({ maxAsset: 1000 });
  const big = makePng(8, 8, 1000);
  assert.equal(store.put(sha(big), big).status, 413);
  for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<!doctype html><script>alert(1)</script>', '%PDF-1.7']) {
    const bytes = Buffer.from(text);
    assert.equal(store.put(sha(bytes), bytes).status, 415, text.slice(0, 10));
  }
  const roomy = createAssetStore();
  for (const [w, h] of [[20000, 20], [20, 20000], [16385, 1], [10001, 10000], [100000, 100000], [0, 10], [10, 0]]) {
    const bomb = makePng(w, h);
    const result = roomy.put(sha(bomb), bomb);
    assert.equal(result.status, 415, `${w}x${h}`);
    assert.match(result.reason, /dimensions/);
  }
  const edge = makePng(10000, 10000);
  assert.equal(roomy.put(sha(edge), edge).ok, true, '100 megapixels exactly is allowed');
  const wide = makePng(16384, 100);
  assert.equal(roomy.put(sha(wide), wide).ok, true, '16384 px is allowed');
});

test('E4 an image whose size cannot be read is refused (fail closed) unless the store is told otherwise', () => {
  const header = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('realm')]);
  const strict = createAssetStore();
  const result = strict.put(sha(header), header);
  assert.equal(result.status, 415);
  assert.match(result.reason, /size could not be read/);
  assert.equal(createAssetStore({ requireDimensions: false }).put(sha(header), header).ok, true);
});

test('E5 pinned images are never evicted, unpinned ones go least-recently-used first', () => {
  const pinned = new Set();
  const store = createAssetStore({ maxBytes: 230, pin: () => pinned });
  const a = makePng(8, 8, 40, 1); const b = makePng(8, 8, 40, 2); const c = makePng(8, 8, 40, 3); const d = makePng(8, 8, 40, 4);
  for (const image of [a, b, c]) assert.equal(store.put(sha(image), image).ok, true);
  pinned.add(sha(a));
  assert.equal(store.put(sha(d), d).ok, true, 'room is made by dropping b (a is pinned)');
  assert.deepEqual([a, b, c, d].map(image => store.has(sha(image))), [true, false, true, true]);
  assert.equal(store.stats().pinned, 1);
});

test('E5 when pinned images alone fill the quota the upload is refused with 507 and nothing is dropped', () => {
  const pinned = new Set();
  const store = createAssetStore({ maxBytes: 200, pin: () => pinned });
  const images = [1, 2].map(n => makePng(8, 8, 60, n));
  for (const image of images) { store.put(sha(image), image); pinned.add(sha(image)); }
  const before = store.bytes;
  const extra = makePng(8, 8, 80, 9);
  const result = store.put(sha(extra), extra);
  assert.equal(result.status, 507);
  assert.match(result.reason, /Table image memory is full/);
  assert.equal(store.bytes, before);
  assert.deepEqual(images.map(image => store.has(sha(image))), [true, true]);
  assert.equal(store.has(sha(extra)), false);
});

test('E5 a refused upload evicts nothing, even when some unpinned images could have been dropped', () => {
  const pinned = new Set();
  const store = createAssetStore({ maxBytes: 250, pin: () => pinned });
  const keep = makePng(8, 8, 150, 1);
  const loose = makePng(8, 8, 30, 2);
  store.put(sha(keep), keep); store.put(sha(loose), loose);
  pinned.add(sha(keep));
  const huge = makePng(8, 8, 150, 3); // would need 150 more bytes: dropping `loose` frees too little
  assert.equal(store.put(sha(huge), huge).status, 507);
  assert.equal(store.has(sha(loose)), true);
});

test('a pin callback that throws or returns junk never breaks an upload', () => {
  const a = makePng(8, 8, 60, 1); const b = makePng(8, 8, 60, 2);
  const throwing = createAssetStore({ maxBytes: 100, pin: () => { throw new Error('scene gone'); } });
  throwing.put(sha(a), a);
  assert.equal(throwing.put(sha(b), b).ok, true);
  const list = createAssetStore({ maxBytes: 100, pin: () => [sha(makePng(8, 8, 60, 1))] });
  list.put(sha(a), a);
  assert.equal(list.put(sha(b), b).status, 507, 'an array is accepted as a set of hashes');
});

// ---- reading image sizes from headers ---------------------------------------------------------------------------------

const gif = (w, h) => { const b = Buffer.alloc(16); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const jpeg = (w, h) => Buffer.concat([
  Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xff, 0xff, 0xdb, 0x00, 0x04, 0, 0]),
  Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
]);
const webpHeader = (kind, size = 20) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write(kind, 12, 'latin1'); b.writeUInt32LE(size, 16); return b; };
const webpX = (w, h) => { const b = webpHeader('VP8X', 10); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const webpL = (w, h) => { const b = webpHeader('VP8L'); b[20] = 0x2f; b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21); return b; };
const webpLossy = (w, h) => { const b = webpHeader('VP8 '); b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); return b; };
const avif = (...sizes) => Buffer.concat([
  Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypavif', 'latin1'), Buffer.alloc(8),
  ...sizes.map(([w, h]) => { const b = Buffer.alloc(20); b.writeUInt32BE(20, 0); b.write('ispe', 4, 'latin1'); b.writeUInt32BE(w, 12); b.writeUInt32BE(h, 16); return b; }),
]);

test('imageSize reads PNG, GIF, JPEG, WebP (all three kinds) and AVIF headers', () => {
  assert.deepEqual(imageSize(makePng(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(gif(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(imageSize(jpeg(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(webpX(4096, 3000)), { width: 4096, height: 3000 });
  assert.deepEqual(imageSize(webpL(1000, 700)), { width: 1000, height: 700 });
  assert.deepEqual(imageSize(webpLossy(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(imageSize(avif([512, 256])), { width: 512, height: 256 });
  assert.deepEqual(imageSize(avif([64, 64], [4000, 3000], [128, 128])), { width: 4000, height: 3000 }, 'the largest extent counts');
});

test('imageSize returns null for truncated or inconsistent headers, never throws', () => {
  assert.equal(imageSize(makePng(10, 10).subarray(0, 20)), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff])), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])), null);
  assert.equal(imageSize(webpHeader('JUNK')), null);
  assert.equal(imageSize(Buffer.alloc(5)), null);
  assert.equal(imageSize(Buffer.from('plain text'), 'image/png'), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
});

test('the store applies the size limits to every format', () => {
  const store = createAssetStore();
  for (const bomb of [gif(60000, 60000), jpeg(30000, 30000), webpX(30000, 100), webpL(16000, 16000), avif([50000, 50000])]) {
    assert.equal(store.put(sha(bomb), bomb).status, 415, sniffImage(bomb));
  }
  const fine = jpeg(2000, 1500);
  assert.equal(store.put(sha(fine), fine).ok, true);
});

// ---- HTTP: reading ---------------------------------------------------------------------------------------------------

const png = makePng(32, 32, 100);
const url = `/__realm/assets/${sha(png)}`;

async function member(t, over = {}) {
  const env = makeAccess(over);
  t.after(env.cleanup);
  env.access.assets.put(sha(png), png);
  const phone = createPhone(env.access);
  await phone.join();
  return { ...env, phone, get: (extra = {}) => call(env.access, { ip: phone.ip, host: phone.host, url, cookie: phone.cookie, ...extra }) };
}

test('E3 GET: no cookie 403, valid 200 with immutable private caching and the isolation headers, 304 on ETag', async t => {
  const { access, phone, get } = await member(t);
  assert.equal((await call(access, { ip: phone.ip, host: phone.host, url })).status, 403);
  const ok = await get();
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.buffer, png);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['content-length'], png.length);
  assert.equal(ok.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(ok.headers.etag, `"${sha(png)}"`);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(ok.headers['content-security-policy'], "default-src 'none'; sandbox");
  for (const tag of [`"${sha(png)}"`, `W/"${sha(png)}"`, `"other", "${sha(png)}"`, '*']) {
    const cached = await get({ headers: { 'if-none-match': tag } });
    assert.equal(cached.status, 304, tag);
    assert.equal(cached.buffer.length, 0);
    assert.equal(cached.headers.etag, `"${sha(png)}"`);
  }
  assert.equal((await get({ headers: { 'if-none-match': '"nope"' } })).status, 200);
  const head = await get({ method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.buffer.length, 0);
  assert.equal(head.headers['content-length'], png.length);
});

test('E3 a 304 is only for someone allowed to read the image', async t => {
  const { access, phone } = await member(t);
  const res = await call(access, { ip: phone.ip, host: phone.host, url, headers: { 'if-none-match': `"${sha(png)}"` } });
  assert.equal(res.status, 403);
});

test('E3 a revoked device gets 403', async t => {
  const { access, phone, get } = await member(t);
  assert.equal((await get()).status, 200);
  access.table.kick(phone.device);
  assert.equal((await get()).status, 403);
});

test('E3 the GM (loopback, localhost Host, rf-gm cookie) may read images without a device cookie; a rebinding Host may not', async t => {
  const { access } = await member(t);
  const { cookie } = await gmLogin(access);
  assert.equal((await call(access, { ip: '127.0.0.1', host: 'localhost:5173', url, cookie })).status, 200);
  assert.equal((await call(access, { ip: '127.0.0.1', host: 'evil.test:5173', url, cookie })).status, 421);
  assert.equal((await call(access, { ip: '192.168.1.77', host: '192.168.1.10:5173', url, cookie })).status, 403, 'the cookie is not enough away from this computer');
});

test('E3 20 misses a minute per address, then 429; hits keep working; a token returns every 3 seconds', async t => {
  const { access, phone, get, clock } = await member(t);
  const miss = `/__realm/assets/${'a'.repeat(64)}`;
  const statuses = [];
  for (let i = 0; i < 23; i++) statuses.push((await get({ url: miss })).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(404));
  assert.deepEqual(statuses.slice(20), [429, 429, 429]);
  assert.equal((await get()).status, 200, 'a real image is still served');
  const forbidden = await call(access, { ip: phone.ip, host: phone.host, url: miss });
  assert.equal(forbidden.status, 429, 'refusals draw from the same bucket');
  clock.advance(3100);
  assert.equal((await get({ url: miss })).status, 404);
  assert.equal((await get({ url: miss })).status, 429);
  const other = await call(access, { ip: '192.168.1.99', host: phone.host, url: miss, cookie: phone.cookie });
  assert.equal(other.status, 404, 'another address has its own bucket');
});

test('asset paths: odd ids and methods are refused without touching the store', async t => {
  const { get, phone, access } = await member(t);
  for (const bad of ['/__realm/assets/', '/__realm/assets/zz', `/__realm/assets/${'A'.repeat(64)}`, `/__realm/assets/${'a'.repeat(63)}`, `/__realm/assets/${sha(png)}/x`, '/__realm/assets/%2e%2e%2fstatus']) {
    assert.equal((await get({ url: bad })).status, 404, bad);
  }
  const post = await call(access, { method: 'POST', url, ip: phone.ip, host: phone.host, cookie: phone.cookie });
  assert.equal(post.status, 405);
  assert.equal((await call(access, { method: 'DELETE', url, ip: phone.ip, host: phone.host, cookie: phone.cookie })).status, 405);
});

// ---- HTTP: writing (GM only) -----------------------------------------------------------------------------------------

async function gm(t, over = {}) {
  const env = makeAccess(over);
  t.after(env.cleanup);
  const { cookie } = await gmLogin(env.access);
  const put = (body, extra = {}) => call(env.access, { method: 'PUT', url: `/__realm/assets/${sha(body)}`, body, ...gmHeaders(cookie), ...extra });
  return { ...env, cookie, put };
}

test('E4 PUT stores an image (201), a repeat is 200, and the player can then read it', async t => {
  const { access, put } = await gm(t);
  const image = makePng(100, 100, 50);
  assert.equal((await put(image)).status, 201);
  assert.equal((await put(image)).status, 200);
  assert.equal(access.assets.has(sha(image)), true);
  const phone = createPhone(access);
  await phone.join();
  const got = await call(access, { ip: phone.ip, host: phone.host, url: `/__realm/assets/${sha(image)}`, cookie: phone.cookie });
  assert.deepEqual(got.buffer, image);
});

test('E4 PUT: hash mismatch 400, SVG and HTML 415, oversize 413, bomb dimensions 415', async t => {
  const { put, cookie, access } = await gm(t);
  const image = makePng(100, 100, 50);
  const wrongHash = await call(access, { method: 'PUT', url: `/__realm/assets/${'0'.repeat(64)}`, body: image, ...gmHeaders(cookie) });
  assert.equal(wrongHash.status, 400);
  assert.equal(wrongHash.body, 'Hash mismatch');
  assert.equal((await put(Buffer.from('<svg onload="alert(1)"/>'))).status, 415);
  assert.equal((await put(Buffer.from('<html><script>1</script></html>'))).status, 415);
  const bomb = makePng(30000, 30000);
  assert.equal((await put(bomb)).status, 415);
  assert.equal(access.assets.has(sha(bomb)), false);
  assert.equal((await call(access, { method: 'PUT', url: '/__realm/assets/nothash', body: image, ...gmHeaders(cookie) })).status, 404);

  const oversize = Buffer.concat([makePng(10, 10), Buffer.alloc(ASSET_LIMITS.maxAsset)]);
  const tooBig = await put(oversize);
  assert.equal(tooBig.status, 413);
  assert.equal(access.assets.has(sha(oversize)), false);
  // Without a Content-Length the stream is cut off at the limit too.
  const streamed = await call(access, { method: 'PUT', url: `/__realm/assets/${sha(oversize)}`, body: oversize, ...gmHeaders(cookie), headers: { 'x-rf': '1', 'content-length': '' } });
  assert.equal(streamed.status, 413);
});

test('E4/E5 quota: when the image memory is full of pinned images the upload is 507 with the toast text', async t => {
  const pinned = new Set();
  const small = makePng(8, 8, 100, 1);
  const { put, access } = await gm(t, { assetLimits: { maxBytes: small.length * 2 + 10 }, projectAssetsPinned: () => pinned });
  const a = makePng(8, 8, 100, 1); const b = makePng(8, 8, 100, 2); const c = makePng(8, 8, 100, 3);
  assert.equal((await put(a)).status, 201);
  assert.equal((await put(b)).status, 201);
  pinned.add(sha(a)); pinned.add(sha(b));
  const refused = await put(c);
  assert.equal(refused.status, 507);
  assert.match(refused.body, /Table image memory is full - remove old scenes or restart the table/);
  assert.equal(access.assets.has(sha(a)), true);
  pinned.delete(sha(a));
  assert.equal((await put(c)).status, 201, 'unpinned images make room');
  assert.equal(access.assets.has(sha(a)), false);
  assert.equal(access.assets.has(sha(b)), true);
});

test('E4 PUT is GM only: LAN address, player cookie, rebinding Host, missing Origin, foreign Origin, missing X-RF, no cookie', async t => {
  const { access, put, cookie } = await gm(t);
  const image = makePng(20, 20, 20);
  const base = { method: 'PUT', url: `/__realm/assets/${sha(image)}`, body: image };
  const phone = createPhone(access);
  await phone.join();
  const attempts = {
    'a player with its device cookie': { ip: phone.ip, host: phone.host, origin: `http://${phone.host}`, cookie: phone.cookie, headers: { 'x-rf': '1' } },
    'the GM cookie from the LAN': { ip: '192.168.1.77', host: '192.168.1.10:5173', origin: 'http://192.168.1.10:5173', cookie, headers: { 'x-rf': '1' } },
    'no cookie at all': { ...gmHeaders(undefined) },
    'no Origin': { ...gmHeaders(cookie), origin: undefined },
    'a foreign Origin': { ...gmHeaders(cookie), origin: 'http://evil.test:5173' },
    'no X-RF header': { ...gmHeaders(cookie), headers: {} },
    'X-RF with another value': { ...gmHeaders(cookie), headers: { 'x-rf': 'yes' } },
  };
  for (const [name, extra] of Object.entries(attempts)) {
    const res = await call(access, { ...base, ...extra });
    assert.equal(res.status, 403, name);
  }
  const rebinding = await call(access, { ...base, ...gmHeaders(cookie), host: 'evil.test:5173', origin: 'http://evil.test:5173' });
  assert.equal(rebinding.status, 421);
  assert.equal(access.assets.size, 0, 'nothing was stored by any of them');
  assert.equal((await put(image)).status, 201, 'and the real GM still can');
});

test('B5 POST /missing lists what the server still needs, and is GM only', async t => {
  const { access, put, cookie } = await gm(t);
  const image = makePng(20, 20, 20);
  await put(image);
  const ask = (hashes, extra = {}) => call(access, { method: 'POST', url: '/__realm/assets/missing', body: hashes, ...gmHeaders(cookie), ...extra });
  assert.deepEqual((await ask([sha(image), 'b'.repeat(64), 'not-a-hash', 7])).json(), ['b'.repeat(64)]);
  assert.deepEqual((await ask([])).json(), []);
  assert.equal((await ask(Array(501).fill('c'.repeat(64)))).status, 400);
  assert.deepEqual((await ask(Array(500).fill('c'.repeat(64)))).json().length, 500);
  assert.equal((await ask('nope')).status, 400);
  assert.equal((await ask({})).status, 400);
  assert.equal((await ask([], { origin: 'http://evil.test:5173' })).status, 403);
  assert.equal((await ask([], { headers: {} })).status, 403);
  assert.equal((await ask([], { ip: '192.168.1.77', host: '192.168.1.10:5173', origin: 'http://192.168.1.10:5173' })).status, 403);
  assert.equal((await ask([], { host: 'evil.test:5173', origin: 'http://evil.test:5173' })).status, 421);
  const huge = await call(access, { method: 'POST', url: '/__realm/assets/missing', body: Buffer.alloc(70 * 1024, 32), ...gmHeaders(cookie) });
  assert.equal(huge.status, 413);
  assert.equal((await call(access, { method: 'GET', url: '/__realm/assets/missing', ...gmHeaders(cookie) })).status, 405);
});

test('uploads are limited to 40 a minute', async t => {
  const { put, clock } = await gm(t);
  const statuses = [];
  for (let i = 0; i < 42; i++) statuses.push((await put(makePng(8, 8, 10, i))).status);
  assert.equal(statuses.filter(status => status === 201).length, ASSET_LIMITS.uploadsPerMinute);
  assert.deepEqual(statuses.slice(-2), [429, 429]);
  clock.advance(2000);
  assert.equal((await put(makePng(8, 8, 10, 99))).status, 201);
});

// ---- egress pacing (off by default) ----------------------------------------------------------------------------------

test('the egress pacer writes in 64 KB chunks no faster than the configured rate (fake clock)', async () => {
  const clock = createFakeClock();
  const pacer = createEgressPacer({ kBps: 256, clock });
  const res = fakeRes();
  const body = Buffer.alloc(1 * MiB, 3);
  const started = clock.now();
  const sending = pacer.send(res, body);
  for (let guard = 0; guard < 2000 && !res.writableEnded; guard++) { await new Promise(resolve => setImmediate(resolve)); clock.advance(20); }
  await sending;
  assert.equal(res.writableEnded, true);
  assert.equal(res.buffer.length, body.length);
  const seconds = (clock.now() - started) / 1000;
  assert.ok(seconds >= 3 && seconds < 5, `1 MiB at 256 KB/s with a 128 KB head start takes about 3.5 s (took ${seconds})`);
});

test('a large image is paced only while sound is live', async t => {
  let live = true;
  const big = Buffer.concat([makePng(2000, 2000), Buffer.alloc(600 * 1024, 5)]);
  const { access, clock, cleanup } = makeAccess({ assetEgressKBps: 512, audioLive: () => live });
  t.after(cleanup);
  access.assets.put(sha(big), big);
  const phone = createPhone(access);
  await phone.join();
  const fetchBig = async () => {
    const req = fakeReq({ ip: phone.ip, host: phone.host, url: `/__realm/assets/${sha(big)}`, cookie: phone.cookie });
    const res = fakeRes();
    access.router(req, res, () => {});
    const started = clock.now();
    for (let guard = 0; guard < 2000 && !res.writableEnded; guard++) { await new Promise(resolve => setImmediate(resolve)); clock.advance(20); }
    return { res, seconds: (clock.now() - started) / 1000 };
  };
  const paced = await fetchBig();
  assert.equal(paced.res.buffer.length, big.length);
  assert.ok(paced.seconds > 0.5, `paced (${paced.seconds}s)`);
  live = false;
  const free = await fetchBig();
  assert.equal(free.res.buffer.length, big.length);
  assert.ok(free.seconds < 0.05, 'no pacing when no sound is playing');
});
