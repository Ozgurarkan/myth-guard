import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createConnection } from '../src/net/connection.js';
import { createFakeClock } from '../test-support/fakeClock.js';
import { createFakeWebSocketClass } from '../test-support/fakeSocket.js';
import { randomHex, wsProof } from '../src/net/hmac.js';
import { parseAuthProtocol, CLOSE, LIMITS } from '../src/net/protocol.js';

const DEVICE = 'a1'.repeat(16);
const DK = 'b2'.repeat(32);
const PAGE = 'http://192.168.1.20:5173/player.html';

/** Let promise continuations run (the fake clock is synchronous, fetch is not). */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

function rig(options = {}) {
  const clock = createFakeClock({ start: 1000 });
  const Socket = createFakeWebSocketClass();
  const events = { status: [], closes: [], opened: 0, messages: [], latency: [], expired: [] };
  const hellos = [];
  const fetchImpl = async (address, init) => {
    hellos.push({ address: String(address), init, body: JSON.parse(init.body) });
    const planned = rigState.helloPlan.shift();
    if (planned === 'hang') return new Promise(() => {});
    if (typeof planned === 'number') return { ok: false, status: planned, json: async () => rigState.helloBody ?? {} };
    return { ok: true, status: 200, json: async () => ({ nonce: randomHex(16), ttl: 15 }) };
  };
  const rigState = { helloPlan: [...(options.helloPlan ?? [])], helloBody: options.helloBody ?? null, rev: null };
  const connection = createConnection({
    role: 'player', url: PAGE, device: () => rigState.device ?? DEVICE, dk: () => rigState.dk ?? DK,
    WebSocketClass: Socket, fetchImpl, clock, random: () => 0.5, env: options.env ?? {},
    resume: () => ({ rev: rigState.rev }),
    onStatus: status => events.status.push(status),
    onOpen: () => { events.opened++; },
    onMessage: (message, info) => events.messages.push({ message, info }),
    onLatency: rtt => events.latency.push(rtt),
    onClose: info => events.closes.push(info),
    onActionExpired: action => events.expired.push(action),
    ...options.connection,
  });
  const api = {
    clock, Socket, events, hellos, connection, rigState,
    get socket() { return Socket.instances.at(-1); },
    async openSocket(hello = {}) {
      await settle();
      const socket = Socket.instances.at(-1);
      socket.test.open();
      socket.test.serverSend({ type: 'HELLO', v: 3, role: 'player', playerId: 'p1', name: '', rev: 1, server: { id: 'srv1', started: 1 }, limits: { maxScene: 1000 }, ...hello });
      return socket;
    },
    sent: socket => socket.test.sentJson,
  };
  return api;
}

test('player handshake: POST /hello with the device, then rf3 plus an auth.* proof computed from dk', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  await settle();
  assert.equal(r.hellos.length, 1);
  assert.equal(r.hellos[0].address, 'http://192.168.1.20:5173/__realm/hello');
  assert.equal(r.hellos[0].init.method, 'POST');
  assert.deepEqual(r.hellos[0].body, { device: DEVICE });
  const [socket] = r.Socket.instances;
  assert.equal(socket.url, 'ws://192.168.1.20:5173/__realm/ws?role=player');
  assert.equal(socket.protocols.length, 2);
  assert.equal(socket.protocols[0], 'rf3');
  const auth = parseAuthProtocol(socket.protocols);
  assert.equal(auth.device, DEVICE);
  const expected = createHmac('sha256', DK).update(`rf3-ws\0${DEVICE}\0${auth.nonce}\0player`).digest('hex');
  assert.equal(auth.proof, expected, 'proof = HMAC(dk, "rf3-ws" 0 device 0 nonce 0 role)');
  assert.equal(auth.proof, wsProof(DK, DEVICE, auth.nonce, 'player'));
  assert.deepEqual(r.events.status, ['connecting']);
});

