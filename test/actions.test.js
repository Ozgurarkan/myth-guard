import test from 'node:test';
import assert from 'node:assert/strict';
import { moveToken, mapPing, endTurn, editCombat, delayTurn, addArea, removeArea, createMemory, PING_COOLDOWN_MS, END_TURN_GUARD_MS } from '../server/net/actions.js';
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

const fight = (extra = {}) => scene({ combat: { entries: [{ tokenId: 'hero', initiative: 12, hp: 18, maxHp: 20 }, { tokenId: 'npc', initiative: 9, hp: 7, maxHp: 7 }], activeId: 'hero', round: 1 }, ...extra });
const edit = (msg, overrides = {}) => editCombat({ scene: fight(), actor: alice, msg: { tokenId: 'hero', ...msg }, gmPresent: true, ...overrides });

test('a player changes their own hero in a fight: numbers are clamped, the GM hears of it and the server copy follows', () => {
  const result = edit({ hp: 12, initiative: 15 });
  assert.deepEqual(result.ack, { ok: true });
  assert.deepEqual(result.toGm, { type: 'PLAYER_COMBAT_EDIT', playerId: 'alice', tokenId: 'hero', hp: 12, initiative: 15 });
  const copy = fight();
  result.mutate(copy);
  assert.deepEqual(copy.combat.entries[0], { tokenId: 'hero', initiative: 15, hp: 12, maxHp: 20 });
  assert.equal(edit({ hp: 500 }).toGm.hp, 20, 'never above the maximum');
  assert.equal(edit({ hp: -5 }).toGm.hp, 0);
  assert.equal(edit({ initiative: 1000 }).toGm.initiative, 99);
  assert.equal(edit({ initiative: 7.6 }).toGm.initiative, 8);
});

test('editing a hero is refused for other people, hidden or absent heroes, a paused table and nonsense', () => {
  assert.equal(edit({ hp: 1 }, { actor: bob }).ack.reason, 'blocked', 'not your hero');
  assert.equal(editCombat({ scene: fight(), actor: alice, msg: { tokenId: 'npc', hp: 1 }, gmPresent: true }).ack.reason, 'blocked', 'a token nobody gave you');
  assert.equal(editCombat({ scene: fight(), actor: alice, msg: { tokenId: 'ghost', hp: 1 }, gmPresent: true }).ack.reason, 'blocked', 'hidden');
  assert.equal(edit({ hp: 1 }, { gmPresent: false }).ack.reason, 'away');
  assert.equal(editCombat({ scene: fight({ playerCanEditCombat: false }), actor: alice, msg: { tokenId: 'hero', hp: 1 }, gmPresent: true }).ack.reason, 'paused');
  assert.equal(editCombat({ scene: scene({ combat: { entries: [], activeId: null, round: 1 } }), actor: alice, msg: { tokenId: 'hero', hp: 1 }, gmPresent: true }).ack.reason, 'blocked', 'not in a fight');
  for (const msg of [{ hp: NaN }, { initiative: Infinity }, {}, { tokenId: 5, hp: 1 }]) assert.equal(edit(msg).ack.reason, 'invalid', JSON.stringify(msg));
});

test('a player may change the maximum of their own hero, never of a creature they were given', () => {
  const grow = edit({ maxHp: 30 });
  assert.deepEqual(grow.toGm, { type: 'PLAYER_COMBAT_EDIT', playerId: 'alice', tokenId: 'hero', maxHp: 30, hp: 18 }, 'hit points stay as they were');
  const shrink = edit({ maxHp: 10 });
  assert.deepEqual([shrink.toGm.maxHp, shrink.toGm.hp], [10, 10], 'cut down to fit the new maximum');
  assert.equal(edit({ maxHp: 0 }).toGm.maxHp, 1);
  assert.equal(edit({ maxHp: 1e9 }).toGm.maxHp, 99999);
  assert.deepEqual([edit({ maxHp: 25, hp: 99 }).toGm.maxHp, edit({ maxHp: 25, hp: 99 }).toGm.hp], [25, 25], 'the new maximum is the ceiling for the same message');
  const copy = fight();
  grow.mutate(copy);
  assert.deepEqual(copy.combat.entries[0], { tokenId: 'hero', initiative: 12, hp: 18, maxHp: 30 });
  const bare = scene({ combat: { entries: [{ tokenId: 'hero', initiative: 12, hp: null, maxHp: null }], activeId: null, round: 1 } });
  assert.deepEqual(editCombat({ scene: bare, actor: alice, msg: { tokenId: 'hero', maxHp: 22 }, gmPresent: true }).toGm.hp, 22, 'a hero with no hit points starts full');
  const creature = scene({ tokens: [{ id: 'hero', x: 0, y: 0, gridSize: 1, ownerId: 'alice', visibleToPlayers: true, characterType: 'npc' }], combat: { entries: [{ tokenId: 'hero', initiative: 3, hp: 7, maxHp: 7 }], activeId: null, round: 1 } });
  assert.equal(editCombat({ scene: creature, actor: alice, msg: { tokenId: 'hero', maxHp: 900, hp: 1 }, gmPresent: true }).ack.reason, 'invalid', 'a creature keeps its numbers');
  assert.equal(editCombat({ scene: creature, actor: alice, msg: { tokenId: 'hero', initiative: 4, hp: 1 }, gmPresent: true }).toGm.initiative, 4);
  assert.equal(edit({ maxHp: NaN }).ack.reason, 'invalid');
});

