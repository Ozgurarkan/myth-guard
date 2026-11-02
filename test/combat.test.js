import test from 'node:test';
import assert from 'node:assert/strict';
import { turnOrder, delayedIds, delayTargets, emptyCombat, initiativeOrder, normalizeCombat, reduceCombat, playerCombat, healthCondition, healthLabel, bloodLevel, tokenKind, combatEntryFor } from '../src/combat.js';

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
  assert.deepEqual(npc, { tokenId: 'goblin', initiative: 10, condition: 'Severely injured' });
  assert.equal(healthLabel(npc), 'Severely injured');
  assert.equal(bloodLevel(npc), .8);
  assert.equal(combat.entries[1].hp, 3, 'GM HP is retained');
  state.tokens[1].characterType = 'pc';
  assert.equal(playerCombat(combat, state).entries[1].hp, 3);
});

test('NPC conditions cover full health, damage thresholds, down and unknown', () => {
  const cases = [[20, 'Healthy'], [19, 'Minor injury'], [16, 'Minor injury'], [15, 'Injured'], [11, 'Injured'], [10, 'Bloodied'], [5, 'Bloodied'],
    [4, 'Severely injured'], [3, 'Severely injured'], [2, 'Critically injured'], [1, 'Critically injured'], [0, 'Down']];
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

test('COMBAT_PATCH changes the initiative and hit points of an entry that exists, and nothing else', () => {
  let combat = add(add(emptyCombat(), 'ranger', 12), 'goblin', 18);
  combat = reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'ranger', hp: 5, initiative: 20 }, tokens);
  assert.deepEqual(combat.entries.find(e => e.tokenId === 'ranger'), { tokenId: 'ranger', initiative: 20, maxHp: 20, hp: 5 });
  assert.deepEqual(initiativeOrder(combat).map(e => e.tokenId), ['ranger', 'goblin'], 'the order follows the new initiative');
  assert.equal(reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'ranger', hp: 99 }, tokens).entries[0].hp, 20, 'hit points never pass the maximum');
  assert.equal(reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'ranger', hp: -4 }, tokens).entries.find(e => e.tokenId === 'ranger').hp, 0);
  assert.deepEqual(reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'mage', initiative: 3 }, tokens).entries.map(e => e.tokenId).sort(), ['goblin', 'ranger'], 'no entry is created');
  const noMax = reduceCombat(emptyCombat(), { type: 'COMBAT_UPSERT', entry: { tokenId: 'mage', initiative: 4, hp: null, maxHp: null } }, tokens);
  assert.equal(reduceCombat(noMax, { type: 'COMBAT_PATCH', tokenId: 'mage', hp: 9 }, tokens).entries[0].hp, null, 'no maximum: hit points are not invented');
});

test('COMBAT_PATCH can change the maximum: current hit points are kept but cut to fit, and a hero without any starts full', () => {
  let combat = add(emptyCombat(), 'ranger', 12, 15, 20);
  const entryOf = c => c.entries.find(e => e.tokenId === 'ranger');
  assert.deepEqual(entryOf(reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'ranger', maxHp: 30 }, tokens)), { tokenId: 'ranger', initiative: 12, maxHp: 30, hp: 15 }, 'a higher maximum leaves the hit points alone');
  assert.deepEqual(entryOf(reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'ranger', maxHp: 10 }, tokens)), { tokenId: 'ranger', initiative: 12, maxHp: 10, hp: 10 }, 'a lower one cuts them down');
  assert.equal(entryOf(reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'ranger', maxHp: 40, hp: 33 }, tokens)).hp, 33, 'both at once: the new maximum is the ceiling');
  assert.equal(entryOf(reduceCombat(combat, { type: 'COMBAT_PATCH', tokenId: 'ranger', maxHp: 0 }, tokens)).maxHp, 20, 'a maximum below 1 is ignored');
  const bare = reduceCombat(emptyCombat(), { type: 'COMBAT_UPSERT', entry: { tokenId: 'ranger', initiative: 5, hp: null, maxHp: null } }, tokens);
  assert.deepEqual(entryOf(reduceCombat(bare, { type: 'COMBAT_PATCH', tokenId: 'ranger', maxHp: 18 }, tokens)), { tokenId: 'ranger', initiative: 5, maxHp: 18, hp: 18 });
});

