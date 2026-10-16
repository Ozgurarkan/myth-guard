// The hub over real sockets: connection lifecycle, state sync, resume, GM slot, admission flows, shutdown.
// Re-proves the guarantees of sessionSync.test.js tests 1 (filtered scene, then patches), 2 (late join / reconnect without
// the GM), 3 (the table survives the GM leaving), 6 and 8 (roster, latency) and 9 (unauthenticated sockets are refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createHub } from '../server/net/hub.js';
import { startTable } from '../test-support/fakeAccess.js';
import { CLOSE, PROTOCOL_VERSION, LIMITS } from '../src/net/protocol.js';

const HASH = 'e'.repeat(64);
const scene = (extra = {}) => ({
  mapImageSrc: `http://127.0.0.1:1/__realm/assets/${HASH}`, mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, imageSrc: `/__realm/assets/${HASH}`, portraitSource: 'data:image/png;base64,SECRET', visibleToPlayers: true },
    { id: 'ambusher', name: 'Hidden Assassin', x: 100, y: 0, gridSize: 1, visibleToPlayers: false },
  ],
  markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 },
  stageX: 0, stageY: 0, stageScale: 1, selectedId: null,
  ...extra,
});

const table = (t, options) => startTable(t, createHub, options);

const connectedGm = async (net, sceneToSend) => {
  const gm = net.gm();
  await gm.until(c => c.of('REQUEST_FULL_STATE').length > 0, 'the GM to be asked for the scene');
  if (sceneToSend) gm.send({ type: 'SCENE', scene: sceneToSend });
  return gm;
};

test('players receive the filtered scene with images as shared URLs, then only patches', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const alice = net.player(net.device({ name: 'Alice' }));
  await alice.until(c => c.of('STATE_FULL').length === 1, 'the first snapshot');

  const full = alice.of('STATE_FULL')[0];
  assert.match(full.state.mapImageSrc, /\/__realm\/assets\/e{64}$/);
  assert.equal(full.state.tokens.length, 1);
  assert.equal(full.state.tokens[0].portraitSource, undefined);
  const raw = alice.texts.join('\n');
  assert.equal(raw.includes('Hidden Assassin'), false);
  assert.equal(raw.includes('data:image'), false, 'no pixels travel in the scene');
  assert.equal(raw.includes('SECRET'), false);

  // Panning and zooming the GM's own view must not touch the network.
  const before = alice.texts.length;
  gm.send({ type: 'SCENE', scene: scene({ stageX: 40, stageScale: 2 }) });
  await delay(80);
  assert.equal(alice.texts.length, before);

  // Moving one token sends one small patch, not the scene.
  const moved = scene();
  moved.tokens[0].x = 150;
  gm.send({ type: 'SCENE', scene: moved });
  await alice.until(c => c.of('STATE_PATCH').length === 1, 'the token patch');
  const patch = alice.of('STATE_PATCH')[0];
  assert.equal(patch.base, full.rev);
  assert.deepEqual(Object.keys(patch.patch), ['coll']);
  assert.deepEqual(patch.patch.coll.tokens.put.map(token => token.x), [150]);
  assert.ok(alice.texts.at(-1).length < 300);

  // Revealing the hidden token publishes it.
  const revealed = scene();
  revealed.tokens = moved.tokens.map(token => ({ ...token, visibleToPlayers: true }));
  gm.send({ type: 'SCENE', scene: revealed });
  await alice.until(c => c.of('STATE_PATCH').some(m => m.patch.coll?.tokens?.put?.some(token => token.id === 'ambusher')), 'the revealed token');
});

test('HELLO, GM_STATUS and the snapshot arrive in that order; the HELLO carries what a client needs', async t => {
  const net = await table(t);
  await connectedGm(net, scene());
  const alice = net.device({ name: 'Alice' });
  const client = net.player(alice);
  await client.until(c => c.of('STATE_FULL').length === 1);
  assert.deepEqual(client.frames.map(f => f.type).slice(0, 4), ['HELLO', 'PLAYER_ID', 'GM_STATUS', 'STATE_FULL']);
  const hello = client.frames[0];
  assert.equal(hello.v, PROTOCOL_VERSION);
  assert.equal(hello.role, 'player');
  assert.equal(hello.playerId, alice.playerId);
  assert.equal(hello.name, 'Alice');
  assert.ok(Number.isSafeInteger(hello.rev));
  assert.ok(hello.server.id && hello.server.started);
  assert.equal(hello.limits.maxScene, 8 * 1024 * 1024);
  assert.equal(client.of('PLAYER_ID')[0].id, alice.playerId);
  assert.equal(client.of('GM_STATUS')[0].connected, true);
  assert.equal(client.of('STATE_FULL')[0].rev, hello.rev, 'the rev in HELLO is the rev of the snapshot that follows');
});

