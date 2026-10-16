import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CLOSE, LIMITS } from '../src/net/protocol.js';
import { deriveDk, inviteKey, joinProof, randomHex, srvProof, wsProof } from '../src/net/hmac.js';
import {
  GM_HOST, call, createPhone, gmLogin, gmUpgrade, jsonPost, makeAccess, makePng, sha, tempDir,
} from '../test-support/wp2-fixtures.js';

const png = makePng(32, 32, 100);
const imageUrl = `/__realm/assets/${sha(png)}`;
const fetchImage = (access, phone) => call(access, { ip: phone.ip, host: phone.host, url: imageUrl, cookie: phone.cookie ?? undefined });

function table(over = {}) {
  const t = makeAccess(over);
  t.access.assets.put(sha(png), png);
  return t;
}

// ---- A: admission and identity ---------------------------------------------------------------------------------------

test('A1 a join with no proof is refused with the generic 403 body and creates nothing', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  const res = await phone.join({ proof: null });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json(), { error: 'bad-proof' });
  assert.equal(access.table.list().length, 0);
  assert.equal((await phone.join({ proof: '' })).status, 403);
  assert.equal(access.metrics.snapshot().rejects.proof, 2);
});

test('A2 a wrong proof is a 403 with the same body as a missing one, and is recorded as a strike', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  const missing = await phone.join({ proof: null });
  const wrong = await phone.join({ proof: 'ab'.repeat(32) });
  const wrongKey = await phone.join({ value: 'AAAAAAAAAAAAAAAAAAAAAA' });
  for (const res of [missing, wrong, wrongKey]) { assert.equal(res.status, 403); assert.deepEqual(res.json(), { error: 'bad-proof' }); }
  assert.equal(access.limiter.strikesOf(phone.ip), 3);
  assert.equal(access.table.list().length, 0);
  assert.equal(wrong.headers['set-cookie'], undefined, 'no cookie for a stranger');
});

test('A3 the correct link proof admits the device; srvProof verifies; the cookie has exactly the right flags', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access, { name: 'Thorin' });
  const res = await phone.join();
  assert.equal(res.status, 200);
  const answer = res.json();
  assert.deepEqual(Object.keys(answer).sort(), ['srv', 'srvProof', 'status']);
  assert.equal(answer.status, 'admitted');
  assert.equal(phone.srvProofOk, true);
  assert.match(phone.dk, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(res.json()).includes(phone.dk), false, 'the key never travels');
  const listed = access.table.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Thorin');
  assert.equal(listed[0].label, 'Android · Chrome');
  assert.equal(listed[0].ip, phone.ip);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('A17 the rf-d cookie is HttpOnly; SameSite=Strict; Path=/ (no Secure, no Domain), and a cookie with a bad MAC opens nothing', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  const res = await phone.join();
  const header = res.headers['set-cookie'];
  assert.match(header, /^rf-d=[0-9a-f]{32}\.[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000$/);
  assert.ok(!/Secure|Domain/i.test(header));
  assert.equal((await fetchImage(access, phone)).status, 200, 'the real cookie works');
  const [id, mac] = phone.cookie.slice(5).split('.');
  for (const forged of [`rf-d=${id}.${mac.replace(/.$/, c => (c === '0' ? '1' : '0'))}`, `rf-d=${id}.${'0'.repeat(32)}`, `rf-d=${randomHex(16)}.${mac}`, `rf-d=${id}`, 'rf-d=', 'rf-d=junk']) {
    assert.equal((await fetchImage(access, { ...phone, cookie: forged })).status, 403, forged);
  }
});

