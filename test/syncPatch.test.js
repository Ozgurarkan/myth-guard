import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, diffState, isEqual } from '../src/syncPatch.js';

const token = (id, x = 0, y = 0) => ({ id, x, y, gridSize: 1, name: id });
const base = () => ({
  mapWidth: 2000, showGrid: true, playerViewRect: { x: 0, y: 0, width: 800, height: 600 },
  tokens: [token('a'), token('b', 100), token('c', 200)],
  markers: [], areaEffects: [], fogCells: ['0,0', '1,0', '2,0'],
});
const roundTrip = (prev, next) => {
  const patch = diffState(prev, next);
  // Patches cross the network as JSON.
  const received = patch && JSON.parse(JSON.stringify(patch));
  return { patch, result: received ? applyPatch(prev, received) : prev };
};

test('identical states produce no patch', () => {
  assert.equal(diffState(base(), base()), null);
  assert.equal(diffState(null, base()), null);
});

test('moving one token sends only that token', () => {
  const next = base();
  next.tokens = next.tokens.map(t => (t.id === 'b' ? { ...t, x: 150 } : t));
  const { patch, result } = roundTrip(base(), next);
  assert.deepEqual(Object.keys(patch), ['coll']);
  assert.deepEqual(patch.coll.tokens.put.map(t => t.id), ['b']);
  assert.equal(patch.coll.tokens.order, undefined);
  assert.deepEqual(result, next);
});

test('adding, removing and reordering tokens round-trip', () => {
  const next = base();
  next.tokens = [token('c', 200), token('d', 5), token('a')];
  const { patch, result } = roundTrip(base(), next);
  assert.deepEqual(patch.coll.tokens.rm, ['b']);
  assert.deepEqual(result.tokens.map(t => t.id), ['c', 'd', 'a']);
  assert.deepEqual(result, next);
});

test('fog strokes send only the cells that changed', () => {
  const next = base();
  next.fogCells = ['0,0', '2,0', '3,0', '4,0'];
  const { patch, result } = roundTrip(base(), next);
  assert.deepEqual(patch.sets.fogCells, { add: ['3,0', '4,0'], rm: ['1,0'] });
  assert.deepEqual([...result.fogCells].sort(), [...next.fogCells].sort());
});

test('scalars, nested objects and deleted keys are replaced or removed', () => {
  const next = base();
  next.showGrid = false;
  next.playerViewRect = { x: 10, y: 0, width: 800, height: 600 };
  delete next.mapWidth;
  const { patch, result } = roundTrip(base(), next);
  assert.deepEqual(patch.del, ['mapWidth']);
  assert.deepEqual(result, next);
});

test('untouched items keep their identity so the player UI can skip re-rendering them', () => {
  const before = base();
  const next = { ...before, tokens: before.tokens.map(t => (t.id === 'a' ? { ...t, x: 9 } : t)) };
  const result = applyPatch(before, JSON.parse(JSON.stringify(diffState(before, next))));
  assert.equal(result.tokens[1], before.tokens[1]);
  assert.equal(result.tokens[2], before.tokens[2]);
  assert.notEqual(result.tokens[0], before.tokens[0]);
  assert.equal(result.playerViewRect, before.playerViewRect);
});

test('duplicate or missing ids fall back to whole-array replacement', () => {
  const prev = { tokens: [{ id: 'a', x: 1 }, { id: 'a', x: 2 }] };
  const next = { tokens: [{ id: 'a', x: 1 }, { id: 'a', x: 3 }] };
  const { patch, result } = roundTrip(prev, next);
  assert.ok(patch.set.tokens);
  assert.deepEqual(result, next);
});

test('random edit sequences always reproduce the exact next state', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let state = base();
  let mirror = base();
  for (let step = 0; step < 300; step++) {
    const next = structuredClone(state);
    const roll = random();
    if (roll < 0.3 && next.tokens.length) next.tokens[Math.floor(random() * next.tokens.length)].x += 1;
    else if (roll < 0.45) next.tokens.push(token(`t${step}`, step));
    else if (roll < 0.55 && next.tokens.length) next.tokens.splice(Math.floor(random() * next.tokens.length), 1);
    else if (roll < 0.65 && next.tokens.length > 1) next.tokens.reverse();
    else if (roll < 0.85) next.fogCells.push(`${step},${step}`);
    else if (roll < 0.9 && next.fogCells.length) next.fogCells.pop();
    else next.showGrid = !next.showGrid;
    const patch = diffState(state, next);
    if (patch) mirror = applyPatch(mirror, JSON.parse(JSON.stringify(patch)));
    state = next;
    assert.equal(isEqual(Object.assign({}, mirror, { fogCells: [...mirror.fogCells].sort() }),
      Object.assign({}, state, { fogCells: [...state.fogCells].sort() })), true, `step ${step}`);
  }
});
