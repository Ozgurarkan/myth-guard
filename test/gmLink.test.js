import test from 'node:test';
import assert from 'node:assert/strict';
import { createGMLink, buildScene, SCENE_KEYS } from '../src/net/gmLink.js';
import { createPlayerLink } from '../src/net/playerLink.js';
import { createDeviceStore } from '../src/net/deviceStore.js';
import { createFakeClock } from '../test-support/fakeClock.js';
import { startTable, transportFor, until, pause } from '../test-support/wp4-table.js';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

// 1x1 PNGs (distinct bytes -> distinct hashes)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/2wvBwQAAAABJRU5ErkJggg==';

const baseState = () => ({
  mapImageSrc: PNG, mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, imageSrc: PNG2, portraitSource: PNG, visibleToPlayers: true },
    { id: 'ambusher', name: 'Hidden Assassin', x: 100, y: 0, gridSize: 1, imageSrc: PNG2, visibleToPlayers: false },
  ],
  markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 },
  stageX: 0, stageY: 0, stageScale: 1, selectedId: null,
});

/** An asset publisher that records what it was asked to share. */
const fakeAssets = () => {
  const calls = [];
  return {
    calls, forgotten: 0, delay: 0,
    async resolve(src, kind) { calls.push({ src, kind }); if (this.delay) await new Promise(r => setTimeout(r, this.delay)); return src ? `/__realm/assets/${kind}-${String(src).length}` : null; },
    forgetUploads() { this.forgotten++; },
  };
};

/** A stand-in for createConnection that the test drives by hand. */
function stub() {
  const sent = [];
  const state = { open: true, closed: false, options: null, limits: {} };
  const transport = {
    get open() { return state.open; },
    get limits() { return state.limits; },
    get stats() { return { rtt: { last: 5 } }; },
    send(message) { if (!state.open) return false; sent.push(message); return true; },
    sendRaw(text) { if (!state.open) return false; sent.push(JSON.parse(text)); return true; },
    close() { state.closed = true; },
    nudge() { state.nudged = true; },
  };
  return { sent, state, transport, createTransport: options => { state.options = options; return transport; } };
}

test('SCENE_KEYS is the list the old broadcast.js had', () => {
  assert.deepEqual(SCENE_KEYS, [
    'mapImageSrc', 'mapWidth', 'mapHeight', 'showGrid', 'gridSize', 'gridColor', 'gridOpacity', 'feetPerCell',
    'snapToGrid', 'playerCanMoveTokens', 'showFog', 'fogCells', 'fogColor', 'fogOpacity', 'areaEffects', 'markers',
    'playerViewRect', 'tokens', 'combat', 'handoutSrc', 'handoutName',
  ]);
});

test('buildScene: shared URLs for images, no uncropped source, and hidden tokens keep their art on the GM computer', async () => {
  const assets = fakeAssets();
  const scene = await buildScene({ ...baseState(), handoutSrc: PNG2, handoutName: 'Letter' }, assets);
  assert.deepEqual(Object.keys(scene).filter(key => !SCENE_KEYS.includes(key)), [], 'pan, zoom and selection stay out');
  assert.match(scene.mapImageSrc, /^\/__realm\/assets\/map-/);
  assert.match(scene.handoutSrc, /^\/__realm\/assets\/handout-/);
  const [hero, ambusher] = scene.tokens;
  assert.equal(hero.portraitSource, undefined);
  assert.match(hero.imageSrc, /^\/__realm\/assets\/token-/);
  assert.equal(hero.portraitSrc, null, 'no portrait of its own');
  assert.equal(ambusher.imageSrc, null);
  assert.equal(ambusher.portraitSrc, null);
  assert.equal(assets.calls.filter(call => call.kind === 'token' && call.src).length, 1, 'the hidden token art is never even looked at');
  assert.equal(JSON.stringify(scene).includes('data:image'), false);
  const portrait = await buildScene({ ...baseState(), tokens: [{ id: 't', imageSrc: PNG, portraitSrc: PNG2, visibleToPlayers: true }] }, fakeAssets());
  assert.ok(portrait.tokens[0].portraitSrc);
  const absent = await buildScene({ tokens: undefined }, fakeAssets());
  assert.deepEqual(absent.tokens, []);
  assert.equal(absent.mapImageSrc, null);
});