const queue = (extra = {}) => scene({
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, ownerId: 'alice', visibleToPlayers: true, characterType: 'pc' },
    { id: 'orc', name: 'Orc', x: 100, y: 0, gridSize: 1, visibleToPlayers: true, characterType: 'npc' },
    { id: 'lurker', name: 'Lurker', x: 200, y: 0, gridSize: 1, visibleToPlayers: false, characterType: 'npc' },
    { id: 'drow', name: 'Drow', x: 300, y: 0, gridSize: 1, visibleToPlayers: true, characterType: 'npc' },
    { id: 'friend', name: 'Bran', x: 400, y: 0, gridSize: 1, ownerId: 'bob', visibleToPlayers: true, characterType: 'pc' },
  ],
  combat: { entries: [
    { tokenId: 'hero', initiative: 20, hp: 10, maxHp: 10 }, { tokenId: 'orc', initiative: 15 }, { tokenId: 'lurker', initiative: 12 }, { tokenId: 'drow', initiative: 5 }, { tokenId: 'friend', initiative: 3, hp: 9, maxHp: 9 },
  ], activeId: 'hero', round: 1 },
  ...extra,
});
const wait = (msg, overrides = {}) => delayTurn({ scene: queue(), actor: alice, msg: { tokenId: 'hero', after: 'orc', ...msg }, gmPresent: true, ...overrides });

test('a hero delays their turn until after another hero who comes later: the GM hears of it and the server copy follows', () => {
  const result = wait({ after: 'friend' });
  assert.deepEqual(result.ack, { ok: true });
  assert.deepEqual(result.toGm, { type: 'PLAYER_DELAY_TURN', playerId: 'alice', tokenId: 'hero', after: 'friend' });
  const copy = queue();
  result.mutate(copy);
  assert.equal(copy.combat.activeId, 'orc', 'the turn passes on at once');
  assert.deepEqual(copy.combat.delays, [{ tokenId: 'hero', after: 'friend' }]);
});

test('delaying is refused off turn, behind a creature, to a hidden hero, to someone already gone, twice, or by another player', () => {
  assert.equal(wait({ after: 'friend' }, { actor: bob }).ack.reason, 'blocked');
  assert.equal(wait({ after: 'orc' }).ack.reason, 'blocked', 'a hero never waits for a creature');
  assert.equal(wait({ after: 'drow' }).ack.reason, 'blocked', 'not even a visible one');
  assert.equal(wait({ after: 'lurker' }).ack.reason, 'blocked', 'a hidden creature is never named');
  assert.equal(wait({ after: 'hero' }).ack.reason, 'blocked');
  assert.equal(wait({ after: 'nobody' }).ack.reason, 'blocked');
  assert.equal(wait({ after: 'friend' }, { gmPresent: false }).ack.reason, 'away');
  const offTurn = queue({ combat: { ...queue().combat, activeId: 'orc' } });
  assert.equal(delayTurn({ scene: offTurn, actor: alice, msg: { tokenId: 'hero', after: 'friend' }, gmPresent: true }).ack.reason, 'not-your-turn');
  const behind = queue({ combat: { ...queue().combat, activeId: 'hero', delays: [{ tokenId: 'hero', after: 'orc' }] } });
  assert.equal(delayTurn({ scene: behind, actor: alice, msg: { tokenId: 'hero', after: 'friend' }, gmPresent: true }).ack.reason, 'blocked', 'once a round');
  const fogged = queue({ showFog: true, fogCells: ['8,0'] });
  assert.equal(delayTurn({ scene: fogged, actor: alice, msg: { tokenId: 'hero', after: 'friend' }, gmPresent: true }).ack.reason, 'blocked', 'under fog counts as hidden');
  const hidden = queue({ tokens: queue().tokens.map(token => (token.id === 'friend' ? { ...token, visibleToPlayers: false } : token)) });
  assert.equal(delayTurn({ scene: hidden, actor: alice, msg: { tokenId: 'hero', after: 'friend' }, gmPresent: true }).ack.reason, 'blocked', 'a hidden hero is never named');
  for (const msg of [{ after: 5 }, { tokenId: 7 }, { tokenId: undefined }]) assert.equal(wait(msg).ack.reason, 'invalid', JSON.stringify(msg));
});


// ── Spell areas ──────────────────────────────────────────────────────────────────────────────────
const castScene = (extra = {}) => scene({ areaEffects: [], ...extra });
const cast = (msg = {}, overrides = {}) => addArea({ scene: castScene(), actor: alice, msg: { id: 'fx1', shape: 'circle', color: '#e5533d', x: 400, y: 300, radius: 100, ...msg }, gmPresent: true, ...overrides });