test('every reconnect fetches a fresh nonce, and the device key is read when connecting, not when constructing', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  await settle();
  const first = parseAuthProtocol(r.socket.protocols);
  r.socket.test.serverClose(1006);
  r.rigState.dk = 'c3'.repeat(32);
  r.clock.advance(1000);
  await settle();
  const second = parseAuthProtocol(r.socket.protocols);
  assert.equal(r.hellos.length, 2);
  assert.notEqual(second.nonce, first.nonce);
  assert.equal(second.proof, wsProof('c3'.repeat(32), DEVICE, second.nonce, 'player'));
});

test('an https page connects with wss', async t => {
  const clock = createFakeClock(); const Socket = createFakeWebSocketClass();
  const connection = createConnection({ role: 'player', url: 'https://table.example/player.html', device: DEVICE, dk: DK, WebSocketClass: Socket, clock,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nonce: randomHex(16) }) }), env: {} });
  t.after(() => connection.close());
  await settle();
  assert.match(Socket.instances[0].url, /^wss:\/\/table\.example\/__realm\/ws\?role=player$/);
});

test('A.6: the GM socket offers only rf3, never calls /hello, and has no credentials to give', async t => {
  const clock = createFakeClock(); const Socket = createFakeWebSocketClass(); let fetched = 0;
  const connection = createConnection({ role: 'gm', url: 'http://localhost:5173/', WebSocketClass: Socket, clock, env: {},
    fetchImpl: async () => { fetched++; return { ok: true, json: async () => ({}) }; } });
  t.after(() => connection.close());
  await settle();
  assert.equal(fetched, 0);
  assert.equal(Socket.instances.length, 1);
  assert.equal(Socket.instances[0].url, 'ws://localhost:5173/__realm/ws?role=gm');
  assert.deepEqual(Socket.instances[0].protocols, ['rf3']);
});

test('a role other than player or gm is refused outright', () => {
  assert.throws(() => createConnection({ role: 'audio', url: PAGE }), TypeError);
});

test('nothing can be sent until the server says HELLO; HELLO is answered with RESUME { rev, aids } and then onOpen', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  r.rigState.rev = 41;
  await settle();
  r.socket.test.open();
  assert.equal(r.connection.open, false);
  assert.equal(r.connection.send({ type: 'PING' }), false, 'before HELLO nothing leaves');
  assert.deepEqual(r.sent(r.socket), []);
  assert.equal(r.events.opened, 0);
  r.socket.test.serverSend({ type: 'HELLO', v: 3, role: 'player', server: { id: 's', started: 5 }, limits: { maxScene: 99 } });
  assert.deepEqual(r.sent(r.socket), [{ type: 'RESUME', rev: 41, aids: [] }]);
  assert.equal(r.events.opened, 1);
  assert.equal(r.connection.open, true);
  assert.deepEqual(r.events.status, ['connecting', 'open']);
  assert.deepEqual(r.connection.server, { id: 's', started: 5 });
  assert.deepEqual(r.connection.limits, { maxScene: 99 });
  assert.equal(r.events.messages[0].message.type, 'HELLO', 'the link sees HELLO before RESUME is written');
  assert.equal(r.connection.send({ type: 'PLAYER_PING', x: 1, y: 2 }), true);
});

test('RESUME is sent once per socket even when HELLO and ADMITTED both arrive', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  await r.openSocket();
  r.socket.test.serverSend({ type: 'ADMITTED' });
  r.socket.test.serverSend({ type: 'HELLO', v: 3 });
  assert.equal(r.sent(r.socket).filter(m => m.type === 'RESUME').length, 1);
  assert.equal(r.events.opened, 1);
});

test('a pending device: WAIT puts the connection on hold (no sends, no pings, no silence abandon); ADMITTED resumes it', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  await settle();
  r.socket.test.open();
  r.socket.test.serverSend({ type: 'WAIT' });
  assert.deepEqual(r.events.status, ['connecting', 'waiting']);
  assert.equal(r.connection.send({ type: 'PLAYER_PING', x: 1, y: 1 }), false);
  r.clock.advance(60000); // far beyond silenceMs: a waiting room is allowed to be quiet
  assert.equal(r.Socket.instances.length, 1, 'not abandoned');
  assert.deepEqual(r.sent(r.socket), [], 'no pings while waiting');
  r.socket.test.serverSend({ type: 'ADMITTED' });
  assert.equal(r.events.opened, 1);
  assert.equal(r.sent(r.socket)[0].type, 'RESUME');
  assert.equal(r.events.status.at(-1), 'open');
  assert.equal(r.connection.open, true);
});

