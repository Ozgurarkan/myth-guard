import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as protocol from '../src/net/protocol.js';
import { wsProof, deriveDk, randomHex } from '../src/net/hmac.js';

const {
  PROTOCOL_VERSION, PATHS, CLOSE, LIMITS, PLAYER_TYPES, GM_TYPES, SERVER_TO_PLAYER, SERVER_TO_GM, TYPE_CAPS, SUBPROTOCOL,
  authProtocol, parseAuthProtocol, cleanName, isId, fnv1a, isHex,
} = protocol;

const SETS = { PLAYER_TYPES, GM_TYPES, SERVER_TO_PLAYER, SERVER_TO_GM };
const everyType = new Set([...PLAYER_TYPES, ...GM_TYPES, ...SERVER_TO_PLAYER, ...SERVER_TO_GM]);
const overlap = (a, b) => [...a].filter(type => b.has(type)).sort();

test('constants match design 4.2', () => {
  assert.equal(PROTOCOL_VERSION, 3);
  assert.equal(SUBPROTOCOL, 'rf3');
  assert.deepEqual({ ...PATHS }, {
    ws: '/__realm/ws', audioWs: '/__realm/audio', hello: '/__realm/hello', join: '/__realm/join', info: '/__realm/info',
    status: '/__realm/status', diag: '/__realm/diag', assets: '/__realm/assets/',
  });
  assert.equal(CLOSE.REPLACED, 4001);
  assert.equal(CLOSE.KICKED, 4002);
  assert.equal(CLOSE.NOT_ADMITTED, 4003);
  assert.equal(CLOSE.TOO_OLD, 4004);
  assert.equal(CLOSE.ABUSE, 4008);
  assert.equal(CLOSE.SLOW, 4009);
  assert.equal(CLOSE.SHUTDOWN, 4010);
  assert.equal(CLOSE.AUTH, 4011);
  assert.equal(CLOSE.UNSUPPORTED_DATA, 1003);
  assert.equal(CLOSE.TOO_BIG, 1009);
  assert.equal(new Set(Object.values(CLOSE)).size, Object.keys(CLOSE).length, 'close codes are unique');
  assert.equal(LIMITS.maxSocketsPerIp, 8);
  assert.equal(LIMITS.playerMaxPayload, 16384);
  assert.equal(LIMITS.gmMaxPayload, 8 * 1024 * 1024);
  assert.equal(LIMITS.patchHistory, 64);
  assert.equal(LIMITS.banMs, 300000);
  assert.equal(LIMITS.nonceTtlMs, 15000);
  assert.ok(LIMITS.silenceMs > LIMITS.heartbeatMs && LIMITS.serverDeadMs > LIMITS.serverPingMs);
  assert.ok(LIMITS.backlogResumeBytes < LIMITS.backlogStopBytes);
});

test('constants are deeply frozen', () => {
  for (const object of [PATHS, CLOSE, LIMITS, TYPE_CAPS, TYPE_CAPS.PING]) {
    assert.ok(Object.isFrozen(object));
    assert.throws(() => { 'use strict'; object.extra = 1; }, TypeError);
  }
  assert.throws(() => { 'use strict'; LIMITS.maxSocketsPerIp = 1000; }, TypeError);
  assert.throws(() => { 'use strict'; TYPE_CAPS.PING.max = 1e9; }, TypeError);
  assert.equal(LIMITS.maxSocketsPerIp, 8);
});

test('the four message Sets are frozen: add, delete and clear throw and change nothing', () => {
  for (const [name, set] of Object.entries(SETS)) {
    assert.ok(Object.isFrozen(set), name);
    const before = set.size;
    assert.throws(() => set.add('EVIL'), TypeError, name);
    assert.throws(() => set.delete([...set][0]), TypeError, name);
    assert.throws(() => set.clear(), TypeError, name);
    assert.equal(set.size, before);
    assert.equal(set.has('EVIL'), false);
    for (const type of set) assert.match(type, /^[A-Z][A-Z_]+$/, `${name}: ${type} looks like a type name`);
  }
  for (const name of ['ROLES', 'ADMISSION_MODES', 'TABLE_OPS', 'ACK_REASONS']) assert.ok(Object.isFrozen(protocol[name]), name);
});

