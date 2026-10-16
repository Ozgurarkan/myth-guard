import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerLink, canonicalJson } from '../src/net/playerLink.js';
import { createGMLink } from '../src/net/gmLink.js';
import { createDeviceStore } from '../src/net/deviceStore.js';
import { JoinError } from '../src/net/joinClient.js';
import { createFakeClock } from '../test-support/fakeClock.js';
import { startTable, transportFor, until, pause } from '../test-support/wp4-table.js';
import { fnv1a, isId } from '../src/net/protocol.js';
import { randomSecret } from '../src/net/hmac.js';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const memoryStore = () => createDeviceStore({ local: null, session: null });
const memberStore = () => { const store = memoryStore(); store.ensureDevice(); store.setDk('ab'.repeat(32)); return store; };

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

// ── unit level: a hand-driven connection ────────────────────────────────────────────────────────────────────

function stub() {
  const sent = [];
  const state = { open: true, closed: 0, options: null, counts: {}, creations: 0 };
  const transport = {
    get open() { return state.open; },
    get stats() { return { rtt: { last: 9 }, reconnects: 2 }; },
    send(message, extra) { if (!state.open) return false; sent.push(extra ? { ...message, aid: extra.aid } : message); return true; },
    close() { state.closed++; },
    nudge() { state.nudged = true; },
    count(name) { state.counts[name] = (state.counts[name] ?? 0) + 1; },
  };
  return { sent, state, transport, createTransport: options => { state.options = options; state.creations++; return transport; } };
}
const joinStub = (result = { status: 'member' }) => {
  const calls = { ensure: 0, capture: 0, code: [], link: [] };
  const queue = [];
  return {
    calls, queue,
    captureInvite() { calls.capture++; return null; },
    async ensureJoined() { calls.ensure++; const next = queue.length ? queue.shift() : result; if (next instanceof Error) throw next; return next; },
    async joinWithCode(code) { calls.code.push(code); const next = queue.length ? queue.shift() : { status: 'admitted' }; if (next instanceof Error) throw next; return next; },
    async joinWithLink(hash) { calls.link.push(hash); return { status: 'admitted' }; },
  };
};

async function unit(options = {}) {
  const s = stub();
  const clock = createFakeClock({ start: 1000 });
  const store = options.store ?? memberStore();
  const join = options.join ?? joinStub();
  const log = { states: [], conn: [], gm: [], id: [], latency: [], move: [], turn: [], ping: [], kicked: [], locked: [], waiting: [], stats: [], audio: [], joinErrors: [] };
  const link = createPlayerLink({
    createTransport: s.createTransport, store, join, clock, readName: () => options.name ?? '',
    onState: v => log.states.push(v), onConnection: (open, status) => log.conn.push([open, status]), onGm: v => log.gm.push(v),
    onIdentity: v => log.id.push(v), onLatency: v => log.latency.push(v), onMoveRejected: v => log.move.push(v),
    onTurnRejected: v => log.turn.push(v), onPing: v => log.ping.push(v), onKicked: v => log.kicked.push(v), onLocked: v => log.locked.push(v),
    onWaiting: (...v) => log.waiting.push(v), onNetStats: v => log.stats.push(v), onAudio: v => log.audio.push(v), onJoinError: v => log.joinErrors.push(v),
    ...options.handlers,
  });
  await settle();
  return { s, clock, store, join, log, link, o: s.state.options, msg: (message, info) => s.state.options.onMessage(message, info ?? {}) };
}

test('a member connects as a player with its stored device and key, and resumes from the last applied revision', async () => {
  const u = await unit();
  assert.equal(u.s.state.creations, 1);
  assert.equal(u.o.role, 'player');
  assert.equal(u.o.device(), u.store.device());
  assert.equal(u.o.dk(), u.store.dk());
  assert.deepEqual(u.o.resume(), { rev: null });
  u.msg({ type: 'STATE_FULL', rev: 12, state: { tokens: [] } });
  assert.deepEqual(u.o.resume(), { rev: 12 }, 'the revision survives a reconnect so the server can send patches');
});

test('without a device key and without an invite the link asks for one instead of connecting', async () => {
  const join = joinStub({ status: 'needs-invite' });
  const u = await unit({ join, store: memoryStore() });
  assert.equal(u.s.state.creations, 0);
  assert.deepEqual(u.log.conn.at(-1), [false, 'needs-invite']);
  assert.equal(join.calls.capture, 1, 'the #join= fragment is read first');
});

test('statuses are passed to onConnection(open, status) as before', async () => {
  const u = await unit();
  u.o.onStatus('connecting'); u.o.onStatus('open'); u.o.onStatus('reconnecting'); u.o.onStatus('waiting');
  assert.deepEqual(u.log.conn.slice(-4), [[false, 'connecting'], [true, 'open'], [false, 'reconnecting'], [false, 'waiting']]);
});

test('identity comes from HELLO.playerId or the old PLAYER_ID; GM_STATUS, MAP_PING and the old rejections are passed on', async () => {
  const u = await unit();
  u.msg({ type: 'HELLO', v: 3, playerId: 'p-from-hello', name: '', server: { id: 's1' } });
  u.msg({ type: 'PLAYER_ID', id: 'p-old' });
  u.msg({ type: 'GM_STATUS', connected: true });
  u.msg({ type: 'MAP_PING', id: 'x', name: 'Y', x: 1, y: 2 });
  u.msg({ type: 'MOVE_REJECTED', id: 'hero', reason: 'blocked' });
  u.msg({ type: 'TURN_REJECTED', reason: 'away' });
  assert.deepEqual(u.log.id, ['p-from-hello', 'p-old']);
  assert.deepEqual(u.log.gm, [true]);
  assert.equal(u.log.ping[0].x, 1);
  assert.deepEqual(u.log.move, [{ type: 'MOVE_REJECTED', id: 'hero', reason: 'blocked' }]);
  assert.equal(u.log.turn[0].reason, 'away');
});