test('a HELLO of another protocol version stops the connection for good (outdated)', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  await r.openSocket({ v: 2 });
  assert.equal(r.events.status.at(-1), 'outdated');
  assert.equal(r.events.opened, 0);
  assert.equal(r.events.closes.at(-1).final, true);
  assert.equal(r.clock.pending, 0);
});

test('backoff is 0.5 s x 2^n capped at 6 s with +-30 % jitter, and starts over after a successful HELLO', async t => {
  for (const [random, factor] of [[0, 0.7], [0.5, 1], [1, 1.3]]) {
    const r = rig({ connection: { random: () => random } });
    t.after(() => r.connection.close());
    await settle();
    const delays = [];
    for (let i = 0; i < 7; i++) {
      r.socket.test.serverClose(1006);
      delays.push(r.clock.nextIn());
      r.clock.advance(r.clock.nextIn());
      await settle();
    }
    const base = [500, 1000, 2000, 4000, 6000, 6000, 6000];
    assert.deepEqual(delays.map(Math.round), base.map(ms => Math.round(ms * factor)), `jitter factor ${factor}`);
    // Success resets the sequence.
    r.socket.test.open();
    r.socket.test.serverSend({ type: 'HELLO', v: 3 });
    r.socket.test.serverClose(1006);
    assert.equal(Math.round(r.clock.nextIn()), Math.round(500 * factor));
    r.connection.close();
  }
});

test('the real random source stays inside the jitter band', async t => {
  const r = rig({ connection: { random: Math.random } });
  t.after(() => r.connection.close());
  await settle();
  for (let i = 0; i < 30; i++) {
    r.socket.test.serverClose(1006);
    const delay = r.clock.nextIn();
    const ceiling = Math.min(6000, 500 * 2 ** i);
    assert.ok(delay >= ceiling * 0.7 - 1 && delay <= ceiling * 1.3 + 1, `${delay} for ceiling ${ceiling}`);
    r.clock.advance(delay);
    await settle();
  }
});

test('the old reconnectDelay / maxReconnectDelay options still work', async t => {
  const r = rig({ connection: { reconnectDelay: 30, maxReconnectDelay: 100, random: () => 0.5 } });
  t.after(() => r.connection.close());
  await settle();
  const delays = [];
  for (let i = 0; i < 4; i++) { r.socket.test.serverClose(1006); delays.push(r.clock.nextIn()); r.clock.advance(r.clock.nextIn()); await settle(); }
  assert.deepEqual(delays, [30, 60, 100, 100]);
});

test('close codes 4001, 4002 and 4004 are final: no timer, no new socket, nudge does nothing', async t => {
  for (const [code, status] of [[CLOSE.REPLACED, 'replaced'], [CLOSE.KICKED, 'kicked'], [CLOSE.TOO_OLD, 'outdated']]) {
    const r = rig();
    t.after(() => r.connection.close());
    const socket = await r.openSocket();
    socket.test.serverClose(code, 'bye');
    assert.equal(r.events.status.at(-1), status);
    assert.deepEqual(r.events.closes.at(-1), { code, status, final: true });
    assert.equal(r.clock.pending, 0, `no timers left after ${code}`);
    r.connection.nudge();
    r.clock.advance(120000);
    await settle();
    assert.equal(r.Socket.instances.length, 1, `no reconnect after ${code}`);
    assert.equal(r.connection.stats.lastClose.code, code);
  }
});

test('4003 (locked / denied) retries every 15 s with no growth and no jitter', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  for (let i = 0; i < 3; i++) {
    const socket = i === 0 ? await r.openSocket() : (await settle(), r.socket);
    socket.test.serverClose(CLOSE.NOT_ADMITTED);
    assert.equal(r.events.status.at(-1), 'locked');
    assert.equal(r.clock.nextIn(), 15000);
    r.clock.advance(15000);
    await settle();
  }
  assert.equal(r.Socket.instances.length, 4);
});

