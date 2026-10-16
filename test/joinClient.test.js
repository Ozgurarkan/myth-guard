import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createJoinClient, JoinError, parseJoinHash } from '../src/net/joinClient.js';
import { createDeviceStore } from '../src/net/deviceStore.js';
import { joinProof, srvProof, deriveDk, randomSecret, randomCode, randomHex, safeEqualHex } from '../src/net/hmac.js';
import { PATHS, PROTOCOL_VERSION, isHex } from '../src/net/protocol.js';

const URL_BASE = 'http://192.168.1.20:5173/player.html';
const secret = randomSecret();
const code = randomCode();

const freshStore = () => createDeviceStore({ local: null, session: null });
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A server that follows 4.3, written from the spec: checks the proof, answers with srvProof. */
function fakeServer({ link = secret, table = code, status = 'admitted', rogue = false, refuse = null } = {}) {
  const calls = [];
  const server = {
    calls, derived: new Map(),
    async fetchImpl(input, init) {
      const body = JSON.parse(init.body);
      calls.push({ url: String(input), init, body });
      if (refuse) return reply(refuse.status, refuse.body);
      const key = body.how === 'link' ? link : `code:${table}`;
      if (!safeEqualHex(joinProof(key, body.device, body.nonce), body.proof)) return reply(403, { error: 'bad-proof' });
      const srv = randomHex(16);
      server.derived.set(body.device, deriveDk(key, body.device, body.nonce, srv));
      return reply(200, { status, srv, srvProof: rogue ? randomHex(32) : srvProof(key, body.device, body.nonce, srv) });
    },
  };
  return server;
}
const clientFor = (server, store = freshStore(), extra = {}) => ({
  store, client: createJoinClient({ store, fetchImpl: server.fetchImpl, url: URL_BASE, ...extra }),
});

test('joinWithLink sends the documented body, verifies srvProof and stores the derived dk', async () => {
  const server = fakeServer();
  const { store, client } = clientFor(server);
  store.setName('Aria');
  const result = await client.joinWithLink(`#join=${secret}`);
  assert.equal(result.status, 'admitted');
  const [call] = server.calls;
  assert.equal(call.url, 'http://192.168.1.20:5173' + PATHS.join, 'resolved against the page URL');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(call.body).sort(), ['device', 'how', 'name', 'nonce', 'proof', 'v']);
  assert.equal(call.body.v, PROTOCOL_VERSION);
  assert.equal(call.body.how, 'link');
  assert.equal(call.body.name, 'Aria');
  assert.ok(isHex(call.body.device, 16) && isHex(call.body.nonce, 16) && isHex(call.body.proof, 32));
  assert.ok(JSON.stringify(call.body).length <= 512, 'fits the 512-byte join body cap');
  // The proof is HMAC(S, "rf3-join\0device\0nonce") computed independently with node:crypto.
  const expected = createHmac('sha256', secret).update(`rf3-join\0${call.body.device}\0${call.body.nonce}`).digest('hex');
  assert.equal(call.body.proof, expected);
  assert.equal(store.dk(), server.derived.get(call.body.device), 'client and server derived the same dk');
  assert.equal(store.device(), call.body.device);
  assert.equal(store.isMember(), true);
  assert.equal(JSON.stringify(call.body).includes(secret), false, 'the secret never travels');
});

test('A4: a server whose srvProof is wrong is refused and nothing is kept', async () => {
  const server = fakeServer({ rogue: true });
  const { store, client } = clientFor(server);
  await assert.rejects(client.joinWithLink(secret), error => error instanceof JoinError && error.code === 'rogue-server');
  assert.equal(store.dk(), null);
  assert.equal(store.isMember(), false);
});

test('a code join normalises what was typed, uses the code key, and rejects bad codes without any request', async () => {
  const server = fakeServer();
  const { store, client } = clientFor(server);
  const typed = ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
  const result = await client.joinWithCode(typed);
  assert.equal(result.status, 'admitted');
  assert.equal(server.calls[0].body.how, 'code');
  assert.equal(server.calls[0].body.proof, joinProof(`code:${code}`, server.calls[0].body.device, server.calls[0].body.nonce));
  assert.ok(store.dk());
  const before = server.calls.length;
  for (const bad of ['', 'ABC', 'AAAAAAA0', 'IIIIIIII', null, undefined, 12345678]) {
    await assert.rejects(client.joinWithCode(bad), error => error.code === 'bad-code', String(bad));
  }
  assert.equal(server.calls.length, before, 'ambiguous letters and short codes never reach the network');
});

test('pending is reported and still stores the key (the phone connects and waits)', async () => {
  const server = fakeServer({ status: 'pending' });
  const { store, client } = clientFor(server);
  assert.equal((await client.joinWithLink(secret)).status, 'pending');
  assert.equal(store.isMember(), true);
});

test('parseJoinHash accepts #join=, join=, the bare secret, and rejects everything else', () => {
  assert.equal(parseJoinHash(`#join=${secret}`), secret);
  assert.equal(parseJoinHash(`join=${secret}`), secret);
  assert.equal(parseJoinHash(`#a=1&join=${secret}&b=2`), secret);
  assert.equal(parseJoinHash(secret), secret);
  for (const bad of ['', '#', '#join=', `#join=${secret}x`, '#join=short', null, undefined, 5]) assert.equal(parseJoinHash(bad), null, String(bad));
});