test('a player joining late or reconnecting is served by the server without troubling the GM', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const alice = net.device({ name: 'Alice' });
  const first = net.player(alice);
  await first.until(c => c.of('STATE_FULL').length === 1);
  assert.equal(gm.of('REQUEST_FULL_STATE').length, 1, 'the GM was asked once, when it connected');

  const late = net.player(net.device({ name: 'Bob' }));
  await late.until(c => c.of('STATE_FULL').length === 1);
  assert.equal(gm.of('REQUEST_FULL_STATE').length, 1, 'late joiners never make the GM resend the scene');

  // Dropping a player's connection and coming back with nothing brings back the same scene on its own.
  first.terminate();
  await first.done;
  const again = net.player(alice);
  await again.until(c => c.of('STATE_FULL').length === 1);
  assert.equal(again.of('STATE_FULL')[0].state.tokens[0].name, 'Aria');
  assert.equal(gm.of('REQUEST_FULL_STATE').length, 1);
});

test('resume over a real socket: a phone N revisions behind gets N patches, one that is current gets nothing, an old one a snapshot', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const alice = net.device({ name: 'Alice' });
  const live = net.player(alice);
  await live.until(c => c.of('STATE_FULL').length === 1);
  const base = live.of('STATE_FULL')[0].rev;
  const current = scene();
  for (let i = 1; i <= 3; i++) { current.tokens[0].x = i * 10; gm.send({ type: 'SCENE', scene: structuredClone(current) }); await delay(25); }
  await live.until(c => c.of('STATE_PATCH').length === 3, 'three patches');
  live.terminate();
  await live.done;

  const caughtUp = net.player(alice, { rev: base + 3 });
  await caughtUp.until(c => c.of('GM_STATUS').length === 1);
  await delay(100);
  assert.equal(caughtUp.of('STATE_FULL').length + caughtUp.of('STATE_PATCH').length, 0, 'exactly current: nothing to send');

  const behind = net.player(alice, { rev: base });
  await behind.until(c => c.of('STATE_PATCH').length === 3, 'the missing patches');
  assert.equal(behind.of('STATE_FULL').length, 0);
  assert.deepEqual(behind.of('STATE_PATCH').map(p => p.rev), [base + 1, base + 2, base + 3]);
  assert.ok(behind.texts.join('').length < 3000);

  for (let i = 0; i < 70; i++) { current.tokens[0].x = 100 + i; gm.send({ type: 'SCENE', scene: structuredClone(current) }); await delay(2); }
  await delay(50);
  const old = net.player(alice, { rev: base + 3 });
  await old.until(c => c.of('STATE_FULL').length === 1, 'a snapshot for a phone that is too far behind');
  assert.equal(old.of('STATE_PATCH').length, 0);
});

test('a client that never sends RESUME is served as if it had nothing, after the wait', async t => {
  const net = await table(t, { hubOptions: { limits: { resumeWaitMs: 120 } } });
  await connectedGm(net, scene());
  const mute = net.player(net.device(), { resume: false });
  await mute.until(c => c.of('HELLO').length === 1);
  await delay(60);
  assert.equal(mute.of('STATE_FULL').length, 0, 'the server is still waiting for RESUME');
  await mute.until(c => c.of('STATE_FULL').length === 1, 'the snapshot after the wait', 1000);
});

test('the table survives the GM closing their window, and the GM can come back', async t => {
  const net = await table(t);
  const first = await connectedGm(net, scene());
  const alice = net.player(net.device());
  await alice.until(c => c.of('STATE_FULL').length === 1 && c.last('GM_STATUS')?.connected === true);
  first.close();
  await alice.until(c => c.last('GM_STATUS')?.connected === false, 'the GM to be marked away');
  assert.equal(alice.last('STATE_FULL').state.tokens.length, 1, 'players keep what they were looking at');
  const late = net.player(net.device());
  await late.until(c => c.of('STATE_FULL').length === 1, 'a late joiner to get the last scene');
  assert.equal(late.last('GM_STATUS').connected, false);

  const second = net.gm();
  await second.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  second.send({ type: 'SCENE', scene: scene({ fogCells: ['9,9'] }) });
  await alice.until(c => c.last('GM_STATUS')?.connected === true && c.of('STATE_PATCH').length === 1, 'the returning GM');
  assert.deepEqual(alice.of('STATE_PATCH')[0].patch.sets.fogCells.add, ['9,9']);
});