test('4008 (abuse) backs off 30 s and ignores wake-ups in that time', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  socket.test.serverClose(CLOSE.ABUSE);
  assert.equal(r.clock.nextIn(), 30000);
  r.connection.nudge();
  r.clock.advance(29000);
  await settle();
  assert.equal(r.Socket.instances.length, 1);
  r.clock.advance(1000);
  await settle();
  assert.equal(r.Socket.instances.length, 2);
});

test('4009 and 4010 reconnect with the normal backoff', async t => {
  for (const code of [CLOSE.SLOW, CLOSE.SHUTDOWN, 1001, 1006]) {
    const r = rig();
    t.after(() => r.connection.close());
    const socket = await r.openSocket();
    socket.test.serverClose(code);
    assert.equal(r.events.status.at(-1), 'reconnecting');
    assert.equal(r.clock.nextIn(), 500);
  }
});

test('4011 retries once at once with a fresh nonce, then gives up as unauthorized', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  socket.test.serverClose(CLOSE.AUTH);
  assert.equal(r.clock.nextIn(), 0, 'no waiting for the first retry');
  const nonceBefore = parseAuthProtocol(socket.protocols).nonce;
  r.clock.advance(0);
  await settle();
  assert.equal(r.Socket.instances.length, 2);
  assert.equal(r.hellos.length, 2, 'a new /hello for the retry');
  assert.notEqual(parseAuthProtocol(r.socket.protocols).nonce, nonceBefore);
  r.socket.test.open();
  r.socket.test.serverClose(CLOSE.AUTH);
  assert.equal(r.events.status.at(-1), 'unauthorized');
  assert.equal(r.events.closes.at(-1).final, true);
  assert.equal(r.clock.pending, 0);
  r.clock.advance(100000);
  await settle();
  assert.equal(r.Socket.instances.length, 2, 'no third attempt');
});

test('the 4011 allowance is restored by an authenticated HELLO', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  let socket = await r.openSocket();
  for (let round = 0; round < 3; round++) {
    socket.test.serverClose(CLOSE.AUTH);
    r.clock.advance(0);
    socket = await r.openSocket(); // the retry authenticates this time
    assert.equal(r.events.status.at(-1), 'open', `round ${round}`);
  }
});

test('a refused /hello (401/403) follows the same once-then-final rule', async t => {
  const r = rig({ helloPlan: [403, 403], helloBody: { error: 'unknown' } });
  t.after(() => r.connection.close());
  await settle();
  assert.equal(r.Socket.instances.length, 0, 'no socket without a nonce');
  assert.equal(r.clock.nextIn(), 0, 'one immediate retry');
  r.clock.advance(0);
  await settle();
  assert.equal(r.events.status.at(-1), 'unauthorized');
  assert.equal(r.hellos.length, 2);
  assert.equal(r.clock.pending, 0);
});

test('a revoked answer from /hello is final (kicked), before any socket exists', async t => {
  const clock = createFakeClock(); const Socket = createFakeWebSocketClass(); const status = [];
  const connection = createConnection({ role: 'player', url: PAGE, device: DEVICE, dk: DK, WebSocketClass: Socket, clock, env: {},
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'revoked' }) }), onStatus: s => status.push(s) });
  t.after(() => connection.close());
  await settle();
  assert.equal(status.at(-1), 'kicked');
  assert.equal(Socket.instances.length, 0);
  assert.equal(clock.pending, 0);
});

