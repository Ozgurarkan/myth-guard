import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from '../server/net/clock.js';
import { createMetrics, redact } from '../server/net/status.js';

test('counters, gauges (plain and live) and rejects show up in the snapshot', () => {
  const clock = createFakeClock();
  const metrics = createMetrics(clock);
  metrics.inc('http.requests');
  metrics.inc('http.requests', 4);
  metrics.inc('reject.host');
  metrics.inc('reject.proof', 2);
  metrics.gauge('sockets', 3);
  let live = 1;
  metrics.gauge('live', () => live);
  metrics.gauge('broken', () => { throw new Error('nope'); });
  live = 9;
  clock.advance(5_400);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters['http.requests'], 5);
  assert.deepEqual(snapshot.rejects, { host: 1, proof: 2 });
  assert.equal(snapshot.gauges.sockets, 3);
  assert.equal(snapshot.gauges.live, 9);
  assert.equal(snapshot.gauges.broken, null, 'a failing gauge does not break /diag');
  assert.equal(snapshot.uptimeS, 5);
  assert.ok(snapshot.memory.rssMB > 0);
  assert.equal(metrics.count('http.requests'), 5);
  assert.equal(metrics.count('never'), 0);
});

test('observe keeps a bounded window and reports count, mean, p50, p95 and max; NaN is ignored', () => {
  const metrics = createMetrics(createFakeClock());
  for (let i = 1; i <= 100; i++) metrics.observe('rtt', i);
  metrics.observe('rtt', NaN);
  metrics.observe('rtt', Infinity);
  const rtt = metrics.snapshot().timings.rtt;
  assert.equal(rtt.count, 100);
  assert.equal(rtt.mean, 50.5);
  assert.equal(rtt.p50, 51);
  assert.equal(rtt.p95, 96);
  assert.equal(rtt.max, 100);
  for (let i = 0; i < 1000; i++) metrics.observe('rtt', 1);
  assert.equal(metrics.snapshot().timings.rtt.count, 1100);
  assert.equal(metrics.snapshot().timings.rtt.p95, 1, 'only the last 256 samples are kept');
});

test('the log is a ring of the last 500 lines, oldest first, with ISO times from the clock', () => {
  const clock = createFakeClock(Date.UTC(2026, 9, 13, 12, 0, 0));
  const metrics = createMetrics(clock);
  for (let i = 0; i < 520; i++) { metrics.log(`line ${i}`); clock.advance(1000); }
  const tail = metrics.logTail();
  assert.equal(tail.length, 500);
  assert.match(tail[0], /^2026-10-13T12:00:20\.000Z line 20$/);
  assert.match(tail.at(-1), / line 519$/);
  assert.equal(metrics.logTail(3).length, 3);
});

test('secrets never reach the log: keys, proofs, tokens, cookies, invite links and codes are scrubbed', () => {
  const hex64 = 'ab'.repeat(32);
  const device = 'cd'.repeat(16);
  const cases = [
    [`dk ${hex64}`, hex64],
    [`proof=${hex64}`, hex64],
    [`Sec-WebSocket-Protocol: rf3, auth.${device}.${device}.${hex64}`, hex64],
    ['cookie: rf-gm=0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
    ['Set-Cookie: rf-d=zzzz.yyyy; Path=/', 'zzzz.yyyy'],
    ['opened http://10.0.0.5:5173/player.html#join=AbCdEfGhIjKlMnOpQrStUv', 'AbCdEfGhIjKlMnOpQrStUv'],
    ['table code: ABCD2345', 'ABCD2345'],
    ['secret=AbCdEfGhIjKlMnOpQrStUv', 'AbCdEfGhIjKlMnOpQrStUv'],
    [`serverSecret: ${hex64}`, hex64],
  ];
  const metrics = createMetrics(createFakeClock());
  for (const [line, secret] of cases) {
    const stored = metrics.log(line);
    assert.ok(!stored.includes(secret), `${line} -> ${stored}`);
  }
  assert.ok(metrics.logTail().join('\n').indexOf(hex64) < 0);
  assert.equal(redact(`device ${device}`), 'device cdcdcd…', 'ids are shortened, not removed');
  assert.equal(redact('plain text stays'), 'plain text stays');
  assert.equal(redact('a\u0000b\nc'), 'a b c', 'control characters cannot forge log lines');
});
