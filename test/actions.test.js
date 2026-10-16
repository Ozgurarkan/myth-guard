import test from 'node:test';
import assert from 'node:assert/strict';
import { moveToken, mapPing, endTurn, createMemory, PING_COOLDOWN_MS, END_TURN_GUARD_MS } from '../server/net/actions.js';
import { ACK_REASONS } from '../src/net/protocol.js';

const alice = { playerId: 'alice', name: 'Aria', label: 'Chrome · Android' };
const bob = { playerId: 'bob', name: '', label: 'Safari · iPhone' };

const scene = (extra = {}) => ({
  mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [], playerCanMoveTokens: true,
  tokens: [
    { id: 'hero', name: 'Aria the Bold', x: 0, y: 0, gridSize: 1, ownerId: 'alice', visibleToPlayers: true },
    { id: 'ghost', name: 'Ghost', x: 100, y: 0, gridSize: 1, ownerId: 'alice', visibleToPlayers: false },
    { id: 'npc', name: 'Goblin', x: 300, y: 0, gridSize: 1 },
  ],
  combat: { entries: [{ tokenId: 'hero', initiative: 12 }], activeId: null, round: 1 },
  ...extra,
});
const move = (overrides = {}) => moveToken({ scene: scene(), actor: alice, msg: { id: 'hero', x: 120, y: 80 }, gmPresent: true, ...overrides });

test('the owner moves a token: the GM hears of it and the server copy follows', () => {
  const result = move();
  assert.deepEqual(result.ack, { ok: true });
  assert.deepEqual(result.toGm, { type: 'PLAYER_TOKEN_MOVE', playerId: 'alice', id: 'hero', x: 120, y: 80 });
  const target = scene();
  result.mutate(target);
  assert.deepEqual([target.tokens[0].x, target.tokens[0].y], [120, 80]);
  assert.equal(target.tokens[2].x, 300, 'only that token changes');
  assert.doesNotThrow(() => result.mutate({ tokens: [] }));
});

test('MOVE_REJECTED reasons keep the old names and the old order of checks', () => {
  assert.equal(move({ actor: bob }).ack.reason, 'blocked');                                    // not the owner
  assert.equal(move({ msg: { id: 'nobody', x: 1, y: 1 } }).ack.reason, 'blocked');            // no such token
  assert.equal(move({ msg: { id: 'npc', x: 1, y: 1 } }).ack.reason, 'blocked');                // GM-only token (no owner)
  assert.equal(move({ scene: null }).ack.reason, 'blocked');
  assert.equal(move({ gmPresent: false }).ack.reason, 'away');
  assert.equal(move({ actor: bob, gmPresent: false }).ack.reason, 'blocked', 'ownership is checked before the GM being away');
  assert.equal(move({ scene: scene({ playerCanMoveTokens: false }) }).ack.reason, 'paused');
  assert.equal(move({ scene: scene({ playerCanMoveTokens: false }), gmPresent: false }).ack.reason, 'away', 'away before paused');
  assert.equal(move({ scene: scene({ fogCells: ['0,0'] }) }).ack.reason, 'blocked', 'a token under fog cannot be moved');
  assert.equal(move({ scene: scene({ fogCells: ['0,0'], showFog: false }) }).ack.ok, true, 'fog switched off');
  assert.equal(move({ msg: { id: 'ghost', x: 1, y: 1 } }).ack.reason, 'blocked', 'a hidden token cannot be moved');
  for (const result of [move({ actor: bob }), move({ gmPresent: false })]) {
    assert.equal(result.toGm, undefined);
    assert.equal(result.mutate, undefined);
    assert.ok(ACK_REASONS.has(result.ack.reason));
  }
});

test('moves are clamped to the map and nonsense is refused as invalid', () => {
  let r = move({ msg: { id: 'hero', x: 99999, y: -50 } });
  assert.deepEqual([r.toGm.x, r.toGm.y], [2000, 0]);
  r = move({ msg: { id: 'hero', x: -5, y: 99999 } });
  assert.deepEqual([r.toGm.x, r.toGm.y], [0, 1500]);
  r = move({ scene: scene({ mapWidth: undefined, mapHeight: 0 }), msg: { id: 'hero', x: 700, y: 800 } });
  assert.deepEqual([r.toGm.x, r.toGm.y], [700, 800], 'without a map size nothing is clamped (as before)');
  for (const msg of [{ id: 'hero', x: NaN, y: 1 }, { id: 'hero', x: 1, y: Infinity }, { id: 5, x: 1, y: 1 }, null]) {
    assert.equal(move({ msg }).ack.reason, 'invalid');
  }
});

