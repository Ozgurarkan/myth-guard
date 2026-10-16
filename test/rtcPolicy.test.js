import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiverPolicy, createSenderPolicy, RTC_POLICY } from '../src/audio/rtcPolicy.js';

// ---- receiver: getStats() samples -> jitterBufferTarget and the AUDIO_STATS report ----------------------------------------

/** A cumulative inbound-rtp sample generator: every 2 s the stream advances; `silent`/`lost`/`concealed` are per interval. */
function stream() {
  const s = { packetsReceived: 0, packetsLost: 0, concealedSamples: 0, silentConcealedSamples: 0, totalSamplesReceived: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 };
  return {
    sample({ silentMs = 0, lost = 0, concealedPct = 0, bufferMs = 800 } = {}) {
      s.packetsReceived += 100 - lost; s.packetsLost += lost;
      s.totalSamplesReceived += 96000;
      s.concealedSamples += Math.round((96000 * concealedPct) / 100) + silentMs * 48;
      s.silentConcealedSamples += silentMs * 48;
      s.jitterBufferEmittedCount += 96000; s.jitterBufferDelay += (96000 * bufferMs) / 1000;
      return { ...s };
    },
  };
}
const run = (policy, source, intervals, options, start = 0) => {
  let last;
  for (let i = 0; i < intervals; i++) last = policy.update(source.sample(options), start + (i + 1) * 2000);
  return last;
};

test('the target starts at 800 ms and a clean stream decays it by 50 ms per minute to a floor of 500', () => {
  const policy = createReceiverPolicy();
  const source = stream();
  assert.equal(policy.target, 800);
  run(policy, source, 15, {}); // 30 s
  assert.ok(policy.target >= 770 && policy.target <= 800, String(policy.target));
  run(policy, source, 30, {}, 30000); // to 90 s
  assert.ok(policy.target >= 725 && policy.target <= 760, String(policy.target));
  run(policy, source, 1000, {}, 90000);
  assert.equal(policy.target, 500);
});

test('a silent hole grows the target to 1.3 x the hole, capped at 2000, and stops the decay for a minute', () => {
  const policy = createReceiverPolicy();
  const source = stream();
  run(policy, source, 5, {});
  const result = policy.update(source.sample({ silentMs: 700 }), 12000);
  assert.equal(result.target, 910);
  assert.equal(result.changed, true);
  assert.equal(result.report.underruns, 1);
  assert.equal(result.report.silentMs30s, 700);
  assert.equal(result.report.longestSilentMs, 700);
  // a shorter hole does not lower it
  assert.equal(policy.update(source.sample({ silentMs: 100 }), 14000).target, 910);
  assert.equal(policy.update(source.sample({ silentMs: 3000 }), 16000).target, 2000, 'cap');
  // quiet for 50 s: still no decay (the minute starts after the last silence)
  const held = run(policy, source, 25, {}, 16000);
  assert.equal(held.target, 2000);
  // after a quiet minute it comes down 50 ms per minute
  run(policy, source, 60, {}, 66000);
  assert.ok(policy.target < 2000 && policy.target >= 1900, String(policy.target));
});

test('a hole that is not silent (concealed audio, FEC at work) does not move the target', () => {
  const policy = createReceiverPolicy();
  const source = stream();
  const r = run(policy, source, 20, { concealedPct: 8, lost: 6 });
  assert.ok(r.target <= 800);
  assert.equal(r.report.underruns, 0);
  assert.ok(Math.abs(r.report.concealedPct - 8) < 0.2);
  assert.ok(Math.abs(r.report.lossPct - 6) < 0.2);
  assert.equal(r.report.jitterBufferMs, 800);
});

test('the report covers the last 30 seconds only', () => {
  const policy = createReceiverPolicy();
  const source = stream();
  run(policy, source, 3, { lost: 50 });
  const r = run(policy, source, 20, {}, 6000);
  assert.equal(r.report.lossPct, 0, 'the early loss has left the window');
  assert.equal(r.report.silentMs30s, 0);
});

test('every report value is a finite number, even for empty or odd samples', () => {
  const policy = createReceiverPolicy();
  policy.update({}, 0);
  const r = policy.update({}, 2000);
  for (const [key, value] of Object.entries(r.report)) assert.ok(Number.isFinite(value), key);
  const reset = policy.update({ packetsReceived: 5 }, 4000); // counters that went backwards (a new connection)
  for (const value of Object.values(reset.report)) assert.ok(Number.isFinite(value) && value >= 0);
});

// ---- sender: connection supervision ------------------------------------------------------------------------------------

const drive = (policy, from, to, step = 500) => {
  const actions = [];
  for (let t = from; t <= to; t += step) { const a = policy.tick(t); if (a) actions.push({ ...a, at: t }); }
  return actions;
};

test('a connection that comes up is left alone', () => {
  const p = createSenderPolicy();
  p.begin(0);
  assert.equal(p.connection('connected', 300), null);
  assert.equal(p.state, 'connected');
  assert.deepEqual(drive(p, 0, 120000), []);
});

test('no connection within 6 s -> fallback "timeout"', () => {
  const p = createSenderPolicy();
  p.begin(1000);
  assert.deepEqual(drive(p, 1000, 6900), []);
  assert.deepEqual(drive(p, 7000, 7000), [{ type: 'fallback', reason: 'timeout', at: 7000 }]);
  assert.equal(p.state, 'fallback');
});

test('ICE failed -> fallback at once', () => {
  const p = createSenderPolicy();
  p.begin(0);
  assert.deepEqual(p.connection('failed', 800), { type: 'fallback', reason: 'ice-failed' });
  const q = createSenderPolicy();
  q.begin(0); q.connection('connected', 100);
  assert.deepEqual(q.connection('failed', 9000), { type: 'fallback', reason: 'ice-failed' });
});

