import test from 'node:test';
import assert from 'node:assert/strict';
import { projectForPlayers } from '../src/playerView.js';

const scene = () => ({
  mapImageSrc: '/__realm/assets/map', mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true,
  fogCells: ['10,10'], playerCanMoveTokens: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, imageSrc: '/__realm/assets/a', portraitSrc: '/__realm/assets/p',
      ownerId: 'alice', characterType: 'pc', npcId: 7, notes: 'secret', visibleToPlayers: true },
    { id: 'ambusher', name: 'Hidden Assassin', x: 100, y: 0, gridSize: 1, visibleToPlayers: false, characterType: 'npc' },
    { id: 'fogged', name: 'Behind Fog', x: 500, y: 500, gridSize: 1, characterType: 'npc' },
    { id: 'goblin', name: 'Goblin', x: 200, y: 0, gridSize: 1, characterType: 'npc' },
  ],
  markers: [
    { id: 'm1', type: 'star', x: 1, y: 1, size: 10, color: '#fff', visibleToPlayers: true, label: 'Door' },
    { id: 'm2', type: 'star', x: 2, y: 2, size: 10, color: '#fff', visibleToPlayers: false, label: 'Trap' },
  ],
  areaEffects: [{ id: 'e1', type: 'circle', x: 0, y: 0, radius: 100, color: '#f00' }],
  combat: { round: 3, activeId: 'goblin', entries: [
    { tokenId: 'hero', initiative: 15, hp: 8, maxHp: 20 },
    { tokenId: 'goblin', initiative: 10, hp: 3, maxHp: 7 },
    { tokenId: 'ambusher', initiative: 20, hp: 30, maxHp: 30 },
  ] },
  handoutSrc: null, handoutName: '',
});

test('players never receive hidden or fogged tokens, hidden markers, or private fields', () => {
  const view = projectForPlayers(scene());
  assert.deepEqual(view.tokens.map(t => t.id), ['hero', 'goblin']);
  assert.deepEqual(view.markers.map(m => m.id), ['m1']);
  const text = JSON.stringify(view);
  for (const secret of ['Hidden Assassin', 'Behind Fog', 'secret', 'Trap', 'npcId', 'characterType']) {
    assert.equal(text.includes(secret), false, `${secret} leaked`);
  }
});

test('NPC hit points are reduced to conditions and hidden combatants vanish from initiative', () => {
  const { combat } = projectForPlayers(scene());
  assert.deepEqual(combat.entries.map(e => e.tokenId).sort(), ['goblin', 'hero']);
  assert.equal(combat.entries.find(e => e.tokenId === 'goblin').hp, undefined);
  assert.equal(combat.entries.find(e => e.tokenId === 'goblin').condition, 'Badly wounded');
  assert.equal(combat.entries.find(e => e.tokenId === 'hero').hp, 8);
  assert.equal(combat.round, 3);
});

test('turning fog off reveals tokens and sends no fog cells', () => {
  const view = projectForPlayers({ ...scene(), showFog: false });
  assert.deepEqual(view.fogCells, []);
  assert.ok(view.tokens.some(t => t.id === 'fogged'));
});

test('a token whose portrait matches its art does not send the image twice', () => {
  const s = scene();
  s.tokens[0].portraitSrc = s.tokens[0].imageSrc;
  assert.equal(projectForPlayers(s).tokens[0].portraitSrc, undefined);
});

test('the projection is stable so unchanged scenes produce no patch', async () => {
  const { diffState } = await import('../src/syncPatch.js');
  assert.equal(diffState(projectForPlayers(scene()), projectForPlayers(scene())), null);
});

test('the hit points saved on a token never reach a player, only the combat view of them does', () => {
  const withHp = scene();
  withHp.tokens = withHp.tokens.map(token => ({ ...token, maxHp: 99 }));
  const view = projectForPlayers(withHp);
  for (const token of view.tokens) assert.equal('maxHp' in token, false, 'a token carries no maxHp to players');
  assert.equal(view.combat.entries.find(e => e.tokenId === 'goblin').maxHp, undefined, 'creature maximums stay hidden');
});
