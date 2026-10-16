import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFrame } from '../server/net/validate.js';
import { PLAYER_TYPES, GM_TYPES, TYPE_CAPS, LIMITS } from '../src/net/protocol.js';

const frame = (role, object, extra) => {
  const body = typeof object === 'string' ? object : JSON.stringify(object);
  return validateFrame(role, body, Buffer.byteLength(body), extra);
};
const device = 'a'.repeat(32);

test('every type in the player and GM catalogues has a validator that accepts a sensible message', () => {
  const samples = {
    PING: { t: 5, rtt: 20 },
    RESUME: { rev: 4, aids: [1, 'two'] },
    RESYNC: {}, REQUEST_FULL_STATE: {},
    PLAYER_NAME: { name: 'Thorin' },
    PLAYER_TOKEN_MOVE: { aid: 3, id: 'hero', x: 1, y: 2 },
    PLAYER_PING: { x: 1, y: 2 },
    PLAYER_END_TURN: { aid: 4, tokenId: 'hero' },
    AUDIO_LISTEN: { enabled: true, caps: { rtc: true, jbt: false } },
    AUDIO_ANSWER: { sid: 's1', sdp: 'v=0' },
    AUDIO_STATS: { sid: 's1', lossPct: 1.5, mode: 'webrtc' },
    SCENE: { scene: { tokens: [], markers: [], areaEffects: [], fogCells: [] } },
    AUDIO_OFFER: { to: device, sid: 's1', sdp: 'v=0' },
    AUDIO_CONTROLS: { volume: 0.5, muted: false },
    AUDIO_STATUS: { active: true },
    AUDIO_SELECT: { settings: [{ id: device, enabled: true }] },
    AUDIO_FALLBACK: { to: device, sid: 's1', reason: 'ice-failed' },
    AUDIO_STOP: {},
    TABLE_CMD: { op: 'lock' },
  };
  for (const type of PLAYER_TYPES) {
    const result = frame('player', { type, ...samples[type] });
    assert.equal(result.ok, true, `${type}: ${JSON.stringify(result)}`);
    assert.equal(result.msg.type, type);
  }
  for (const type of GM_TYPES) {
    const result = frame('gm', { type, ...samples[type] });
    assert.equal(result.ok, true, `${type}: ${JSON.stringify(result)}`);
  }
});

test('malformed input is refused with a code and never throws', () => {
  for (const body of ['', 'nope', '{', '[]', 'null', '42', '"str"', '{"type":5}', '{"type":""}', '{"type":"' + 'X'.repeat(41) + '"}', '{"x":1}']) {
    const result = frame('player', body);
    assert.deepEqual(result, { ok: false, code: 'malformed' }, body.slice(0, 30));
  }
  assert.deepEqual(validateFrame('player', undefined, 5), { ok: false, code: 'malformed' });
  assert.deepEqual(validateFrame('player', Buffer.from('{}'), 2), { ok: false, code: 'malformed' });
  // 10,000-deep nesting is dropped, not a crash
  const deep = `{"type":"PING","t":${'['.repeat(10000)}${']'.repeat(10000)}}`;
  assert.equal(frame('player', deep).ok, false);
});

test('unknown types and wrong directions are told apart', () => {
  assert.equal(frame('player', { type: 'NOPE' }).code, 'unknown-type');
  assert.equal(frame('player', { type: '__proto__' }).code, 'unknown-type');
  assert.equal(frame('player', { type: 'constructor' }).code, 'unknown-type');
  assert.equal(frame('player', { type: 'SCENE', scene: {} }).code, 'wrong-direction');
  assert.equal(frame('player', { type: 'TABLE_CMD', op: 'kick', device }).code, 'wrong-direction');
  assert.equal(frame('player', { type: 'STATE_FULL', rev: 1, state: {} }).code, 'wrong-direction');
  assert.equal(frame('gm', { type: 'PLAYER_TOKEN_MOVE', id: 'a', x: 1, y: 1 }).code, 'wrong-direction');
  assert.equal(frame('gm', { type: 'PLAYER_ROSTER', players: [] }).code, 'wrong-direction');
});