test('A3/A4 the server proof can only be produced with the invite key: a rogue server (or a tampered answer) is caught by the client check', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  const res = await phone.join();
  const { nonce, key } = phone.lastJoin;
  const answer = res.json();
  assert.equal(answer.srvProof, srvProof(key, phone.device, nonce, answer.srv));
  // What a rogue access point that does not know S can offer, and what the client would conclude:
  const rogueKey = inviteKey('link', 'AAAAAAAAAAAAAAAAAAAAAA');
  const verifies = proof => proof === srvProof(key, phone.device, nonce, answer.srv);
  assert.equal(verifies(answer.srvProof), true);
  assert.equal(verifies(srvProof(rogueKey, phone.device, nonce, answer.srv)), false);
  assert.equal(verifies(answer.srvProof.replace(/.$/, c => (c === 'a' ? 'b' : 'a'))), false);
  assert.equal(verifies(srvProof(key, phone.device, nonce, randomHex(16))), false, 'a proof for another srv');
  assert.notEqual(answer.srvProof, joinProof(key, phone.device, nonce), 'labels separate the two proofs');
});

test('A5 the table code works when typed; five wrong codes ban that address for five minutes, others are unaffected', async t => {
  const { access, clock, cleanup } = table();
  t.after(cleanup);
  access.table.inviteShown();
  const guesser = createPhone(access, { ip: '192.168.1.60' });
  const bystander = createPhone(access, { ip: '192.168.1.61' });
  for (let i = 1; i <= LIMITS.failedProofsBeforeBan; i++) {
    const res = await guesser.join({ how: 'code', value: 'AAAAAAAA' });
    assert.equal(res.status, 403, `wrong code ${i}`);
    assert.deepEqual(res.json(), { error: 'bad-proof' });
  }
  assert.equal(access.banned(guesser.ip), true);
  const right = await guesser.join({ how: 'code' });
  assert.equal(right.status, 403);
  assert.deepEqual(right.json(), { error: 'banned' }, 'even the right code does not help while banned');
  assert.equal((await bystander.join({ how: 'code' })).status, 200, 'another address joins with the code');
  assert.equal(bystander.srvProofOk, true);
  clock.advance(LIMITS.banMs - 1000);
  assert.equal((await guesser.join({ how: 'code' })).json().error, 'banned');
  clock.advance(2000);
  const later = await guesser.join({ how: 'code' });
  assert.equal(later.status, 200, 'the ban ended');
});

test('A5 a code that has gone stale (dialog closed for ten minutes) is refused like a wrong one', async t => {
  const { access, clock, cleanup } = table();
  t.after(cleanup);
  access.table.inviteShown();
  clock.advance(LIMITS.codeFreshAfterCloseMs + 1);
  const phone = createPhone(access);
  const res = await phone.join({ how: 'code' });
  assert.deepEqual([res.status, res.json()], [403, { error: 'bad-proof' }]);
  access.table.inviteShown();
  assert.equal((await phone.join({ how: 'code' })).status, 200);
});

test('A6 a flood of wrong codes from many addresses auto-locks the table and the GM is told', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  access.table.inviteShown();
  const events = [];
  access.table.on('change', event => events.push(event));
  let tries = 0;
  for (let address = 10; address < 20 && !access.table.locked(); address++) {
    const attacker = createPhone(access, { ip: `192.168.1.${address}` });
    for (let i = 0; i < 4 && !access.table.locked(); i++) { await attacker.join({ how: 'code', value: 'AAAAAAAA' }); tries += 1; }
  }
  assert.equal(access.table.locked(), true);
  assert.equal(tries, LIMITS.wrongCodeGlobalPerMin + 1, 'the 31st wrong code in a minute locks it');
  assert.ok(events.some(event => event.kind === 'lock' && event.reason === 'code-flood'), 'a change event says why');
  assert.match(access.metrics.logTail().join('\n'), /too many wrong table codes/);
  const stranger = createPhone(access, { ip: '192.168.1.99' });
  assert.deepEqual((await stranger.join()).json(), { error: 'locked' });
});

