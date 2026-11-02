// A player edits their own hero's hit points and initiative while a fight runs: over real sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../server/net/hub.js';
import { startTable } from '../test-support/fakeAccess.js';
import { applyPatch } from '../src/syncPatch.js';

const sceneFor = (owner, extra = {}) => ({
  mapImageSrc: '/__realm/assets/map', mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, ownerId: owner, visibleToPlayers: true, characterType: 'pc' },
    { id: 'goblin', name: 'Goblin', x: 500, y: 500, gridSize: 1, visibleToPlayers: true, characterType: 'npc' },
  ],
  markers: [], areaEffects: [],
  combat: { entries: [{ tokenId: 'hero', initiative: 12, hp: 18, maxHp: 20 }, { tokenId: 'goblin', initiative: 9, hp: 7, maxHp: 7 }], activeId: 'hero', round: 1 },
  ...extra,
});
const viewOf = client => {
  let state = null;
  for (const frame of client.frames) {
    if (frame.type === 'STATE_FULL') state = frame.state;
    else if (frame.type === 'STATE_PATCH') state = applyPatch(state, frame.patch);
  }
  return state ?? {};
};

async function seated(t) {
  const net = await startTable(t, createHub);
  const alice = net.device({ name: 'Alice' });
  const bob = net.device({ name: 'Bob' });
  const gm = net.gm();
  await gm.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  gm.send({ type: 'SCENE', scene: sceneFor(alice.playerId) });
  const a = net.player(alice);
  const b = net.player(bob);
  await Promise.all([a, b].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  return { ...net, alice, gm, a, b };
}

test('the owner changes hit points and initiative: acknowledged, sent to the GM, and everyone sees it', async t => {
  const { a, b, gm, alice } = await seated(t);
  a.send({ type: 'PLAYER_COMBAT_EDIT', aid: 1, tokenId: 'hero', hp: 11, initiative: 17 });
  await gm.until(c => c.of('PLAYER_COMBAT_EDIT').length === 1, 'the edit to reach the GM');
  assert.deepEqual(gm.of('PLAYER_COMBAT_EDIT')[0], { type: 'PLAYER_COMBAT_EDIT', playerId: alice.playerId, tokenId: 'hero', hp: 11, initiative: 17 });
  await a.until(c => c.of('ACK').length === 1);
  assert.deepEqual(a.of('ACK')[0], { type: 'ACK', ok: true, action: 'combat-edit', id: 'hero', aid: 1 });
  await b.until(c => viewOf(c).combat?.entries.find(e => e.tokenId === 'hero')?.initiative === 17, 'the other player to see it');
  assert.equal(viewOf(b).combat.entries.find(e => e.tokenId === 'hero').hp, 11);
});

test('another player, a creature, or a switched-off table cannot change a hero', async t => {
  const { a, b, gm, alice } = await seated(t);
  b.send({ type: 'PLAYER_COMBAT_EDIT', aid: 1, tokenId: 'hero', hp: 1 });
  await b.until(c => c.of('ACK').length === 1);
  assert.equal(b.of('ACK')[0].ok, false);
  a.send({ type: 'PLAYER_COMBAT_EDIT', aid: 1, tokenId: 'goblin', hp: 1 });
  await a.until(c => c.of('ACK').length === 1);
  assert.equal(a.of('ACK')[0].ok, false);
  gm.send({ type: 'SCENE', scene: sceneFor(alice.playerId, { playerCanEditCombat: false }) });
  await a.until(c => c.of('STATE_PATCH').length >= 1);
  a.send({ type: 'PLAYER_COMBAT_EDIT', aid: 2, tokenId: 'hero', hp: 1 });
  await a.until(c => c.of('ACK').length === 2);
  assert.deepEqual([a.of('ACK')[1].ok, a.of('ACK')[1].reason], [false, 'paused']);
  await delay(100);
  assert.equal(gm.of('PLAYER_COMBAT_EDIT').length, 0, 'the GM never heard of a refused edit');
});