test('a second GM window replaces the first with 4001 and players never see the GM as away', async t => {
  const net = await table(t);
  const first = await connectedGm(net, scene());
  const alice = net.player(net.device());
  await alice.until(c => c.of('STATE_FULL').length === 1);
  const second = net.gm();
  await first.done;
  assert.equal(first.closed.code, CLOSE.REPLACED);
  await second.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  await delay(80);
  assert.equal(alice.of('GM_STATUS').some(m => m.connected === false), false);
  assert.equal(net.hub.sessions.gm() !== null, true);
  // the replaced window can no longer publish
  first.send({ type: 'SCENE', scene: scene({ fogCells: ['1,1'] }) });
  await delay(50);
  assert.equal(alice.of('STATE_PATCH').length, 0);
  second.send({ type: 'SCENE', scene: scene({ fogCells: ['2,2'] }) });
  await alice.until(c => c.of('STATE_PATCH').length === 1);
});

test('sockets that fail authentication never become WebSockets (cross-origin, no proof, GM without its cookie)', async t => {
  const net = await table(t);
  const alice = net.device();
  const attempt = (url, protocols, options) => new Promise(resolve => {
    const ws = new WebSocket(url, protocols, options);
    ws.on('unexpected-response', (request, response) => { response.resume(); resolve(response.statusCode); });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('error'));
  });
  const [url, protocols, options] = net.access.fake.clientArgs(net.port, alice);
  assert.equal(await attempt(...net.access.fake.clientArgs(net.port, alice, { origin: 'https://unrelated.example' })), 403);
  assert.equal(await attempt(...net.access.fake.clientArgs(net.port, 'gm', { host: 'evil.test:5173' })), 421, 'the DNS rebinding case');
  assert.equal(await attempt(url, [protocols[0]], options), 401, 'no auth token');
  assert.equal(await attempt(url, undefined, options), 400, 'no sub-protocol at all');
  const [gmUrl, gmProtocols, gmOptions] = net.access.fake.clientArgs(net.port, 'gm');
  assert.equal(await attempt(gmUrl, gmProtocols, { ...gmOptions, headers: { Host: gmOptions.headers.Host } }), 403, 'no rf-gm cookie');
  assert.equal(await attempt(`ws://127.0.0.1:${net.port}/__realm/ws?role=admin`, gmProtocols, gmOptions), 400);
  assert.equal(net.hub.sessions.all().length, 0);
  assert.equal(net.access.fake.openSockets(), 0, 'refused upgrades hold no connection slot');
});

test('a stale nonce or a removed device is told so with a close code the client can act on', async t => {
  const net = await table(t);
  const alice = net.device();
  const [url, protocols, options] = net.access.fake.clientArgs(net.port, alice);
  const first = new WebSocket(url, protocols, options);
  await once(first, 'open');
  first.close();
  // replaying the same handshake: the nonce is used up
  const replay = new WebSocket(url, protocols, options);
  const [code] = await once(replay, 'close');
  assert.equal(code, CLOSE.AUTH);
  net.access.table.kick(alice.device);
  const kicked = new WebSocket(...net.access.fake.clientArgs(net.port, alice));
  const [kickCode] = await once(kicked, 'close');
  assert.equal(kickCode, CLOSE.KICKED);
  assert.equal(net.hub.sessions.all().length, 0, 'no session was ever created for them');
});

test('the old /session-sync path answers 426 with a reload message; unrelated upgrade paths are left alone', async t => {
  const net = await table(t);
  const wss = new (await import('ws')).WebSocketServer({ noServer: true });
  net.server.on('upgrade', (request, socket, head) => { if (request.url === '/hmr') wss.handleUpgrade(request, socket, head, ws => ws.send('vite')); });
  t.after(() => wss.close());
  const legacy = new WebSocket(`ws://127.0.0.1:${net.port}/session-sync?role=player`);
  const text = await new Promise(resolve => legacy.on('unexpected-response', (request, response) => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve(`${response.statusCode} ${body}`));
  }));
  assert.equal(text, '426 Myth Guard was updated. Reload this page.');
  const other = new WebSocket(`ws://127.0.0.1:${net.port}/hmr`);
  const [message] = await once(other, 'message');
  assert.equal(message.toString(), 'vite');
  other.close();
});