test('flush is throttled: a burst of state changes sends one SCENE with the newest state', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  const assets = fakeAssets();
  const link = createGMLink({ createTransport: s.createTransport, assets, clock, throttleMs: 40 });
  s.state.options.onOpen();
  await settle(); clock.advance(0); await settle(); // the onOpen flush has nothing to send yet
  assert.deepEqual(s.sent, []);
  let state = baseState();
  for (let i = 1; i <= 5; i++) { state = { ...state, tokens: state.tokens.map(t => (t.id === 'hero' ? { ...t, x: i * 10 } : t)) }; link.broadcastState(state); }
  clock.advance(39); await settle();
  assert.equal(s.sent.length, 0);
  clock.advance(1); await settle();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].type, 'SCENE');
  assert.equal(s.sent[0].scene.tokens[0].x, 50);
});

test('pan, zoom and selection never reach the network; a shared change does', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  const link = createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock });
  let state = baseState();
  link.broadcastState(state);
  clock.advance(40); await settle();
  assert.equal(s.sent.length, 1);
  link.broadcastState(state = { ...state, stageX: 40, stageScale: 2, selectedId: 'hero' });
  clock.advance(500); await settle();
  assert.equal(s.sent.length, 1);
  link.broadcastState({ ...state, showFog: false });
  clock.advance(40); await settle();
  assert.equal(s.sent.length, 2);
});

test('a state change that arrives while a scene is being built is not lost', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  const assets = fakeAssets();
  assets.delay = 10;
  const link = createGMLink({ createTransport: s.createTransport, assets, clock });
  link.broadcastState(baseState());
  clock.advance(40);
  await pause(2);                     // the first build is under way
  link.broadcastState({ ...baseState(), fogCells: ['1,1'] });
  clock.advance(40);                  // the second flush finds one running and sets `again`
  await until(() => s.sent.length >= 2, 'the second scene');
  assert.deepEqual(s.sent.at(-1).scene.fogCells, ['1,1']);
});

test('nothing is sent while the connection is not open; the scene goes out as soon as it opens', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  const assets = fakeAssets();
  s.state.open = false;
  const link = createGMLink({ createTransport: s.createTransport, assets, clock });
  link.broadcastState(baseState());
  clock.advance(40); await settle();
  assert.deepEqual(s.sent, []);
  s.state.open = true;
  s.state.options.onOpen();
  assert.equal(assets.forgotten, 1, 'a restarted server has lost its images');
  clock.advance(0); await settle();
  assert.equal(s.sent.length, 1);
});

test('REQUEST_FULL_STATE makes the GM publish again even though nothing changed', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  const link = createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock });
  link.broadcastState(baseState());
  clock.advance(40); await settle();
  s.state.options.onMessage({ type: 'REQUEST_FULL_STATE' });
  clock.advance(0); await settle();
  assert.equal(s.sent.length, 2);
});

test('handlers: roster, ping, end turn, status, latency, and the new join request / table / audio / net stats', () => {
  const s = stub();
  const link = createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock: createFakeClock() });
  const seen = {};
  const keep = name => (...args) => { (seen[name] ??= []).push(args.length === 1 ? args[0] : args); };
  link.setHandlers({ onRoster: keep('roster'), onPing: keep('ping'), onEndTurn: keep('endTurn'), onStatus: keep('status'), onLatency: keep('latency'),
    onJoinRequest: keep('join'), onTable: keep('table'), onAudio: keep('audio'), onNetStats: keep('stats') });
  const o = s.state.options;
  o.onStatus('open'); o.onLatency(12);
  o.onMessage({ type: 'PLAYER_ROSTER', players: [{ id: 'p', name: 'Thorin' }] });
  o.onMessage({ type: 'MAP_PING', id: 'p', x: 1, y: 2 });
  o.onMessage({ type: 'PLAYER_END_TURN', playerId: 'p', tokenId: 'hero' });
  o.onMessage({ type: 'JOIN_REQUEST', device: 'd', name: 'Gimli' });
  o.onMessage({ type: 'TABLE', mode: 'ask', locked: false, code: 'ABCDEFGH' });
  o.onMessage({ type: 'AUDIO_LISTENER', device: 'd' });
  o.onMessage({ type: 'AUDIO_ANSWER', sid: 's' });
  o.onMessage({ type: 'AUDIO_STATS', sid: 's' });
  assert.deepEqual(seen.status, ['open']);
  assert.deepEqual(seen.latency, [12]);
  assert.deepEqual(seen.roster, [[{ id: 'p', name: 'Thorin' }]]);
  assert.equal(seen.ping[0].x, 1);
  assert.equal(seen.endTurn[0].tokenId, 'hero');
  assert.equal(seen.join[0].name, 'Gimli');
  assert.equal(seen.table[0].mode, 'ask');
  assert.equal(link.table.code, 'ABCDEFGH');
  assert.equal(seen.audio.length, 3);
  assert.deepEqual(seen.stats[0], { rtt: { last: 5 } });
  assert.doesNotThrow(() => o.onMessage({ type: 'SOMETHING_ELSE' }));
});