test('sizes: the role maximum is checked before parsing, then the per-type cap', () => {
  const big = JSON.stringify({ type: 'PING', pad: 'x'.repeat(200) });
  assert.equal(frame('player', big).code, 'oversize');                              // over PING's 96 bytes
  const hugePlayer = 'x'.repeat(LIMITS.playerMaxPayload + 1);
  assert.equal(validateFrame('player', hugePlayer, hugePlayer.length).code, 'oversize'); // never parsed
  assert.equal(frame('player', { type: 'PLAYER_NAME', name: 'a'.repeat(300) }).code, 'oversize');
  assert.equal(frame('player', { type: 'AUDIO_ANSWER', sid: 's', sdp: 'v'.repeat(13000) }).code, 'oversize');
  // the GM may send a scene far larger than any player frame
  const scene = { type: 'SCENE', scene: { fogCells: Array.from({ length: 20000 }, (_, i) => `${i},1`) } };
  assert.ok(JSON.stringify(scene).length > LIMITS.playerMaxPayload);
  assert.equal(frame('gm', scene).ok, true);
  assert.equal(validateFrame('gm', '{}', TYPE_CAPS.SCENE.max + 1).code, 'oversize');
});

test('numbers must be finite and sane; coordinates, ids and action ids are checked', () => {
  const move = fields => frame('player', { type: 'PLAYER_TOKEN_MOVE', id: 'hero', x: 1, y: 2, ...fields });
  assert.equal(move({}).ok, true);
  for (const bad of [{ x: '5' }, { x: null }, { y: 1e300 }, { x: 1e999 }, { x: -1e999 }, { id: '' }, { id: 'a b' }, { id: 5 }, { id: 'x'.repeat(65) },
    { aid: -1 }, { aid: 1.5 }, { aid: {} }, { aid: 'has space' }, { aid: 2 ** 60 }]) {
    assert.equal(move(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(frame('player', '{"type":"PLAYER_PING","x":1e999,"y":2}').ok, false);        // parses to Infinity
  assert.equal(frame('player', { type: 'PLAYER_PING', x: 1, y: 2, aid: 7 }).msg.aid, 7);
  assert.equal(frame('player', { type: 'PLAYER_END_TURN', tokenId: 'hero' }).ok, true);
  assert.equal(frame('player', { type: 'PLAYER_END_TURN', tokenId: ['hero'] }).ok, false);
  assert.equal(frame('player', { type: 'PING', t: 'now', rtt: Infinity }).ok, false);
  assert.equal(frame('player', '{"type":"PING","rtt":1e999}').ok, false);
});

test('handlers get a fresh, minimal object: extra fields and prototype keys do not travel', () => {
  const result = frame('player', '{"type":"PLAYER_TOKEN_MOVE","id":"hero","x":1,"y":2,"evil":"yes","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.msg).sort(), ['id', 'type', 'x', 'y']);
  assert.equal(Object.getPrototypeOf(result.msg), Object.prototype);
  assert.equal({}.polluted, undefined);
  const loose = frame('player', '{"type":"AUDIO_STATS","sid":"s1","__proto__":1,"constructor":2,"prototype":3,"nested":{"a":1},"ok":4}');
  assert.deepEqual(loose.msg, { type: 'AUDIO_STATS', sid: 's1', ok: 4 });
});

test('names are cleaned: control characters stripped and cut to 40', () => {
  const result = frame('player', { type: 'PLAYER_NAME', name: `  Tho\u0000rin\n${'x'.repeat(100)}` });
  assert.equal(result.ok, true);
  assert.ok(result.msg.name.startsWith('Thorin'));
  assert.ok(result.msg.name.length <= 40);
  assert.equal(frame('player', { type: 'PLAYER_NAME', name: 5 }).ok, false);
});

test('RESUME: rev is a non-negative integer or null, aids are at most 64 ids', () => {
  assert.deepEqual(frame('player', { type: 'RESUME', rev: null, aids: [] }).msg, { type: 'RESUME', rev: null, aids: [] });
  assert.deepEqual(frame('player', { type: 'RESUME' }).msg, { type: 'RESUME', rev: null, aids: [] });
  for (const bad of [{ rev: -1 }, { rev: 1.5 }, { rev: '3' }, { aids: 'x' }, { aids: [{}] }, { aids: Array(65).fill(1) }, { aids: [null] }]) {
    assert.equal(frame('player', { type: 'RESUME', ...bad }).ok, false, JSON.stringify(bad));
  }
});

test('SCENE: must be an object whose collections hold objects', () => {
  assert.equal(frame('gm', { type: 'SCENE', scene: [] }).ok, false);
  assert.equal(frame('gm', { type: 'SCENE', scene: 'x' }).ok, false);
  assert.equal(frame('gm', { type: 'SCENE' }).ok, false);
  assert.equal(frame('gm', { type: 'SCENE', scene: { tokens: [null] } }).ok, false);
  assert.equal(frame('gm', { type: 'SCENE', scene: { tokens: 'x' } }).ok, false);
  assert.equal(frame('gm', { type: 'SCENE', scene: { fogCells: [1] } }).ok, false);
  assert.equal(frame('gm', { type: 'SCENE', scene: { combat: 5 } }).ok, false);
  assert.equal(frame('gm', { type: 'SCENE', scene: { tokens: [{ id: 'a' }], combat: null } }).ok, true);
});

test('TABLE_CMD: known ops only, devices as ids, mode and name where needed', () => {
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'kick', device }).ok, true);
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'kick', device: 'b'.repeat(24) }).ok, true); // a playerId
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'kick' }).ok, false);
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'explode', device }).ok, false);
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'kick', device: 'nope' }).ok, false);
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'mode', mode: 'ask' }).ok, true);
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'mode', mode: 'wide-open' }).ok, false);
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'rename', device, name: 'Aria' }).msg.name, 'Aria');
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'rename', device }).ok, false);
  assert.equal(frame('gm', { type: 'TABLE_CMD', op: 'rotate' }).ok, true);
});

