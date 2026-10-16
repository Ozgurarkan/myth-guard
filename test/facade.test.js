import test from 'node:test';
import assert from 'node:assert/strict';
import * as facade from '../src/net/facade.js';
import * as legacy from '../src/broadcast.js';
import { createFakeHub } from '../test-support/wp4-fakeHub.js';
import { until, pause } from '../test-support/wp4-table.js';
import { randomSecret } from '../src/net/hmac.js';

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

test('the facade exports everything src/broadcast.js exports today, with the same kinds of value', () => {
  // `legacy` is whatever src/broadcast.js is right now: the old implementation before the switch, a re-export of the facade after it.
  const wanted = ['SCENE_KEYS', 'buildScene', 'createGMLink', 'createPlayerLink', 'broadcastState', 'subscribeGM', 'subscribePlayer',
    'sendPlayerTokenMove', 'sendPlayerPing', 'sendPlayerEndTurn', 'setPlayerName', 'getPlayerName'];
  for (const name of wanted) {
    assert.ok(name in facade, `facade lacks ${name}`);
    assert.ok(name in legacy, `broadcast.js lacks ${name}`);
    assert.equal(typeof facade[name], typeof legacy[name], name);
  }
  for (const name of Object.keys(legacy)) assert.ok(name in facade, `broadcast.js exports ${name} but the facade does not`);
  assert.deepEqual(facade.SCENE_KEYS, legacy.SCENE_KEYS);
});

test('buildScene gives the same scene as the old one for the same input', async () => {
  const assets = { resolve: async (src, kind) => (src ? `/__realm/assets/${kind}/${src.length}` : null) };
  const state = { ...baseState(), handoutSrc: PNG2, handoutName: 'Note' };
  assert.deepEqual(await facade.buildScene(state, assets), await legacy.buildScene(state, assets));
});

test('documented additions exist', () => {
  for (const name of ['sendTableCommand', 'sendGmMessage', 'sendPlayerMessage', 'joinWithCode', 'joinWithLink', 'retryPlayerConnection', 'getPlayerNetStats', 'getGMNetStats']) {
    assert.equal(typeof facade[name], 'function', name);
  }
});

test('without a connection the send functions answer false and never throw', () => {
  assert.equal(facade.sendPlayerTokenMove('a', 1, 2), false);
  assert.equal(facade.sendPlayerPing(1, 2), false);
  assert.equal(facade.sendPlayerEndTurn('a'), false);
  assert.equal(facade.sendTableCommand('lock'), false);
  assert.equal(facade.sendGmMessage({ type: 'AUDIO_STOP' }), false);
  assert.equal(facade.sendPlayerMessage({ type: 'AUDIO_LISTEN' }), false);
  assert.doesNotThrow(() => facade.setPlayerName('Nobody'));
  assert.equal(facade.getPlayerNetStats(), null);
  assert.equal(facade.getGMNetStats(), null);
});