test('disconnected: one ICE restart after 2 s, fallback if it does not recover in 6 s', () => {
  const p = createSenderPolicy();
  p.begin(0); p.connection('connected', 200);
  p.connection('disconnected', 10000);
  assert.deepEqual(drive(p, 10000, 11900), []);
  assert.deepEqual(drive(p, 12000, 12000), [{ type: 'restart', reason: 'disconnected', at: 12000 }]);
  assert.equal(p.state, 'restarting');
  assert.deepEqual(drive(p, 12500, 17900), []);
  assert.deepEqual(drive(p, 18000, 18000), [{ type: 'fallback', reason: 'restart-timeout', at: 18000 }]);
});

test('a brief disconnect that recovers on its own costs nothing; after a restart that works, a second one is allowed only later', () => {
  const p = createSenderPolicy();
  p.begin(0); p.connection('connected', 200);
  p.connection('disconnected', 5000);
  p.connection('connected', 6500);
  assert.deepEqual(drive(p, 5000, 60000), []);
  // second episode: disconnected long enough for the restart, which works
  p.connection('disconnected', 61000);
  assert.equal(drive(p, 61000, 63000)[0].type, 'restart');
  p.connection('connected', 64000);
  assert.equal(p.state, 'connected');
  // a third episode soon after: the restart was already used, so 8 s of disconnection means fallback
  p.connection('disconnected', 70000);
  const actions = drive(p, 70000, 79000);
  assert.deepEqual(actions, [{ type: 'fallback', reason: 'disconnected', at: 78000 }]);
});

test('30 s of health gives the restart back', () => {
  const p = createSenderPolicy();
  p.begin(0); p.connection('connected', 200);
  p.connection('disconnected', 1000);
  assert.equal(drive(p, 1000, 3000)[0].type, 'restart');
  p.connection('connected', 4000);
  drive(p, 4000, 40000);
  assert.equal(p.restarted, false);
  p.connection('disconnected', 41000);
  assert.equal(drive(p, 41000, 43000)[0].type, 'restart');
});

test('more than 3 s of silent concealment in 30 s reported by the player -> fallback', () => {
  const p = createSenderPolicy();
  p.begin(0); p.connection('connected', 100);
  assert.equal(p.stats({ silentMs30s: 2900 }, 10000), null);
  assert.deepEqual(p.stats({ silentMs30s: 3200 }, 12000), { type: 'fallback', reason: 'concealment' });
});

test('on the fallback WebRTC is tried again every 60 s; 10 s of health promotes it', () => {
  const p = createSenderPolicy();
  p.begin(0);
  p.connection('failed', 500);
  assert.deepEqual(drive(p, 1000, 60400), []);
  assert.deepEqual(drive(p, 60500, 60500), [{ type: 'retry', at: 60500 }]);
  assert.equal(p.state, 'retrying');
  p.connection('connected', 61000);
  assert.equal(p.state, 'probation');
  assert.deepEqual(drive(p, 61000, 70900), []);
  assert.deepEqual(drive(p, 71000, 71000), [{ type: 'promote', at: 71000 }]);
  assert.equal(p.state, 'connected');
});

test('a retry that cannot connect, or an unhealthy probation, goes back to waiting another 60 s', () => {
  const p = createSenderPolicy();
  p.begin(0); p.connection('failed', 100);
  const first = drive(p, 100, 60200);
  assert.deepEqual(first.map(a => a.type), ['retry']);
  const t0 = first[0].at;
  assert.deepEqual(drive(p, t0, t0 + 6500), [], 'the retry times out quietly');
  assert.equal(p.state, 'fallback');
  const second = drive(p, t0 + 6500, t0 + 61000);
  assert.deepEqual(second.map(a => a.type), ['retry']);
  assert.ok(second[0].at >= t0 + 60000);
  p.connection('connected', second[0].at + 500);
  assert.equal(p.state, 'probation');
  assert.equal(p.stats({ silentMs30s: 1500 }, second[0].at + 2000), null);
  assert.equal(p.state, 'fallback', 'concealment during probation sends it back');
  const third = createSenderPolicy();
  third.begin(0); third.connection('failed', 1); drive(third, 1, 60100);
  third.connection('connected', 60500);
  third.connection('disconnected', 62000);
  assert.equal(third.state, 'fallback');
});

test('a phone without RTCPeerConnection goes straight to the fallback', () => {
  const p = createSenderPolicy();
  assert.deepEqual(p.unsupported(0), { type: 'fallback', reason: 'no-rtc' });
  assert.deepEqual(drive(p, 0, 59000), []);
  assert.deepEqual(drive(p, 60000, 60000).map(a => a.type), ['retry']);
});

test('stop() returns to idle and nothing fires afterwards', () => {
  const p = createSenderPolicy();
  p.begin(0);
  p.stop();
  assert.deepEqual(drive(p, 0, 120000), []);
  assert.equal(p.state, 'idle');
});

test('the constants are the ones in design 5.2 and 5.4', () => {
  assert.equal(RTC_POLICY.initialTarget, 800);
  assert.equal(RTC_POLICY.maxTarget, 2000);
  assert.equal(RTC_POLICY.minTarget, 500);
  assert.equal(RTC_POLICY.connectTimeoutMs, 6000);
  assert.equal(RTC_POLICY.disconnectedFallbackMs, 8000);
  assert.equal(RTC_POLICY.silentLimitMs, 3000);
  assert.equal(RTC_POLICY.retryEveryMs, 60000);
  assert.equal(RTC_POLICY.promoteAfterMs, 10000);
});
