import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/net/protocol.js';
import { inviteKey, joinProof, randomHex } from '../src/net/hmac.js';
import { createFakeClock } from '../server/net/clock.js';
import { createInvite } from '../server/net/invite.js';
import { createTableStore } from '../server/net/tableStore.js';
import { tempDir } from '../test-support/wp2-fixtures.js';
import { join } from 'node:path';

function setup(file = null) {
  const clock = createFakeClock();
  const store = createTableStore({ file, clock });
  const invite = createInvite({ store, clock });
  const proofFor = (how, device, nonce, value) => joinProof(inviteKey(how, value), device, nonce);
  return { clock, store, invite, proofFor };
}

test('A3 the link proof is accepted and the result carries the key that srvProof and dk use', () => {
  const { invite, store, proofFor } = setup();
  const device = randomHex(16);
  const nonce = randomHex(16);
  const verdict = invite.verify('link', device, nonce, proofFor('link', device, nonce, store.data.invite.secret));
  assert.deepEqual(verdict, { ok: true, key: store.data.invite.secret });
});

test('A2 wrong, empty, malformed and cross-path proofs are all just "bad-proof"', () => {
  const { invite, store, proofFor } = setup();
  invite.markShown();
  const device = randomHex(16);
  const nonce = randomHex(16);
  const good = proofFor('link', device, nonce, store.data.invite.secret);
  for (const proof of ['', undefined, null, 'f'.repeat(64), good.toUpperCase(), good.slice(0, 63), `${good}0`,
    proofFor('link', device, randomHex(16), store.data.invite.secret), proofFor('link', randomHex(16), nonce, store.data.invite.secret),
    proofFor('code', device, nonce, store.data.invite.code)]) {
    assert.deepEqual(invite.verify('link', device, nonce, proof), { ok: false, reason: 'bad-proof' }, String(proof).slice(0, 12));
  }
  assert.deepEqual(invite.verify('nonsense', device, nonce, good), { ok: false, reason: 'bad-proof' });
});

test('A5 the typed code needs a fresh invite: unusable until the GM has looked, then valid for ten minutes (fake clock)', () => {
  const { invite, store, proofFor, clock } = setup();
  const device = randomHex(16);
  const nonce = randomHex(16);
  const proof = proofFor('code', device, nonce, store.data.invite.code);
  assert.deepEqual(invite.verify('code', device, nonce, proof), { ok: false, reason: 'stale-code' }, 'nobody has opened the dialog yet');
  invite.markShown();
  assert.equal(invite.verify('code', device, nonce, proof).ok, true);
  assert.equal(invite.verify('code', device, nonce, proof.replace(/.$/, c => (c === 'a' ? 'b' : 'a'))).reason, 'bad-proof');
  clock.advance(LIMITS.codeFreshAfterCloseMs - 1);
  assert.equal(invite.verify('code', device, nonce, proof).ok, true);
  clock.advance(2);
  assert.equal(invite.verify('code', device, nonce, proof).reason, 'stale-code');
  invite.markShown();
  assert.equal(invite.verify('code', device, nonce, proof).ok, true, 'looking again extends it');
});

test('the typed code is forgiving about case, spaces and the dash', () => {
  const { invite, store, proofFor } = setup();
  invite.markShown();
  const code = store.data.invite.code;
  const device = randomHex(16);
  const nonce = randomHex(16);
  const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase().replace('-', ' - ');
  assert.equal(invite.verify('code', device, nonce, proofFor('code', device, nonce, typed)).ok, true);
});

test('the link path has no expiry', () => {
  const { invite, store, proofFor, clock } = setup();
  clock.advance(30 * 24 * 3600 * 1000);
  const device = randomHex(16);
  const nonce = randomHex(16);
  assert.equal(invite.verify('link', device, nonce, proofFor('link', device, nonce, store.data.invite.secret)).ok, true);
});

test('A10 rotate kills the old secret and the old code, and the new ones work at once', () => {
  const { invite, store, proofFor } = setup();
  invite.markShown();
  const oldSecret = store.data.invite.secret;
  const oldCode = store.data.invite.code;
  const device = randomHex(16);
  const nonce = randomHex(16);
  invite.rotate();
  assert.notEqual(store.data.invite.secret, oldSecret);
  assert.notEqual(store.data.invite.code, oldCode);
  assert.equal(invite.verify('link', device, nonce, proofFor('link', device, nonce, oldSecret)).ok, false);
  assert.equal(invite.verify('code', device, nonce, proofFor('code', device, nonce, oldCode)).ok, false);
  assert.equal(invite.verify('link', device, nonce, proofFor('link', device, nonce, store.data.invite.secret)).ok, true);
  assert.equal(invite.verify('code', device, nonce, proofFor('code', device, nonce, store.data.invite.code)).ok, true, 'the GM is looking at the dialog while rotating');
});

test('rotateCode changes only the code, and the new code is unusable until the GM looks again', () => {
  const { invite, store, proofFor } = setup();
  invite.markShown();
  const secret = store.data.invite.secret;
  const oldCode = store.data.invite.code;
  invite.rotateCode();
  const device = randomHex(16);
  const nonce = randomHex(16);
  assert.equal(store.data.invite.secret, secret);
  assert.notEqual(store.data.invite.code, oldCode);
  assert.equal(invite.verify('link', device, nonce, proofFor('link', device, nonce, secret)).ok, true);
  assert.equal(invite.verify('code', device, nonce, proofFor('code', device, nonce, store.data.invite.code)).reason, 'stale-code');
});

test('urlFor puts the secret in the fragment, which a browser never sends to the server', () => {
  const { invite, store } = setup();
  const url = invite.urlFor('192.168.1.10', 5173);
  assert.equal(url, `http://192.168.1.10:5173/player.html#join=${store.data.invite.secret}`);
  assert.ok(!new URL(url).pathname.includes(store.data.invite.secret));
  assert.ok(!new URL(url).search.includes(store.data.invite.secret));
});

test('the invite is persisted; freshness is not (a restart needs the dialog to be opened again)', t => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const first = setup(join(dir, 'table.json'));
  first.invite.markShown();
  const second = setup(join(dir, 'table.json'));
  assert.equal(second.store.data.invite.secret, first.store.data.invite.secret);
  assert.equal(second.invite.codeFresh(), false);
  first.invite.rotate();
  const third = setup(join(dir, 'table.json'));
  assert.equal(third.store.data.invite.code, first.store.data.invite.code, 'rotation was saved');
});
