import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  hmac, randomHex, safeEqualHex, joinProof, srvProof, wsProof, deriveDk, normalizeCode, inviteKey,
  randomSecret, randomCode, isInviteSecret, cookieMac, playerIdOf,
} from '../src/net/hmac.js';
import { CODE_ALPHABET } from '../src/net/protocol.js';

const reference = (key, ...parts) => {
  const message = Buffer.concat(parts.flatMap((part, i) => (i ? [Buffer.from([0]), Buffer.from(part)] : [Buffer.from(part)])));
  return createHmac('sha256', Buffer.from(key)).update(message).digest('hex');
};

test('hmac matches node:crypto for 1,000 random keys and messages (NUL bytes, empty and long keys included)', () => {
  for (let i = 0; i < 1000; i++) {
    const key = randomBytes(Math.floor(Math.random() * 200));
    const data = randomBytes(Math.floor(Math.random() * 300));
    assert.equal(hmac(new Uint8Array(key), new Uint8Array(data)), createHmac('sha256', key).update(data).digest('hex'), `case ${i}`);
  }
});

test('hmac joins string parts with a single NUL and encodes strings as UTF-8', () => {
  for (let i = 0; i < 200; i++) {
    const parts = Array.from({ length: 1 + (i % 5) }, () => randomBytes(1 + Math.floor(Math.random() * 20)).toString('base64'));
    assert.equal(hmac('key-' + i, ...parts), reference('key-' + i, ...parts));
  }
  assert.equal(hmac('clé', 'héllo ✓ \u{1F600}', 'x'), reference('clé', 'héllo ✓ \u{1F600}', 'x'));
  assert.equal(hmac('k'), reference('k', ''), 'no parts equals one empty part');
  assert.equal(hmac('k', 'a', new Uint8Array([98])), reference('k', 'a', 'b'), 'mixed string and byte parts');
});

test('hmac refuses ambiguous or wrongly typed input', () => {
  assert.throws(() => hmac('k', 'a\0b'), TypeError);
  assert.throws(() => hmac('k', 42), TypeError);
  assert.throws(() => hmac(null, 'a'), TypeError);
  assert.notEqual(hmac('k', 'a', 'bc'), hmac('k', 'ab', 'c'), 'part boundaries matter');
});