test('v3 ACKs become the old rejection callbacks; a successful ACK is silent; an ACK for a forgotten action is ignored', async () => {
  const u = await unit();
  u.msg({ type: 'ACK', aid: 'a-1', ok: false, reason: 'paused' }, { action: { type: 'PLAYER_TOKEN_MOVE', id: 'hero', x: 1, y: 1, aid: 'a-1' } });
  u.msg({ type: 'ACK', aid: 'a-2', ok: false, reason: 'not-your-turn' }, { action: { type: 'PLAYER_END_TURN', tokenId: 'hero', aid: 'a-2' } });
  u.msg({ type: 'ACK', aid: 'a-3', ok: true }, { action: { type: 'PLAYER_TOKEN_MOVE', id: 'hero', aid: 'a-3' } });
  u.msg({ type: 'ACK', aid: 'a-4', ok: false, reason: 'blocked' }, { action: null });
  assert.deepEqual(u.log.move, [{ id: 'hero', reason: 'paused' }]);
  assert.deepEqual(u.log.turn, [{ reason: 'not-your-turn' }]);
});

test('snapshot then patches: each patch must continue the revision; a gap triggers RESYNC and patches are ignored until a snapshot', async () => {
  const u = await unit();
  const first = { tokens: [{ id: 'a', x: 0 }], fogCells: [] };
  u.msg({ type: 'STATE_PATCH', rev: 5, base: 4, patch: { set: { showGrid: false } } });
  assert.equal(u.log.states.length, 0, 'a patch before any snapshot is ignored');
  u.msg({ type: 'STATE_FULL', rev: 10, state: first });
  assert.deepEqual(u.log.states.at(-1), first);
  u.msg({ type: 'STATE_PATCH', rev: 11, base: 10, patch: { coll: { tokens: { put: [{ id: 'a', x: 50 }] } } } });
  assert.equal(u.log.states.at(-1).tokens[0].x, 50);
  assert.equal(u.link.rev, 11);
  u.msg({ type: 'STATE_PATCH', rev: 13, base: 12, patch: { set: { showGrid: false } } });   // 12 was lost
  assert.deepEqual(u.s.sent.at(-1), { type: 'RESYNC' });
  assert.equal(u.link.rev, null);
  assert.deepEqual(u.o.resume(), { rev: null });
  const count = u.log.states.length;
  u.msg({ type: 'STATE_PATCH', rev: 14, base: 13, patch: { set: { showGrid: true } } });
  assert.equal(u.log.states.length, count, 'ignored while waiting for the snapshot');
  u.msg({ type: 'STATE_FULL', rev: 20, state: { tokens: [] } });
  assert.equal(u.link.rev, 20);
  assert.equal(u.log.states.length, count + 1);
});

test('a RESYNC that the server dropped is asked again after 3 s, until a snapshot arrives', async () => {
  const u = await unit();
  u.msg({ type: 'STATE_FULL', rev: 1, state: { tokens: [] } });
  u.msg({ type: 'STATE_PATCH', rev: 9, base: 8, patch: {} });
  const resyncs = () => u.s.sent.filter(m => m.type === 'RESYNC').length;
  assert.equal(resyncs(), 1);
  u.clock.advance(2999);
  assert.equal(resyncs(), 1);
  u.clock.advance(1);
  assert.equal(resyncs(), 2);
  u.msg({ type: 'STATE_FULL', rev: 30, state: { tokens: [] } });
  u.clock.advance(20000);
  assert.equal(resyncs(), 2, 'a snapshot ends the retries');
});

test('a malformed patch is a resync, not a crash', async () => {
  const u = await unit();
  u.msg({ type: 'STATE_FULL', rev: 1, state: { tokens: [] } });
  assert.doesNotThrow(() => u.msg({ type: 'STATE_PATCH', rev: 2, base: 1, patch: { coll: { tokens: 7 } } }));
  assert.ok(u.link.rev === null || u.link.rev === 2);
});

test('the revision of a different server run is forgotten (HELLO.server.id changed); the same server keeps it', async () => {
  const u = await unit();
  u.msg({ type: 'HELLO', v: 3, server: { id: 'run-1' } });
  u.msg({ type: 'STATE_FULL', rev: 40, state: { tokens: [] } });
  u.msg({ type: 'HELLO', v: 3, server: { id: 'run-1' } });
  assert.equal(u.link.rev, 40);
  u.msg({ type: 'HELLO', v: 3, server: { id: 'run-2' } });
  assert.equal(u.link.rev, null, 'a restarted server counts from the start again');
  assert.deepEqual(u.o.resume(), { rev: null });
});