test('A7 locked: a new device is refused, a known device still reconnects, unlocking admits again', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const member = createPhone(access, { ip: '192.168.1.50' });
  await member.join();
  access.table.lock();
  const newcomer = createPhone(access, { ip: '192.168.1.51' });
  const refused = await newcomer.join();
  assert.deepEqual([refused.status, refused.json()], [403, { error: 'locked' }]);
  assert.equal(access.table.list().length, 1);
  const back = await member.connect();
  assert.equal(back.ok, true);
  assert.equal(back.pending, false);
  assert.equal((await fetchImage(access, member)).status, 200);
  assert.equal(access.table.unlock(), true);
  assert.equal((await newcomer.join()).status, 200);
});

test('locking does not need a valid proof to answer "locked" (no oracle for guessing the code while locked)', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  access.table.lock();
  const phone = createPhone(access);
  assert.deepEqual((await phone.join({ proof: 'ab'.repeat(32) })).json(), { error: 'locked' });
  assert.equal(access.limiter.strikesOf(phone.ip), 0);
});

test('A8 ask: the new device is pending and gets no images; the GM is told; Admit lets it in', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  access.table.setMode('ask');
  const requests = [];
  access.table.on('joinRequest', request => requests.push(request));
  const phone = createPhone(access, { name: 'Brynn', ip: '192.168.1.52' });
  const res = await phone.join();
  assert.equal(res.json().status, 'pending');
  assert.equal(phone.srvProofOk, true);
  assert.equal(requests.length, 1);
  assert.deepEqual({ ...requests[0], playerId: undefined }, { device: phone.device, playerId: undefined, name: 'Brynn', label: 'Android · Chrome', ip: '192.168.1.52' });
  assert.match(requests[0].playerId, /^[0-9a-f]{24}$/);

  const waiting = await phone.connect();
  assert.equal(waiting.ok, true);
  assert.equal(waiting.pending, true, 'the hub sends WAIT and no state');
  assert.equal((await fetchImage(access, phone)).status, 403, 'a pending device cannot read images');
  const audio = await phone.connect({ path: '/__realm/audio' });
  assert.deepEqual([audio.ok, audio.status], [false, 403], 'nor open the audio socket');

  assert.equal(access.table.admit(phone.device), true);
  const admitted = await phone.connect();
  assert.equal(admitted.pending, false);
  assert.equal((await fetchImage(access, phone)).status, 200);
});

test('A8 ask: Deny removes the device; it cannot flood the GM with requests straight away', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  access.table.setMode('ask');
  const phone = createPhone(access);
  await phone.join();
  const kinds = [];
  access.table.on('change', event => kinds.push(event.kind));
  assert.equal(access.table.deny(phone.device), true);
  assert.deepEqual(kinds, ['deny']);
  assert.equal(access.table.list().length, 0);
  assert.equal((await phone.hello()).status, 403, 'unknown now');
  const again = await phone.join({ nonce: randomHex(16) });
  assert.equal(again.status, 429);
});

test('A9 Kick: the key is deleted, reconnecting is refused, and the cookie no longer opens images', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  assert.equal((await phone.connect()).ok, true);
  assert.equal((await fetchImage(access, phone)).status, 200);
  const kinds = [];
  access.table.on('change', event => kinds.push(event));
  assert.equal(access.table.kick(phone.device), true);
  assert.deepEqual(kinds, [{ kind: 'kick', device: phone.device }]);
  assert.equal(access.internals.devices.find(phone.device).dk, null);
  const hello = await phone.hello();
  assert.deepEqual([hello.status, hello.json()], [403, { error: 'revoked' }]);
  // Even a request that replays an old valid nonce and proof is refused.
  const stale = phone.upgrade({ nonce: randomHex(16) });
  assert.equal(access.authenticateUpgrade(stale).ok, false);
  assert.equal((await fetchImage(access, phone)).status, 403);
  // The same device id cannot join again, even with a perfect proof.
  const rejoin = await phone.join({ nonce: randomHex(16) });
  assert.equal(rejoin.status, 403);
  assert.equal(access.table.list().length, 0);
  assert.equal(access.limiter.strikesOf(phone.ip), 0, 'a kicked phone retrying is not an attack');
});

