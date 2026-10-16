// Limits and robustness: oversize and malformed frames, floods, strikes and bans, socket caps, slow and dead peers,
// resume timing, and a 100,000-frame fuzz that must not hurt the hub (design test group D).
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createHub } from '../server/net/hub.js';
import { createFakeClock } from '../server/net/clock.js';
import { createFakeSocket } from '../test-support/fakeSocket.js';
import { createFakeAccess, createFakeMetrics, startTable } from '../test-support/fakeAccess.js';
import { CLOSE, LIMITS, PLAYER_TYPES, GM_TYPES } from '../src/net/protocol.js';

const table = (t, options) => startTable(t, createHub, options);
const sceneWith = owner => ({
  mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [], playerCanMoveTokens: true,
  tokens: [{ id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, ownerId: owner, visibleToPlayers: true }],
  markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 },
});

// ── real sockets ──────────────────────────────────────────────────────────────────────────────────────────────────
test('D2 an oversize frame closes the socket with 1009 and the server carries on (player 17 KB, GM over its cap)', async t => {
  const net = await table(t);
  const a = net.player(net.device());
  const b = net.player(net.device());
  await Promise.all([a, b].map(c => c.until(x => x.of('HELLO').length === 1)));
  a.ws.send(JSON.stringify({ type: 'PING', pad: 'x'.repeat(LIMITS.playerMaxPayload + 1) }));
  await a.done;
  assert.equal(a.closed.code, CLOSE.TOO_BIG);
  b.send({ type: 'PING', t: 1 });
  await b.until(c => c.of('PONG').length === 1, 'the other player is still served');

  const gm = net.gm();
  await gm.until(c => c.of('HELLO').length === 1);
  gm.ws.send(JSON.stringify({ type: 'SCENE', scene: { tokens: [], pad: 'x'.repeat(LIMITS.gmMaxPayload + 10) } }));
  await gm.done;
  assert.equal(gm.closed.code, CLOSE.TOO_BIG);
  assert.equal(net.metrics.count('handlerErrors'), 0);
});

test('a frame over its own type cap (but under the socket cap) is dropped and counted, not fatal', async t => {
  const net = await table(t);
  const a = net.player(net.device());
  await a.until(c => c.of('HELLO').length === 1);
  a.send({ type: 'PLAYER_NAME', name: 'x'.repeat(400) });
  a.send({ type: 'PING', t: 7 });
  await a.until(c => c.of('PONG').length === 1);
  assert.equal(net.metrics.count('reject.oversize'), 1);
  assert.equal(a.closed, null);
});

test('binary frames on the control socket close it with 1003', async t => {
  const net = await table(t);
  const a = net.player(net.device());
  await a.until(c => c.of('HELLO').length === 1);
  a.ws.send(Buffer.from([1, 2, 3]));
  await a.done;
  assert.equal(a.closed.code, CLOSE.UNSUPPORTED_DATA);
});

test('D3 malformed, unknown, wrong-direction and hostile frames are dropped and counted; the session lives on', async t => {
  const net = await table(t);
  const a = net.player(net.device());
  await a.until(c => c.of('HELLO').length === 1);
  const hostile = [
    'not json', '{"type":', '[]', 'null', '{"type":42}',
    '{"type":"NOPE"}', '{"type":"SCENE","scene":{}}', '{"type":"__proto__"}',
    '{"type":"PLAYER_TOKEN_MOVE","id":"hero","x":1e999,"y":0}',
  ];
  for (const frame of hostile) a.ws.send(frame);
  await delay(120);
  assert.equal(a.closed, null, 'nine strikes are below the limit of ten');
  for (const key of ['malformed', 'unknown-type', 'wrong-direction', 'invalid']) assert.ok(net.metrics.count(`reject.${key}`) >= 1, key);
  await delay(10_050);                                   // let the strikes age out
  a.ws.send(`{"type":"PING","t":${'['.repeat(5000)}${']'.repeat(5000)}}`);
  a.ws.send('{"type":"PLAYER_TOKEN_MOVE","__proto__":{"x":1},"constructor":{"prototype":{"y":1}},"id":"hero","x":1,"y":1}');
  a.send({ type: 'PING', t: 1 });
  await a.until(c => c.of('PONG').length === 1, 'still served');
  assert.equal(net.metrics.count('handlerErrors'), 0);
  assert.equal({}.x, undefined);
});