test('every 50th patch carries a checksum of the player view; a mismatch counts a divergence and asks for a snapshot', async () => {
  const u = await unit();
  const state = { tokens: [{ id: 'a', x: 1, y: 2, name: 'Z' }], fogCells: ['1,1'] };
  u.msg({ type: 'STATE_FULL', rev: 49, state });
  const after = { ...state, tokens: [{ id: 'a', x: 9, y: 2, name: 'Z' }] };
  const sum = fnv1a(canonicalJson(after));
  u.msg({ type: 'STATE_PATCH', rev: 50, base: 49, sum, patch: { coll: { tokens: { put: [{ name: 'Z', y: 2, id: 'a', x: 9 }] } } } }); // key order differs on purpose
  assert.equal(u.link.rev, 50);
  assert.equal(u.s.state.counts.divergence, undefined);
  u.msg({ type: 'STATE_PATCH', rev: 51, base: 50, sum: 12345, patch: { set: { showGrid: false } } });
  assert.equal(u.s.state.counts.divergence, 1);
  assert.deepEqual(u.s.sent.at(-1), { type: 'RESYNC' });
  assert.equal(u.link.rev, null);
});

test('canonicalJson sorts keys and drops undefined like the server does', () => {
  assert.equal(canonicalJson({ b: 1, a: [undefined, { z: undefined, y: 2 }], c: null }), '{"a":[null,{"y":2}],"b":1,"c":null}');
  assert.equal(canonicalJson('x'), '"x"');
  assert.equal(canonicalJson(undefined), 'null');
});

test('sendMove / sendEndTurn carry a fresh valid action id; sendPing and setName do not; nothing is sent (or numbered) when disconnected', async () => {
  const u = await unit();
  assert.equal(u.link.sendMove('hero', 5, 6), true);
  assert.equal(u.link.sendEndTurn('hero'), true);
  assert.equal(u.link.sendPing(7, 8), true);
  assert.equal(u.link.setName('Aria'), true);
  const [move, end, ping, name] = u.s.sent;
  assert.deepEqual({ ...move, aid: undefined }, { type: 'PLAYER_TOKEN_MOVE', id: 'hero', x: 5, y: 6, aid: undefined });
  assert.ok(isId(move.aid) && isId(end.aid) && move.aid !== end.aid);
  assert.deepEqual(ping, { type: 'PLAYER_PING', x: 7, y: 8 });
  assert.deepEqual(name, { type: 'PLAYER_NAME', name: 'Aria' });
  u.s.state.open = false;
  const counter = u.store.nextAid();
  assert.equal(u.link.sendMove('hero', 1, 1), false);
  assert.equal(u.link.sendEndTurn('hero'), false);
  assert.equal(u.link.sendPing(1, 1), false);
  assert.equal(u.link.send({ type: 'AUDIO_LISTEN', enabled: true }), false);
  assert.equal(Number(u.store.nextAid().split('-')[1]) - parseInt(counter.split('-')[1], 36) >= 0, true);
  assert.equal(parseInt(u.store.nextAid().split('-')[1], 36) - parseInt(counter.split('-')[1], 36), 2, 'a refused send does not burn an id');
});

test('on open the stored name is sent unless HELLO already carried it', async () => {
  const same = await unit({ name: 'Thorin' });
  same.msg({ type: 'HELLO', v: 3, name: 'Thorin', server: { id: 's' } });
  same.o.onOpen(same.s.transport);
  assert.deepEqual(same.s.sent.filter(m => m.type === 'PLAYER_NAME'), []);
  const different = await unit({ name: 'Thorin Oakenshield' });
  different.msg({ type: 'HELLO', v: 3, name: 'Thorin', server: { id: 's' } });
  different.o.onOpen(different.s.transport);
  assert.deepEqual(different.s.sent.filter(m => m.type === 'PLAYER_NAME'), [{ type: 'PLAYER_NAME', name: 'Thorin Oakenshield' }]);
  const unknown = await unit({ name: '' });
  unknown.msg({ type: 'HELLO', v: 3, server: { id: 's' } });
  unknown.o.onOpen(unknown.s.transport);
  assert.equal(unknown.s.sent.filter(m => m.type === 'PLAYER_NAME').length, 1, 'a HELLO without a name: say it, as the old link did');
});

test('KICKED: onKicked once, identity forgotten, connection closed for good, status kicked; the close code afterwards adds nothing', async () => {
  const u = await unit();
  assert.ok(u.store.isMember());
  u.msg({ type: 'KICKED', reason: 'removed by the GM' });
  assert.deepEqual(u.log.kicked, [{ reason: 'kicked', detail: 'removed by the GM' }]);
  assert.equal(u.store.isMember(), false);
  assert.equal(u.store.device(), null);
  assert.equal(u.s.state.closed, 1);
  assert.deepEqual(u.log.conn.at(-1), [false, 'kicked']);
  u.o.onClose({ code: 4002, status: 'kicked', final: true });
  assert.equal(u.log.kicked.length, 1);
});

test('the 4002 close alone (no KICKED frame) is a kick too; DENIED is reported as denied', async () => {
  const a = await unit();
  a.o.onStatus('kicked');
  a.o.onClose({ code: 4002, status: 'kicked', final: true });
  assert.deepEqual(a.log.kicked, [{ reason: 'kicked' }]);
  assert.equal(a.store.isMember(), false);
  const b = await unit();
  b.msg({ type: 'DENIED' });
  assert.deepEqual(b.log.kicked, [{ reason: 'denied' }]);
  assert.equal(b.s.state.closed, 1);
});

test('locked: TABLE_LOCKED and the 4003 close both reach onLocked; the connection keeps retrying by itself', async () => {
  const u = await unit();
  u.msg({ type: 'TABLE_LOCKED' });
  u.o.onClose({ code: 4003, status: 'locked', final: false });
  assert.deepEqual(u.log.locked, [{ reason: 'locked' }, { reason: 'locked' }]);
  assert.equal(u.s.state.closed, 0);
  assert.equal(u.store.isMember(), true, 'a locked table does not make this device a stranger');
});