test('end to end through the default wiring: browser globals -> subscribeGM / subscribePlayer -> the table', async t => {
  const hub = createFakeHub();
  const secret = randomSecret();
  hub.invite.secret = secret;
  const replaced = [];
  const saved = new Map();
  const define = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  const storage = () => { const data = new Map(); return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) }; };
  define('WebSocket', hub.WebSocketClass);
  define('fetch', hub.fetchImpl);
  define('location', { href: `${hub.url}/player.html#join=${secret}`, hash: `#join=${secret}`, pathname: '/player.html', search: '' });
  define('history', { replaceState: (...args) => replaced.push(args) });
  define('localStorage', storage());
  define('sessionStorage', storage());
  t.after(() => {
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
    hub.close();
  });

  const gmEvents = { roster: [], moves: [], pings: [], ended: [], status: [], tables: [] };
  const stopGM = facade.subscribeGM({
    onRoster: p => { gmEvents.roster = p; }, onTokenMove: (id, x, y) => gmEvents.moves.push({ id, x, y }), onPing: p => gmEvents.pings.push(p),
    onEndTurn: m => gmEvents.ended.push(m), onStatus: s => gmEvents.status.push(s), onTable: m => gmEvents.tables.push(m),
  });
  facade.broadcastState(baseState());

  const p = { view: null, open: false, status: null, id: null, rejected: [], turnRejected: [], pings: [], gm: null, stats: [] };
  const stopPlayer = facade.subscribePlayer({
    onState: v => { p.view = v; }, onConnection: (o, s) => { p.open = o; p.status = s; }, onIdentity: id => { p.id = id; },
    onMoveRejected: r => p.rejected.push(r), onTurnRejected: r => p.turnRejected.push(r), onPing: x => p.pings.push(x), onGm: g => { p.gm = g; },
    onNetStats: s => p.stats.push(s), onLatency: () => {},
  });
  await until(() => p.view && p.open && p.id && p.gm === true, 'the player to see the table');
  assert.equal(p.status, 'open');
  assert.deepEqual(replaced, [[null, '', '/player.html']], 'the invite secret was removed from the address bar');
  assert.equal(p.view.tokens.length, 1);
  assert.equal(JSON.stringify(p.view).includes('Hidden Assassin'), false);
  assert.match(p.view.mapImageSrc, /^\/__realm\/assets\/[0-9a-f]{64}$/);
  assert.equal(gmEvents.status.at(-1), 'open');
  await until(() => gmEvents.tables.length > 0, 'the TABLE message');

  // name: stored, remembered, shown in the roster
  facade.setPlayerName('Thorin');
  assert.equal(facade.getPlayerName(), 'Thorin');
  await until(() => gmEvents.roster.some(entry => entry.name === 'Thorin'), 'the roster');

  // moves
  facade.broadcastState({ ...baseState(), tokens: baseState().tokens.map(token => ({ ...token, ownerId: p.id })) });
  await until(() => p.view.tokens[0].ownerId === p.id);
  assert.equal(facade.sendPlayerTokenMove('hero', 120, 80), true);
  await until(() => gmEvents.moves.length === 1);
  assert.deepEqual(gmEvents.moves[0], { id: 'hero', x: 120, y: 80 });
  await until(() => p.view.tokens[0].x === 120);
  facade.sendPlayerTokenMove('ambusher', 1, 1);
  await until(() => p.rejected.length === 1);
  assert.deepEqual(p.rejected[0], { id: 'ambusher', reason: 'blocked' });

  // ping and end turn
  assert.equal(facade.sendPlayerPing(400, 300), true);
  await until(() => gmEvents.pings.length === 1 && p.pings.length === 1);
  assert.deepEqual([p.pings[0].x, p.pings[0].y], [400, 300]);
  facade.sendPlayerEndTurn('hero');
  await until(() => p.turnRejected.length === 1);
  assert.equal(p.turnRejected[0].reason, 'not-your-turn');

  // statistics are available through the handler and the getter
  await until(() => facade.getPlayerNetStats()?.messagesIn > 0);
  assert.ok(p.stats.length > 0);
  assert.equal(typeof facade.getPlayerNetStats().reconnects, 'number');

  // the GM can remove the device through the facade
  const device = hub.devices.keys().next().value;
  const kicked = [];
  stopPlayer();                                        // a new subscription for the kick part
  const stopAgain = facade.subscribePlayer({ onKicked: k => kicked.push(k), onConnection: (o, s) => { p.status = s; } });
  await until(() => p.status === 'open', 'the player to be back');
  assert.equal(facade.sendTableCommand('kick', { device }), true);
  await until(() => kicked.length === 1, 'the kick');
  assert.equal(kicked[0].reason, 'kicked');
  assert.equal(facade.sendPlayerPing(1, 1), false, 'a removed device sends nothing');

  stopAgain();
  stopGM();
  assert.equal(facade.sendPlayerTokenMove('hero', 1, 1), false, 'after unsubscribing nothing is sent');
  assert.equal(facade.sendTableCommand('lock'), false);
  await pause(30);
});