test('graceful shutdown: every socket gets 4010, new connections are refused, and close() is safe to repeat', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const players = [net.player(net.device()), net.player(net.device())];
  await Promise.all(players.map(p => p.until(c => c.of('STATE_FULL').length === 1)));
  const closing = net.hub.close();
  await closing;
  await Promise.all([gm, ...players].map(c => c.done));
  for (const client of [gm, ...players]) assert.equal(client.closed.code, CLOSE.SHUTDOWN);
  await net.hub.close();
  const late = new WebSocket(...net.access.fake.clientArgs(net.port, net.device()));
  const status = await new Promise(resolve => { late.on('unexpected-response', (q, r) => { r.resume(); resolve(r.statusCode); }); late.on('error', () => resolve('error')); });
  assert.ok(status === 503 || status === 'error');
  assert.equal(net.access.fake.openSockets(), 0);
});

test('"ask" mode: a waiting device gets WAIT and no state; admit gives ADMITTED and the state; deny closes with 4003', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const waiting = net.device({ name: 'Newcomer', status: 'pending' });
  await gm.until(c => c.of('JOIN_REQUEST').length === 1, 'the join request');
  assert.equal(gm.of('JOIN_REQUEST')[0].device, waiting.device);

  const phone = net.player(waiting);
  await phone.until(c => c.of('WAIT').length === 1);
  await delay(100);
  assert.equal(phone.of('STATE_FULL').length, 0);
  assert.equal(phone.of('GM_STATUS').length, 0);
  phone.send({ type: 'PLAYER_PING', x: 5, y: 5 });          // a waiting device cannot act
  phone.send({ type: 'PING', t: 1 });
  await phone.until(c => c.of('PONG').length === 1, 'pings still work');
  assert.equal(gm.of('MAP_PING').length, 0);
  assert.equal(gm.last('PLAYER_ROSTER').players.find(p => p.deviceId === waiting.device).admitted, false);

  gm.send({ type: 'TABLE_CMD', op: 'admit', device: waiting.device });
  await phone.until(c => c.of('ADMITTED').length === 1 && c.of('STATE_FULL').length === 1, 'admission and state');
  assert.equal(phone.last('STATE_FULL').state.tokens[0].name, 'Aria');

  const denied = net.device({ name: 'Stranger', status: 'pending' });
  const other = net.player(denied);
  await other.until(c => c.of('WAIT').length === 1);
  gm.send({ type: 'TABLE_CMD', op: 'deny', device: denied.device });
  await other.done;
  assert.equal(other.closed.code, CLOSE.NOT_ADMITTED);
  assert.equal(other.of('DENIED').length, 1);
  assert.equal(other.of('STATE_FULL').length, 0);
});

test('a GM that connects later is told about the devices still waiting', async t => {
  const net = await table(t);
  net.device({ name: 'Early bird', status: 'pending' });
  const gm = net.gm();
  await gm.until(c => c.of('JOIN_REQUEST').length === 1, 'the pending request');
  assert.equal(gm.of('TABLE')[0].mode, 'open');
});

test('Kick from the GM: KICKED then close 4002, the device cannot come back, the others are untouched', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const alice = net.device({ name: 'Alice' });
  const bob = net.device({ name: 'Bob' });
  const a = net.player(alice);
  const b = net.player(bob);
  await Promise.all([a, b].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  gm.send({ type: 'TABLE_CMD', op: 'kick', device: alice.playerId }); // the roster only shows playerIds: either id works
  await a.done;
  assert.equal(a.closed.code, CLOSE.KICKED);
  assert.equal(a.of('KICKED').length, 1);
  assert.equal(b.closed, null);
  const back = new WebSocket(...net.access.fake.clientArgs(net.port, alice));
  assert.equal((await once(back, 'close'))[0], CLOSE.KICKED);
  await gm.until(c => c.last('PLAYER_ROSTER')?.players.every(p => p.deviceId !== alice.device), 'the roster to drop the kicked device');
});