test('D4 a PING flood gets at most the allowed PONGs, then 4008, then the address is banned', async t => {
  const net = await table(t);
  const a = net.player(net.device());
  await a.until(c => c.of('HELLO').length === 1);
  const frame = JSON.stringify({ type: 'PING', t: 1 });
  for (let i = 0; i < 10_000; i++) a.ws.send(frame);
  await a.done;
  assert.equal(a.closed.code, CLOSE.ABUSE);
  assert.ok(a.of('PONG').length <= 6, `${a.of('PONG').length} PONGs`);
  assert.equal(net.access.banned('127.0.0.1'), true);
  const retry = new WebSocket(...net.access.fake.clientArgs(net.port, net.device()));
  const status = await new Promise(resolve => { retry.on('unexpected-response', (q, r) => { r.resume(); resolve(r.statusCode); }); retry.on('error', () => resolve('error')); });
  assert.equal(status, 403, 'the ban stops the next upgrade before a socket exists');
});

test('D1 / D8 the per-IP socket cap holds under 600 attempts from one address, and memory stays flat', async t => {
  const net = await table(t);
  const rssBefore = process.memoryUsage().rss;
  const open = [];
  let refused = 0;
  const attempts = [];
  for (let i = 0; i < 600; i++) {
    attempts.push(new Promise(resolve => {
      const ws = new WebSocket(...net.access.fake.clientArgs(net.port, net.device()));
      ws.on('open', () => { open.push(ws); resolve(); });
      ws.on('unexpected-response', (q, r) => { r.resume(); refused += 1; resolve(); });
      ws.on('error', () => resolve());
    }));
    if (i % 50 === 49) await Promise.all(attempts.splice(0));
  }
  await Promise.all(attempts);
  assert.equal(open.length, LIMITS.maxSocketsPerIp);
  assert.equal(refused, 600 - LIMITS.maxSocketsPerIp);
  assert.equal(net.access.fake.openSockets(), LIMITS.maxSocketsPerIp);
  assert.equal(net.hub.sessions.all().length, LIMITS.maxSocketsPerIp);
  const grown = (process.memoryUsage().rss - rssBefore) / 1048576;
  assert.ok(grown < 60, `RSS grew by ${grown.toFixed(1)} MB (the old server grew by 270 MB for 600 sockets)`);
  for (const ws of open) ws.terminate();
});

test('the global socket cap is honoured too', async t => {
  const net = await table(t, { accessOptions: { maxTotal: 3, maxPerIp: 99 } });
  const clients = [1, 2, 3].map(() => net.player(net.device()));
  await Promise.all(clients.map(c => c.until(x => x.of('HELLO').length === 1)));
  const fourth = new WebSocket(...net.access.fake.clientArgs(net.port, net.device()));
  const status = await new Promise(resolve => { fourth.on('unexpected-response', (q, r) => { r.resume(); resolve(r.statusCode); }); fourth.on('error', () => {}); });
  assert.equal(status, 503);
});

