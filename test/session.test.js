import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createBucket, takeToken, timers, safeMetrics } from '../server/net/session.js';
import { createFakeClock } from '../server/net/clock.js';
import { createFakeSocket } from '../test-support/fakeSocket.js';
import { createFakeMetrics } from '../test-support/fakeAccess.js';
import { CLOSE, LIMITS } from '../src/net/protocol.js';

function setup(role = 'player', extra = {}) {
  const clock = createFakeClock();
  const socket = createFakeSocket();
  const metrics = createFakeMetrics();
  const abused = [];
  const session = createSession({
    socket, role, clock, metrics, onAbuse: s => abused.push(s),
    auth: { device: 'd'.repeat(32), playerId: 'p'.repeat(24), name: 'Aria', ip: '10.0.0.5', label: 'Chrome · Android' },
    ...extra,
  });
  return { clock, socket, metrics, session, abused };
}

test('a token bucket refills with the injected clock and never exceeds its burst', () => {
  const bucket = createBucket({ burst: 3, perSec: 2 }, 0);
  assert.deepEqual([0, 0, 0, 0].map(() => takeToken(bucket, 0)), [true, true, true, false]);
  assert.equal(takeToken(bucket, 400), false);       // 0.8 token
  assert.equal(takeToken(bucket, 500), true);        // 1.0
  assert.equal(takeToken(bucket, 500), false);
  takeToken(bucket, 10_000_000);
  assert.ok(bucket.tokens <= 3);
  assert.equal(takeToken(bucket, 5), true, 'a clock that goes backwards does not break the bucket');
});

test('per-type limits: PING allows its burst of 5 and then 1 per second', () => {
  const { session, clock } = setup();
  const taken = Array.from({ length: 8 }, () => session.allow('PING'));
  assert.deepEqual(taken, [true, true, true, true, true, false, false, false]);
  clock.advance(1000);
  assert.equal(session.allow('PING'), true);
  assert.equal(session.allow('PING'), false);
  // other types have their own buckets
  assert.equal(session.allow('PLAYER_PING'), true);
});

test('RESUME is allowed once per socket and never refills', () => {
  const { session, clock } = setup();
  assert.equal(session.allow('RESUME'), true);
  clock.advance(60_000);
  assert.equal(session.allow('RESUME'), false);
});

test('token moves follow the old limit: 40 in a burst, then about 30 a second', () => {
  const { session, clock } = setup();
  let accepted = 0;
  for (let i = 0; i < 100; i++) if (session.allow('PLAYER_TOKEN_MOVE')) accepted += 1;
  assert.equal(accepted, 40);
  clock.advance(1000);
  accepted = 0;
  for (let i = 0; i < 100; i++) if (session.allow('PLAYER_TOKEN_MOVE')) accepted += 1;
  assert.ok(accepted >= 29 && accepted <= 31, `accepted ${accepted}`);
});

test('a socket that rotates through message types is still bounded by the whole-socket bucket', () => {
  const { session } = setup();
  const types = ['PING', 'PLAYER_PING', 'PLAYER_NAME', 'AUDIO_STATS', 'RESYNC', 'AUDIO_LISTEN'];
  let ok = 0;
  for (let i = 0; i < 1000; i++) if (session.allow(types[i % types.length])) ok += 1;
  assert.ok(ok <= 100, `${ok} frames got through at one instant`);
});

test('ten violations within ten seconds close a player with 4008 and report the abuse once', () => {
  const { session, socket, abused, metrics, clock } = setup();
  for (let i = 0; i < 9; i++) assert.equal(session.violation('malformed'), false);
  assert.equal(socket.closed, null);
  clock.advance(10_001);                           // the first nine fall out of the window
  for (let i = 0; i < 9; i++) assert.equal(session.violation('ratelimit'), false);
  assert.equal(socket.closed, null);
  assert.equal(session.violation('ratelimit'), true);
  assert.equal(socket.closed.code, CLOSE.ABUSE);
  assert.equal(abused.length, 1);
  assert.equal(metrics.count('reject.ratelimit'), 10);
  assert.equal(metrics.count('reject.malformed'), 9);
  assert.equal(session.strikeCount, 19);
});

test('the GM is never closed for mistakes', () => {
  const { session, socket, abused } = setup('gm');
  for (let i = 0; i < 100; i++) session.violation('invalid');
  assert.equal(socket.closed, null);
  assert.equal(abused.length, 0);
});

