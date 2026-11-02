// Delaying a turn over real sockets: the owner waits until after another hero who comes later in the round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../server/net/hub.js';
import { startTable } from '../test-support/fakeAccess.js';
import { applyPatch } from '../src/syncPatch.js';

const sceneFor = (owner, friendOwner) => ({
  mapImageSrc: '/__realm/assets/map', mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, ownerId: owner, visibleToPlayers: true, characterType: 'pc' },
    { id: 'orc', name: 'Orc', x: 500, y: 500, gridSize: 1, visibleToPlayers: true, characterType: 'npc' },
    { id: 'lurker', name: 'Lurker', x: 700, y: 500, gridSize: 1, visibleToPlayers: false, characterType: 'npc' },
    { id: 'drow', name: 'Drow', x: 900, y: 500, gridSize: 1, visibleToPlayers: true, characterType: 'npc' },
    { id: 'friend', name: 'Bran', x: 1100, y: 500, gridSize: 1, ownerId: friendOwner, visibleToPlayers: true, characterType: 'pc' },
  ],
  markers: [], areaEffects: [],
  combat: { entries: [
    { tokenId: 'hero', initiative: 20, hp: 10, maxHp: 10 }, { tokenId: 'orc', initiative: 15, hp: 5, maxHp: 5 },
    { tokenId: 'lurker', initiative: 12, hp: 5, maxHp: 5 }, { tokenId: 'drow', initiative: 5, hp: 5, maxHp: 5 }, { tokenId: 'friend', initiative: 3, hp: 8, maxHp: 8 },
  ], activeId: 'hero', round: 1 },
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
  gm.send({ type: 'SCENE', scene: sceneFor(alice.playerId, bob.playerId) });
  const a = net.player(alice);
  const b = net.player(bob);
  await Promise.all([a, b].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  return { ...net, alice, bob, gm, a, b };
}

test('the active hero waits for a later hero: acknowledged, sent to the GM, and every screen sees the new order', async t => {
  const { a, b, gm, alice } = await seated(t);
  a.send({ type: 'PLAYER_DELAY_TURN', aid: 1, tokenId: 'hero', after: 'friend' });
  await gm.until(c => c.of('PLAYER_DELAY_TURN').length === 1, 'the delay to reach the GM');
  assert.deepEqual(gm.of('PLAYER_DELAY_TURN')[0], { type: 'PLAYER_DELAY_TURN', playerId: alice.playerId, tokenId: 'hero', after: 'friend' });
  await a.until(c => c.of('ACK').length === 1);
  assert.deepEqual(a.of('ACK')[0], { type: 'ACK', ok: true, action: 'delay-turn', id: 'hero', aid: 1 });
  await b.until(c => viewOf(c).combat?.delayed?.includes('hero'), 'the other player to see the delay');
  const combat = viewOf(b).combat;
  assert.deepEqual(combat.order, ['orc', 'drow', 'friend', 'hero'], 'the hidden lurker is not in the order players are sent');
  assert.equal(combat.activeId, 'orc');
  assert.equal(JSON.stringify(viewOf(b)).includes('lurker'), false, 'nothing about the hidden creature reaches a player');
});

test('another player, waiting behind a creature, or naming a hidden creature is refused and the GM never hears of it', async t => {
  const { a, b, gm } = await seated(t);
  b.send({ type: 'PLAYER_DELAY_TURN', aid: 1, tokenId: 'hero', after: 'friend' });
  a.send({ type: 'PLAYER_DELAY_TURN', aid: 1, tokenId: 'hero', after: 'orc' });
  a.send({ type: 'PLAYER_DELAY_TURN', aid: 2, tokenId: 'hero', after: 'lurker' });
  await a.until(x => x.of('ACK').length === 2);
  await b.until(x => x.of('ACK').length === 1);
  assert.deepEqual(a.of('ACK').map(ack => ack.ok), [false, false]);
  assert.equal(b.of('ACK')[0].ok, false);
  await delay(100);
  assert.equal(gm.of('PLAYER_DELAY_TURN').length, 0);
});