test('TABLE_CMD: lock, mode, rename and rotate reach the table and the GM is told the new state', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const alice = net.device({ name: 'Alice' });
  const a = net.player(alice);
  await a.until(c => c.of('STATE_FULL').length === 1);
  gm.send({ type: 'TABLE_CMD', op: 'lock' });
  await gm.until(c => c.last('TABLE')?.locked === true);
  assert.equal(gm.last('TABLE').mode, 'locked');
  assert.equal(a.closed, null, 'locking the table does not remove anyone');
  gm.send({ type: 'TABLE_CMD', op: 'mode', mode: 'ask' });
  await gm.until(c => c.last('TABLE')?.mode === 'ask');
  const code = gm.last('TABLE').code;
  gm.send({ type: 'TABLE_CMD', op: 'rotate' });
  await gm.until(c => c.last('TABLE')?.code !== code);
  gm.send({ type: 'TABLE_CMD', op: 'rename', device: alice.device, name: 'Aria the Bold' });
  await gm.until(c => c.last('PLAYER_ROSTER')?.players.some(p => p.name === 'Aria the Bold'), 'the new name in the roster');
});

test('the roster tells the GM who is at the table and how good their connection is; PING is answered with the same t', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const thorin = net.device({ name: 'Player', label: 'Chrome · Android' });
  const phone = net.player(thorin);
  await phone.until(c => c.of('STATE_FULL').length === 1);
  phone.send({ type: 'PLAYER_NAME', name: 'Thorin' });
  await gm.until(c => c.last('PLAYER_ROSTER')?.players.some(p => p.name === 'Thorin'), 'the roster');
  const entry = gm.last('PLAYER_ROSTER').players.find(p => p.name === 'Thorin');
  assert.match(entry.device, /·/);
  assert.equal(entry.online, true);
  assert.equal(entry.id, thorin.playerId);
  assert.equal(net.access.table.list()[0].name, 'Thorin', 'the new name is remembered by the table');

  phone.send({ type: 'PING', t: 12345, rtt: 87.4 });
  await phone.until(c => c.of('PONG').length === 1);
  assert.equal(phone.of('PONG')[0].t, 12345);
  assert.ok(Number.isFinite(phone.of('PONG')[0].s));
  await gm.until(c => c.last('PLAYER_ROSTER')?.players.find(p => p.name === 'Thorin').rtt === 87, 'the round trip in the roster', 2500);
  phone.close();
  await gm.until(c => c.last('PLAYER_ROSTER')?.players.find(p => p.deviceId === thorin.device)?.online === false, 'the player to show as offline');
});