test('errors are mapped: 403 reasons, 429, a refused connection, server trouble, malformed answers', async () => {
  const cases = [
    [{ status: 403, body: { error: 'bad-proof' } }, 'bad-proof'],
    [{ status: 403, body: { error: 'locked' } }, 'locked'],
    [{ status: 403, body: { error: 'full' } }, 'full'],
    [{ status: 403, body: { error: 'banned' } }, 'banned'],
    [{ status: 403, body: { error: 'something-new' } }, 'refused'],
    [{ status: 429, body: {} }, 'rate'],
    [{ status: 500, body: {} }, 'server'],
  ];
  for (const [refuse, expected] of cases) {
    const { client } = clientFor(fakeServer({ refuse }));
    await assert.rejects(client.joinWithLink(secret), error => error.code === expected && typeof error.message === 'string' && error.message.length > 5, expected);
  }
  const down = createJoinClient({ store: freshStore(), url: URL_BASE, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(down.joinWithLink(secret), error => error.code === 'network');
  const garbage = createJoinClient({ store: freshStore(), url: URL_BASE, fetchImpl: async () => reply(200, { status: 'admitted', srv: 'zz', srvProof: 'zz' }) });
  await assert.rejects(garbage.joinWithLink(secret), error => error.code === 'server');
  const notJson = createJoinClient({ store: freshStore(), url: URL_BASE, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }) });
  await assert.rejects(notJson.joinWithLink(secret), error => error.code === 'server');
});

test('a wrong invite is a bad-proof and leaves no key behind', async () => {
  const { store, client } = clientFor(fakeServer());
  await assert.rejects(client.joinWithLink(randomSecret()), error => error.code === 'bad-proof');
  await assert.rejects(client.joinWithLink('#join=nonsense'), error => error.code === 'bad-invite');
  assert.equal(store.dk(), null);
});

test('ensureJoined: member when it holds device and key, needs-invite when it has neither, joins with the tab invite', async () => {
  const server = fakeServer();
  const { store, client } = clientFor(server);
  assert.deepEqual(await client.ensureJoined(), { status: 'needs-invite' });
  assert.equal(server.calls.length, 0);
  store.setInvite(secret);
  const joined = await client.ensureJoined();
  assert.equal(joined.status, 'admitted');
  assert.equal(store.invite(), null, 'a spent invite is not kept');
  assert.equal(server.calls.length, 1);
  const again = await client.ensureJoined();
  assert.equal(again.status, 'member');
  assert.equal(server.calls.length, 1, 'a member never asks the network');
});

test('ensureJoined drops a rotated invite (bad-proof) but keeps one that was merely refused for now', async () => {
  const locked = fakeServer({ refuse: { status: 403, body: { error: 'locked' } } });
  const a = clientFor(locked);
  a.store.setInvite(secret);
  await assert.rejects(a.client.ensureJoined(), error => error.code === 'locked');
  assert.equal(a.store.invite(), secret, 'locked: try again later with the same invite');
  const rotated = fakeServer({ link: randomSecret() });
  const b = clientFor(rotated);
  b.store.setInvite(secret);
  await assert.rejects(b.client.ensureJoined(), error => error.code === 'bad-proof');
  assert.equal(b.store.invite(), null, 'a wrong invite is not retried forever');
});

test('concurrent ensureJoined calls share one request, and a later call is not stuck on the first', async () => {
  const server = fakeServer();
  const { store, client } = clientFor(server);
  store.setInvite(secret);
  const [x, y] = await Promise.all([client.ensureJoined(), client.ensureJoined()]);
  assert.equal(server.calls.length, 1);
  assert.equal(x, y);
  store.forget();
  assert.deepEqual(await client.ensureJoined(), { status: 'needs-invite' }, 'the shared promise is released');
});

test('captureInvite keeps the secret for this tab and scrubs it from the address bar', () => {
  const store = freshStore();
  const replaced = [];
  const env = {
    location: { hash: `#join=${secret}`, pathname: '/player.html', search: '?x=1' },
    history: { replaceState: (...args) => replaced.push(args) },
  };
  const client = createJoinClient({ store, env, fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(client.captureInvite(), secret);
  assert.equal(store.invite(), secret);
  assert.deepEqual(replaced, [[null, '', '/player.html?x=1']], 'the fragment is gone, path and query stay');
  assert.equal(createJoinClient({ store: freshStore(), env: { location: { hash: '#other' } } }).captureInvite(), null);
  assert.equal(createJoinClient({ store: freshStore(), env: { location: {}, history: null } }).captureInvite(), null);
  // replaceState failing must not lose the invite.
  const throwing = createJoinClient({ store: freshStore(), env: { location: { hash: `#join=${secret}`, pathname: '/' }, history: { replaceState() { throw new Error('x'); } } } });
  assert.equal(throwing.captureInvite(), secret);
});

test('replaying the same device with the same invite twice keeps one identity', async () => {
  const server = fakeServer();
  const { store, client } = clientFor(server);
  await client.joinWithLink(secret);
  const device = store.device();
  await client.joinWithLink(secret);
  assert.equal(store.device(), device);
  assert.equal(server.calls[1].body.device, device);
  assert.notEqual(server.calls[1].body.nonce, server.calls[0].body.nonce, 'a fresh nonce for every attempt');
  assert.equal(store.dk(), server.derived.get(device), 'the key follows the newest derivation');
});