test('catalogue: every v2 type the app uses today is present in the right direction', () => {
  // read from src/broadcast.js and server/sessionSync.js
  for (const type of ['PLAYER_NAME', 'PLAYER_TOKEN_MOVE', 'PLAYER_TOKEN_LIVE', 'PLAYER_PING', 'PLAYER_END_TURN', 'REQUEST_FULL_STATE', 'RESYNC', 'PING']) {
    assert.ok(PLAYER_TYPES.has(type), `player -> server ${type}`);
  }
  for (const type of ['SCENE', 'PING']) assert.ok(GM_TYPES.has(type), `GM -> server ${type}`);
  for (const type of ['HELLO', 'PLAYER_ID', 'GM_STATUS', 'STATE_FULL', 'STATE_PATCH', 'MAP_PING', 'MOVE_REJECTED', 'TURN_REJECTED', 'PONG']) {
    assert.ok(SERVER_TO_PLAYER.has(type), `server -> player ${type}`);
  }
  for (const type of ['HELLO', 'REQUEST_FULL_STATE', 'PLAYER_ROSTER', 'PLAYER_TOKEN_MOVE', 'PLAYER_END_TURN', 'MAP_PING', 'PONG']) {
    assert.ok(SERVER_TO_GM.has(type), `server -> GM ${type}`);
  }
});

test('catalogue: every type named in design 4.6 is present', () => {
  const player = 'PING RESUME RESYNC REQUEST_FULL_STATE PLAYER_NAME PLAYER_TOKEN_MOVE PLAYER_PING PLAYER_END_TURN AUDIO_LISTEN AUDIO_ANSWER AUDIO_STATS';
  const gm = 'PING RESUME SCENE AUDIO_OFFER AUDIO_CONTROLS AUDIO_STATUS AUDIO_SELECT AUDIO_FALLBACK AUDIO_STOP TABLE_CMD';
  const toPlayer = 'HELLO STATE_FULL STATE_PATCH GM_STATUS MAP_PING ACK PONG AUDIO_OFFER AUDIO_CONTROLS AUDIO_STATUS AUDIO_FALLBACK AUDIO_STOP KICKED TABLE_LOCKED WAIT ADMITTED DENIED';
  const toGm = 'HELLO REQUEST_FULL_STATE PLAYER_ROSTER JOIN_REQUEST TABLE PLAYER_TOKEN_MOVE PLAYER_END_TURN MAP_PING AUDIO_LISTENER AUDIO_ANSWER AUDIO_STATS';
  for (const type of player.split(' ')) assert.ok(PLAYER_TYPES.has(type), type);
  for (const type of gm.split(' ')) assert.ok(GM_TYPES.has(type), type);
  for (const type of toPlayer.split(' ')) assert.ok(SERVER_TO_PLAYER.has(type), type);
  for (const type of toGm.split(' ')) assert.ok(SERVER_TO_GM.has(type), type);
});