test('several windows on one device collapse in the roster; a fourth window replaces the oldest', async t => {
  const net = await table(t);
  const gm = await connectedGm(net, scene());
  const alice = net.device({ name: 'Alice' });
  const windows = [];
  for (let i = 0; i < LIMITS.socketsPerDevice; i++) windows.push(net.player(alice));
  await Promise.all(windows.map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  await gm.until(c => c.last('PLAYER_ROSTER')?.players.length === 1);
  assert.equal(net.hub.sessions.byDevice(alice.device).length, 3);
  const fourth = net.player(alice);
  await windows[0].done;
  assert.equal(windows[0].closed.code, CLOSE.REPLACED);
  await fourth.until(c => c.of('STATE_FULL').length === 1);
  assert.equal(net.hub.sessions.byDevice(alice.device).length, 3);
});

test('extensions: handlers for extra message types, lifecycle hooks, sendTo / sendGm and the audio socket', async t => {
  const events = [];
  const net = await table(t);
  net.hub.extend({
    playerTypes: { AUDIO_LISTEN: (session, msg) => events.push(['listen', session.device, msg.enabled, msg.caps]) },
    gmTypes: { AUDIO_STATUS: (session, msg) => events.push(['status', msg.active]) },
    onSessionOpen: s => events.push(['open', s.role]),
    onSessionClose: s => events.push(['close', s.role]),
    onGmChange: connected => events.push(['gm', connected]),
  });
  net.hub.extend({ playerTypes: { AUDIO_LISTEN: () => events.push(['second handler']) } });
  const gm = await connectedGm(net, scene());
  const alice = net.device({ name: 'Alice' });
  const a = net.player(alice);
  await a.until(c => c.of('STATE_FULL').length === 1);
  a.send({ type: 'AUDIO_LISTEN', enabled: true, caps: { rtc: true, jbt: true, evil: 1 } });
  gm.send({ type: 'AUDIO_STATUS', active: true });
  await delay(80);
  assert.deepEqual(events.filter(e => ['listen', 'second handler', 'status'].includes(e[0])), [['listen', alice.device, true, { rtc: true, jbt: true }], ['second handler'], ['status', true]]);
  assert.deepEqual(events.slice(0, 3), [['gm', true], ['open', 'gm'], ['open', 'player']]);
  assert.equal(net.hub.sendTo(alice.device, { type: 'AUDIO_CONTROLS', volume: 1 }), 1);
  assert.equal(net.hub.sendTo('nobody', { type: 'X' }), 0);
  assert.equal(net.hub.sendGm({ type: 'AUDIO_LISTENER', device: alice.device }), true);
  await a.until(c => c.of('AUDIO_CONTROLS').length === 1);
  await gm.until(c => c.of('AUDIO_LISTENER').length === 1);
  assert.deepEqual(net.hub.sessions.players().map(s => s.device), [alice.device]);
  assert.equal(net.hub.sessions.gm().role, 'gm');

  // an extension that throws costs a counter, not the server
  net.hub.extend({ playerTypes: { AUDIO_STATS: () => { throw new Error('boom'); } }, onSessionOpen: () => { throw new Error('boom'); } });
  a.send({ type: 'AUDIO_STATS', sid: 's1', lossPct: 3 });
  await delay(60);
  assert.ok(net.metrics.count('handlerErrors') >= 1);
  a.send({ type: 'PING', t: 1 });
  await a.until(c => c.of('PONG').length === 1, 'the server still answers');

  a.close();
  await a.done;
  await delay(50);
  assert.ok(events.some(e => e[0] === 'close' && e[1] === 'player'));
});

test('the audio socket: authenticated like the control socket, handed to the registered handler, closed with 4010 on shutdown', async t => {
  const net = await table(t);
  const alice = net.device({ name: 'Alice' });
  const [url0] = net.access.fake.clientArgs(net.port, alice);
  const noHandler = new WebSocket(...net.access.fake.clientArgs(net.port, alice, { path: '/__realm/audio' }));
  const status = await new Promise(resolve => { noHandler.on('unexpected-response', (q, r) => { r.resume(); resolve(r.statusCode); }); noHandler.on('error', () => {}); });
  assert.equal(status, 404, 'nothing serves audio yet');
  assert.ok(url0);

  const seen = [];
  net.hub.upgradeAudio((ws, auth) => { seen.push({ role: auth.role, device: auth.device }); ws.on('message', data => ws.send(data)); });
  const audio = new WebSocket(...net.access.fake.clientArgs(net.port, alice, { path: '/__realm/audio' }));
  await once(audio, 'open');
  audio.send(Buffer.from([1, 2, 3]));
  const [echo] = await once(audio, 'message');
  assert.deepEqual([...echo], [1, 2, 3]);
  assert.deepEqual(seen, [{ role: 'player', device: alice.device }]);
  assert.equal(net.access.fake.openSockets(), 1);
  assert.equal(net.hub.sessions.all().length, 0, 'audio sockets are not control sessions');
  await net.hub.close();
  const [code] = await once(audio, 'close');
  assert.equal(code, CLOSE.SHUTDOWN);
  assert.equal(net.access.fake.openSockets(), 0);
});

test('a client on a different protocol version is closed with 4004', async t => {
  const net = await table(t);
  const old = new WebSocket(...net.access.fake.clientArgs(net.port, net.device(), { query: '&v=2' }));
  const [code] = await once(old, 'close');
  assert.equal(code, CLOSE.TOO_OLD);
});

test('the connection slot of the per-IP cap is released when a session ends', async t => {
  const net = await table(t, { accessOptions: { maxPerIp: 2 } });
  const alice = net.device();
  const a = net.player(alice);
  const b = net.player(net.device());
  await Promise.all([a, b].map(c => c.until(x => x.of('HELLO').length === 1)));
  assert.equal(net.access.fake.openSockets(), 2);
  const third = new WebSocket(...net.access.fake.clientArgs(net.port, net.device()));
  const status = await new Promise(resolve => { third.on('unexpected-response', (q, r) => { r.resume(); resolve(r.statusCode); }); third.on('error', () => {}); });
  assert.equal(status, 503);
  a.close();
  await a.done;
  await delay(50);
  assert.equal(net.access.fake.openSockets(), 1);
  const fourth = net.player(net.device());
  await fourth.until(c => c.of('HELLO').length === 1);
});