test('hello trouble (server error, network down, hang, garbage) retries with backoff and never creates a socket early', async t => {
  const clock = createFakeClock(); const Socket = createFakeWebSocketClass(); const plan = [500, 'throw', 'hang', 'garbage', 'ok'];
  let calls = 0;
  const connection = createConnection({ role: 'player', url: PAGE, device: DEVICE, dk: DK, WebSocketClass: Socket, clock, env: {}, random: () => 0.5,
    fetchImpl: async () => {
      calls++;
      const step = plan.shift();
      if (step === 500) return { ok: false, status: 500, json: async () => ({}) };
      if (step === 'throw') throw new TypeError('Failed to fetch');
      if (step === 'hang') return new Promise(() => {});
      if (step === 'garbage') return { ok: true, status: 200, json: async () => ({ nonce: 'nothex' }) };
      return { ok: true, status: 200, json: async () => ({ nonce: randomHex(16) }) };
    } });
  t.after(() => connection.close());
  const delays = [];
  for (let i = 0; i < 4; i++) {
    await settle();
    if (i === 2) { assert.equal(clock.nextIn(), 5000, 'the hang is cut off after helloTimeoutMs'); clock.advance(5000); await settle(); }
    delays.push(clock.nextIn());
    clock.advance(clock.nextIn());
  }
  await settle();
  assert.equal(calls, 5);
  assert.equal(Socket.instances.length, 1, 'only the last, successful /hello led to a socket');
  assert.deepEqual(delays, [500, 1000, 2000, 4000]);
});

test('a socket that never opens is abandoned after the connect timeout; one that opens but never says HELLO too', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  await settle();
  r.clock.advance(7999);
  assert.equal(r.events.closes.length, 0);
  r.clock.advance(1);
  assert.equal(r.events.closes.length, 1);
  assert.equal(r.events.closes[0].code, 4000);
  r.clock.advance(r.clock.nextIn());
  await settle();
  r.socket.test.open();
  r.clock.advance(8000);
  assert.equal(r.events.closes.length, 2, 'silent after open');
});

test('silence detection: a socket that stops answering is replaced after silenceMs, pings are sent meanwhile', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  r.clock.advance(LIMITS.heartbeatMs * 2);
  const pings = r.sent(socket).filter(m => m.type === 'PING');
  assert.equal(pings.length, 2);
  r.clock.advance(LIMITS.heartbeatMs); // 12 s of silence: not yet "more than"
  assert.equal(r.events.closes.length, 0);
  r.clock.advance(LIMITS.heartbeatMs); // 16 s
  assert.equal(r.events.closes.length, 1);
  assert.equal(r.events.closes[0].code, 4000);
  assert.equal(r.events.status.at(-1), 'reconnecting');
  r.clock.advance(r.clock.nextIn());
  await settle();
  assert.equal(r.Socket.instances.length, 2, 'a replacement was opened');
});

test('any frame counts as life: a quiet but talking server is never abandoned', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  for (let i = 0; i < 20; i++) { r.clock.advance(5000); socket.test.serverSend({ type: 'GM_STATUS', connected: true }); }
  assert.equal(r.events.closes.length, 0);
});

test('PING carries t, rtt, loss and rec, always within the 96-byte cap; PONG gives latency and statistics', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  r.clock.advance(4000);
  const first = r.sent(socket).filter(m => m.type === 'PING')[0];
  assert.deepEqual(Object.keys(first), ['type', 't'], 'nothing to report yet');
  r.clock.advance(35);
  socket.test.serverSend({ type: 'PONG', t: first.t, s: 123 });
  assert.deepEqual(r.events.latency, [35]);
  assert.equal(r.connection.latency, 35);
  r.clock.advance(4000 - 35);
  const second = r.sent(socket).filter(m => m.type === 'PING')[1];
  assert.equal(second.rtt, 35);
  r.clock.advance(20);
  socket.test.serverSend({ type: 'PONG', t: second.t });
  assert.deepEqual(r.events.latency, [35, 20]);
  const stats = r.connection.stats;
  assert.equal(stats.rtt.last, 20);
  assert.equal(stats.rtt.p50, 20);
  assert.equal(stats.rtt.p95, 35);
  assert.equal(stats.rtt.samples, 2);
  // Unanswered pings show up as loss; a reconnect shows up as rec; the frame stays small.
  for (let i = 0; i < 2; i++) r.clock.advance(4000);
  const later = r.sent(socket).filter(m => m.type === 'PING').at(-1);
  assert.ok(later.loss > 0, JSON.stringify(later));
  for (const ping of r.sent(socket).filter(m => m.type === 'PING')) assert.ok(JSON.stringify(ping).length < 96, JSON.stringify(ping));
});

