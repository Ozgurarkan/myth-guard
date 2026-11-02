// Spell areas over real sockets: a player casts (a free area, or a circle bound to their hero), the GM is told, every screen sees it,
// and the table's rules hold: only your own hero, only your own areas to take back, nothing about a hidden token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../server/net/hub.js';
import { startTable } from '../test-support/fakeAccess.js';
import { applyPatch } from '../src/syncPatch.js';

const sceneFor = (owner, friendOwner, extra = {}) => ({
  mapImageSrc: '/__realm/assets/map', mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 100, y: 100, gridSize: 1, ownerId: owner, visibleToPlayers: true, characterType: 'pc' },
    { id: 'friend', name: 'Bran', x: 600, y: 100, gridSize: 1, ownerId: friendOwner, visibleToPlayers: true, characterType: 'pc' },
    { id: 'lurker', name: 'Lurker', x: 900, y: 500, gridSize: 1, visibleToPlayers: false, characterType: 'npc' },
  ],
  markers: [], areaEffects: [{ id: 'gmfx', type: 'circle', x: 1000, y: 1000, radius: 80, color: '#ffffff', opacity: 0.4 }], combat: null,
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

async function seated(t, extra) {
  const net = await startTable(t, createHub);
  const alice = net.device({ name: 'Alice' });
  const bob = net.device({ name: 'Bob' });
  const gm = net.gm();
  await gm.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  gm.send({ type: 'SCENE', scene: sceneFor(alice.playerId, bob.playerId, extra) });
  const a = net.player(alice);
  const b = net.player(bob);
  await Promise.all([a, b].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  return { ...net, alice, bob, gm, a, b };
}

test('a bound circle: acknowledged, sent to the GM, and every screen sees it tied to the hero', async t => {
  const { a, b, gm, alice } = await seated(t);
  a.send({ type: 'PLAYER_AREA_ADD', aid: 1, id: 'aura1', shape: 'circle', color: '#6fb4e8', radius: 150, boundTo: 'hero' });
  await gm.until(c => c.of('PLAYER_AREA_ADD').length === 1, 'the cast to reach the GM');
  assert.deepEqual(gm.of('PLAYER_AREA_ADD')[0], { type: 'PLAYER_AREA_ADD', playerId: alice.playerId, id: 'aura1', shape: 'circle', color: '#6fb4e8', radius: 150, boundTo: 'hero' });
  await a.until(c => c.of('ACK').length === 1);
  assert.deepEqual(a.of('ACK')[0], { type: 'ACK', ok: true, action: 'area-add', id: 'aura1', aid: 1 });
  await b.until(c => viewOf(c).areaEffects?.some(effect => effect.id === 'aura1'), 'the other player to see the circle');
  const aura = viewOf(b).areaEffects.find(effect => effect.id === 'aura1');
  assert.deepEqual([aura.type, aura.boundTo, aura.radius, aura.ownerId], ['circle', 'hero', 150, alice.playerId]);
  assert.ok(viewOf(b).areaEffects.some(effect => effect.id === 'gmfx'), 'the GM\'s own area is still there');
});

test('a free area and a cone are stored at their place with their own look', async t => {
  const { a, b } = await seated(t);
  a.send({ type: 'PLAYER_AREA_ADD', aid: 1, id: 'cone1', shape: 'cone', color: '#e5533d', x: 300, y: 400, radius: 300, angle: 90, rotation: 45 });
  await b.until(c => viewOf(c).areaEffects?.some(effect => effect.id === 'cone1'), 'the cone to appear');
  const cone = viewOf(b).areaEffects.find(effect => effect.id === 'cone1');
  assert.deepEqual([cone.type, cone.x, cone.y, cone.angle, cone.rotation, cone.color], ['cone', 300, 400, 90, 45, '#e5533d']);
});

test('binding to someone else\'s hero or a hidden token, and casting with no hero, are refused and the GM never hears of it', async t => {
  const { a, b, gm } = await seated(t);
  a.send({ type: 'PLAYER_AREA_ADD', aid: 1, id: 'x1', shape: 'circle', color: '#e5533d', radius: 100, boundTo: 'friend' });
  a.send({ type: 'PLAYER_AREA_ADD', aid: 2, id: 'x2', shape: 'circle', color: '#e5533d', radius: 100, boundTo: 'lurker' });
  await a.until(c => c.of('ACK').length === 2);
  assert.deepEqual(a.of('ACK').map(ack => ack.ok), [false, false]);
  await delay(100);
  assert.equal(gm.of('PLAYER_AREA_ADD').length, 0);
  assert.equal(viewOf(b).areaEffects.length, 1, 'only the GM\'s area');
});

test('you can only take back your own areas; the GM\'s and other players\' stay', async t => {
  const { a, b, gm } = await seated(t);
  a.send({ type: 'PLAYER_AREA_ADD', aid: 1, id: 'mine', shape: 'circle', color: '#e5533d', x: 400, y: 400, radius: 100 });
  b.send({ type: 'PLAYER_AREA_ADD', aid: 1, id: 'bobs', shape: 'rect', color: '#6fb4e8', x: 800, y: 400, width: 100, height: 100 });
  await b.until(c => ['mine', 'bobs'].every(id => viewOf(c).areaEffects?.some(effect => effect.id === id)), 'both casts');
  a.send({ type: 'PLAYER_AREA_REMOVE', aid: 2, id: 'bobs' });
  a.send({ type: 'PLAYER_AREA_REMOVE', aid: 3, id: 'gmfx' });
  await a.until(c => c.of('ACK').filter(ack => ack.aid >= 2).length === 2);
  assert.deepEqual(a.of('ACK').filter(ack => ack.aid >= 2).map(ack => ack.ok), [false, false]);
  a.send({ type: 'PLAYER_AREA_REMOVE', aid: 4, id: 'mine' });
  await gm.until(c => c.of('PLAYER_AREA_REMOVE').length === 1, 'the take-back to reach the GM');
  assert.equal(gm.of('PLAYER_AREA_REMOVE')[0].id, 'mine');
  await b.until(c => !viewOf(c).areaEffects?.some(effect => effect.id === 'mine'), 'the area to disappear');
  assert.deepEqual(viewOf(b).areaEffects.map(effect => effect.id).sort(), ['bobs', 'gmfx']);
  b.send({ type: 'PLAYER_AREA_REMOVE', aid: 2, all: true });
  await b.until(c => !viewOf(c).areaEffects?.some(effect => effect.id === 'bobs'), 'all of Bob\'s to go');
  assert.deepEqual(viewOf(b).areaEffects.map(effect => effect.id), ['gmfx']);
});

test('while the GM has casting switched off nothing is accepted and the GM never hears of it', async t => {
  const { a, gm } = await seated(t, { playerCanCast: false });
  assert.equal(viewOf(a).playerCanCast, false);
  a.send({ type: 'PLAYER_AREA_ADD', aid: 1, id: 'no', shape: 'circle', color: '#e5533d', x: 1, y: 1, radius: 100 });
  await a.until(c => c.of('ACK').length === 1);
  assert.equal(a.of('ACK')[0].ok, false);
  assert.equal(a.of('ACK')[0].reason, 'paused');
  await delay(80);
  assert.equal(gm.of('PLAYER_AREA_ADD').length, 0);
});