test('waiting room: WAIT then ADMITTED', async () => {
  const u = await unit();
  u.msg({ type: 'WAIT' });
  u.msg({ type: 'ADMITTED' });
  assert.deepEqual(u.log.waiting.map(([waiting]) => waiting), [true, false]);
});

test('audio messages are passed to onAudio; net statistics follow every latency sample, open and close', async () => {
  const u = await unit();
  for (const type of ['AUDIO_OFFER', 'AUDIO_CONTROLS', 'AUDIO_STATUS', 'AUDIO_FALLBACK', 'AUDIO_STOP']) u.msg({ type, sid: 's' });
  assert.equal(u.log.audio.length, 5);
  u.o.onLatency(31);
  assert.deepEqual(u.log.latency, [31]);
  assert.deepEqual(u.log.stats.at(-1), { rtt: { last: 9 }, reconnects: 2 });
  const before = u.log.stats.length;
  u.o.onOpen(u.s.transport);
  u.o.onClose({ code: 1006, status: 'reconnecting', final: false });
  assert.equal(u.log.stats.length, before + 2);
});

test('an unauthorized (4011 twice) device with an invite for this tab joins again; without one it is reported as removed', async () => {
  const withInvite = await unit();
  withInvite.store.setInvite(randomSecret());
  withInvite.join.queue.push({ status: 'admitted' });
  withInvite.o.onClose({ code: 4011, status: 'unauthorized', final: true });
  assert.equal(withInvite.store.dk(), null, 'the stale key is dropped');
  await settle();
  assert.equal(withInvite.join.calls.ensure, 2);
  assert.equal(withInvite.s.state.creations, 2, 'a new connection with the new key');
  assert.deepEqual(withInvite.log.kicked, []);

  const without = await unit();
  without.o.onClose({ code: 4011, status: 'unauthorized', final: true });
  assert.deepEqual(without.log.kicked, [{ reason: 'auth' }]);
  assert.equal(without.store.isMember(), false);
});

test('join refused: locked, full and banned show the lock screen and try again later on their own', async () => {
  const join = joinStub();
  join.queue.push(new JoinError('locked', 'The table is locked.', 403));
  const u = await unit({ join, store: memoryStore() });
  assert.deepEqual(u.log.conn.at(-1), [false, 'locked']);
  assert.deepEqual(u.log.locked, [{ reason: 'locked' }]);
  assert.equal(u.log.joinErrors[0].code, 'locked');
  assert.equal(u.s.state.creations, 0);
  u.clock.advance(14999); await settle();
  assert.equal(join.calls.ensure, 1);
  u.clock.advance(1); await settle();
  assert.equal(join.calls.ensure, 2, 'retried after 15 s');
  assert.equal(u.s.state.creations, 1, 'and connected once the table opened');
  join.queue.push(new JoinError('full', 'The table is full.', 403));
  u.link.retry(); await settle();
  assert.deepEqual(u.log.conn.at(-1), [false, 'full']);
});

test('join refused: a bad invite goes back to needs-invite, a rogue server stops everything, network trouble retries with growing waits', async () => {
  const bad = joinStub();
  bad.queue.push(new JoinError('bad-proof', 'x', 403));
  const a = await unit({ join: bad, store: memoryStore() });
  assert.deepEqual(a.log.conn.at(-1), [false, 'needs-invite']);
  a.clock.advance(100000); await settle();
  assert.equal(bad.calls.ensure, 1, 'no retries with a wrong invite');

  const rogue = joinStub();
  rogue.queue.push(new JoinError('rogue-server', 'x'));
  const b = await unit({ join: rogue, store: memoryStore() });
  assert.deepEqual(b.log.conn.at(-1), [false, 'rogue-server']);
  b.clock.advance(100000); await settle();
  assert.equal(rogue.calls.ensure, 1);

  const net = joinStub();
  net.queue.push(new JoinError('network', 'x'), new JoinError('network', 'x'), new JoinError('network', 'x'));
  const c = await unit({ join: net, store: memoryStore() });
  const waits = [];
  for (let i = 0; i < 3; i++) { waits.push(c.clock.nextIn()); c.clock.advance(c.clock.nextIn()); await settle(); }
  assert.deepEqual(waits, [3000, 6000, 12000]);
  assert.equal(c.s.state.creations, 1);
});

test('joinWithCode joins and then connects; a wrong code rejects, reaches onJoinError and leaves the link alone', async () => {
  const join = joinStub({ status: 'needs-invite' });
  const u = await unit({ join, store: memoryStore() });
  assert.equal(u.s.state.creations, 0);
  join.queue.push(new JoinError('bad-proof', 'Not accepted', 403));
  await assert.rejects(u.link.joinWithCode('AAAA-BBBB'), error => error.code === 'bad-proof');
  assert.equal(u.log.joinErrors.at(-1).code, 'bad-proof');
  assert.equal(u.s.state.creations, 0);
  join.queue.length = 0;
  join.calls.ensure = 0;
  // After a successful join the store holds the key: simulate that, as the real join client does.
  u.store.ensureDevice(); u.store.setDk('cd'.repeat(32));
  join.queue.push({ status: 'admitted' }, { status: 'member' });
  await u.link.joinWithCode('AAAABBBB');
  await settle();
  assert.deepEqual(join.calls.code, ['AAAA-BBBB', 'AAAABBBB']);
  assert.equal(u.s.state.creations, 1);
});