test('a player move is passed on only if that player may move that token; otherwise the GM re-publishes to undo it on their screen', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  const link = createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock });
  const moves = [];
  link.setHandlers({ onTokenMove: (id, x, y) => moves.push({ id, x, y }) });
  link.broadcastState({ ...baseState(), tokens: baseState().tokens.map(t => ({ ...t, ownerId: 'alice' })) });
  clock.advance(40); await settle();
  assert.equal(s.sent.length, 1);
  const o = s.state.options;
  o.onMessage({ type: 'PLAYER_TOKEN_MOVE', playerId: 'alice', id: 'hero', x: 10, y: 20 });
  assert.deepEqual(moves, [{ id: 'hero', x: 10, y: 20 }]);
  o.onMessage({ type: 'PLAYER_TOKEN_MOVE', playerId: 'bob', id: 'hero', x: 10, y: 20 });
  o.onMessage({ type: 'PLAYER_TOKEN_MOVE', playerId: 'alice', id: 'hero', x: NaN, y: 1 });
  o.onMessage({ type: 'PLAYER_TOKEN_MOVE', playerId: 'alice', id: 'nobody', x: 1, y: 1 });
  assert.equal(moves.length, 1);
  clock.advance(0); await settle();
  assert.equal(s.sent.length, 2, 'refused moves put the player screen back');
});

test('tableCommand sends TABLE_CMD with only the known fields, and refuses nonsense', () => {
  const s = stub();
  const link = createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock: createFakeClock() });
  assert.equal(link.tableCommand('kick', { device: 'abc', evil: 'x' }), true);
  assert.deepEqual(s.sent.at(-1), { type: 'TABLE_CMD', op: 'kick', device: 'abc' });
  assert.equal(link.tableCommand('mode', { mode: 'ask' }), true);
  assert.deepEqual(s.sent.at(-1), { type: 'TABLE_CMD', op: 'mode', mode: 'ask' });
  assert.equal(link.tableCommand('rename', { device: 'abc', name: 'Aria' }), true);
  assert.equal(link.tableCommand('rotate'), true);
  const count = s.sent.length;
  assert.equal(link.tableCommand('format-disk'), false);
  assert.equal(link.tableCommand('kick', { device: 42 }), false);
  s.state.open = false;
  assert.equal(link.tableCommand('lock'), false);
  assert.equal(s.sent.length, count);
  assert.equal(link.send({ type: 'AUDIO_STOP' }), false);
});

test('a scene larger than the server accepts is not sent (it would be closed with 1009), the GM is told once, and there is no retry loop', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  s.state.limits = { maxScene: 200 };
  const link = createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock });
  const errors = [];
  link.setHandlers({ onAssetError: message => errors.push(message) });
  link.broadcastState(baseState());
  clock.advance(40); await settle();
  assert.equal(s.sent.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /too large/i);
  clock.advance(10000); await settle();
  assert.equal(errors.length, 1);
});

test('close() stops publishing and closes the connection', async () => {
  const clock = createFakeClock({ start: 1000 });
  const s = stub();
  const link = createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock });
  link.broadcastState(baseState());
  link.close();
  clock.advance(1000); await settle();
  assert.equal(s.sent.length, 0);
  assert.equal(s.state.closed, true);
  link.broadcastState({ ...baseState(), showGrid: false });
  clock.advance(1000); await settle();
  assert.equal(s.sent.length, 0);
});

test('the default connection options: role gm, the link clock, transportOptions passed through', () => {
  const s = stub();
  const clock = createFakeClock();
  createGMLink({ createTransport: s.createTransport, assets: fakeAssets(), clock, transportOptions: { url: 'http://localhost:5173/', reconnectDelay: 7 } });
  assert.equal(s.state.options.role, 'gm');
  assert.equal(s.state.options.url, 'http://localhost:5173/');
  assert.equal(s.state.options.reconnectDelay, 7);
  assert.equal(s.state.options.clock, clock);
});

// ── with a hub (the fake one, or the real one with WP4_HUB=real): the whole path, real connection, real asset publisher ──

