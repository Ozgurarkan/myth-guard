// Spell areas players draw: what a request turns into, and how effects are added, replaced, limited and taken back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { playerEffect, addPlayerEffect, removePlayerEffects, effectsOf, aurasByToken, freeEffects, MAX_PLAYER_AREAS, PLAYER_AREA_COLORS, AREA_LIMITS } from '../src/areas.js';

const scene = (extra = {}) => ({
  mapWidth: 2000, mapHeight: 1500, gridSize: 50,
  tokens: [
    { id: 'hero', ownerId: 'alice', x: 100, y: 100, gridSize: 1 },
    { id: 'ghost', ownerId: 'alice', x: 0, y: 0, gridSize: 1, visibleToPlayers: false },
    { id: 'friend', ownerId: 'bob', x: 300, y: 100, gridSize: 1 },
  ],
  ...extra,
});
const circle = (overrides = {}) => ({ id: 'e1', shape: 'circle', color: '#e5533d', x: 400, y: 300, radius: 100, ...overrides });

test('a circle, a square and a cone become effects with the GM\'s own shape, owned by the caster', () => {
  assert.deepEqual(playerEffect(circle(), scene(), 'alice').effect,
    { id: 'e1', type: 'circle', x: 400, y: 300, radius: 100, color: '#e5533d', opacity: 0.4, ownerId: 'alice' });
  assert.deepEqual(playerEffect({ id: 'e2', shape: 'rect', color: '#6fb4e8', x: 10, y: 20, width: 200, height: 100 }, scene(), 'alice').effect,
    { id: 'e2', type: 'rect', x: 10, y: 20, width: 200, height: 100, color: '#6fb4e8', opacity: 0.4, ownerId: 'alice' });
  const cone = playerEffect({ id: 'e3', shape: 'cone', color: '#8bd24f', x: 50, y: 60, radius: 150, angle: 90, rotation: -90 }, scene(), 'alice').effect;
  assert.deepEqual([cone.type, cone.radius, cone.angle, cone.rotation], ['cone', 150, 90, 270], 'a rotation is kept between 0 and 360');
});

test('sizes are clamped to what the grid allows, a point is kept on the map, and a bad colour becomes the first one', () => {
  const big = playerEffect(circle({ radius: 1e6, x: -50, y: 99999 }), scene(), 'alice').effect;
  assert.equal(big.radius, 50 * AREA_LIMITS.circle);
  assert.deepEqual([big.x, big.y], [0, 1500]);
  assert.equal(playerEffect(circle({ radius: 0.001 }), scene(), 'alice').effect.radius, 12.5, 'a quarter of a square at least');
  assert.equal(playerEffect({ id: 'c', shape: 'cone', color: '#fff000', x: 0, y: 0, radius: 100, angle: 500 }, scene(), 'alice').effect.angle, 180);
  assert.equal(playerEffect(circle({ color: 'red' }), scene(), 'alice').effect.color, PLAYER_AREA_COLORS[0]);
  assert.equal(playerEffect(circle({ color: '#ABCDEF' }), scene(), 'alice').effect.color, '#abcdef');
});

test('nonsense is invalid: a missing id, an unknown shape, a missing size or point', () => {
  for (const bad of [circle({ id: '' }), circle({ id: 'a b' }), circle({ shape: 'star' }), circle({ radius: undefined }), circle({ radius: NaN }), circle({ x: undefined }), circle({ y: 'low' }),
    { id: 'r', shape: 'rect', color: '#e5533d', x: 0, y: 0, width: 100 }]) {
    assert.equal(playerEffect(bad, scene(), 'alice').error, 'invalid', JSON.stringify(bad));
  }
  assert.equal(playerEffect(circle(), scene(), '').error, 'invalid', 'no caster');
  assert.equal(playerEffect(null, scene(), 'alice').error, 'invalid');
});