test('hmac: RFC 4231 test vectors for HMAC-SHA-256', () => {
  const ascii = text => new TextEncoder().encode(text);
  const fill = (n, byte) => new Uint8Array(n).fill(byte);
  const vectors = [
    ['1', fill(20, 0x0b), ascii('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    ['2', ascii('Jefe'), ascii('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    ['3', fill(20, 0xaa), fill(50, 0xdd), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
    ['4', Uint8Array.from({ length: 25 }, (_, i) => i + 1), fill(50, 0xcd), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
    ['6', fill(131, 0xaa), ascii('Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
    ['7', fill(131, 0xaa),
      ascii('This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'),
      '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2'],
  ];
  for (const [name, key, data, expected] of vectors) assert.equal(hmac(key, data), expected, `RFC 4231 test case ${name}`);
  // test case 5 is a truncated (128-bit) output
  assert.equal(hmac(fill(20, 0x0c), ascii('Test With Truncation')).slice(0, 32), 'a3b6167473100ee06e0c796c2955552b');
});

test('hmac.js and protocol.js import nothing from Node and do not need crypto.subtle', () => {
  for (const file of ['../src/net/hmac.js', '../src/net/protocol.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"]node:|require\(|from\s+['"](fs|path|crypto|os|buffer)['"]/);
    assert.doesNotMatch(source, /\bBuffer\b/);
    assert.doesNotMatch(source, /crypto\.subtle\./);
  }
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  try {
    assert.equal(globalThis.crypto.subtle, undefined);
    assert.equal(hmac('k', 'm'), reference('k', 'm'));
    assert.equal(randomHex(8).length, 16);
    assert.equal(randomCode().length, 8);
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, 'subtle', original); else delete globalThis.crypto.subtle;
  }
});

test('randomHex: length, alphabet, bounds and no repeats', () => {
  assert.match(randomHex(16), /^[0-9a-f]{32}$/);
  assert.equal(randomHex(1).length, 2);
  assert.equal(randomHex(65536).length, 131072);
  assert.throws(() => randomHex(0), RangeError);
  assert.throws(() => randomHex(1.5), RangeError);
  assert.throws(() => randomHex(65537), RangeError);
  assert.throws(() => randomHex('16'), RangeError);
  const seen = new Set(Array.from({ length: 500 }, () => randomHex(16)));
  assert.equal(seen.size, 500);
});

test('safeEqualHex: equal, unequal, different lengths, wrong types', () => {
  assert.equal(safeEqualHex('abcdef', 'abcdef'), true);
  assert.equal(safeEqualHex('abcdef', 'abcdee'), false);
  assert.equal(safeEqualHex('abcdef', 'bbcdef'), false);
  assert.equal(safeEqualHex('abcdef', 'abcde'), false);
  assert.equal(safeEqualHex('abcde', 'abcdef'), false);
  assert.equal(safeEqualHex('', ''), true);
  assert.equal(safeEqualHex('', 'a'), false);
  assert.equal(safeEqualHex(null, null), false);
  assert.equal(safeEqualHex(undefined, 'a'), false);
  assert.equal(safeEqualHex(['a'], ['a']), false);
  assert.equal(safeEqualHex('a'.repeat(64), 'a'.repeat(63) + '\0'), false);
});

test('safeEqualHex has no early exit: the loop reads every position whatever differs', () => {
  // Structural check (timing on a shared CPU is too noisy): no return or break may sit inside the loop.
  const source = readFileSync(new URL('../src/net/hmac.js', import.meta.url), 'utf8');
  const start = source.indexOf('export const safeEqualHex');
  const body = source.slice(start, source.indexOf('// ----', start));
  const loop = body.slice(body.indexOf('for ('));
  assert.doesNotMatch(loop.slice(0, loop.indexOf('return diff')), /return|break/);
  const a = 'a'.repeat(64);
  assert.equal(safeEqualHex(a, 'b' + a.slice(1)), false);
  assert.equal(safeEqualHex(a, a.slice(0, 63) + 'b'), false);
});

test('normalizeCode: case, dashes, spaces; rejects ambiguous letters and wrong lengths', () => {
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeCode(' ab cd\tef-gh '), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCD–EFGH'), 'ABCDEFGH', 'en dash');
  assert.equal(normalizeCode('a2b3-c4d5'), 'A2B3C4D5');
  assert.equal(normalizeCode('ABCDEFG'), null, 'too short');
  assert.equal(normalizeCode('ABCDEFGHJ'), null, 'too long');
  assert.equal(normalizeCode(''), null);
  // O, I, L, 0, 1 are not in the alphabet and are NOT mapped to look-alikes.
  for (const bad of ['ABCDEFG0', 'ABCDEFG1', 'ABCDEFGO', 'ABCDEFGI', 'ABCDEFGL', 'abcdefgo']) assert.equal(normalizeCode(bad), null, bad);
  assert.equal(normalizeCode('ＡBCDEFGH'), null, 'full-width A is not folded');
  assert.equal(normalizeCode('ſBCDEFGH'), null, 'long s is not folded to S');
  assert.equal(normalizeCode('ıBCDEFGH'), null, 'dotless i is not folded to I');
  for (const junk of [null, undefined, 12345678, {}, ['ABCDEFGH'], 'A'.repeat(100000)]) assert.equal(normalizeCode(junk), null);
});

test('randomCode: 8 characters of the alphabet, roughly uniform, no ambiguous characters', () => {
  const counts = new Map();
  for (let i = 0; i < 4000; i++) {
    const code = randomCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
    assert.equal(normalizeCode(code), code);
    for (const char of code) counts.set(char, (counts.get(char) || 0) + 1);
  }
  assert.equal(CODE_ALPHABET.length, 31);
  assert.equal(counts.size, 31, 'every symbol shows up');
  const expected = (4000 * 8) / 31;
  for (const [char, count] of counts) assert.ok(count > expected * 0.8 && count < expected * 1.2, `${char}: ${count} vs ${expected}`);
});

test('invite secrets and keys', () => {
  const secret = randomSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(isInviteSecret(secret), true);
  assert.equal(isInviteSecret(secret + 'A'), false);
  assert.equal(isInviteSecret('a'.repeat(21) + '+'), false);
  assert.equal(inviteKey('link', secret), secret);
  assert.equal(inviteKey('link', 'short'), null);
  assert.equal(inviteKey('code', 'abcd-efgh'), 'code:ABCDEFGH');
  assert.equal(inviteKey('code', 'ABCDEFG0'), null);
  assert.equal(inviteKey('other', secret), null);
});

test('formulas equal the written definitions of design 4.3 (checked against node:crypto)', () => {
  const key = randomSecret();
  const device = randomHex(16), nonce = randomHex(16), srv = randomHex(16);
  assert.equal(joinProof(key, device, nonce), createHmac('sha256', key).update(`rf3-join\0${device}\0${nonce}`).digest('hex'));
  assert.equal(srvProof(key, device, nonce, srv), createHmac('sha256', key).update(`rf3-srv\0${device}\0${nonce}\0${srv}`).digest('hex'));
  const dk = deriveDk(key, device, nonce, srv);
  assert.equal(dk, createHmac('sha256', key).update(`rf3-dk\0${device}\0${nonce}\0${srv}`).digest('hex'));
  assert.match(dk, /^[0-9a-f]{64}$/);
  assert.equal(wsProof(dk, device, nonce, 'player'), createHmac('sha256', dk).update(`rf3-ws\0${device}\0${nonce}\0player`).digest('hex'));
  const serverSecret = randomHex(32);
  assert.equal(cookieMac(serverSecret, device), createHmac('sha256', serverSecret).update(`cookie\0${device}`).digest('hex').slice(0, 32));
  assert.equal(playerIdOf(serverSecret, device), createHmac('sha256', serverSecret).update(`pid\0${device}`).digest('hex').slice(0, 24));
});

test('proofs differ per role, device, nonce, srv, key and label', () => {
  const key = randomSecret();
  const d1 = randomHex(16), d2 = randomHex(16), n1 = randomHex(16), n2 = randomHex(16), s1 = randomHex(16), s2 = randomHex(16);
  const dk = deriveDk(key, d1, n1, s1);
  const all = new Set([
    wsProof(dk, d1, n1, 'player'), wsProof(dk, d1, n1, 'gm'), wsProof(dk, d2, n1, 'player'), wsProof(dk, d1, n2, 'player'),
    wsProof(deriveDk(key, d1, n1, s2), d1, n1, 'player'),
    joinProof(key, d1, n1), joinProof(key, d2, n1), joinProof(key, d1, n2), joinProof(randomSecret(), d1, n1),
    srvProof(key, d1, n1, s1), srvProof(key, d1, n1, s2), srvProof(key, d1, n2, s1),
    dk, deriveDk(key, d1, n1, s2), deriveDk(key, d2, n1, s1), deriveDk(key, d1, n2, s1),
  ]);
  assert.equal(all.size, 16, 'sixteen different inputs give sixteen different outputs');
  // The labels separate join / srv / dk even though the inputs overlap.
  assert.notEqual(srvProof(key, d1, n1, s1), deriveDk(key, d1, n1, s1));
  assert.notEqual(joinProof(key, d1, n1), srvProof(key, d1, n1, n1));
  // The code path and the link path never produce the same proof.
  assert.notEqual(joinProof(inviteKey('code', 'ABCDEFGH'), d1, n1), joinProof(key, d1, n1));
});

test('formulas refuse malformed identifiers instead of hashing something ambiguous', () => {
  const d = randomHex(16), n = randomHex(16), s = randomHex(16), key = randomSecret(), dk = randomHex(32);
  assert.throws(() => joinProof(key, 'zz', n), TypeError);
  assert.throws(() => joinProof(key, d.toUpperCase(), n), TypeError);
  assert.throws(() => joinProof(key, d, n + '\0'), TypeError);
  assert.throws(() => joinProof('', d, n), TypeError);
  assert.throws(() => joinProof(null, d, n), TypeError);
  assert.throws(() => srvProof(key, d, n, 'x'), TypeError);
  assert.throws(() => deriveDk(key, d, n, s.slice(2)), TypeError);
  assert.throws(() => wsProof(dk, d, n, 'admin'), TypeError);
  assert.throws(() => wsProof(dk, d, n, 'player\0gm'), TypeError);
  assert.throws(() => wsProof(dk.slice(2), d, n, 'player'), TypeError);
  assert.throws(() => cookieMac(randomHex(32), 'nope'), TypeError);
});

test('a complete join handshake: both sides derive the same dk, a wrong key does not', () => {
  const device = randomHex(16), nonce = randomHex(16), srv = randomHex(16);
  const secret = randomSecret();
  const clientProof = joinProof(inviteKey('link', secret), device, nonce);
  assert.ok(safeEqualHex(clientProof, joinProof(secret, device, nonce)));
  const serverSays = srvProof(secret, device, nonce, srv);
  assert.ok(safeEqualHex(serverSays, srvProof(inviteKey('link', secret), device, nonce, srv)));
  const clientDk = deriveDk(secret, device, nonce, srv);
  const serverDk = deriveDk(secret, device, nonce, srv);
  assert.equal(clientDk, serverDk);
  assert.equal(safeEqualHex(wsProof(clientDk, device, nonce, 'player'), wsProof(serverDk, device, nonce, 'player')), true);
  assert.equal(safeEqualHex(joinProof(randomSecret(), device, nonce), clientProof), false);
  assert.equal(safeEqualHex(srvProof(randomSecret(), device, nonce, srv), serverSays), false);
});