// ── Delaying a turn ─────────────────────────────────────────────────────────────────────────────────────────────────
const fight3 = () => {
  let combat = add(add(add(emptyCombat(), 'goblin', 18), 'ranger', 12), 'mage', 8);
  return next(combat); // the goblin starts
};
const ids = combat => turnOrder(combat).map(e => e.tokenId);
const delay = (combat, tokenId, after) => reduceCombat(combat, { type: 'COMBAT_DELAY', tokenId, after }, tokens);

test('a hero who delays acts right after the chosen combatant, the turn passes on, and next round the order is the usual one', () => {
  let combat = fight3();
  assert.equal(combat.activeId, 'goblin');
  combat = delay(combat, 'goblin', 'mage');
  assert.deepEqual(ids(combat), ['ranger', 'mage', 'goblin']);
  assert.equal(combat.activeId, 'ranger', 'the turn passes to whoever came next');
  assert.deepEqual(delayedIds(combat), ['goblin']);
  assert.deepEqual(initiativeOrder(combat).map(e => e.tokenId), ['goblin', 'ranger', 'mage'], 'initiative itself is untouched');
  combat = next(combat);
  assert.equal(combat.activeId, 'mage');
  combat = next(combat);
  assert.deepEqual([combat.activeId, combat.round], ['goblin', 1], 'the delayed hero acts after the one they chose');
  combat = next(combat);
  assert.deepEqual([combat.activeId, combat.round], ['goblin', 2], 'a new round starts with the usual first');
  assert.deepEqual(delayedIds(combat), []);
  assert.deepEqual(ids(combat), ['goblin', 'ranger', 'mage']);
  assert.equal('delays' in combat, false);
});

test('a delay lands right after the target in the middle of the order too, and Back walks the same order', () => {
  let combat = delay(fight3(), 'goblin', 'ranger');
  assert.deepEqual(ids(combat), ['ranger', 'goblin', 'mage']);
  assert.equal(combat.activeId, 'ranger');
  combat = next(combat);
  assert.equal(combat.activeId, 'goblin');
  combat = reduceCombat(combat, { type: 'COMBAT_PREVIOUS' }, tokens);
  assert.equal(combat.activeId, 'ranger');
});

test('delaying is refused off turn, backwards, to oneself, to a stranger, or twice in a round', () => {
  const start = fight3();
  assert.deepEqual(delay(start, 'ranger', 'mage'), start, 'it is not the ranger’s turn');
  assert.deepEqual(delay(start, 'goblin', 'goblin'), start);
  assert.deepEqual(delay(start, 'goblin', 'nobody'), start);
  let atRanger = next(start);
  assert.equal(delay(atRanger, 'ranger', 'goblin').activeId, 'ranger', 'the goblin already acted this round: nothing changes');
  const once = delay(start, 'goblin', 'ranger');
  const goblinAgain = next(once);
  assert.equal(goblinAgain.activeId, 'goblin');
  assert.deepEqual(delay(goblinAgain, 'goblin', 'mage'), goblinAgain, 'once per round');
});

// Heroes wait for heroes, creatures for creatures.
const mixedTokens = [
  { id: 'aria', characterType: 'pc' }, { id: 'orc', characterType: 'npc' }, { id: 'bran', characterType: 'pc' }, { id: 'imp', characterType: 'npc' },
].map(token => ({ ...token, x: 0, y: 0, gridSize: 1 }));
const mixedFight = () => {
  let combat = emptyCombat();
  for (const [tokenId, initiative] of [['aria', 20], ['orc', 15], ['bran', 10], ['imp', 5]]) {
    combat = reduceCombat(combat, { type: 'COMBAT_UPSERT', entry: { tokenId, initiative, hp: 9, maxHp: 9 } }, mixedTokens);
  }
  return reduceCombat(combat, { type: 'COMBAT_NEXT' }, mixedTokens); // aria starts
};
const delayMixed = (combat, tokenId, after) => reduceCombat(combat, { type: 'COMBAT_DELAY', tokenId, after }, mixedTokens);

