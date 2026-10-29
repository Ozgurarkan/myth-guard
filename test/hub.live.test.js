// A token that is being dragged is shown to the others while the hand is still down (PLAYER_TOKEN_LIVE / GM_TOKEN_LIVE ->
// TOKEN_LIVE). Nothing is stored, and the privacy rule of the scene projection holds for every frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../server/net/hub.js';
import { startTable } from '../test-support/fakeAccess.js';

const table = (t, options) => startTable(t, createHub, options);

const sceneFor = owner => ({
  mapImageSrc: '/__realm/assets/map', mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: ['20,20'],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, ownerId: owner, visibleToPlayers: true },
    { id: 'goblin', name: 'Goblin', x: 500, y: 500, gridSize: 1, visibleToPlayers: true },
    { id: 'ambusher', name: 'Assassin', x: 100, y: 0, gridSize: 1, visibleToPlayers: false },
    { id: 'lurker', name: 'Lurker', x: 1000, y: 1000, gridSize: 1, visibleToPlayers: true },   // under fog cell 20,20
  ],
  markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 },
});

async function seated(t) {
  const net = await table(t);
  const alice = net.device({ name: 'Alice' });
  const bob = net.device({ name: 'Bob' });
  const gm = net.gm();
  await gm.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  gm.send({ type: 'SCENE', scene: sceneFor(alice.playerId) });
  const a = net.player(alice);
  const b = net.player(bob);
  await Promise.all([a, b].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  return { ...net, alice, bob, gm, a, b };
}

test('a hero dragged by its player is shown to the other players and the GM, never echoed back', async t => {
  const { a, b, gm, alice } = await seated(t);
  a.send({ type: 'PLAYER_TOKEN_LIVE', id: 'hero', x: 120, y: 80 });
  await Promise.all([b, gm].map(c => c.until(x => x.of('TOKEN_LIVE').length === 1, 'the live position')));
  assert.deepEqual(b.of('TOKEN_LIVE')[0], { type: 'TOKEN_LIVE', id: 'hero', x: 120, y: 80 });
  assert.deepEqual(gm.of('TOKEN_LIVE')[0], { type: 'TOKEN_LIVE', id: 'hero', x: 120, y: 80, playerId: alice.playerId });
  await delay(120);
  assert.equal(a.of('TOKEN_LIVE').length, 0, 'the sender already shows its own drag');
});

test('a player cannot stream a token that is not theirs, is hidden, or stands under fog', async t => {
  const { a, b, gm } = await seated(t);
  for (const id of ['goblin', 'ambusher', 'lurker', 'nobody']) a.send({ type: 'PLAYER_TOKEN_LIVE', id, x: 300, y: 300 });
  a.send({ type: 'PLAYER_TOKEN_LIVE', id: 'hero', x: 1010, y: 1010 });   // dragged into fog: it would vanish on the drop
  await delay(200);
  assert.equal(b.of('TOKEN_LIVE').length, 0);
  assert.equal(gm.of('TOKEN_LIVE').length, 0);
});

test('live drags stop while the GM has paused player movement', async t => {
  const { a, b, gm, alice } = await seated(t);
  gm.send({ type: 'SCENE', scene: { ...sceneFor(alice.playerId), playerCanMoveTokens: false } });
  await a.until(c => c.of('STATE_PATCH').length >= 1);
  a.send({ type: 'PLAYER_TOKEN_LIVE', id: 'hero', x: 50, y: 50 });
  await delay(200);
  assert.equal(b.of('TOKEN_LIVE').length, 0);
});

test('the GM dragging a visible token is shown to every player, clamped to the map', async t => {
  const { a, b, gm } = await seated(t);
  gm.send({ type: 'GM_TOKEN_LIVE', id: 'goblin', x: 640, y: 99999 });
  await Promise.all([a, b].map(c => c.until(x => x.of('TOKEN_LIVE').length === 1, 'the live position')));
  assert.deepEqual(a.of('TOKEN_LIVE')[0], { type: 'TOKEN_LIVE', id: 'goblin', x: 640, y: 1500 });
  assert.deepEqual(b.of('TOKEN_LIVE')[0], { type: 'TOKEN_LIVE', id: 'goblin', x: 640, y: 1500 });
});

test('canary: the GM dragging a hidden or fogged token tells the players nothing', async t => {
  const { a, b, gm } = await seated(t);
  gm.send({ type: 'GM_TOKEN_LIVE', id: 'ambusher', x: 400, y: 400 });      // hidden from players
  gm.send({ type: 'GM_TOKEN_LIVE', id: 'lurker', x: 1010, y: 1010 });      // still under fog
  gm.send({ type: 'GM_TOKEN_LIVE', id: 'goblin', x: 1010, y: 1010 });      // a visible token dragged into fog
  gm.send({ type: 'GM_TOKEN_LIVE', id: 'unknown', x: 1, y: 1 });
  await delay(250);
  for (const c of [a, b]) {
    assert.equal(c.of('TOKEN_LIVE').length, 0);
    assert.ok(!JSON.stringify(c.frames).includes('"ambusher","x":400'), 'no trace of the hidden token position');
  }
});

test('live drags are not stored: the scene the players hold does not move until the drop', async t => {
  const { a, b, gm } = await seated(t);
  gm.send({ type: 'GM_TOKEN_LIVE', id: 'goblin', x: 700, y: 700 });
  await b.until(x => x.of('TOKEN_LIVE').length === 1);
  assert.equal(b.of('STATE_PATCH').length, 0, 'no patch was produced by a live frame');
  a.send({ type: 'PLAYER_TOKEN_LIVE', id: 'hero', x: 200, y: 200 });
  await gm.until(x => x.of('TOKEN_LIVE').length === 1);
  assert.equal(b.of('STATE_PATCH').length, 0);
});