test('A9 a refused reconnect of a kicked device carries the close code the hub can use', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  await phone.hello();
  const nonce = phone.lastNonce;
  access.table.kick(phone.device);
  const verdict = access.authenticateUpgrade(phone.upgrade({ nonce }));
  assert.deepEqual([verdict.ok, verdict.status, verdict.closeCode], [false, 403, CLOSE.KICKED]);
});

test('A10 Rotate: the old link and the old code fail for new devices, admitted devices keep working', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const member = createPhone(access, { ip: '192.168.1.50' });
  await member.join();
  const oldLink = access.table.invite().urlFor('x', 1).split('#join=')[1];
  const oldCode = access.table.invite().code;
  access.table.inviteShown();
  access.table.rotate();
  const newcomer = createPhone(access, { ip: '192.168.1.51' });
  assert.equal((await newcomer.join({ value: oldLink })).status, 403);
  assert.equal((await newcomer.join({ how: 'code', value: oldCode })).status, 403);
  assert.equal((await newcomer.join({ nonce: randomHex(16) })).status, 200, 'the new link works');
  assert.equal((await member.connect()).ok, true);
  assert.equal((await fetchImage(access, member)).status, 200);
});

test('A11 the 17th device and the 5th pending device are refused with "full"', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  for (let i = 0; i < LIMITS.maxAdmittedDevices; i++) assert.equal((await createPhone(access, { ip: `192.168.1.${100 + i}` }).join()).status, 200, `device ${i + 1}`);
  const last = await createPhone(access, { ip: '192.168.1.200' }).join();
  assert.deepEqual([last.status, last.json()], [403, { error: 'full' }]);

  const ask = table();
  t.after(ask.cleanup);
  ask.access.table.setMode('ask');
  for (let i = 0; i < LIMITS.maxPendingDevices; i++) assert.equal((await createPhone(ask.access, { ip: `192.168.1.${100 + i}` }).join()).json().status, 'pending');
  const fifth = await createPhone(ask.access, { ip: '192.168.1.150' }).join();
  assert.deepEqual([fifth.status, fifth.json()], [403, { error: 'full' }]);
});

test('A12 a captured WebSocket handshake replayed later is refused: the nonce is single-use', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  await phone.hello();
  const captured = () => phone.upgrade();
  assert.equal(access.authenticateUpgrade(captured()).ok, true);
  const replay = access.authenticateUpgrade(captured());
  assert.deepEqual([replay.ok, replay.status, replay.reason], [false, 401, 'nonce']);
  // Replaying it from the attacker's own address and Host does not help either.
  const elsewhere = access.authenticateUpgrade(phone.upgrade({ remote: '192.168.1.66' }));
  assert.equal(elsewhere.ok, false);
});

test('A12 a nonce is burnt even by a failed attempt, so one nonce cannot be used to try several proofs', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  await phone.hello();
  assert.equal(access.authenticateUpgrade(phone.upgrade({ proof: 'ab'.repeat(32) })).ok, false);
  const second = access.authenticateUpgrade(phone.upgrade());
  assert.deepEqual([second.ok, second.reason], [false, 'nonce']);
});

test('A12 a nonce issued for one device cannot be used by another', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const alice = createPhone(access, { ip: '192.168.1.50' });
  const bob = createPhone(access, { ip: '192.168.1.51' });
  await alice.join(); await bob.join();
  await alice.hello();
  const stolen = access.authenticateUpgrade(bob.upgrade({ nonce: alice.lastNonce, dk: bob.dk }));
  assert.deepEqual([stolen.ok, stolen.reason], [false, 'nonce']);
});