test('rec appears after the connection was re-established, and the whole PING stays under the cap', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  let socket = await r.openSocket();
  socket.test.serverClose(1006);
  r.clock.advance(r.clock.nextIn());
  socket = await r.openSocket();
  assert.equal(r.connection.stats.reconnects, 1);
  r.clock.advance(4000);
  const ping = r.sent(socket).filter(m => m.type === 'PING')[0];
  assert.equal(ping.rec, 1);
  assert.ok(JSON.stringify(ping).length < 96);
});

test('a PONG without a usable t is ignored, binary and malformed frames are dropped without harm', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  socket.test.serverSend({ type: 'PONG' });
  socket.test.serverSend('not json');
  socket.test.serverSend('null');
  socket.test.serverSend('{"x":1}');
  socket.test.serverSend(new ArrayBuffer(8));
  assert.deepEqual(r.events.latency, []);
  assert.equal(r.events.messages.length, 1, 'only HELLO reached the link');
  assert.equal(r.events.closes.length, 0);
});

test('waking: online, pageshow and a visible tab replace a dead retry wait at once; a hidden tab does not', async t => {
  const listeners = new Map();
  const win = { addEventListener: (type, fn) => listeners.set(`w:${type}`, fn), removeEventListener: (type) => listeners.delete(`w:${type}`) };
  const doc = { visibilityState: 'hidden', addEventListener: (type, fn) => listeners.set(`d:${type}`, fn), removeEventListener: (type) => listeners.delete(`d:${type}`) };
  const r = rig({ env: { window: win, document: doc } });
  t.after(() => r.connection.close());
  assert.deepEqual([...listeners.keys()].sort(), ['d:visibilitychange', 'w:online', 'w:pageshow']);
  const socket = await r.openSocket();
  socket.test.serverClose(1006);
  r.clock.advance(r.clock.nextIn()); await settle(); r.socket.test.serverClose(1006); // second failure: the wait is now 1 s
  assert.equal(r.clock.nextIn(), 1000);

  listeners.get('d:visibilitychange')(); // still hidden
  await settle();
  assert.equal(r.Socket.instances.length, 2);

  listeners.get('w:online')();
  await settle();
  assert.equal(r.Socket.instances.length, 3, 'online: connected without waiting');
  r.socket.test.serverClose(1006);
  doc.visibilityState = 'visible';
  listeners.get('d:visibilitychange')();
  await settle();
  assert.equal(r.Socket.instances.length, 4, 'visible again: connected without waiting');
  r.socket.test.serverClose(1006);
  listeners.get('w:pageshow')();
  await settle();
  assert.equal(r.Socket.instances.length, 5);
  r.connection.close();
  assert.equal(listeners.size, 0, 'close() removes every listener');
});

test('waking with a socket that still looks open probes it: no PONG in 3 s means it is replaced', async t => {
  const listeners = new Map();
  const win = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {} };
  const r = rig({ env: { window: win, document: undefined } });
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  listeners.get('online')();
  assert.equal(r.sent(socket).filter(m => m.type === 'PING').length, 1);
  r.clock.advance(2999);
  assert.equal(r.events.closes.length, 0);
  r.clock.advance(1);
  assert.equal(r.events.closes.length, 1);
  // An answered probe is harmless.
  r.clock.advance(r.clock.nextIn()); const second = await r.openSocket();
  listeners.get('online')();
  const probe = r.sent(second).filter(m => m.type === 'PING')[0];
  second.test.serverSend({ type: 'PONG', t: probe.t });
  r.clock.advance(10000 - 1);
  assert.equal(r.events.closes.length, 1, 'the PONG cancelled the probe');
});