test('catalogue: sets are disjoint where they must be', () => {
  // A player must never be able to send a GM-only command, or pretend to be the server.
  for (const type of ['SCENE', 'TABLE_CMD', 'GM_TOKEN_LIVE', 'AUDIO_OFFER', 'AUDIO_SELECT', 'AUDIO_CONTROLS', 'AUDIO_STATUS', 'AUDIO_FALLBACK', 'AUDIO_STOP']) {
    assert.equal(PLAYER_TYPES.has(type), false, `player may not send ${type}`);
  }
  for (const type of ['PLAYER_NAME', 'PLAYER_TOKEN_MOVE', 'PLAYER_PING', 'PLAYER_END_TURN', 'RESYNC', 'REQUEST_FULL_STATE', 'AUDIO_LISTEN', 'AUDIO_ANSWER', 'AUDIO_STATS']) {
    assert.equal(GM_TYPES.has(type), false, `GM may not send ${type}`);
  }
  for (const type of ['STATE_FULL', 'STATE_PATCH', 'HELLO', 'ACK', 'PONG', 'KICKED', 'PLAYER_ROSTER', 'PLAYER_ID', 'GM_STATUS', 'TABLE', 'JOIN_REQUEST']) {
    assert.equal(PLAYER_TYPES.has(type) && type !== 'PING', false, `player may not send server message ${type}`);
    assert.equal(GM_TYPES.has(type), false, `GM may not send server message ${type}`);
  }
  assert.deepEqual(overlap(PLAYER_TYPES, GM_TYPES), ['PING', 'RESUME'], 'the only types both clients send');
  assert.deepEqual(overlap(SERVER_TO_PLAYER, SERVER_TO_GM), ['HELLO', 'MAP_PING', 'PONG', 'TOKEN_LIVE'], 'the only types the server sends to both');
  // Player-only server messages never reach the GM and vice versa.
  for (const type of ['STATE_FULL', 'STATE_PATCH', 'KICKED', 'WAIT', 'ADMITTED', 'DENIED', 'TABLE_LOCKED', 'ACK']) assert.equal(SERVER_TO_GM.has(type), false, type);
  for (const type of ['PLAYER_ROSTER', 'JOIN_REQUEST', 'TABLE', 'AUDIO_LISTENER']) assert.equal(SERVER_TO_PLAYER.has(type), false, type);
});

test('TYPE_CAPS has exactly one entry for every type in the Sets, and nothing else', () => {
  assert.deepEqual(Object.keys(TYPE_CAPS).sort(), [...everyType].sort());
  for (const [type, entry] of Object.entries(TYPE_CAPS)) {
    assert.deepEqual(Object.keys(entry).sort(), ['burst', 'max', 'perSec'], type);
    assert.ok(Number.isInteger(entry.max) && entry.max >= 16, `${type}.max`);
    const clientSends = PLAYER_TYPES.has(type) || GM_TYPES.has(type);
    if (clientSends) {
      assert.ok(Number.isFinite(entry.burst) && entry.burst >= 1, `${type}.burst`);
      assert.ok(Number.isFinite(entry.perSec) && entry.perSec >= 0, `${type}.perSec`);
    } else {
      assert.equal(entry.burst, null, `${type} is server-only: not rate limited`);
      assert.equal(entry.perSec, null);
    }
  }
});

test('TYPE_CAPS: the numbers of design 4.6', () => {
  assert.deepEqual({ ...TYPE_CAPS.PING }, { max: 96, burst: 5, perSec: 1 });
  assert.deepEqual({ ...TYPE_CAPS.PLAYER_TOKEN_MOVE }, { max: 192, burst: 40, perSec: 30 });
  assert.equal(TYPE_CAPS.PLAYER_PING.max, 128);
  assert.equal(TYPE_CAPS.PLAYER_END_TURN.max, 160);
  assert.equal(TYPE_CAPS.PLAYER_NAME.max, 256);
  assert.equal(TYPE_CAPS.RESUME.max, 512);
  assert.equal(TYPE_CAPS.RESYNC.max, 64);
  assert.equal(TYPE_CAPS.AUDIO_ANSWER.max, 12288);
  assert.equal(TYPE_CAPS.AUDIO_OFFER.max, 12288);
  assert.equal(TYPE_CAPS.AUDIO_SELECT.max, 65536);
  assert.equal(TYPE_CAPS.TABLE_CMD.max, 512);
  assert.equal(TYPE_CAPS.SCENE.max, 8 * 1024 * 1024);
  assert.equal(TYPE_CAPS.SCENE.max, LIMITS.gmMaxPayload);
  // No player-sendable type may exceed the player payload limit, or it could never arrive.
  for (const type of PLAYER_TYPES) assert.ok(TYPE_CAPS[type].max <= LIMITS.playerMaxPayload, `${type} fits in a player frame`);
  for (const type of GM_TYPES) assert.ok(TYPE_CAPS[type].max <= LIMITS.gmMaxPayload, `${type} fits in a GM frame`);
  // RESUME may be sent once per socket: a bucket of one that never refills.
  assert.deepEqual({ burst: TYPE_CAPS.RESUME.burst, perSec: TYPE_CAPS.RESUME.perSec }, { burst: 1, perSec: 0 });
});