test('a hero can only delay behind a later hero, never a creature', () => {
  const start = mixedFight();
  assert.equal(start.activeId, 'aria');
  assert.deepEqual(delayTargets(start, mixedTokens, 'aria').map(e => e.tokenId), ['bran'], 'the orc and the imp are not offered');
  assert.deepEqual(delayMixed(start, 'aria', 'orc'), start, 'a hero does not wait for a creature');
  assert.deepEqual(delayMixed(start, 'aria', 'imp'), start);
  const waited = delayMixed(start, 'aria', 'bran');
  assert.deepEqual(ids(waited), ['orc', 'bran', 'aria', 'imp']);
  assert.equal(waited.activeId, 'orc', 'the turn passes on at once');
});

test('a creature can only delay behind a later creature, never a hero', () => {
  const atOrc = reduceCombat(mixedFight(), { type: 'COMBAT_NEXT' }, mixedTokens);
  assert.equal(atOrc.activeId, 'orc');
  assert.deepEqual(delayTargets(atOrc, mixedTokens, 'orc').map(e => e.tokenId), ['imp'], 'bran is a hero, so he is not offered');
  assert.deepEqual(delayMixed(atOrc, 'orc', 'bran'), atOrc, 'a creature does not wait for a hero');
  const waited = delayMixed(atOrc, 'orc', 'imp');
  assert.deepEqual(ids(waited), ['aria', 'bran', 'imp', 'orc']);
  assert.equal(waited.activeId, 'bran');
  assert.deepEqual(delayedIds(waited), ['orc']);
  assert.deepEqual(delayTargets(waited, mixedTokens, 'bran').map(e => e.tokenId), [], 'no other hero comes later');
  assert.deepEqual(delayTargets(waited, mixedTokens, 'nobody'), []);
});

test('on a player screen, where tokens carry no type, creatures are still told apart by their condition', () => {
  const state = { gridSize: 50, showFog: false, fogCells: [], tokens: mixedTokens };
  const seen = playerCombat(mixedFight(), state);
  const untyped = mixedTokens.map(({ characterType, ...token }) => token); // what a player is sent
  assert.equal(untyped.some(token => 'characterType' in token), false);
  assert.deepEqual(delayTargets(seen, untyped, 'aria').map(e => e.tokenId), ['bran'], 'the orc and the imp are not offered to a hero');
  assert.deepEqual(delayTargets(seen, untyped, 'bran').map(e => e.tokenId), [], 'bran has no later hero');
});

test('removing a combatant who is waited for puts the delayed hero back in their place', () => {
  const combat = delay(fight3(), 'goblin', 'mage');
  const removed = reduceCombat(combat, { type: 'COMBAT_REMOVE', id: 'mage' }, tokens);
  assert.deepEqual(ids(removed), ['goblin', 'ranger']);
  assert.equal(removed.delays, undefined);
});

test('players get the finished order of what they can see, never the delay that names a hidden creature', () => {
  const state = {
    gridSize: 50, showFog: false, fogCells: [],
    tokens: [{ id: 'ranger', x: 0, y: 0, gridSize: 1 }, { id: 'goblin', x: 0, y: 0, gridSize: 1 }, { id: 'mage', x: 0, y: 0, gridSize: 1, visibleToPlayers: false }],
  };
  const combat = delay(fight3(), 'goblin', 'mage');
  const seen = playerCombat(combat, state);
  assert.deepEqual(seen.order, ['ranger', 'goblin'], 'the hidden mage is not in the list');
  assert.deepEqual(seen.delayed, ['goblin']);
  assert.equal('delays' in seen, false);
  assert.equal(JSON.stringify(seen).includes('"after"'), false);
  assert.deepEqual(turnOrder(seen).map(e => e.tokenId), ['ranger', 'goblin']);
  const plain = playerCombat(fight3(), state);
  assert.equal('order' in plain, false, 'no delay, no extra fields');
});