test('actions: send(obj, { aid }) adds the aid, an ACK removes it and hands the original action to the link', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  assert.equal(r.connection.send({ type: 'PLAYER_TOKEN_MOVE', id: 'hero', x: 1, y: 2 }, { aid: 'ab-1' }), true);
  assert.deepEqual(r.sent(socket).at(-1), { type: 'PLAYER_TOKEN_MOVE', id: 'hero', x: 1, y: 2, aid: 'ab-1' });
  assert.deepEqual(r.connection.pendingActions, ['ab-1']);
  socket.test.serverSend({ type: 'ACK', aid: 'ab-1', ok: false, reason: 'blocked' });
  const ack = r.events.messages.at(-1);
  assert.equal(ack.message.type, 'ACK');
  assert.equal(ack.info.action.type, 'PLAYER_TOKEN_MOVE');
  assert.equal(ack.info.action.id, 'hero');
  assert.deepEqual(r.connection.pendingActions, []);
  socket.test.serverSend({ type: 'ACK', aid: 'ab-1', ok: true }); // a duplicate ack is harmless
  assert.equal(r.events.messages.at(-1).info.action, null);
  r.clock.advance(60000);
  assert.deepEqual(r.events.expired, []);
});

test('an unacknowledged action is dropped after 5 s and reported once', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  r.connection.send({ type: 'PLAYER_END_TURN', tokenId: 't' }, { aid: 'ab-2' });
  socket.test.serverSend({ type: 'PONG', t: 0 });
  r.clock.advance(4999);
  assert.deepEqual(r.connection.pendingActions, ['ab-2']);
  r.clock.advance(1);
  assert.deepEqual(r.connection.pendingActions, []);
  assert.equal(r.events.expired.length, 1);
  assert.equal(r.events.expired[0].aid, 'ab-2');
  assert.equal(r.connection.stats.expired, 1);
});

test('resume: after a reconnect RESUME lists the unacknowledged aids, then the actions are re-sent in order', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  r.rigState.rev = 7;
  const socket = await r.openSocket();
  r.connection.send({ type: 'PLAYER_TOKEN_MOVE', id: 'a', x: 1, y: 1 }, { aid: 'ab-1' });
  r.connection.send({ type: 'PLAYER_END_TURN', tokenId: 'a' }, { aid: 'ab-2' });
  r.connection.send({ type: 'PLAYER_TOKEN_MOVE', id: 'b', x: 2, y: 2 }, { aid: 'ab-3' });
  socket.test.serverSend({ type: 'ACK', aid: 'ab-2', ok: true });
  socket.test.serverClose(1006);
  r.clock.advance(r.clock.nextIn());
  r.rigState.rev = 9;
  const next = await r.openSocket();
  assert.deepEqual(r.sent(next), [
    { type: 'RESUME', rev: 9, aids: ['ab-1', 'ab-3'] },
    { type: 'PLAYER_TOKEN_MOVE', id: 'a', x: 1, y: 1, aid: 'ab-1' },
    { type: 'PLAYER_TOKEN_MOVE', id: 'b', x: 2, y: 2, aid: 'ab-3' },
  ]);
  next.test.serverSend({ type: 'ACK', aid: 'ab-1', ok: true });
  next.test.serverSend({ type: 'ACK', aid: 'ab-3', ok: true });
  assert.deepEqual(r.connection.pendingActions, []);
  assert.equal(r.connection.stats.reconnects, 1);
});

test('an action that was not acknowledged within 5 s is not replayed by a later reconnect', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  r.connection.send({ type: 'PLAYER_TOKEN_MOVE', id: 'a', x: 1, y: 1 }, { aid: 'ab-1' });
  r.clock.advance(5000);
  socket.test.serverClose(1006);
  r.clock.advance(r.clock.nextIn());
  const next = await r.openSocket();
  assert.deepEqual(r.sent(next), [{ type: 'RESUME', rev: null, aids: [] }]);
});

test('RESUME with no rev function sends rev null; GM links resume the same way', async t => {
  const clock = createFakeClock(); const Socket = createFakeWebSocketClass();
  const connection = createConnection({ role: 'gm', url: 'http://localhost:5173/', WebSocketClass: Socket, clock, env: {} });
  t.after(() => connection.close());
  await settle();
  Socket.instances[0].test.open();
  Socket.instances[0].test.serverSend({ type: 'HELLO', v: 3 });
  assert.deepEqual(Socket.instances[0].test.sentJson, [{ type: 'RESUME', rev: null, aids: [] }]);
});