test('a ping goes to everyone, stays on the map and has a 700 ms cooldown per device', () => {
  const memory = createMemory();
  const ping = (msg, now, actor = alice, mem = memory) => mapPing({ scene: scene(), actor, msg, memory: mem, now });
  const first = ping({ x: 400, y: 300 }, 1000);
  assert.deepEqual(first.ping, { type: 'MAP_PING', id: 'alice', name: 'Aria', x: 400, y: 300 });
  assert.equal(ping({ x: 10, y: 10 }, 1000 + PING_COOLDOWN_MS - 1), null, 'inside the cooldown');
  assert.deepEqual([ping({ x: 99999, y: -50 }, 1000 + PING_COOLDOWN_MS).ping.x, 0], [2000, 0], 'off the map is pulled back');
  assert.equal(ping({ x: NaN, y: 5 }, 5000), null);
  assert.equal(ping({ x: 1, y: 2 }, 5001, alice, createMemory()).ping.name, 'Aria', 'another device has its own cooldown');
  assert.equal(ping({ x: 1, y: 2 }, 9000, bob, createMemory()).ping.name, 'Safari · iPhone', 'without a name the device label is shown');
  assert.equal(mapPing({ scene: null, actor: alice, msg: { x: 1, y: 1 }, memory: createMemory(), now: 1 }), null);
  // a dropped ping does not restart the cooldown
  const mem = createMemory();
  ping({ x: 1, y: 1 }, 100, alice, mem);
  ping({ x: 1, y: 1 }, 600, alice, mem);
  assert.notEqual(ping({ x: 1, y: 1 }, 100 + PING_COOLDOWN_MS, alice, mem), null);
});

test('the first ping on a clock that starts at zero is not swallowed', () => {
  assert.notEqual(mapPing({ scene: scene(), actor: alice, msg: { x: 1, y: 1 }, memory: createMemory(), now: 0 }), null);
});

test('only the player whose hero is acting can end the turn; a double tap counts once', () => {
  const acting = scene({ combat: { entries: [{ tokenId: 'hero', initiative: 12 }], activeId: 'hero', round: 1 } });
  const memory = createMemory();
  const end = (overrides = {}) => endTurn({ scene: acting, actor: alice, msg: { tokenId: 'hero' }, gmPresent: true, memory, now: 0, ...overrides });

  assert.equal(end({ scene: scene() }).ack.reason, 'not-your-turn');                          // nobody's turn yet
  assert.equal(end({ actor: bob, memory: createMemory() }).ack.reason, 'not-your-turn');      // somebody else's hero
  assert.equal(end({ msg: { tokenId: 'nobody' } }).ack.reason, 'not-your-turn');
  assert.equal(end({ gmPresent: false }).ack.reason, 'away');
  assert.equal(end({ gmPresent: false, actor: bob }).ack.reason, 'away', 'away is checked first, as before');
  assert.equal(end({ msg: { tokenId: 7 } }).ack.reason, 'invalid');

  const accepted = end({ now: 10_000 });
  assert.deepEqual(accepted.ack, { ok: true });
  assert.deepEqual(accepted.toGm, { type: 'PLAYER_END_TURN', playerId: 'alice', tokenId: 'hero', name: 'Aria the Bold' });
  const tapped = end({ now: 10_000 + END_TURN_GUARD_MS - 1 });
  assert.deepEqual(tapped.ack, { ok: true }, 'the second tap is answered as done');
  assert.equal(tapped.toGm, undefined, 'but the GM hears of the first one only');
  assert.ok(end({ now: 10_000 + END_TURN_GUARD_MS }).toGm, 'after 1.5 s it counts again');
});

test('the rules never mutate their input unless asked to (mutate is a separate step)', () => {
  const s = scene();
  const before = JSON.stringify(s);
  moveToken({ scene: s, actor: alice, msg: { id: 'hero', x: 5, y: 5 }, gmPresent: true });
  mapPing({ scene: s, actor: alice, msg: { x: 1, y: 1 }, memory: createMemory(), now: 5 });
  endTurn({ scene: s, actor: alice, msg: { tokenId: 'hero' }, gmPresent: true, memory: createMemory(), now: 5 });
  assert.equal(JSON.stringify(s), before);
});

test('a scene with junk in it does not make a rule throw', () => {
  const junk = { tokens: [null, 5, 'x', { id: 'hero', ownerId: 'alice', x: 'NaN', y: null, gridSize: 'big' }], combat: 'nope', mapWidth: 'wide' };
  assert.doesNotThrow(() => moveToken({ scene: junk, actor: alice, msg: { id: 'hero', x: 1, y: 1 }, gmPresent: true }));
  assert.doesNotThrow(() => endTurn({ scene: junk, actor: alice, msg: { tokenId: 'hero' }, gmPresent: true, memory: createMemory(), now: 1 }));
  assert.doesNotThrow(() => mapPing({ scene: junk, actor: alice, msg: { x: 1, y: 1 }, memory: createMemory(), now: 1 }));
});