test('A13 a nonce expires after 15 seconds (fake clock) and not a moment before', async t => {
  const { access, clock, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  const hello = await phone.hello();
  assert.deepEqual(hello.json(), { nonce: phone.lastNonce, ttl: 15 });
  clock.advance(LIMITS.nonceTtlMs - 1);
  assert.equal(access.authenticateUpgrade(phone.upgrade()).ok, true);
  await phone.hello();
  clock.advance(LIMITS.nonceTtlMs);
  const late = access.authenticateUpgrade(phone.upgrade());
  assert.deepEqual([late.ok, late.reason, late.closeCode], [false, 'nonce', CLOSE.AUTH]);
  assert.equal(access.internals.handshake.liveNonces(), 0, 'expired nonces are swept');
});

test('hello: unknown devices and junk are refused, the rate is limited, and live nonces are capped', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  const stranger = await phone.hello();
  assert.deepEqual([stranger.status, stranger.json()], [403, { error: 'unknown-device' }]);
  for (const body of [{}, { device: 'x' }, { device: randomHex(16).toUpperCase() }, [], 'text', null, { device: 5 }]) {
    const res = await call(access, jsonPost('/__realm/hello', body, { ip: phone.ip, host: phone.host, origin: `http://${phone.host}` }));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  await phone.join();
  let granted = 0;
  let limited = 0;
  for (let i = 0; i < LIMITS.helloPerIpPerMin + 20; i++) (await phone.hello()).status === 200 ? granted++ : limited++;
  assert.ok(limited >= 20, `rate limited (${granted} granted)`);

  const crowded = table();
  t.after(crowded.cleanup);
  crowded.access.internals.store.data.limits.maxAdmittedDevices = 20;
  const phones = [];
  for (let i = 0; i < 17; i++) { const p = createPhone(crowded.access, { ip: `192.168.1.${100 + i}` }); await p.join(); phones.push(p); }
  for (const p of phones.slice(0, 16)) for (let i = 0; i < 16; i++) assert.equal((await p.hello()).status, 200);
  assert.equal(crowded.access.internals.handshake.liveNonces(), LIMITS.nonceMaxLive);
  assert.equal((await phones[16].hello()).status, 429, 'the table of live nonces is full');
});

test('hello: one address can hold only a few live nonces; the oldest is dropped', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  const nonces = [];
  for (let i = 0; i < 20; i++) { await phone.hello(); nonces.push(phone.lastNonce); }
  assert.equal(access.internals.handshake.liveNonces(), 16);
  assert.equal(access.authenticateUpgrade(phone.upgrade({ nonce: nonces[0] })).reason, 'nonce', 'the oldest is gone');
  assert.equal(access.authenticateUpgrade(phone.upgrade({ nonce: nonces[19] })).ok, true);
});

test('A14 a player\'s proof cannot open the GM role (LAN address, or loopback without the cookie)', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  await phone.hello();
  const asGm = access.authenticateUpgrade(phone.upgrade({ role: 'gm', proof: wsProof(phone.dk, phone.device, phone.lastNonce, 'gm') }));
  assert.deepEqual([asGm.ok, asGm.status, asGm.reason], [false, 403, 'gm']);
  const sameWithPlayerProof = access.authenticateUpgrade(phone.upgrade({ role: 'gm' }));
  assert.equal(sameWithPlayerProof.ok, false);
  await phone.hello();
  const onLoopback = access.authenticateUpgrade(phone.upgrade({ role: 'gm', remote: '127.0.0.1', hostHeader: GM_HOST, originHeader: `http://${GM_HOST}` }));
  assert.deepEqual([onLoopback.ok, onLoopback.reason], [false, 'gm'], 'loopback alone is not enough');
});

test('A14 a proof computed for the GM role does not open a player socket (the role is part of the proof)', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  await phone.hello();
  const verdict = access.authenticateUpgrade(phone.upgrade({ role: 'player', proof: wsProof(phone.dk, phone.device, phone.lastNonce, 'gm') }));
  assert.deepEqual([verdict.ok, verdict.status, verdict.reason], [false, 401, 'proof']);
});