test('sendRaw sends a pre-serialised frame, only when ready; postMessage is the old name for send', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  assert.equal(r.connection.sendRaw('{"type":"X"}'), false);
  const socket = await r.openSocket();
  assert.equal(r.connection.sendRaw('{"type":"SCENE"}'), true);
  assert.equal(r.connection.postMessage({ type: 'PLAYER_PING', x: 1, y: 1 }), true);
  assert.equal(socket.sent.at(-2), '{"type":"SCENE"}');
});

test('statistics: bytes, fulls, patches, reconnects, time since open, last close code', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const socket = await r.openSocket();
  const full = JSON.stringify({ type: 'STATE_FULL', rev: 1, state: {} });
  socket.test.serverSend(full);
  socket.test.serverSend({ type: 'STATE_PATCH', rev: 2, base: 1, patch: {} });
  socket.test.serverSend({ type: 'STATE_PATCH', rev: 3, base: 2, patch: {} });
  r.connection.send({ type: 'PLAYER_PING', x: 1, y: 1 });
  r.clock.advance(2500);
  const stats = r.connection.stats;
  assert.equal(stats.fulls, 1);
  assert.equal(stats.patches, 2);
  assert.ok(stats.bytesIn > full.length);
  assert.ok(stats.bytesOut > 20);
  assert.equal(stats.sinceMs, 2500);
  assert.equal(stats.reconnects, 0);
  socket.test.serverClose(CLOSE.SLOW);
  assert.equal(r.connection.stats.sinceMs, null);
  assert.equal(r.connection.stats.lastClose.code, CLOSE.SLOW);
});

test('close() stops everything: no timers, no listeners, late socket events are ignored, and sends fail', async t => {
  const r = rig();
  const socket = await r.openSocket();
  r.connection.send({ type: 'PLAYER_END_TURN', tokenId: 'x' }, { aid: 'ab-9' });
  const statusCount = r.events.status.length;
  r.connection.close();
  assert.equal(r.clock.pending, 0);
  socket.test.serverSend({ type: 'GM_STATUS', connected: true });
  socket.test.serverClose(1006);
  r.clock.advance(100000);
  await settle();
  assert.equal(r.events.status.length, statusCount);
  assert.equal(r.Socket.instances.length, 1);
  assert.equal(r.connection.send({ type: 'PLAYER_PING', x: 1, y: 1 }), false);
  assert.equal(r.connection.open, false);
});

test('close() while the /hello is still in flight never creates a socket', async t => {
  const clock = createFakeClock(); const Socket = createFakeWebSocketClass(); let release;
  const connection = createConnection({ role: 'player', url: PAGE, device: DEVICE, dk: DK, WebSocketClass: Socket, clock, env: {},
    fetchImpl: () => new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => ({ nonce: randomHex(16) }) }); }) });
  await settle();
  connection.close();
  release();
  await settle();
  assert.equal(Socket.instances.length, 0);
  assert.equal(clock.pending, 0);
});

test('a socket replaced by a newer one can no longer influence the connection', async t => {
  const r = rig();
  t.after(() => r.connection.close());
  const old = await r.openSocket();
  old.test.serverClose(1006);
  r.clock.advance(r.clock.nextIn());
  const fresh = await r.openSocket();
  const before = r.events.status.length;
  old.test.serverSend({ type: 'HELLO', v: 3 });
  old.test.serverClose(CLOSE.KICKED);
  assert.equal(r.events.status.length, before);
  assert.equal(r.connection.open, true);
  assert.equal(fresh.readyState, 1);
});

test('a missing device or key makes the first attempt count as a refused proof, not a crash', async t => {
  const clock = createFakeClock(); const Socket = createFakeWebSocketClass(); const status = [];
  const connection = createConnection({ role: 'player', url: PAGE, device: () => null, dk: () => null, WebSocketClass: Socket, clock, env: {},
    fetchImpl: async () => { throw new Error('must not be called'); }, onStatus: s => status.push(s) });
  t.after(() => connection.close());
  await settle();
  clock.advance(0);
  await settle();
  assert.equal(status.at(-1), 'unauthorized');
  assert.equal(Socket.instances.length, 0);
});