test('a bound circle has no position of its own and only goes on the caster\'s own visible hero', () => {
  const bound = playerEffect(circle({ boundTo: 'hero', x: undefined, y: undefined }), scene(), 'alice').effect;
  assert.deepEqual([bound.boundTo, bound.x, bound.y, bound.radius], ['hero', 0, 0, 100]);
  assert.equal(playerEffect(circle({ boundTo: 'friend' }), scene(), 'alice').error, 'blocked', 'another player\'s hero');
  assert.equal(playerEffect(circle({ boundTo: 'ghost' }), scene(), 'alice').error, 'blocked', 'a hidden hero would be given away');
  assert.equal(playerEffect(circle({ boundTo: 'nobody' }), scene(), 'alice').error, 'blocked');
  assert.equal(playerEffect({ ...circle({ boundTo: 'hero' }), shape: 'cone' }, scene(), 'alice').error, 'invalid', 'only circles can be bound');
  assert.equal(playerEffect(circle({ boundTo: 7 }), scene(), 'alice').error, 'invalid');
});

test('the same cast twice is one effect, a new bound circle replaces a hero\'s old one, and other players are untouched', () => {
  const first = playerEffect(circle({ id: 'b1', boundTo: 'hero' }), scene(), 'alice').effect;
  let list = addPlayerEffect([], first);
  assert.equal(addPlayerEffect(list, first).length, 1, 'a resent message adds nothing');
  const second = playerEffect(circle({ id: 'b2', boundTo: 'hero', radius: 200 }), scene(), 'alice').effect;
  list = addPlayerEffect(list, second);
  assert.deepEqual(list.map(effect => effect.id), ['b2'], 'one circle per hero');
  const bobs = playerEffect(circle({ id: 'b3', boundTo: 'friend' }), scene(), 'bob').effect;
  list = addPlayerEffect(list, bobs);
  assert.deepEqual(list.map(effect => effect.id).sort(), ['b2', 'b3']);
});

test('a player holds at most eight: the next cast takes down their oldest, and nobody else loses one', () => {
  let list = [{ id: 'gm', type: 'circle', x: 0, y: 0, radius: 50, color: '#fff' }, playerEffect(circle({ id: 'bob1' }), scene(), 'bob').effect];
  for (let i = 0; i < MAX_PLAYER_AREAS + 2; i += 1) list = addPlayerEffect(list, playerEffect(circle({ id: `a${i}` }), scene(), 'alice').effect);
  const mine = effectsOf(list, 'alice').map(effect => effect.id);
  assert.equal(mine.length, MAX_PLAYER_AREAS);
  assert.deepEqual(mine, ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'], 'the two oldest are gone');
  assert.ok(list.some(effect => effect.id === 'gm') && list.some(effect => effect.id === 'bob1'), 'the GM\'s and Bob\'s are still there');
});

test('taking back removes only the caster\'s own: one by id, or all of them', () => {
  const list = [
    playerEffect(circle({ id: 'a1' }), scene(), 'alice').effect, playerEffect(circle({ id: 'a2' }), scene(), 'alice').effect,
    playerEffect(circle({ id: 'b1' }), scene(), 'bob').effect, { id: 'gm', type: 'circle', x: 0, y: 0, radius: 50, color: '#fff' },
  ];
  assert.deepEqual(removePlayerEffects(list, 'alice', { id: 'a1' }).map(e => e.id), ['a2', 'b1', 'gm']);
  assert.deepEqual(removePlayerEffects(list, 'alice', { id: 'b1' }).map(e => e.id), ['a1', 'a2', 'b1', 'gm'], 'not hers');
  assert.deepEqual(removePlayerEffects(list, 'alice', { id: 'gm' }).map(e => e.id), ['a1', 'a2', 'b1', 'gm'], 'not the GM\'s');
  assert.deepEqual(removePlayerEffects(list, 'alice', { all: true }).map(e => e.id), ['b1', 'gm']);
  assert.deepEqual(removePlayerEffects(undefined, 'alice', { all: true }), []);
});

test('bound circles are grouped by hero and kept out of the free list', () => {
  const list = [
    playerEffect(circle({ id: 'a1', boundTo: 'hero' }), scene(), 'alice').effect, playerEffect(circle({ id: 'a2' }), scene(), 'alice').effect,
    playerEffect(circle({ id: 'b1', boundTo: 'friend' }), scene(), 'bob').effect,
  ];
  const auras = aurasByToken(list);
  assert.deepEqual([...auras.keys()].sort(), ['friend', 'hero']);
  assert.deepEqual(auras.get('hero').map(e => e.id), ['a1']);
  assert.equal(auras.get('nobody'), undefined);
  assert.deepEqual(freeEffects(list).map(e => e.id), ['a2']);
  assert.deepEqual(freeEffects(undefined), []);
});