test('retry() starts over with a fresh connection; close() stops timers and closes the connection', async () => {
  const u = await unit();
  u.link.retry(); await settle();
  assert.equal(u.s.state.creations, 2);
  assert.equal(u.s.state.closed, 1, 'the old one was closed');
  u.link.nudge();
  assert.equal(u.s.state.nudged, true);
  u.link.close();
  assert.equal(u.s.state.closed, 2);
  u.link.retry(); await settle();
  assert.equal(u.s.state.creations, 2, 'a closed link stays closed');
});

test('closing while the join is still in flight never creates a connection', async () => {
  let release;
  const join = { captureInvite() {}, ensureJoined: () => new Promise(resolve => { release = () => resolve({ status: 'member' }); }) };
  const u = await unit({ join });
  u.link.close();
  release(); await settle();
  assert.equal(u.s.state.creations, 0);
});

// ── with a hub (the fake one, or the real one with WP4_HUB=real) ────────────────────────────────────────────────────

async function withTable(t, tableOptions) {
  const table = await startTable(t, tableOptions);
  const closers = [];
  t.after(() => closers.forEach(close => close()));
  const gm = (handlers = {}, extra = {}) => {
    const link = createGMLink({ transportOptions: transportFor(table), throttleMs: 5, ...extra });
    link.setHandlers(handlers);
    closers.push(() => link.close());
    return link;
  };
  /** A player that joins with the table's invite link. */
  const player = (handlers = {}, { store = memoryStore(), invite = true, name = '', ...extra } = {}) => {
    if (invite && !store.isMember()) store.setInvite(table.invite().secret);
    if (name) store.setName(name);
    const link = createPlayerLink({ ...handlers, store, transportOptions: transportFor(table), readName: () => store.name(), ...extra });
    closers.push(() => link.close());
    return { link, store };
  };
  /** A phone that stays connected and records the last view: tells a test when the hub has applied a change. */
  const observer = () => {
    const seen = { view: null, open: false };
    player({ onState: v => { seen.view = v; }, onConnection: o => { seen.open = o; } });
    return seen;
  };
  return { table, gm, player, observer };
}

const fullFrames = (table, store) => table.framesTo(store.device()).filter(frame => frame.type === 'STATE_FULL');
const patchFrames = (table, store) => table.framesTo(store.device()).filter(frame => frame.type === 'STATE_PATCH');

test('hub: a new browser joins with the invite and receives the filtered scene (images as shared URLs, no hidden token), then only patches', async t => {
  const { table, gm, player } = await withTable(t);
  const link = gm();
  let state = baseState();
  link.broadcastState(state);
  const views = []; let open = false; let identity = null;
  const { store } = player({ onState: v => views.push(v), onConnection: o => { open = o; }, onIdentity: id => { identity = id; } });
  await until(() => open && views.length && identity, 'the player to see the table');
  assert.equal(store.isMember(), true);
  assert.equal(store.invite(), null, 'the spent invite is gone');
  const join = table.requests.find(request => request.path === '/__realm/join');
  assert.equal(join.body.how, 'link');
  assert.equal(join.status, 200);
  const first = views[0];
  assert.match(first.mapImageSrc, new RegExp(`^${table.url}/__realm/assets/[0-9a-f]{64}$`));
  assert.equal(first.tokens.length, 1);
  assert.equal(first.tokens[0].portraitSource, undefined);
  assert.equal(JSON.stringify(first).includes('Hidden Assassin'), false);
  assert.equal(JSON.stringify(first).includes('data:image'), false);
  assert.equal(JSON.stringify(table.framesTo(store.device())).includes('Hidden Assassin'), false, 'not one frame mentions the hidden token');

  const count = views.length;
  state = { ...state, stageX: 40, stageScale: 2 };               // GM view changes never reach players
  link.broadcastState(state);
  await pause(60);
  assert.equal(views.length, count);

  state = { ...state, tokens: state.tokens.map(token => (token.id === 'hero' ? { ...token, x: 150 } : token)) };
  link.broadcastState(state);
  await until(() => views.at(-1).tokens[0].x === 150, 'the moved token');
  assert.equal(fullFrames(table, store).length, 1, 'one snapshot, then patches');
  const patch = patchFrames(table, store)[0];
  assert.ok(JSON.stringify(patch).length < 300);
  assert.equal(table.sentBy('player', 'RESUME')[0].rev, null, 'the first connection has nothing to resume');
  if (table.fake) assert.equal(table.hub.strikes ?? 0, 0, 'a well-behaved client earns no strikes');
});

test('hub: a dropped connection resumes with the missed patches, not a snapshot', async t => {
  const { table, gm, player, observer } = await withTable(t);
  const link = gm();
  let state = baseState();
  link.broadcastState(state);
  const watch = observer();
  const views = []; let open = false;
  const { store } = player({ onState: v => views.push(v), onConnection: o => { open = o; } });
  await until(() => open && views.length && watch.view, 'the first views');
  const lastRev = fullFrames(table, store)[0].rev;

  table.outage(store.device());
  table.dropDevice(store.device());
  await until(() => !open, 'the drop');
  state = { ...state, fogCells: ['1,1'] };                          // two changes while the phone is away
  link.broadcastState(state);
  await until(() => watch.view.fogCells.length === 1, 'the hub to publish the first change');
  state = { ...state, tokens: state.tokens.map(token => (token.id === 'hero' ? { ...token, x: 77 } : token)) };
  link.broadcastState(state);
  await until(() => watch.view.tokens[0].x === 77, 'the hub to publish the second change');
  table.outage(false);
  await until(() => open && views.at(-1).tokens[0].x === 77, 'the player to catch up');
  assert.deepEqual(views.at(-1).fogCells, ['1,1']);
  assert.equal(fullFrames(table, store).length, 1, 'no second snapshot');
  assert.equal(patchFrames(table, store).length, 2);
  assert.equal(table.sentBy('player', 'RESUME').at(-1).rev, lastRev, 'RESUME carried the last applied revision');
});