test('authProtocol / parseAuthProtocol round trip', () => {
  const device = randomHex(16), nonce = randomHex(16);
  const dk = deriveDk('key', device, nonce, randomHex(16));
  const proof = wsProof(dk, device, nonce, 'player');
  const token = authProtocol(device, nonce, proof);
  assert.equal(token, `auth.${device}.${nonce}.${proof}`);
  assert.equal(token.length, 5 + 32 + 1 + 32 + 1 + 64);
  const expected = { device, nonce, proof };
  assert.deepEqual(parseAuthProtocol(token), expected);
  assert.deepEqual(parseAuthProtocol(`rf3, ${token}`), expected, 'raw Sec-WebSocket-Protocol header');
  assert.deepEqual(parseAuthProtocol(`${token},rf3`), expected);
  assert.deepEqual(parseAuthProtocol(['rf3', token]), expected, 'array of offered protocols');
  assert.deepEqual(parseAuthProtocol(new Set(['rf3', token])), expected, 'Set, as ws passes to handleProtocols');
  assert.equal(parseAuthProtocol('rf3'), null, 'no auth token');
});

test('parseAuthProtocol rejects overlong, non-hex, uppercase, malformed and ambiguous input', () => {
  const device = randomHex(16), nonce = randomHex(16), proof = randomHex(32);
  const good = `auth.${device}.${nonce}.${proof}`;
  assert.notEqual(parseAuthProtocol(good), null);
  const bad = [
    '', 'auth.', 'auth...', `auth.${device}.${nonce}`, `auth.${device}.${nonce}.${proof}.x`,
    `auth.${device.slice(1)}.${nonce}.${proof}`, `auth.${device}a.${nonce}.${proof}`,
    `auth.${device}.${nonce.slice(1)}.${proof}`, `auth.${device}.${nonce}.${proof.slice(2)}`, `auth.${device}.${nonce}.${proof}00`,
    `auth.${'g'.repeat(32)}.${nonce}.${proof}`, `auth.${device}.${'z'.repeat(32)}.${proof}`, `auth.${device}.${nonce}.${'-'.repeat(64)}`,
    `auth.${device.toUpperCase()}.${nonce}.${proof}`, `auth.${device}.${nonce}.${proof.toUpperCase()}`,
    `auth.${device}.${nonce}.${proof}\n`, `auth.${device}.${nonce}.${proof}\0`, ` auth.${device}.${nonce}.${proof}x`,
    `AUTH.${device}.${nonce}.${proof}`, `xauth.${device}.${nonce}.${proof}`, `auth:${device}.${nonce}.${proof}`,
    `auth.${device}.${nonce}.${proof}, auth.${device}.${nonce}.${proof}`, // two tokens
    `rf3, ${good}, ${good.replace(/.$/, '0')}`,
    good + 'a'.repeat(1000), 'a'.repeat(100000), `rf3, ${'x'.repeat(600)}, ${good}`,
  ];
  for (const input of bad) assert.equal(parseAuthProtocol(input), null, JSON.stringify(input).slice(0, 80));
  for (const input of [null, undefined, 42, {}, true, () => good, [good, good], [42], ['rf3', null, good], new Array(9).fill('rf3')]) {
    assert.equal(parseAuthProtocol(input), null, String(input));
  }
  assert.throws(() => authProtocol('nothex', nonce, proof), TypeError);
  assert.throws(() => authProtocol(device, nonce, proof.slice(1)), TypeError);
});