test('send counts messages and bytes, and refuses quietly on a socket that is not open', () => {
  const { session, socket, metrics } = setup();
  assert.equal(session.send('héllo'), true);
  assert.equal(session.msgsOut, 1);
  assert.equal(session.bytesOut, Buffer.byteLength('héllo'));
  assert.equal(session.sendJson({ type: 'X' }), true);
  assert.deepEqual(JSON.parse(socket.sent.at(-1).data), { type: 'X' });
  const circular = {}; circular.self = circular;
  assert.equal(session.sendJson(circular), false);
  assert.equal(metrics.count('sendErrors'), 1);
  socket.readyState = 3;
  assert.equal(session.send('x'), false);
  assert.equal(session.isOpen, false);
  // a socket whose send throws
  const { session: s2, socket: sock2 } = setup();
  sock2.send = () => { throw new Error('boom'); };
  assert.equal(s2.send('x'), false);
});

test('droppable messages are skipped while the socket is backed up, others are not', () => {
  const { session, socket } = setup();
  socket.test.setBuffered(LIMITS.backlogStopBytes + 1);
  assert.equal(session.sendJson({ type: 'MAP_PING' }, { droppable: true }), false);
  assert.equal(session.sendJson({ type: 'ACK' }), true);
  assert.equal(session.dropped, 1);
});

test('backlog: a backed-up socket is marked stale, drains to a snapshot, or is closed with 4009 after 10 s', () => {
  const { session, socket, clock } = setup();
  assert.equal(session.checkBacklog(), 'ok');
  session.markStale();
  socket.test.setBuffered(LIMITS.backlogResumeBytes + 1);
  assert.equal(session.checkBacklog(), 'stale');
  clock.advance(9_000);
  assert.equal(session.checkBacklog(), 'stale');
  socket.test.setBuffered(LIMITS.backlogResumeBytes - 1);
  assert.equal(session.checkBacklog(), 'drained');
  session.clearStale();
  assert.equal(session.stale, false);

  // never drains
  session.markStale();
  socket.test.setBuffered(10 * LIMITS.backlogStopBytes);
  clock.advance(LIMITS.slowCloseMs);
  assert.equal(session.checkBacklog(), 'closed');
  assert.equal(socket.closed.code, CLOSE.SLOW);
});

test('backlog: a socket far behind on non-state traffic is also closed, but only after the full 10 s', () => {
  const { session, socket, clock } = setup();
  socket.test.setBuffered(LIMITS.backlogStopBytes + 10);
  assert.equal(session.checkBacklog(), 'ok');
  clock.advance(5_000);
  assert.equal(session.checkBacklog(), 'ok');
  socket.test.setBuffered(100);                     // it recovered: the timer starts over
  assert.equal(session.checkBacklog(), 'ok');
  socket.test.setBuffered(LIMITS.backlogStopBytes + 10);
  assert.equal(session.checkBacklog(), 'ok');
  clock.advance(9_000);
  assert.equal(session.checkBacklog(), 'ok');
  clock.advance(1_001);
  assert.equal(session.checkBacklog(), 'closed');
});

test('close() asks politely, then terminates a peer that never finishes the handshake', () => {
  const { session, socket, clock } = setup();
  socket.close = (code, reason) => { socket.closed = { code, reason }; socket.readyState = 2; };    // a peer that never answers
  session.close(CLOSE.KICKED, 'x'.repeat(500));
  assert.equal(socket.closed.code, CLOSE.KICKED);
  assert.ok(socket.closed.reason.length <= 100, 'close reasons must fit in a control frame');
  assert.equal(socket.terminated, false);
  clock.advance(2000);
  assert.equal(socket.terminated, true);
});

test('markClosed cancels pending timers', () => {
  const { session, socket, clock } = setup();
  socket.close = () => { socket.readyState = 2; };
  const handle = clock.setTimeout(() => assert.fail('resume wait must be cancelled'), 100);
  session.cancelResumeWait = () => clock.clearTimeout(handle);
  session.close(1000, 'bye');
  session.markClosed();
  clock.advance(5000);
  assert.equal(socket.terminated, false);
  assert.equal(session.closed, true);
  assert.equal(session.send('late'), false);
});

test('timers(): works with a fake clock, with none, and with a metrics sink that throws', () => {
  const clock = createFakeClock();
  const t = timers(clock);
  let fired = 0;
  const cancel = t.after(100, () => { fired += 1; });
  const stop = t.every(50, () => { fired += 10; });
  clock.advance(100);
  assert.equal(fired, 21);
  cancel(); stop();
  clock.advance(1000);
  assert.equal(fired, 21);
  assert.equal(typeof timers().now(), 'number');
  const m = safeMetrics({ inc() { throw new Error('boom'); } });
  assert.doesNotThrow(() => m.inc('x'));
  assert.doesNotThrow(() => safeMetrics(undefined).gauge('x', 1));
});

test('describe() reports counters for the status page', () => {
  const { session } = setup();
  session.send('abc');
  session.rtt = 33;
  const info = session.describe();
  assert.equal(info.rtt, 33);
  assert.equal(info.msgsOut, 1);
  assert.equal(info.ip, '10.0.0.5');
  assert.equal('socket' in info, false);
});