test('hub: a player who is more than 16 patches behind gets a snapshot instead', async t => {
  const { table, gm, player, observer } = await withTable(t);
  const link = gm();
  let state = baseState();
  link.broadcastState(state);
  const watch = observer();
  const views = []; let open = false;
  const { store } = player({ onState: v => views.push(v), onConnection: o => { open = o; } });
  await until(() => open && views.length && watch.view, 'the first views');
  table.outage(store.device());
  table.dropDevice(store.device());
  await until(() => !open);
  for (let i = 1; i <= 20; i++) {
    state = { ...state, fogCells: Array.from({ length: i }, (_, k) => `${k},0`) };
    link.broadcastState(state);
    await until(() => watch.view.fogCells.length === i, `change ${i}`);
  }
  table.outage(false);
  await until(() => open && views.at(-1).fogCells.length === 20, 'the player to catch up');
  assert.equal(fullFrames(table, store).length, 2);
});

test('hub: a late joiner never makes the GM resend the scene, and a GM who leaves does not blank the table; a returning GM is picked up', async t => {
  const { table, gm, player } = await withTable(t);
  const first = gm();
  first.broadcastState(baseState());
  let view, away;
  player({ onState: v => { view = v; }, onGm: present => { away = !present; } });
  await until(() => view && away === false, 'the first player');
  const requests = table.framesToGm('REQUEST_FULL_STATE').length;
  assert.equal(requests, 1, 'the GM was asked once, when it connected');
  let late;
  player({ onState: v => { late = v; } });
  await until(() => late, 'a late joiner');
  assert.equal(table.framesToGm('REQUEST_FULL_STATE').length, requests, 'late joiners never make the GM resend the scene');
  first.close();
  await until(() => away === true, 'the GM to be marked away');
  assert.equal(view.tokens.length, 1, 'players keep what they were looking at');
  let later;
  player({ onState: v => { later = v; } });
  await until(() => later, 'a joiner while the GM is away');
  const second = gm();
  second.broadcastState({ ...baseState(), fogCells: ['1,1'] });
  await until(() => away === false && view.fogCells.length === 1, 'the returning GM');
});

test('hub: token moves are accepted from the owner only, with ACK rejections turned into onMoveRejected', async t => {
  const { gm, player } = await withTable(t);
  const moves = [];
  const link = gm({ onTokenMove: (id, x, y) => moves.push({ id, x, y }) });
  const mine = { id: null, view: null, rejected: [] };
  const theirs = { id: null, view: null, rejected: [] };
  const alice = player({ onIdentity: id => { mine.id = id; }, onState: v => { mine.view = v; }, onMoveRejected: r => mine.rejected.push(r) }).link;
  const bob = player({ onIdentity: id => { theirs.id = id; }, onState: v => { theirs.view = v; }, onMoveRejected: r => theirs.rejected.push(r) }).link;
  await until(() => mine.id && theirs.id, 'identities');
  let state = { ...baseState(), tokens: baseState().tokens.map(token => ({ ...token, ownerId: mine.id })) };
  link.broadcastState(state);
  await until(() => mine.view?.tokens[0]?.ownerId === mine.id && theirs.view, 'the scene');

  assert.equal(alice.sendMove('hero', 120, 80), true);
  await until(() => moves.length === 1, 'the GM to hear of the move');
  assert.deepEqual(moves[0], { id: 'hero', x: 120, y: 80 });
  await until(() => theirs.view.tokens[0].x === 120, 'everyone to see the move');

  bob.sendMove('hero', 5, 5);
  await until(() => theirs.rejected.length === 1);
  assert.deepEqual(theirs.rejected[0], { id: 'hero', reason: 'blocked' });
  assert.equal(moves.length, 1);

  state = { ...state, playerCanMoveTokens: false };
  link.broadcastState(state);
  await until(() => mine.view.playerCanMoveTokens === false);
  alice.sendMove('hero', 300, 300);
  await until(() => mine.rejected.length === 1);
  assert.equal(mine.rejected[0].reason, 'paused');

  state = { ...state, playerCanMoveTokens: true, fogCells: ['0,0'] };
  link.broadcastState(state);
  await until(() => mine.view.fogCells.length === 1);
  alice.sendMove('hero', 300, 300);
  await until(() => mine.rejected.length === 2);
  assert.equal(mine.rejected[1].reason, 'blocked', 'a token under fog cannot be moved');
  assert.equal(moves.length, 1);
});

test('hub: moves are refused while the GM is away', async t => {
  const { gm, player } = await withTable(t);
  const link = gm();
  let identity, view; const rejected = [];
  const alice = player({ onIdentity: id => { identity = id; }, onState: v => { view = v; }, onMoveRejected: r => rejected.push(r) }).link;
  await until(() => identity);
  link.broadcastState({ ...baseState(), tokens: baseState().tokens.map(token => ({ ...token, ownerId: identity })) });
  await until(() => view);
  link.close();
  await pause(60);
  alice.sendMove('hero', 50, 50);
  await until(() => rejected.length === 1);
  assert.equal(rejected[0].reason, 'away');
});