test('isHex and isId', () => {
  assert.equal(isHex('ab12', 2), true);
  assert.equal(isHex('AB12', 2), false);
  assert.equal(isHex('ab1', 2), false);
  assert.equal(isHex(1234, 2), false);
  for (const ok of ['a', 'tok_1', 'a-b-c', 'A'.repeat(64), '0']) assert.equal(isId(ok), true, ok);
  for (const bad of ['', 'a'.repeat(65), 'a b', 'a.b', 'a/b', 'a\n', 'é', null, undefined, 5, ['a'], { toString: () => 'a' }]) {
    assert.equal(isId(bad), false, String(bad));
  }
});

test('cleanName strips control characters and bounds the length', () => {
  assert.equal(cleanName('Aria'), 'Aria');
  assert.equal(cleanName('  Thorin  '), 'Thorin');
  assert.equal(cleanName('A\u0000r\u0007i\u001fa\u007f'), 'Aria');
  assert.equal(cleanName('Ar\nia\r\n\t'), 'Aria', 'newlines and tabs are removed, as the v2 server did');
  assert.equal(cleanName('\u0080\u009fAria'), 'Aria', 'C1 controls');
  assert.equal(cleanName('A‮r‭ia⁦⁩'), 'Aria', 'bidi overrides and isolates');
  assert.equal(cleanName('A​ri‎a﻿⁠'), 'Aria', 'zero-width characters');
  assert.equal(cleanName('Aria'), 'Aria', 'private use');
  assert.equal(cleanName('Ar\uD800ia'), 'Aria', 'lone surrogate');
  assert.equal(cleanName('Mary   Jane  Watson'), 'Mary Jane Watson', 'whitespace runs collapse');
  assert.equal(cleanName('\u{1F468}‍\u{1F469}‍\u{1F467}'), '\u{1F468}‍\u{1F469}‍\u{1F467}', 'ZWJ emoji sequences survive');
  assert.equal(cleanName('Zoë Étienne'), 'Zoë Étienne');
  assert.equal(cleanName('x'.repeat(500)).length, 40);
  assert.equal(cleanName('x'.repeat(500), 10), 'xxxxxxxxxx');
  assert.equal(cleanName('abc', 0), '');
  assert.equal(cleanName('\u{1F600}'.repeat(100)).length, 80, '40 code points, never half a surrogate pair');
  assert.equal(Array.from(cleanName('\u{1F600}'.repeat(100))).length, 40);
  assert.doesNotMatch(cleanName('a\u{1F600}'.repeat(30), 5), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.equal(cleanName('ab   ' + 'c'.repeat(100), 3), 'ab', 'trimmed again after cutting');
  assert.equal(cleanName('\u0000\u0001\u0002'), '');
  for (const junk of [null, undefined, 42, {}, ['Aria'], true]) assert.equal(cleanName(junk), '');
  assert.equal(cleanName('y'.repeat(10_000_000), 40).length, 40);
  assert.equal(cleanName('Aria', NaN), 'Aria', 'bad limit falls back to 40');
  // idempotent
  const messy = ' A\u0000b‮c  \u{1F600}d '.repeat(20);
  assert.equal(cleanName(cleanName(messy)), cleanName(messy));
});

test('fnv1a is the 32-bit FNV-1a of the UTF-8 bytes', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
  assert.equal(fnv1a('hello'), 0x4f9f2cab);
  assert.equal(fnv1a('é'), fnv1a('Ã©' === 'é' ? '' : 'é'));
  // reference implementation over a Buffer
  const reference = text => { let h = 0x811c9dc5n; for (const b of Buffer.from(text, 'utf8')) { h ^= BigInt(b); h = (h * 0x01000193n) & 0xffffffffn; } return Number(h); };
  for (const text of ['', 'x', 'Zoë', '\u{1F600}', '{"rev":1,"tokens":[]}', 'a'.repeat(1000)]) assert.equal(fnv1a(text), reference(text), text.slice(0, 20));
  for (let i = 0; i < 200; i++) {
    const text = createHash('sha256').update(String(i)).digest('latin1');
    assert.equal(fnv1a(text), reference(text));
  }
  assert.ok(fnv1a('x') >= 0 && fnv1a('x') <= 0xffffffff && Number.isInteger(fnv1a('x')));
});