test('A15 an upgrade without the auth.* sub-protocol is refused before any socket exists', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  await phone.hello();
  for (const protocols of ['rf3', 'rf3, auth.nope', 'rf3, auth.', '', undefined, `auth.${phone.device}.${phone.lastNonce}.${'0'.repeat(64)}`,
    `rf3, auth.${phone.device}.${phone.lastNonce}.${'A'.repeat(64)}`]) {
    const req = phone.upgrade({ protocols: protocols ?? undefined });
    if (protocols === undefined) delete req.headers['sec-websocket-protocol'];
    else req.headers['sec-websocket-protocol'] = protocols;
    const verdict = access.authenticateUpgrade(req);
    assert.equal(verdict.ok, false, String(protocols));
    assert.ok(verdict.status >= 400 && verdict.status < 500);
  }
});

test('an upgrade for the wrong path, without a role, or with a bad role is a 400', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  for (const options of [{ path: '/__realm/elsewhere' }, { path: '/session-sync' }, { role: 'admin' }, { role: '' }]) {
    await phone.hello();
    const req = phone.upgrade(options.role === 'admin' || options.role === '' ? { path: '/__realm/ws' } : options);
    if ('role' in options) req.url = `/__realm/ws?role=${options.role}`;
    assert.equal(access.authenticateUpgrade(req).status, 400, JSON.stringify(options));
  }
  await phone.hello();
  const noRole = phone.upgrade();
  noRole.url = '/__realm/ws';
  assert.equal(access.authenticateUpgrade(noRole).status, 400);
});

test('A16 table.json survives a restart: the device reconnects without the invite; a corrupt file gives a fresh table and a log line', async t => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const first = table({ dataDir: dir.dir });
  const phone = createPhone(first.access);
  await phone.join();
  assert.equal((await phone.connect()).ok, true);
  const oldLink = first.access.table.invite().urlFor('x', 1);
  first.access.close();

  const second = table({ dataDir: dir.dir });
  t.after(second.cleanup);
  assert.equal(second.access.table.invite().urlFor('x', 1), oldLink, 'the invite is the same');
  const back = await phone.connect();
  assert.equal(back.ok, true, 'a restarted server still knows the device');
  assert.equal(back.device, phone.device);
  assert.equal((await fetchImage(second.access, phone)).status, 200, 'the cookie is still valid after a restart');
  second.access.close();

  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir.dir, 'table.json'), '{"version": 1, "serverSecret": ');
  const third = table({ dataDir: dir.dir });
  t.after(third.cleanup);
  assert.match(third.access.metrics.logTail().join('\n'), /table\.json could not be read/);
  assert.equal(third.access.table.list().length, 0);
  await phone.hello();
  assert.equal(third.access.authenticateUpgrade(phone.upgrade()).ok, false, 'everyone must join again');
});

test('a replayed identical join is idempotent: same answer, one device, still counted against the join limit', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  const nonce = randomHex(16);
  const first = await phone.join({ nonce });
  const second = await phone.join({ nonce });
  assert.deepEqual(second.json(), first.json());
  assert.equal(access.table.list().length, 1);
  const dk = deriveDk(phone.lastJoin.key, phone.device, nonce, first.json().srv);
  assert.equal(access.internals.devices.find(phone.device).dk, dk, 'the stored key is still the one the phone derived');
  for (let i = 0; i < 20; i++) await phone.join({ nonce });
  assert.equal((await phone.join({ nonce })).status, 429);
});