test('a player casts a spell area: the GM hears of it and the server copy gets the effect at once', () => {
  const result = cast();
  assert.deepEqual(result.ack, { ok: true });
  assert.deepEqual(result.toGm, { type: 'PLAYER_AREA_ADD', playerId: 'alice', id: 'fx1', shape: 'circle', color: '#e5533d', x: 400, y: 300, radius: 100 });
  const copy = castScene();
  result.mutate(copy);
  assert.deepEqual(copy.areaEffects, [{ id: 'fx1', type: 'circle', x: 400, y: 300, radius: 100, color: '#e5533d', opacity: 0.4, ownerId: 'alice' }]);
  const noList = scene();
  assert.doesNotThrow(() => cast().mutate(noList));
  assert.equal(noList.areaEffects.length, 1, 'a scene with no list yet gets one');
});

test('a circle bound to a hero follows no point: the server stores which token it is bound to', () => {
  const result = cast({ id: 'aura', boundTo: 'hero', x: undefined, y: undefined });
  assert.equal(result.ack.ok, true);
  const copy = castScene();
  result.mutate(copy);
  assert.deepEqual([copy.areaEffects[0].boundTo, copy.areaEffects[0].x, copy.areaEffects[0].y], ['hero', 0, 0]);
  cast({ id: 'aura2', boundTo: 'hero', radius: 200 }).mutate(copy);
  assert.deepEqual(copy.areaEffects.map(effect => effect.id), ['aura2'], 'a hero wears one circle');
});

test('casting is refused with no GM, while the GM has it switched off, without a hero, onto someone else\'s or a hidden hero, or with nonsense', () => {
  assert.equal(cast({}, { gmPresent: false }).ack.reason, 'away');
  assert.equal(addArea({ scene: castScene({ playerCanCast: false }), actor: alice, msg: { id: 'fx1', shape: 'circle', color: '#e5533d', x: 1, y: 1, radius: 50 }, gmPresent: true }).ack.reason, 'paused');
  assert.equal(cast({}, { actor: bob }).ack.reason, 'blocked', 'Bob has no hero on this map');
  assert.equal(cast({ boundTo: 'npc' }).ack.reason, 'blocked', 'a creature is nobody\'s hero');
  assert.equal(cast({ boundTo: 'ghost' }).ack.reason, 'blocked', 'a hidden hero');
  assert.equal(addArea({ scene: null, actor: alice, msg: { id: 'fx1' }, gmPresent: true }).ack.reason, 'blocked');
  assert.equal(addArea({ scene: castScene(), actor: { playerId: '' }, msg: { id: 'fx1' }, gmPresent: true }).ack.reason, 'blocked');
  assert.equal(cast({ shape: 'star' }).ack.reason, 'invalid');
  assert.equal(cast({ radius: undefined }).ack.reason, 'invalid');
});

test('taking back: only your own, one or all; allowed even while casting is switched off', () => {
  const stocked = () => castScene({ areaEffects: [
    { id: 'a1', type: 'circle', x: 0, y: 0, radius: 50, color: '#fff', ownerId: 'alice' }, { id: 'a2', type: 'circle', x: 0, y: 0, radius: 50, color: '#fff', ownerId: 'alice' },
    { id: 'b1', type: 'circle', x: 0, y: 0, radius: 50, color: '#fff', ownerId: 'bob' }, { id: 'gm1', type: 'circle', x: 0, y: 0, radius: 50, color: '#fff' },
  ] });
  const take = (msg, overrides = {}) => removeArea({ scene: stocked(), actor: alice, msg, gmPresent: true, ...overrides });
  const one = take({ id: 'a1' });
  assert.deepEqual(one.ack, { ok: true });
  assert.deepEqual(one.toGm, { type: 'PLAYER_AREA_REMOVE', playerId: 'alice', id: 'a1' });
  const copy = stocked();
  one.mutate(copy);
  assert.deepEqual(copy.areaEffects.map(e => e.id), ['a2', 'b1', 'gm1']);
  const all = take({ all: true });
  assert.deepEqual(all.toGm, { type: 'PLAYER_AREA_REMOVE', playerId: 'alice', all: true });
  const copy2 = stocked();
  all.mutate(copy2);
  assert.deepEqual(copy2.areaEffects.map(e => e.id), ['b1', 'gm1']);
  assert.equal(take({ id: 'b1' }).ack.reason, 'blocked', 'Bob\'s');
  assert.equal(take({ id: 'gm1' }).ack.reason, 'blocked', 'the GM\'s');
  assert.equal(take({ id: 'nothing' }).ack.reason, 'blocked');
  assert.equal(take({}).ack.reason, 'invalid');
  assert.equal(take({ id: 'a1' }, { gmPresent: false }).ack.reason, 'away');
  const paused = removeArea({ scene: { ...stocked(), playerCanCast: false }, actor: alice, msg: { id: 'a1' }, gmPresent: true });
  assert.equal(paused.ack.ok, true);
});
