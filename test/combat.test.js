import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCombat, initiativeOrder, normalizeCombat, reduceCombat, playerCombat, healthCondition, healthLabel, bloodLevel, tokenKind, combatEntryFor } from '../src/combat.js';

const tokens = ['ranger', 'goblin', 'mage'].map(id => ({ id, x: 0, y: 0, gridSize: 1 }));
const add = (combat, tokenId, initiative, hp = 20, maxHp = 20) => reduceCombat(combat, {
  type: 'COMBAT_UPSERT', entry: { tokenId, initiative, hp, maxHp },
}, tokens);
const next = combat => reduceCombat(combat, { type: 'COMBAT_NEXT' }, tokens);

test('initiative sorts descending with stable ties and updates preserve the active character', () => {
  let combat = add(add(add(emptyCombat(), 'ranger', 12), 'goblin', 18), 'mage', 12);
  assert.deepEqual(initiativeOrder(combat).map(e => e.tokenId), ['goblin', 'ranger', 'mage']);
  combat = next(combat);
  combat = add(combat, 'goblin', 5);
  assert.equal(combat.activeId, 'goblin');
  assert.equal(combat.entries.length, 3);
});

test('turns wrap into new rounds and previous reverses the transition', () => {
  let combat = add(add(emptyCombat(), 'ranger', 15), 'goblin', 10);
  combat = next(combat);
  assert.equal(combat.activeId, 'ranger');
  assert.equal(combat.round, 1);
  combat = next(next(combat));
  assert.equal(combat.round, 2);
  assert.equal(combat.activeId, 'ranger');
  combat = reduceCombat(combat, { type: 'COMBAT_PREVIOUS' }, tokens);
  assert.equal(combat.round, 1);
  assert.equal(combat.activeId, 'goblin');
});

test('removing the active last combatant advances the round; removing all resets', () => {
  let combat = next(next(add(add(emptyCombat(), 'ranger', 15), 'goblin', 10)));
  combat = reduceCombat(combat, { type: 'COMBAT_REMOVE', id: 'goblin' }, tokens);
  assert.equal(combat.round, 2);
  assert.equal(combat.activeId, 'ranger');
  combat = reduceCombat(combat, { type: 'COMBAT_REMOVE', id: 'ranger' }, tokens);
  assert.deepEqual(combat, emptyCombat());
});

test('HP clamps safely and old saves or removed tokens cannot leave ghost turns', () => {
  assert.deepEqual(normalizeCombat(undefined, tokens), emptyCombat());
  let combat = add(emptyCombat(), 'ranger', 0, 50, 20);
  assert.equal(combat.entries[0].hp, 20);
  combat = add(combat, 'ranger', 0, -10, 20);
  assert.equal(combat.entries[0].hp, 0);
  combat = add(combat, 'ranger', 0, null, null);
  assert.equal(combat.entries[0].maxHp, null);
  assert.equal(combat.entries[0].hp, null);
  assert.deepEqual(normalizeCombat(next(combat), []), emptyCombat());
});

test('player initiative excludes hidden and fog-covered tokens, including the active identity', () => {
  const combat = next(add(add(emptyCombat(), 'ranger', 20), 'goblin', 10));
  const state = { tokens: [{ ...tokens[0], visibleToPlayers: false }, { ...tokens[1], x: 50 }], showFog: true, fogCells: ['1,0'], gridSize: 50 };
  const publicCombat = playerCombat(combat, state);
  assert.equal(publicCombat.entries.length, 0);
  assert.equal(publicCombat.activeId, null);
  state.fogCells = [];
  assert.deepEqual(playerCombat(combat, state).entries.map(e => e.tokenId), ['goblin']);
});

test('NPC health is replaced with condition-only data while PCs retain numeric HP', () => {
  const combat = add(add(emptyCombat(), 'ranger', 20, 7, 20), 'goblin', 10, 3, 20);
  const state = { tokens: [tokens[0], { ...tokens[1], characterType: 'npc' }], showFog: false, fogCells: [], gridSize: 50 };
  const [pc, npc] = playerCombat(combat, state).entries;
  assert.equal(pc.hp, 7);
  assert.equal(healthLabel(pc), '7 / 20 HP');
  assert.deepEqual(npc, { tokenId: 'goblin', initiative: 10, condition: 'Almost dead' });
  assert.equal(healthLabel(npc), 'Almost dead');
  assert.equal(bloodLevel(npc), .85);
  assert.equal(combat.entries[1].hp, 3, 'GM HP is retained');
  state.tokens[1].characterType = 'pc';
  assert.equal(playerCombat(combat, state).entries[1].hp, 3);
});

test('NPC conditions cover full health, damage thresholds, down and unknown', () => {
  const cases = [[20, 'Healthy'], [19, 'Wounded'], [11, 'Wounded'], [10, 'Badly wounded'], [6, 'Badly wounded'], [5, 'Almost dead'], [1, 'Almost dead'], [0, 'Down']];
  for (const [hp, condition] of cases) assert.equal(healthCondition({ hp, maxHp: 20 }), condition);
  assert.equal(healthCondition({ hp: null, maxHp: null }), 'Unknown');
  assert.equal(bloodLevel({ condition: 'Down' }), 1);
  assert.equal(tokenKind({ category: 'NPC' }), 'npc');
  assert.equal(tokenKind({ characterType: 'pc', category: 'NPC' }), 'pc');
});

test('a token joins combat at full health from the hit points saved on it', () => {
  assert.deepEqual(combatEntryFor({ id: 'goblin', maxHp: 7 }, 12), { tokenId: 'goblin', initiative: 12, hp: 7, maxHp: 7 });
  assert.deepEqual(combatEntryFor({ id: 'hero', maxHp: 20.9 }, 3), { tokenId: 'hero', initiative: 3, hp: 20, maxHp: 20 });
  // No hit points saved (or nonsense): the old behaviour, health left for the GM to fill in.
  for (const maxHp of [undefined, null, 0, -4, NaN, '12']) {
    assert.deepEqual(combatEntryFor({ id: 'x', maxHp }, 5), { tokenId: 'x', initiative: 5, hp: null, maxHp: null });
  }
  const tokens = [{ id: 'goblin', maxHp: 7 }];
  const combat = reduceCombat(emptyCombat(), { type: 'COMBAT_UPSERT', entry: combatEntryFor(tokens[0], 12) }, tokens);
  assert.equal(combat.entries[0].hp, 7);
  assert.equal(combat.entries[0].maxHp, 7);
});