test('hub: the roster tells the GM who is at the table', async t => {
  const { gm, player } = await withTable(t);
  let roster = [];
  const link = gm({ onRoster: players => { roster = players; } });
  link.broadcastState(baseState());
  player({}, { name: 'Thorin' });
  await until(() => roster.some(entry => entry.name === 'Thorin'), 'the roster');
  assert.equal(typeof roster[0].device, 'string');
  assert.ok(roster[0].id);
});

test('hub: a ping reaches every player and the GM, stays on the map, and cannot be spammed', async t => {
  const { gm, player } = await withTable(t);
  const gmPings = [], alicePings = [], bobPings = [];
  const link = gm({ onPing: p => gmPings.push(p) });
  let aliceId, aliceView, bobView;
  const alice = player({ onIdentity: id => { aliceId = id; }, onState: v => { aliceView = v; }, onPing: p => alicePings.push(p) }).link;
  player({ onState: v => { bobView = v; }, onPing: p => bobPings.push(p) });
  link.broadcastState(baseState());
  await until(() => aliceId && aliceView && bobView);

  alice.sendPing(400, 300);
  await until(() => gmPings.length === 1 && alicePings.length === 1 && bobPings.length === 1, 'the ping everywhere');
  assert.equal(bobPings[0].id, aliceId);
  assert.deepEqual([bobPings[0].x, bobPings[0].y], [400, 300]);
  alice.sendPing(10, 10);
  await pause(100);
  assert.equal(gmPings.length, 1, 'inside the cooldown');
  await pause(700);
  alice.sendPing(99999, -50);
  await until(() => gmPings.length === 2);
  assert.deepEqual([gmPings[1].x, gmPings[1].y], [2000, 0]);
  await pause(700);
  alice.sendPing(NaN, 5);
  await pause(100);
  assert.equal(gmPings.length, 2);
});

test('hub: only the player whose hero is acting can end the turn, and the GM hears of it once', async t => {
  const { gm, player } = await withTable(t);
  const ended = [];
  const link = gm({ onEndTurn: m => ended.push(m) });
  const mine = { id: null, view: null, rejected: [] };
  const theirs = { id: null, view: null, rejected: [] };
  const alice = player({ onIdentity: id => { mine.id = id; }, onState: v => { mine.view = v; }, onTurnRejected: r => mine.rejected.push(r) }).link;
  const bob = player({ onIdentity: id => { theirs.id = id; }, onState: v => { theirs.view = v; }, onTurnRejected: r => theirs.rejected.push(r) }).link;
  await until(() => mine.id && theirs.id);
  const scene = activeId => ({ ...baseState(), tokens: baseState().tokens.map(token => ({ ...token, ownerId: mine.id })),
    combat: { entries: [{ tokenId: 'hero', initiative: 12 }], activeId, round: 1 } });
  link.broadcastState(scene(null));
  await until(() => mine.view && theirs.view);
  alice.sendEndTurn('hero');
  await until(() => mine.rejected.length === 1);
  assert.equal(mine.rejected[0].reason, 'not-your-turn');
  link.broadcastState(scene('hero'));
  await until(() => mine.view.combat?.activeId === 'hero');
  bob.sendEndTurn('hero');
  await until(() => theirs.rejected.length === 1);
  assert.equal(ended.length, 0);
  alice.sendEndTurn('hero');
  alice.sendEndTurn('hero');
  await until(() => ended.length === 1);
  await pause(100);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].playerId, mine.id);
  link.close();
  await pause(1600);                                              // past the double-tap guard, so only the away rule can answer
  alice.sendEndTurn('hero');
  await until(() => mine.rejected.length === 2);
  assert.equal(mine.rejected[1].reason, 'away');
});

test('hub: a move sent as the connection died is re-sent after the reconnect and applied once', async t => {
  const { table, gm, player } = await withTable(t);
  const moves = [];
  const link = gm({ onTokenMove: (id, x, y) => moves.push({ id, x, y }) });
  let identity, view, open = false;
  const alice = player({ onIdentity: id => { identity = id; }, onState: v => { view = v; }, onConnection: o => { open = o; } }).link;
  await until(() => identity && open);
  link.broadcastState({ ...baseState(), tokens: baseState().tokens.map(token => ({ ...token, ownerId: identity })) });
  await until(() => view?.tokens[0]?.ownerId === identity);
  assert.equal(alice.sendMove('hero', 33, 44), true);
  table.closeAll(1006, 'player');                                  // the frame may or may not have made it: either way, once
  await until(() => !open, 'the drop');
  await until(() => open, 'the reconnect');
  await until(() => moves.length === 1, 'the GM to hear of the move');
  await pause(150);
  assert.equal(moves.length, 1, 'applied exactly once');
  assert.deepEqual(moves[0], { id: 'hero', x: 33, y: 44 });
});