test('whoever knows the invite cannot replace the key of a device that already exists', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const victim = createPhone(access, { ip: '192.168.1.50' });
  await victim.join();
  const before = access.internals.devices.find(victim.device).dk;
  const attacker = createPhone(access, { ip: '192.168.1.66', device: victim.device });
  const res = await attacker.join({ nonce: randomHex(16) });
  assert.equal(res.status, 403);
  assert.equal(access.internals.devices.find(victim.device).dk, before);
  assert.equal((await victim.connect()).ok, true);
  assert.equal(access.limiter.strikesOf('192.168.1.66'), 1);
});

test('join rejects a wrong protocol version, malformed ids and a non-object body without throwing', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  assert.equal((await phone.join({ version: 2 })).status, 400);
  assert.equal((await phone.join({ device: 'not-hex', proof: 'f'.repeat(64) })).status, 400);
  assert.equal((await phone.join({ nonce: 'abc', proof: 'f'.repeat(64) })).status, 400);
  assert.equal((await phone.join({ how: 'telepathy' })).status, 400);
  for (const body of ['[]', '"x"', 'null', '7', '{', '']) {
    const res = await call(access, { method: 'POST', url: '/__realm/join', body, headers: { 'content-type': 'application/json' }, ip: phone.ip, host: phone.host, origin: `http://${phone.host}` });
    assert.equal(res.status, 400, body);
  }
  assert.equal(access.table.list().length, 0);
});

test('the name is cleaned and capped; the label comes from the User-Agent, not from the client', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access, { name: `  ‮Robin\u0000 ${'x'.repeat(100)}`, agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' });
  await phone.join();
  const [entry] = access.table.list();
  assert.ok(entry.name.startsWith('Robin xxx'));
  assert.ok(Array.from(entry.name).length <= LIMITS.nameMax);
  assert.ok(!/[‮\u0000]/.test(entry.name));
  assert.equal(entry.label, 'iPhone / iPad · Safari');
});

// ---- B: the GM role ------------------------------------------------------------------------------------------------------

test('B1..B4 the GM upgrade needs loopback AND a localhost Host AND the same Origin AND the rf-gm cookie', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const { cookie } = await gmLogin(access);
  assert.match(cookie, /^rf-gm=[0-9a-f]{64}$/);
  const ok = access.authenticateUpgrade(gmUpgrade({ cookie }));
  assert.deepEqual([ok.ok, ok.role, ok.device, ok.pending, ok.protocol], [true, 'gm', 'gm', false, 'rf3']);

  // B1 not from this computer (even with a valid cookie that somehow got there)
  const lan = access.authenticateUpgrade(gmUpgrade({ cookie, ip: '192.168.1.50', host: '192.168.1.10:5173', origin: 'http://192.168.1.10:5173' }));
  assert.deepEqual([lan.ok, lan.status, lan.reason], [false, 403, 'gm']);
  assert.equal(access.limiter.strikesOf('192.168.1.50'), 1, 'trying the GM role from the LAN is a strike');
  // B2 DNS rebinding: loopback peer, evil Host, matching Origin, valid cookie
  const rebinding = access.authenticateUpgrade(gmUpgrade({ cookie, host: 'evil.test:5173', origin: 'http://evil.test:5173' }));
  assert.deepEqual([rebinding.ok, rebinding.status, rebinding.reason], [false, 421, 'host']);
  // ... and the machine's own LAN name or address is not a GM host either
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, host: '192.168.1.10:5173', origin: 'http://192.168.1.10:5173' })).ok, false);
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, host: 'GM-PC:5173', origin: 'http://GM-PC:5173' })).ok, false);
  // B3 no cookie, wrong cookie, another cookie name
  for (const bad of [undefined, 'rf-gm=', `rf-gm=${'0'.repeat(64)}`, `rf-gm=${cookie.slice(6, -1)}`, `other=${cookie.slice(6)}`, `rf-gm=${cookie.slice(6)}x`]) {
    assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie: bad })).ok, false, String(bad));
  }
  // B4 foreign Origin, and no Origin
  for (const origin of ['http://evil.test:5173', 'https://localhost:5173', 'null', 'http://localhost:5174', null]) {
    const res = access.authenticateUpgrade(gmUpgrade({ cookie, origin }));
    assert.equal(res.ok, false, String(origin));
    assert.equal(res.status, 403);
  }
  // 127.0.0.1 and [::1] are GM hosts as well
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' })).ok, true);
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, ip: '::1', host: '[::1]:5173', origin: 'http://[::1]:5173' })).ok, true);
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, ip: '::ffff:127.0.0.1' })).ok, true);
});