test('extension types are accepted for the role they were registered for, loosely checked', () => {
  const extra = new Set(['CUSTOM_THING']);
  assert.equal(frame('player', { type: 'CUSTOM_THING', a: 1 }).code, 'unknown-type');
  const result = frame('player', { type: 'CUSTOM_THING', a: 1, b: { deep: true }, __proto__: 5 }, extra);
  assert.equal(result.ok, true);
  assert.deepEqual(result.msg, { type: 'CUSTOM_THING', a: 1 });
  assert.equal(frame('gm', { type: 'CUSTOM_THING' }, extra).ok, true); // the caller passes the set for the right role
});

test('a seeded fuzz of 20,000 random frames never throws and always answers with ok or a known code', () => {
  let seed = 12345;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = list => list[Math.floor(random() * list.length)];
  const values = [0, -1, 1.5, 1e308, 'x', '', null, true, [], {}, 'a'.repeat(100), NaN];
  const types = [...PLAYER_TYPES, ...GM_TYPES, 'NOPE', '__proto__'];
  const codes = new Set(['oversize', 'malformed', 'unknown-type', 'wrong-direction', 'invalid']);
  for (let i = 0; i < 20000; i++) {
    const object = { type: pick(types) };
    for (const key of ['id', 'x', 'y', 'aid', 'rev', 'aids', 'name', 'sid', 'sdp', 'op', 'to', 'scene', 'tokenId', 'enabled']) {
      if (random() < 0.5) object[key] = pick(values);
    }
    const body = random() < 0.1 ? JSON.stringify(object).slice(0, Math.floor(random() * 50)) : JSON.stringify(object);
    for (const role of ['player', 'gm']) {
      const result = validateFrame(role, body, Buffer.byteLength(body));
      assert.ok(result.ok || codes.has(result.code));
    }
  }
});
