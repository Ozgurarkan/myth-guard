import test from 'node:test';
import assert from 'node:assert/strict';
import { createJitter, createSeqUnwrapper } from '../src/audio/jitter.js';

const PACKET = 4096 / 48000;
const feed = (jitter, n, { start = 0, seq0 = 0, delay = () => 0, skip = () => false, at0 = 0 } = {}) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (skip(i)) continue;
    const arrival = at0 + (start + i) * PACKET + delay(i);
    out.push(jitter.observe({ seq: (seq0 + start + i) >>> 0, ts: ((start + i) * 4096) >>> 0, arrival }));
  }
  return out;
};

test('a perfectly paced stream has no jitter, no loss, no lateness', () => {
  const j = createJitter();
  feed(j, 600);
  const s = j.snapshot();
  assert.equal(s.received, 600);
  assert.equal(s.lost, 0);
  assert.equal(s.lossPct, 0);
  assert.ok(s.jitterMs < 0.001);
  assert.ok(s.worstLateMs < 0.001);
});

test('interarrival jitter follows RFC 3550: for alternating +-20 ms it settles near the mean absolute difference (40 ms)', () => {
  const j = createJitter();
  feed(j, 2000, { delay: i => (i % 2 ? 0.02 : -0.02) + 0.05 });
  assert.ok(Math.abs(j.snapshot().jitterMs - 40) < 2, String(j.snapshot().jitterMs));
});

test('loss, duplicates and reordering are told apart', () => {
  const j = createJitter();
  const lost = new Set([10, 11, 50]);
  feed(j, 100, { skip: i => lost.has(i) });
  let s = j.snapshot();
  assert.equal(s.expected, 100);
  assert.equal(s.lost, 3);
  assert.ok(Math.abs(s.lossPct - 3) < 1e-9);
  assert.equal(j.observe({ seq: 20, ts: 20 * 4096, arrival: 99 }).kind, 'duplicate');
  assert.equal(j.observe({ seq: 11, ts: 11 * 4096, arrival: 99 }).kind, 'reordered', 'a packet counted lost that arrives late');
  s = j.snapshot();
  assert.equal(s.duplicates, 1);
  assert.equal(s.reordered, 1);
  assert.equal(s.lost, 2, 'it is no longer lost');
});

test('sequence numbers and timestamps wrap at 2^32 without a glitch in the statistics', () => {
  const j = createJitter();
  const results = feed(j, 200, { seq0: 0xffffff00, start: 0 });
  assert.ok(results.every(r => r.kind === 'new'));
  assert.equal(results[0].ext, 0xffffff00);
  assert.equal(results[199].ext, 0xffffff00 + 199, 'extended past 2^32');
  const s = j.snapshot();
  assert.equal(s.received, 200);
  assert.equal(s.lost, 0);
  // timestamps wrap too (ts is taken modulo 2^32 by the sender)
  const k = createJitter();
  const base = 2 ** 32 - 8192;
  for (let i = 0; i < 100; i++) k.observe({ seq: i, ts: (base + i * 4096) >>> 0, arrival: i * PACKET });
  assert.ok(k.snapshot().worstLateMs < 0.01, 'no phantom lateness at the ts wrap');
});

test('lateness: after a 700 ms stall the first packets of the burst are 700 ms late, and it shows in worstLateness for a window', () => {
  const j = createJitter({ window: 30 });
  feed(j, 100);
  // stall: packets 100..107 arrive 0.7 s late, together
  for (let i = 100; i < 108; i++) j.observe({ seq: i, ts: i * 4096, arrival: 100 * PACKET + 0.7 + (i - 100) * 0.0005 });
  assert.ok(Math.abs(j.worstLateness() - 0.7) < 0.01, String(j.worstLateness()));
  assert.ok(Math.abs(j.snapshot().lateMs - (0.7 - 7 * (PACKET - 0.0005) * 0 - 7 * PACKET) * 1000) < 700, 'last of the burst is less late');
  // 30 s later the stall has left the window
  feed(j, 500, { start: 108, at0: 0.7 - 0.7 }); // nominal pacing resumes
  assert.ok(j.worstLateness() < 0.05, String(j.worstLateness()));
});

test('a jump of the sequence far backwards is a new stream: the statistics restart', () => {
  const j = createJitter();
  feed(j, 2000);
  assert.equal(j.snapshot().received, 2000);
  const r = j.observe({ seq: 5, ts: 5 * 4096, arrival: 30 });
  assert.equal(r.kind, 'reset');
  const s = j.snapshot();
  assert.equal(s.resets, 1);
  assert.equal(s.received, 1);
  assert.equal(s.lost, 0);
  // a small step back is just a late packet
  const k = createJitter();
  feed(k, 100);
  assert.equal(k.observe({ seq: 90, ts: 90 * 4096, arrival: 9 }).kind, 'duplicate');
});

test('the unwrapper', () => {
  const u = createSeqUnwrapper();
  assert.deepEqual(u.next(0xfffffffe), { ext: 0xfffffffe, kind: 'first' });
  assert.deepEqual(u.next(0xffffffff), { ext: 0xffffffff, kind: 'next' });
  assert.deepEqual(u.next(0), { ext: 2 ** 32, kind: 'next' });
  assert.deepEqual(u.next(5), { ext: 2 ** 32 + 5, kind: 'next' });
  assert.deepEqual(u.next(3), { ext: 2 ** 32 + 3, kind: 'back' });
  assert.equal(u.next(5 + 100000000).kind, 'reset', 'a huge jump forward is not a gap');
  u.reset();
  assert.equal(u.next(77).kind, 'first');
});

test('memory stays bounded however long the stream runs', () => {
  const j = createJitter();
  feed(j, 50000);
  assert.equal(j.snapshot().received, 50000);
  assert.ok(j.snapshot().lost === 0);
});

test('without timestamps only the sequence statistics are kept', () => {
  const j = createJitter();
  for (let i = 0; i < 20; i++) j.observe({ seq: i, arrival: i * 0.1 });
  const s = j.snapshot();
  assert.equal(s.received, 20);
  assert.equal(s.jitterMs, 0);
  assert.equal(s.worstLateMs, 0);
});