test('the GM needs no auth token and does not send one; a stray one is not consulted', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const { cookie } = await gmLogin(access);
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, protocols: 'rf3' })).ok, true);
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, protocols: `rf3, auth.${'0'.repeat(32)}.${'0'.repeat(32)}.${'0'.repeat(64)}` })).ok, true);
  assert.equal(access.authenticateUpgrade(gmUpgrade({ cookie, protocols: 'other' })).ok, false, 'rf3 must be offered');
});

test('the rf-gm cookie is a session cookie that is HttpOnly and SameSite=Strict, set only for the GM computer', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const { res } = await gmLogin(access);
  const header = res.headers['set-cookie'];
  assert.match(header, /^rf-gm=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.ok(!/Max-Age|Expires|Secure|Domain/i.test(header), 'dies with the browser session');
  const lan = await call(access, { ip: '192.168.1.50', host: '192.168.1.10:5173', url: '/' });
  assert.equal(lan.headers['set-cookie'], undefined);
  assert.equal(lan.status, 302);
  const again = await gmLogin(access);
  assert.equal(again.cookie, (await gmLogin(access)).cookie, 'the token is stable for the life of the process');
});

test('socketOpened/socketClosed apply the per-address and total caps; authenticateUpgrade peeks without claiming a slot', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access);
  await phone.join();
  for (let i = 0; i < LIMITS.maxSocketsPerIp; i++) assert.equal(access.socketOpened(phone.ip), true);
  const refused = await phone.connect();
  assert.deepEqual([refused.ok, refused.status, refused.reason], [false, 429, 'ip-cap']);
  access.socketClosed(phone.ip);
  assert.equal((await phone.connect()).ok, true);
  assert.equal(access.socketOpened(phone.ip), true);
  assert.equal(access.socketOpened(phone.ip), false);
  assert.equal(access.metrics.snapshot().rejects['ip-cap'], 2);
});

test('strike() reports a ban; the hub\'s "closed for abuse" call (10 points) bans for 30 s, not 5 minutes', async t => {
  const { access, clock, cleanup } = table();
  t.after(cleanup);
  assert.equal(access.strike('192.168.1.70', 1), false);
  assert.equal(access.strike('192.168.1.71', LIMITS.strikesToClose), true);
  assert.equal(access.banned('192.168.1.71'), true);
  clock.advance(LIMITS.strikeBanMs + 1);
  assert.equal(access.banned('192.168.1.71'), false);
  assert.equal(access.strike('127.0.0.1', LIMITS.strikesToClose), false, 'the GM computer is never banned');
  access.ban('192.168.1.72', 1000);
  assert.equal(access.authenticateUpgrade(createPhone(access, { ip: '192.168.1.72' }).upgrade()).reason, 'banned');
});

test('a banned address is refused at hello, join and upgrade with the generic answers', async t => {
  const { access, cleanup } = table();
  t.after(cleanup);
  const phone = createPhone(access, { ip: '192.168.1.80' });
  await phone.join();
  access.ban(phone.ip, 60_000);
  assert.deepEqual((await phone.hello()).json(), { error: 'banned' });
  assert.deepEqual((await phone.join({ nonce: randomHex(16) })).json(), { error: 'banned' });
  assert.equal(access.authenticateUpgrade(phone.upgrade({ nonce: randomHex(16) })).status, 403);
});