test('hub: ask mode - the phone waits (no state), the GM sees the request and admits, then the phone gets the scene', async t => {
  const { table, gm, player } = await withTable(t, { mode: 'ask' });
  const requests = [];
  const link = gm({ onJoinRequest: r => requests.push(r) });
  link.broadcastState(baseState());
  const waiting = []; let view = null; const status = [];
  const { store } = player({ onWaiting: w => waiting.push(w), onState: v => { view = v; }, onConnection: (o, s) => status.push(s) }, { name: 'Gimli' });
  await until(() => waiting.includes(true), 'the waiting room');
  assert.ok(status.includes('waiting'));
  await until(() => requests.length === 1, 'the join request');
  assert.equal(requests[0].name, 'Gimli');
  await pause(80);
  assert.equal(view, null, 'a waiting device gets no state');
  assert.equal(fullFrames(table, store).length, 0);
  assert.equal(link.tableCommand('admit', { device: requests[0].device }), true);
  await until(() => view && waiting.at(-1) === false, 'admission');
  assert.equal(status.at(-1), 'open');
  assert.equal(view.tokens.length, 1);
});

test('hub: kick - the player is told, forgets its identity and does not come back', async t => {
  const { table, gm, player } = await withTable(t);
  const link = gm();
  const kicked = []; let open = false;
  const { store } = player({ onKicked: k => kicked.push(k), onConnection: o => { open = o; } });
  await until(() => open, 'the player');
  const device = store.device();
  assert.equal(link.tableCommand('kick', { device }), true);
  await until(() => kicked.length === 1, 'the kick');
  assert.equal(kicked[0].reason, 'kicked');
  assert.equal(store.isMember(), false);
  const sockets = table.socketCount('player');
  await pause(300);
  assert.equal(table.socketCount('player'), sockets, 'no reconnect attempts');
  assert.equal(kicked.length, 1);
});

test('hub: a locked table refuses a new phone but still lets a known one back in', async t => {
  const { table, gm, player } = await withTable(t);
  gm();
  let open = false;
  player({ onConnection: o => { open = o; } }, { name: 'Known' });
  await until(() => open);
  table.setMode('locked');
  const locked = []; const statuses = [];
  const stranger = player({ onLocked: l => locked.push(l), onConnection: (o, s) => statuses.push(s) });
  await until(() => locked.length > 0, 'the lock screen');
  assert.equal(locked[0].reason, 'locked');
  assert.equal(statuses.at(-1), 'locked');
  assert.equal(stranger.store.isMember(), false);
  table.closeAll(1006, 'player');
  await until(() => !open);
  await until(() => open, 'the known phone to come back');
  table.setMode('open');
  stranger.store.setInvite(table.invite().secret);              // a locked table may have rotated the invite
  stranger.link.retry();
  await until(() => stranger.store.isMember(), 'the stranger to get in after the unlock', { timeout: 4000 });
});

test('hub: with a stale invite the phone asks for a code; a typed code gets it in', async t => {
  const { table, player } = await withTable(t);
  const statuses = []; const errors = [];
  const store = memoryStore();
  store.setInvite(randomSecret());
  const { link } = player({ onConnection: (o, s) => statuses.push(s), onJoinError: e => errors.push(e) }, { store, invite: false });
  await until(() => statuses.includes('needs-invite'), 'needs-invite');
  assert.equal(errors[0].code, 'bad-proof');
  assert.equal(store.invite(), null);
  await assert.rejects(link.joinWithCode('AAAAAAAA'), error => error.code === 'bad-proof');
  await link.joinWithCode(table.invite().code.toLowerCase());
  await until(() => statuses.at(-1) === 'open', 'the connection after joining by code');
  assert.equal(store.isMember(), true);
  assert.equal(table.requests.filter(request => request.path === '/__realm/join').at(-1).body.how, 'code');
});

test('hub: a rogue access point (wrong srvProof) is never trusted and nothing is stored', async t => {
  const { table, player } = await withTable(t);
  if (!table.fake) { t.skip('needs a server that lies; fake hub only'); return; }
  table.hub.setRogue(true);
  const statuses = []; const errors = [];
  const { store } = player({ onConnection: (o, s) => statuses.push(s), onJoinError: e => errors.push(e) });
  await until(() => statuses.includes('rogue-server'), 'the rogue verdict');
  assert.equal(errors[0].code, 'rogue-server');
  assert.equal(store.dk(), null);
  assert.equal(table.socketCount('player'), 0, 'it never even opened a socket');
});

test('hub: a table that no longer knows the device (4011 twice) removes it', async t => {
  const { table, player } = await withTable(t);
  if (!table.fake) { t.skip('needs a hub that closes with 4011 after the upgrade; the real hub refuses inside the HTTP upgrade'); return; }
  const kicked = []; let open = false;
  const { store } = player({ onKicked: k => kicked.push(k), onConnection: o => { open = o; } });
  await until(() => open);
  table.hub.refuseUpgrades(2, 4011);
  table.closeAll(1006, 'player');
  await until(() => kicked.length === 1, 'the final refusal');
  assert.equal(kicked[0].reason, 'auth');
  assert.equal(store.isMember(), false);
});

test('hub: the player socket offers rf3 plus exactly one auth token, and a proof the table accepts', async t => {
  const { table, player } = await withTable(t);
  let open = false;
  player({ onConnection: o => { open = o; } });
  await until(() => open);
  const entry = table.sockets.find(item => item.role === 'player');
  assert.equal(entry.protocols[0], 'rf3');
  assert.equal(entry.protocols.length, 2);
  assert.match(entry.protocols[1], /^auth\.[0-9a-f]{32}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  assert.equal(entry.opened, true);
  const hello = table.requests.find(request => request.path === '/__realm/hello');
  assert.equal(hello.status, 200);
  assert.deepEqual(Object.keys(hello.body), ['device']);
});
