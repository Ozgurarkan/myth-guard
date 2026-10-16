// Player actions over real sockets. Re-proves sessionSync.test.js tests 4 (moves: owner only, pause, fog, no SCENE from
// players), 5 (moves refused while the GM is away), 10 (pings) and 11 (end turn), and adds the idempotent action ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../server/net/hub.js';
import { startTable } from '../test-support/fakeAccess.js';
import { CLOSE } from '../src/net/protocol.js';
import { applyPatch } from '../src/syncPatch.js';

const table = (t, options) => startTable(t, createHub, options);

const baseScene = (owner, extra = {}) => ({
  mapImageSrc: '/__realm/assets/map', mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, ownerId: owner, visibleToPlayers: true },
    { id: 'ambusher', name: 'Hidden Assassin', x: 100, y: 0, gridSize: 1, visibleToPlayers: false },
  ],
  markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 },
  ...extra,
});

/** What a client's screen shows: its snapshot with every patch applied. */
function viewOf(client) {
  let state = null;
  for (const frame of client.frames) {
    if (frame.type === 'STATE_FULL') state = frame.state;
    else if (frame.type === 'STATE_PATCH') state = applyPatch(state, frame.patch);
  }
  return state ?? {};
}

/** A GM and two players at the table; Alice owns 'hero'. */
async function seated(t, options) {
  const net = await table(t, options);
  const alice = net.device({ name: 'Alice' });
  const bob = net.device({ name: 'Bob' });
  const gm = net.gm();
  await gm.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  let current = baseScene(alice.playerId);
  const publish = next => { current = next ?? current; gm.send({ type: 'SCENE', scene: structuredClone(current) }); };
  publish();
  const a = net.player(alice);
  const b = net.player(bob);
  await Promise.all([a, b].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  return { ...net, alice, bob, gm, a, b, publish, scene: () => current };
}

test('token moves are accepted from the owner only, and only while the GM allows them', async t => {
  const net = await seated(t);
  const { a, b, gm } = net;

  a.send({ type: 'PLAYER_TOKEN_MOVE', aid: 1, id: 'hero', x: 120, y: 80 });
  await gm.until(c => c.of('PLAYER_TOKEN_MOVE').length === 1);
  await a.until(c => c.of('ACK').length === 1, 'the ACK for the first move');
  const { playerId, ...move } = gm.of('PLAYER_TOKEN_MOVE')[0];
  assert.deepEqual(move, { type: 'PLAYER_TOKEN_MOVE', id: 'hero', x: 120, y: 80 });
  assert.equal(playerId, net.alice.playerId);
  assert.deepEqual(a.of('ACK').at(-1), { type: 'ACK', ok: true, action: 'move', id: 'hero', aid: 1 });
  await b.until(c => c.of('STATE_PATCH').some(p => p.patch.coll?.tokens?.put?.[0]?.x === 120), 'everyone to see the move');

  b.send({ type: 'PLAYER_TOKEN_MOVE', aid: 1, id: 'hero', x: 5, y: 5 });
  await b.until(c => c.of('ACK').length === 1);
  assert.deepEqual(b.of('ACK')[0], { type: 'ACK', ok: false, reason: 'blocked', action: 'move', id: 'hero', aid: 1 });
  assert.equal(gm.of('PLAYER_TOKEN_MOVE').length, 1);

  net.publish({ ...net.scene(), playerCanMoveTokens: false });
  await a.until(c => viewOf(c).playerCanMoveTokens === false);
  a.send({ type: 'PLAYER_TOKEN_MOVE', aid: 2, id: 'hero', x: 300, y: 300 });
  await a.until(c => c.of('ACK').length === 2);
  assert.equal(a.of('ACK')[1].reason, 'paused');

  const fogged = baseScene(net.alice.playerId, { fogCells: ['2,1'], tokens: [{ id: 'hero', name: 'Aria', x: 120, y: 80, gridSize: 1, ownerId: net.alice.playerId, visibleToPlayers: true }] });
  net.publish(fogged);
  await a.until(c => viewOf(c).fogCells?.length === 1 || viewOf(c).tokens.length === 0);
  a.send({ type: 'PLAYER_TOKEN_MOVE', aid: 3, id: 'hero', x: 400, y: 400 });
  await a.until(c => c.of('ACK').length === 3);
  assert.equal(a.of('ACK')[2].ok, false, 'a token under fog cannot be moved');
  assert.equal(gm.of('PLAYER_TOKEN_MOVE').length, 1);

  // Players cannot publish scenes or impersonate the GM.
  const before = viewOf(a).mapImageSrc;
  b.send({ type: 'SCENE', scene: { mapImageSrc: 'https://evil.example/x.png', tokens: [] } });
  b.send({ type: 'TABLE_CMD', op: 'kick', device: net.alice.device });
  await delay(100);
  assert.equal(viewOf(a).mapImageSrc, before);
  assert.equal(a.closed, null, 'the kick request from a player did nothing');
  assert.equal(net.metrics.count('reject.wrong-direction'), 2);
});

test('moves are clamped to the map before the GM and the other players hear of them', async t => {
  const net = await seated(t);
  net.a.send({ type: 'PLAYER_TOKEN_MOVE', aid: 1, id: 'hero', x: 99999, y: -40 });
  await net.gm.until(c => c.of('PLAYER_TOKEN_MOVE').length === 1);
  const move = net.gm.of('PLAYER_TOKEN_MOVE')[0];
  assert.deepEqual([move.x, move.y], [2000, 0]);
});

test('moves are refused while the GM is away', async t => {
  const net = await seated(t);
  net.gm.close();
  await net.a.until(c => c.last('GM_STATUS')?.connected === false);
  net.a.send({ type: 'PLAYER_TOKEN_MOVE', aid: 1, id: 'hero', x: 50, y: 50 });
  await net.a.until(c => c.of('ACK').length === 1);
  assert.equal(net.a.of('ACK')[0].reason, 'away');
  net.a.send({ type: 'PLAYER_END_TURN', aid: 2, tokenId: 'hero' });
  await net.a.until(c => c.of('ACK').length === 2);
  assert.equal(net.a.of('ACK')[1].reason, 'away');
  assert.equal(viewOf(net.a).tokens[0].x, 0, 'a refused move changes nothing');
});

test('a ping reaches every player and the GM, stays on the map, and cannot be spammed', async t => {
  const net = await seated(t);
  const { a, b, gm } = net;
  a.send({ type: 'PLAYER_PING', x: 400, y: 300 });
  await Promise.all([a, b, gm].map(c => c.until(x => x.of('MAP_PING').length === 1, 'the ping to arrive everywhere')));
  assert.equal(b.of('MAP_PING')[0].id, net.alice.playerId);
  assert.equal(b.of('MAP_PING')[0].name, 'Alice');
  assert.deepEqual([b.of('MAP_PING')[0].x, b.of('MAP_PING')[0].y], [400, 300]);

  a.send({ type: 'PLAYER_PING', x: 10, y: 10 });            // inside the cooldown: ignored
  await delay(120);
  assert.equal(gm.of('MAP_PING').length, 1);

  await delay(700);
  a.send({ type: 'PLAYER_PING', x: 99999, y: -50 });         // off the map: pulled back onto it
  await gm.until(c => c.of('MAP_PING').length === 2);
  assert.deepEqual([gm.of('MAP_PING')[1].x, gm.of('MAP_PING')[1].y], [2000, 0]);

  await delay(700);
  a.send('{"type":"PLAYER_PING","x":1e999,"y":5}');          // nonsense is dropped
  a.send({ type: 'PLAYER_PING', x: 'NaN', y: 5 });
  await delay(150);
  assert.equal(gm.of('MAP_PING').length, 2);
  assert.equal(a.closed, null, 'two bad frames are strikes, not a ban');
});

test('only the player whose hero is acting can end the turn, and the GM hears of it once', async t => {
  const net = await seated(t);
  const { a, b, gm } = net;
  const state = activeId => baseScene(net.alice.playerId, { combat: { entries: [{ tokenId: 'hero', initiative: 12 }], activeId, round: 1 } });

  a.send({ type: 'PLAYER_END_TURN', aid: 1, tokenId: 'hero' });      // nobody's turn yet
  await a.until(c => c.of('ACK').length === 1);
  assert.equal(a.of('ACK')[0].reason, 'not-your-turn');

  net.publish(state('hero'));
  await a.until(c => viewOf(c).combat?.activeId === 'hero');
  b.send({ type: 'PLAYER_END_TURN', aid: 1, tokenId: 'hero' });      // somebody else's hero
  await b.until(c => c.of('ACK').length === 1);
  assert.equal(b.of('ACK')[0].reason, 'not-your-turn');
  assert.equal(gm.of('PLAYER_END_TURN').length, 0);

  a.send({ type: 'PLAYER_END_TURN', aid: 2, tokenId: 'hero' });
  a.send({ type: 'PLAYER_END_TURN', aid: 3, tokenId: 'hero' });      // a double tap counts once
  await a.until(c => c.of('ACK').length === 3);
  await delay(100);
  assert.equal(gm.of('PLAYER_END_TURN').length, 1);
  assert.deepEqual(a.of('ACK').slice(1).map(m => m.ok), [true, true], 'the second tap is answered as done');
  const ended = gm.of('PLAYER_END_TURN')[0];
  assert.equal(ended.playerId, net.alice.playerId);
  assert.equal(ended.tokenId, 'hero');
  assert.equal(ended.name, 'Aria');

  gm.close();                                                         // with the GM away the turn cannot be ended
  await a.until(c => c.last('GM_STATUS')?.connected === false);
  await delay(1600);
  a.send({ type: 'PLAYER_END_TURN', aid: 4, tokenId: 'hero' });
  await a.until(c => c.of('ACK').length === 4);
  assert.equal(a.of('ACK')[3].reason, 'away');
});

test('an action id is never applied twice: a replay, a retry after a reconnect and a RESUME all get the original answer', async t => {
  const net = await seated(t);
  const { a, gm } = net;
  a.send({ type: 'PLAYER_TOKEN_MOVE', aid: 7, id: 'hero', x: 100, y: 100 });
  a.send({ type: 'PLAYER_TOKEN_MOVE', aid: 7, id: 'hero', x: 100, y: 100 });
  await a.until(c => c.of('ACK').length === 2, 'two answers for the same aid');
  assert.deepEqual(a.of('ACK')[1], a.of('ACK')[0]);
  await delay(60);
  assert.equal(gm.of('PLAYER_TOKEN_MOVE').length, 1, 'the GM heard of the move once');

  // The phone drops before it saw the ACK; after reconnecting it re-sends the action and lists it in RESUME.
  a.terminate();
  await a.done;
  const rev = a.frames.filter(f => f.rev !== undefined && f.type !== 'HELLO').at(-1).rev;
  const again = net.player(net.alice, { rev, aids: [7, 8] });
  await again.until(c => c.of('ACK').length === 1, 'the answer for the action the server already processed (RESUME aids)');
  assert.equal(again.of('ACK')[0].aid, 7);
  assert.equal(again.of('ACK')[0].ok, true);
  again.send({ type: 'PLAYER_TOKEN_MOVE', aid: 7, id: 'hero', x: 100, y: 100 });
  await again.until(c => c.of('ACK').length === 2, 'the answer to the re-sent action');
  await delay(60);
  assert.equal(gm.of('PLAYER_TOKEN_MOVE').length, 1, 'still once');

  // A rejection is remembered just the same.
  net.b.send({ type: 'PLAYER_TOKEN_MOVE', aid: 1, id: 'hero', x: 1, y: 1 });
  await net.b.until(c => c.of('ACK').length === 1, 'bob first rejection');
  net.b.send({ type: 'PLAYER_TOKEN_MOVE', aid: 1, id: 'hero', x: 1, y: 1 });
  await net.b.until(c => c.of('ACK').length === 2, 'bob repeated rejection');
  assert.deepEqual(net.b.of('ACK')[1], net.b.of('ACK')[0]);

  // Another window of the same device shares the memory.
  const second = net.player(net.alice);
  await second.until(c => c.of('STATE_FULL').length === 1, 'second window state');
  second.send({ type: 'PLAYER_TOKEN_MOVE', aid: 7, id: 'hero', x: 100, y: 100 });
  await second.until(c => c.of('ACK').length === 1, 'second window ack');
  assert.equal(gm.of('PLAYER_TOKEN_MOVE').length, 1);

});

test('the server remembers a bounded number of action ids per device; older ones are forgotten', async t => {
  const net = await seated(t, { hubOptions: { limits: { actionMemory: 5 } } });
  for (let i = 1; i <= 8; i++) net.a.send({ type: 'PLAYER_TOKEN_MOVE', aid: i, id: 'hero', x: i * 10, y: 5 });
  await net.a.until(c => c.of('ACK').length === 8, 'eight answers');
  const probe = net.player(net.alice, { aids: [1, 2, 3, 4, 5, 6, 7, 8] });
  await probe.until(c => c.of('ACK').length >= 5, 'the remembered answers');
  await delay(60);
  assert.deepEqual(probe.of('ACK').map(m => m.aid), [4, 5, 6, 7, 8], 'aids 1-3 fell out of the memory');
});

test('a ping that carries an action id is not shown twice when the phone re-sends it', async t => {
  const net = await seated(t);
  net.a.send({ type: 'PLAYER_PING', aid: 'p1', x: 10, y: 10 });
  await net.gm.until(c => c.of('MAP_PING').length === 1);
  await delay(750);
  net.a.send({ type: 'PLAYER_PING', aid: 'p1', x: 10, y: 10 });
  await delay(150);
  assert.equal(net.gm.of('MAP_PING').length, 1);
});

test('move, ping and end-turn floods respect their per-type limits and end in a 4008 close', async t => {
  const net = await seated(t);
  for (let i = 0; i < 300; i++) net.a.send({ type: 'PLAYER_TOKEN_MOVE', aid: i, id: 'hero', x: i, y: i });
  await net.a.done;
  assert.equal(net.a.closed.code, CLOSE.ABUSE);
  const moves = net.gm.of('PLAYER_TOKEN_MOVE').length;
  assert.ok(moves >= 30 && moves <= 60, `the GM heard of ${moves} moves out of 300`);
  assert.ok(net.metrics.count('reject.ratelimit') >= 200);
  assert.equal(net.access.banned('127.0.0.1'), true, 'the abuse was reported to access');
  // the other player is not affected
  net.b.send({ type: 'PING', t: 1 });
  await net.b.until(c => c.of('PONG').length === 1);
});

test('PLAYER_NAME is cleaned, shared by all windows of the device and shown in pings', async t => {
  const net = await seated(t);
  net.a.send({ type: 'PLAYER_NAME', name: `  Tho\u0007rin ${'x'.repeat(80)}` });
  await net.gm.until(c => c.last('PLAYER_ROSTER')?.players.some(p => p.name.startsWith('Thorin')));
  const name = net.gm.last('PLAYER_ROSTER').players.find(p => p.name.startsWith('Thorin')).name;
  assert.ok(name.length <= 40);
  assert.equal(/[\u0000-\u001f]/.test(name), false);
  await delay(2100);                                                 // PLAYER_NAME is limited to one per 2 s
  net.a.send({ type: 'PLAYER_PING', x: 5, y: 5 });
  await net.b.until(c => c.of('MAP_PING').length === 1);
  assert.equal(net.b.of('MAP_PING')[0].name, name);
});