test('a slow real client does not slow the others (state is skipped for it, then repaired)', async t => {
  const net = await table(t);
  const gm = net.gm();
  await gm.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  const fast = net.player(net.device());
  const slow = net.player(net.device());
  gm.send({ type: 'SCENE', scene: sceneWith('nobody') });
  await Promise.all([fast, slow].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  slow.ws._socket.pause();                       // the phone stops reading; its kernel buffers fill
  const big = sceneWith('nobody');
  big.fogCells = Array.from({ length: 4000 }, (_, i) => `${i % 90},${Math.floor(i / 90)}`);
  const started = Date.now();
  for (let i = 0; i < 120; i++) {
    big.tokens[0].x = i;
    big.fogCells = big.fogCells.slice(1).concat(`${200 + i},${i}`);
    gm.send({ type: 'SCENE', scene: structuredClone(big) });
    await delay(20);                             // the GM is limited to 60 scenes a second
  }
  await fast.until(c => c.of('STATE_PATCH').length >= 20, 'the fast player to keep receiving patches');
  assert.ok(Date.now() - started < 6000);
  await fast.until(c => viewX(c) === 119, 'the fast player to see the last position', 5000);
  slow.ws._socket.resume();
  await slow.until(c => viewX(c) === 119, 'the slow player to catch up (a snapshot or patches)', 8000);
  assert.equal(slow.closed, null, 'catching up quickly is not a reason to close');
});

function viewX(client) {
  let x = null;
  for (const frame of client.frames) {
    if (frame.type === 'STATE_FULL') x = frame.state.tokens[0]?.x ?? null;
    else if (frame.type === 'STATE_PATCH') x = frame.patch.coll?.tokens?.put?.find(token => token.id === 'hero')?.x ?? x;
  }
  return x;
}

// ── fake sockets and a fake clock ─────────────────────────────────────────────────────────────────────────────────
function fakeTable({ limits } = {}) {
  const clock = createFakeClock();
  const metrics = createFakeMetrics();
  const access = createFakeAccess({ clock, metrics });
  const hub = createHub({ access, metrics, clock, limits, revBase: 100 });
  const authOf = (record, role) => (role === 'gm'
    ? { ok: true, role: 'gm', device: 'gm', playerId: 'gm', name: 'GM', ip: '127.0.0.1', label: 'GM', pending: false }
    : { ok: true, role: 'player', device: record.device, playerId: record.playerId, name: record.name, ip: '127.0.0.1', label: record.label, pending: false });
  const wrap = (socket, session) => ({
    socket, session,
    frames: () => socket.sent.map(entry => JSON.parse(entry.data)),
    of: type => socket.sent.map(entry => JSON.parse(entry.data)).filter(frame => frame.type === type),
    send: object => socket.test.receive(object),
  });
  const player = (record = access.fake.addDevice({ name: 'P' }), { resume = true, rev = null } = {}) => {
    const socket = createFakeSocket();
    const session = hub.connect(socket, authOf(record, 'player'));
    const client = { ...wrap(socket, session), record };
    if (resume) client.send({ type: 'RESUME', rev, aids: [] });
    return client;
  };
  const gm = () => {
    const socket = createFakeSocket();
    return wrap(socket, hub.connect(socket, authOf(null, 'gm')));
  };
  return { clock, metrics, access, hub, player, gm };
}

test('backlog policy through the hub: a frozen phone is skipped, repaired when it drains, closed with 4009 if it never does', async () => {
  const net = fakeTable();
  const gm = net.gm();
  const a = net.player();
  const slow = net.player();
  const alice = a.record;
  gm.send({ type: 'SCENE', scene: sceneWith(alice.playerId) });
  await Promise.resolve();
  assert.equal(slow.of('STATE_FULL').length, 1);
  slow.socket.test.freeze();
  const scene = sceneWith(alice.playerId);
  for (let i = 1; i <= 30; i++) {
    scene.tokens[0].x = i;
    scene.fogCells = Array.from({ length: 800 }, (_, k) => `${k},${i}`);    // big patches
    gm.send({ type: 'SCENE', scene: structuredClone(scene) });
    await Promise.resolve();
    net.clock.advance(50);
  }
  assert.ok(slow.session.stale, 'the frozen phone was marked stale');
  assert.ok(a.of('STATE_PATCH').length >= 29, 'the others never wait');
  assert.equal(slow.of('STATE_FULL').length, 1, 'no snapshot is queued onto a backed-up socket');
  const patchesToSlow = slow.of('STATE_PATCH').length;
  net.clock.advance(5_000);
  assert.equal(slow.socket.closed, null);
  slow.socket.test.thaw();
  net.clock.advance(300);
  assert.equal(slow.of('STATE_FULL').length, 2, 'one fresh snapshot once it drained');
  assert.ok(slow.of('STATE_PATCH').length <= patchesToSlow + 1);
  assert.equal(slow.of('STATE_FULL')[1].state.tokens[0].x, 30);
  assert.equal(slow.session.stale, false);

  const stuck = net.player();
  stuck.socket.test.setBuffered(LIMITS.backlogStopBytes + 1);      // its queue is full and never drains
  scene.tokens[0].x = 77;
  gm.send({ type: 'SCENE', scene: structuredClone(scene) });
  await Promise.resolve();
  assert.ok(stuck.session.stale);
  net.clock.advance(LIMITS.slowCloseMs + 500);
  assert.equal(stuck.socket.closed?.code, CLOSE.SLOW);
  assert.equal(a.socket.closed, null);
});

test('resume timing: a silent client is served as "nothing yet" after 2 s, a client that answers is served at once', () => {
  const net = fakeTable();
  const gm = net.gm();
  gm.send({ type: 'SCENE', scene: sceneWith('x') });
  const quick = net.player();
  const silent = net.player(undefined, { resume: false });
  assert.equal(quick.of('STATE_FULL').length, 1);
  assert.equal(silent.of('STATE_FULL').length, 0);
  net.clock.advance(LIMITS.resumeWaitMs - 1);
  assert.equal(silent.of('STATE_FULL').length, 0);
  net.clock.advance(1);
  assert.equal(silent.of('STATE_FULL').length, 1);
  silent.send({ type: 'RESUME', rev: null, aids: [] });                  // too late: a second RESUME is a violation, not a second snapshot
  assert.equal(silent.of('STATE_FULL').length, 1);
});

test('dead peers are found: no frame or pong for 30 s means the socket is terminated; a peer that answers stays', () => {
  const net = fakeTable();
  const live = net.player();
  const dead = net.player();
  for (let step = 0; step < 6; step++) {
    net.clock.advance(LIMITS.serverPingMs);
    live.socket.test.pong();
  }
  assert.ok(live.socket.pings >= 5, 'server pings every 15 s');
  assert.equal(live.socket.terminated, false);
  assert.equal(dead.socket.terminated, true);
  assert.equal(net.hub.sessions.byDevice(dead.record.device).length, 0);
});

test('strikes are reported to access so the address can be banned', () => {
  const net = fakeTable();
  const p = net.player();
  for (let i = 0; i < LIMITS.strikesToClose; i++) p.socket.test.receive('garbage');
  assert.equal(p.socket.closed.code, CLOSE.ABUSE);
  assert.equal(net.access.banned('127.0.0.1'), true);
});

test('D7 a seeded fuzz of 100,000 frames never throws and never counts a handler error', () => {
  const net = fakeTable({ limits: { strikesToClose: 1e9 } });  // sessions must live to see every frame
  let seed = 20261013;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = list => list[Math.floor(random() * list.length)];
  const junk = [0, -1, 1.5, 1e308, -1e308, 'x', '', null, true, false, [], {}, 'a'.repeat(300), 'hero', 'ambusher', 'nobody', '__proto__', 7, 2000, -3];
  const keys = ['id', 'x', 'y', 'aid', 'rev', 'aids', 'name', 'sid', 'sdp', 'op', 'to', 'scene', 'tokenId', 'enabled', 'caps', 'device', 'mode', 't', 'rtt', 'loss', 'settings', 'active', 'volume', 'muted', 'reason'];
  const types = [...new Set([...PLAYER_TYPES, ...GM_TYPES, 'NOPE', 'STATE_FULL', 'PLAYER_ROSTER', '__proto__', 'constructor', ''])];

  const gm = net.gm();
  const a = net.player(net.access.fake.addDevice({ name: 'A' }));
  const b = net.player(net.access.fake.addDevice({ name: 'B' }));
  const players = [a, b];
  const randomScene = () => {
    const scene = sceneWith(pick([a.record.playerId, b.record.playerId, 'x']));
    const n = Math.floor(random() * 5);
    for (let i = 0; i < n; i++) scene.tokens.push({ id: pick(['hero', 't1', 't2', 'ambusher', 'ghost']), x: pick(junk), y: pick(junk), gridSize: pick(junk), visibleToPlayers: pick([true, false, undefined, 'no']), ownerId: pick([a.record.playerId, 'x']), characterType: pick(['npc', 'pc', 7]), hp: pick(junk), notes: pick(junk) });
    if (random() < 0.4) scene.fogCells = Array.from({ length: Math.floor(random() * 30) }, () => `${Math.floor(random() * 5)},${Math.floor(random() * 5)}`);
    if (random() < 0.3) scene.combat = { entries: [{ tokenId: pick(['hero', 't1']), initiative: pick(junk), hp: pick(junk), maxHp: pick(junk) }], activeId: pick(['hero', 't1', null]), round: pick(junk) };
    if (random() < 0.3) scene.markers = [{ id: pick(['m1', 'm2']), type: 'star', x: pick(junk), y: pick(junk), visibleToPlayers: pick([true, false]), label: pick(junk) }];
    if (random() < 0.3) scene.areaEffects = [{ id: pick(['e1', 'e2']), type: pick(['circle', 'rect', 'cone', 7]), x: pick(junk), radius: pick(junk), secret: pick(junk) }];
    if (random() < 0.2) scene.gridSize = pick(junk);
    if (random() < 0.2) scene.mapWidth = pick(junk);
    if (random() < 0.1) scene.playerViewRect = pick(junk);
    return scene;
  };
  const randomFrame = () => {
    const roll = random();
    if (roll < 0.05) return Buffer.from(Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * 256)));   // binary: closes the socket
    if (roll < 0.12) return Array.from({ length: Math.floor(random() * 60) }, () => String.fromCharCode(Math.floor(random() * 128))).join('');
    if (roll < 0.14) return `{"type":"PING","t":${'['.repeat(Math.floor(random() * 3000))}`;
    if (roll < 0.16) return '{"type":"PLAYER_TOKEN_MOVE","__proto__":{"polluted":1},"id":"hero","x":1,"y":2}';
    const object = { type: pick(types) };
    for (const key of keys) if (random() < 0.3) object[key] = pick(junk);
    if (object.type === 'SCENE' && random() < 0.8) object.scene = randomScene();
    if (object.type === 'TABLE_CMD' && random() < 0.7) { object.op = pick(['kick', 'admit', 'deny', 'lock', 'unlock', 'rotate', 'mode', 'rename']); object.device = pick([a.record.device, a.record.playerId, 'f'.repeat(32), 'nope']); object.mode = pick(['open', 'ask', 'locked']); object.name = 'N'; }
    if (object.type === 'PLAYER_TOKEN_MOVE' && random() < 0.6) { object.id = pick(['hero', 't1']); object.x = Math.floor(random() * 3000) - 500; object.y = Math.floor(random() * 2000); object.aid = Math.floor(random() * 80); }
    if (object.type === 'PLAYER_END_TURN' && random() < 0.6) { object.tokenId = pick(['hero', 't1']); object.aid = Math.floor(random() * 80); }
    if (object.type === 'PLAYER_PING' && random() < 0.7) { object.x = Math.floor(random() * 3000); object.y = Math.floor(random() * 2000); }
    if (object.type === 'RESUME' && random() < 0.5) { object.rev = pick([null, 0, 5, 100, 101, 1e9]); object.aids = [Math.floor(random() * 80)]; }
    if (random() < 0.05) return JSON.stringify(object).slice(0, Math.floor(random() * 60));
    return JSON.stringify(object);
  };

  const frames = 100_000;
  let reconnects = 0;
  for (let i = 0; i < frames; i++) {
    net.clock.advance(20);                       // 50 frames a second: buckets refill, timers (ticks, heartbeats, roster) run
    if (i % 3000 === 0) gm.send({ type: 'SCENE', scene: randomScene() });
    const frame = randomFrame();
    const target = random() < 0.3 ? gm : pick(players);
    if (target.socket.readyState !== 1) {
      if (target === gm) continue;
      players[players.indexOf(target)] = net.player(target.record, { resume: false });
      reconnects += 1;
      continue;
    }
    // bytes are sent exactly as a socket would deliver them: Buffers are binary, strings are text
    target.socket.test.receive(frame);
    target.socket.sent.length = 0;               // the fuzz does not need to keep what it was sent
  }
  assert.ok(net.hub.sessions.all().length >= 1);
  net.clock.advance(60_000);
  assert.equal(net.metrics.count('handlerErrors'), 0, net.metrics.logs.slice(0, 3).join('\n'));
  // the hub still serves a brand new player
  const fresh = net.player(net.access.fake.addDevice({ name: 'Fresh' }));
  fresh.send({ type: 'PING', t: 9 });
  assert.equal(fresh.of('PONG').length, 1);
  assert.equal(fresh.of('HELLO').length, 1);
  assert.equal({}.polluted, undefined);
  assert.ok(net.metrics.count('reject.malformed') + net.metrics.count('reject.invalid') > 1000, 'the fuzz really did hit the validation paths');
  assert.ok(net.metrics.count('actions.accepted') + net.metrics.count('actions.rejected') > 50, `the fuzz reached the action handlers (reconnects ${reconnects})`);
});

test('a hub closed while sockets are open resolves once they are gone, even if a peer never answers the close', async () => {
  const net = fakeTable();
  const p = net.player();
  p.socket.close = (code, reason) => { p.socket.closed = { code, reason }; p.socket.readyState = 2; };     // never completes the handshake
  const done = net.hub.close();
  net.clock.advance(1000);
  await done;
  assert.equal(p.socket.closed.code, CLOSE.SHUTDOWN);
  assert.equal(p.socket.terminated, true);
  void once; void delay;
});