async function withTable(t, options) {
  const table = await startTable(t, options);
  const closers = [];
  t.after(() => closers.forEach(close => close()));
  const gm = (handlers = {}, extra = {}) => {
    const link = createGMLink({ transportOptions: transportFor(table), throttleMs: 5, ...extra });
    link.setHandlers(handlers);
    closers.push(() => link.close());
    return link;
  };
  /** A phone that has joined by invite link and watches the table (to see what the hub holds). */
  const watcher = () => {
    const store = createDeviceStore({ local: null, session: null });
    store.setInvite(table.invite().secret);
    const seen = { view: null, open: false };
    const link = createPlayerLink({ onState: v => { seen.view = v; }, onConnection: o => { seen.open = o; }, store, transportOptions: transportFor(table) });
    closers.push(() => link.close());
    return seen;
  };
  return { table, gm, watcher };
}

test('hub: the GM connects with rf3 only, uploads each image once with the GM header, and sends shared URLs, never pixels', async t => {
  const { table, gm, watcher } = await withTable(t);
  const link = gm();
  link.broadcastState(baseState());
  const seen = watcher();
  await until(() => seen.view, 'the scene to reach a player');
  const socket = table.sockets.find(entry => entry.role === 'gm');
  assert.deepEqual(socket.protocols, ['rf3'], 'no auth token for the GM (A.6)');
  assert.equal(table.requests.some(request => request.path === '/__realm/hello' && request.body?.device === undefined), false);
  const sent = table.sentBy('gm', 'SCENE');
  assert.ok(sent.length >= 1);
  const scene = sent.at(-1).scene;
  assert.match(scene.mapImageSrc, /^(https?:\/\/[^/]+)?\/__realm\/assets\/[0-9a-f]{64}$/);
  assert.equal(scene.tokens[1].imageSrc, null, 'hidden token art never leaves the GM');
  assert.equal(JSON.stringify(sent).includes('data:image'), false);
  const uploads = table.requests.filter(request => request.path.startsWith('/__realm/assets/') && request.method === 'PUT');
  assert.equal(uploads.length, 2, 'the map and the visible token art; the hidden token art is not uploaded');
  assert.ok(uploads.every(request => request.status === 201), uploads.map(request => request.status).join());
  assert.equal(seen.view.tokens.length, 1, 'the hidden token is not in the player view');
  assert.equal(link.open, true);
});

test('hub: a second GM window replaces the first (4001) and the first never reconnects', async t => {
  const { table, gm } = await withTable(t);
  const statuses = [];
  const first = gm({ onStatus: s => statuses.push(s) });
  await until(() => first.open, 'the first GM');
  const second = gm();
  await until(() => second.open, 'the second GM');
  await until(() => statuses.includes('replaced'), 'the first GM to be told');
  const sockets = table.socketCount('gm');
  await pause(300);
  assert.equal(table.socketCount('gm'), sockets, 'no reconnect attempts from the replaced window');
  assert.equal(first.open, false);
  assert.equal(second.open, true);
});

test('hub: after a dropped connection the GM reconnects and republishes the scene', async t => {
  const { table, gm, watcher } = await withTable(t);
  const link = gm();
  link.broadcastState(baseState());
  const seen = watcher();
  await until(() => seen.view, 'the first scene');
  const scenes = table.sentBy('gm', 'SCENE').length;
  table.closeAll(1006, 'gm');
  await until(() => !link.open, 'the drop');
  await until(() => link.open, 'the GM to be back');
  await until(() => table.sentBy('gm', 'SCENE').length > scenes, 'the scene to be sent again');
});

test('hub: TABLE_CMD changes the table, and TABLE reaches the handler each time', async t => {
  const { table, gm } = await withTable(t, { mode: 'ask' });
  const tables = [];
  const link = gm({ onTable: message => tables.push(message) });
  await until(() => tables.length > 0, 'the TABLE message');
  assert.equal(tables[0].mode, 'ask');
  assert.equal(link.tableCommand('mode', { mode: 'open' }), true);
  await until(() => tables.at(-1).mode === 'open', 'the TABLE update');
  assert.equal(link.tableCommand('lock'), true);
  await until(() => tables.at(-1).locked === true, 'the lock');
  assert.equal(link.table.locked, true);
  assert.equal(link.tableCommand('unlock'), true);
  await until(() => tables.at(-1).locked === false, 'the unlock');
});

test('hub: an image the table cannot take is reported in words a person can act on, and the scene still goes out', async t => {
  const { table, gm } = await withTable(t, { assetQuota: 10 });
  const errors = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = originalWarn; });
  const link = gm({ onAssetError: message => errors.push(message) });
  link.broadcastState(baseState());
  await until(() => errors.length > 0 && table.sentBy('gm', 'SCENE').length > 0, 'the error and the scene');
  assert.match(errors[0], /memory is full|too large/i);
  assert.equal(table.sentBy('gm', 'SCENE').at(-1).scene.mapImageSrc, null, 'an unshareable image becomes null, as before');
});
