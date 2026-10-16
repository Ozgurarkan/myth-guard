import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayout, PLAYOUT_DEFAULTS } from '../src/audio/playout.js';
import { simulate, PROFILES, rng, PACKET, FRAMES, RATE } from '../test-support/wp5-mixer.js';

// ---- the two guarantees of the old playbackTimeline.test.js, restated for the new scheduler ---------------------------------

function driver(options = {}) {
  let now = 0;
  const events = [];
  const p = createPlayout({ clock: () => now, onEvent: (name, data) => events.push({ name, ...data }), ...options });
  const plays = [];
  const track = ops => {
    for (const op of ops) {
      if (op.op === 'play') plays.push({ ...op.seg, pushedAt: now });
      else if (op.op === 'cancel') { const at = plays.findIndex(x => x.id === op.id); if (at >= 0) plays.splice(at, 1); }
    }
    return ops;
  };
  return {
    p, plays, events,
    at(t) { now = t; return this; },
    get now() { return now; },
    push(seq, extra = {}) { return track(p.push({ seq, ts: seq * FRAMES, frames: FRAMES, rate: RATE, ...extra })); },
    pump() { return track(p.pump(now)); },
  };
}

test('delayed audio bursts stay contiguous instead of clearing the playback queue (uneven delivery with 620 ms gaps, minutes long)', () => {
  const d = driver();
  let next = 0;
  for (let batch = 0, t = 0; batch < 900; batch++) {
    t += [0.45, 0.2, 0.62, 0.3][batch % 4];
    d.at(t);
    while (next * PACKET <= t) d.push(next++);
    for (let k = 0; k < 4; k++) d.at(t + k * 0.025).pump();
  }
  assert.ok(d.plays.length > 4000);
  assert.equal(d.p.stats().underruns, 0);
  assert.equal(d.p.stats().jumps, 0);
  assert.ok(d.p.stats().trimmed <= 12, 'only the odd surplus packet of a 620 ms burst is trimmed (a skip of 85 ms with a crossfade, never a hole)');
  d.plays.sort((a, b) => a.at - b.at);
  for (let i = 1; i < d.plays.length; i++) {
    const prev = d.plays[i - 1], cur = d.plays[i];
    assert.ok(cur.at >= prev.at + prev.len - 0.0051, `no overlap between chunks ${i} beyond a crossfade`);
    assert.ok(cur.at > cur.pushedAt, 'audio is scheduled before its playback deadline');
  }
  const gaps = d.plays.slice(1).map((c, i) => c.at - (d.plays[i].at + d.plays[i].len));
  assert.ok(gaps.every(g => g < 1e-6), 'no gaps between chunks');
});

test('a real outage increases buffering and a stalled backlog stays bounded', () => {
  const d = driver();
  for (let i = 0; i < 20; i++) d.at(i * PACKET).push(i);
  d.at(20 * PACKET).pump();
  assert.equal(d.p.stats().underruns, 0);
  // a 3 s outage: nothing arrives, the buffer runs dry
  for (let t = 20 * PACKET; t < 20 * PACKET + 3; t += 0.025) d.at(t).pump();
  assert.equal(d.p.stats().underruns, 1);
  assert.equal(d.p.mode, 'buffering');
  // then a backlog of 100 packets lands at once (what a TCP burst does)
  d.at(20 * PACKET + 3);
  for (let i = 20; i < 120; i++) d.push(i);
  const s = d.p.stats();
  assert.ok(s.bufferedMs <= s.targetMs + PLAYOUT_DEFAULTS.overflow * 1000 + PACKET * 1000, `buffered ${s.bufferedMs} ms for target ${s.targetMs}`);
  assert.ok(s.trimmed + s.stale >= 60, 'the oldest packets of the backlog were thrown away');
  const first = d.plays.at(-1);
  assert.ok(first.src >= 100, 'what plays is the newest sound, not 3 s old sound');
});

// ---- scenarios judged by the rendered output --------------------------------------------------------------------------------

const clean = r => { assert.equal(r.analysis.discontinuities, 0, 'no click'); assert.deepEqual(Object.values(r.violations), [0, 0, 0, 0], JSON.stringify(r.violations)); };

test('clean network: no hole, no click, latency settles at T and stays there', () => {
  const r = simulate({ seconds: 40, net: PROFILES.clean() });
  clean(r);
  assert.equal(r.analysis.dropouts, 0);
  assert.ok(r.latency.startMs > 1100 && r.latency.startMs < 1350, String(r.latency.startMs));
  assert.ok(Math.abs(r.latency.endMs - r.latency.startMs) < 120);
  assert.ok(r.analysis.first < 2.4, `first sound at ${r.analysis.first}`);
});

test('every profile of design 6.5 except the long stalls: 0 dropouts and 0 clicks (fallback acceptance, 5.9)', () => {
  for (const name of ['clean', 'good', 'busy', 'bad', 'jitter80', 'stall300', 'stall700', 'stall1000']) {
    const r = simulate({ seconds: 45, net: PROFILES[name](45), seed: 7 });
    clean(r);
    assert.equal(r.analysis.dropouts, 0, `${name}: ${JSON.stringify(r.analysis.holes)}`);
  }
});

test('wifi (contains a 1.3 s stall): one dropout shorter than the stall; roam (3 s): one dropout shorter than the outage', () => {
  const wifi = simulate({ seconds: 45, net: PROFILES.wifi(45) });
  clean(wifi);
  assert.ok(wifi.analysis.dropouts <= 1);
  assert.ok(wifi.analysis.silenceMs < 1300, String(wifi.analysis.silenceMs));
  const roam = simulate({ seconds: 45, net: PROFILES.roam(45) });
  clean(roam);
  assert.equal(roam.analysis.dropouts, 1);
  assert.ok(roam.analysis.silenceMs < 3000);
  assert.ok(roam.stats.targetMs <= 2500, 'T never exceeds its cap');
});

test('after a stall the delay comes back: no staying 1-3 s late (the old path\'s failure)', () => {
  for (const hold of [0.7, 1.0, 1.5, 3.0]) {
    const net = { base: 0.003, jitter: 0.01, holds: [[10, hold]] };
    const r = simulate({ seconds: 40, net });
    clean(r);
    const target = r.stats.targetMs;
    const end = r.latency.endMs;
    assert.ok(end <= target + 150, `hold ${hold}s: ended ${Math.round(end)} ms late with T ${Math.round(target)}`);
    assert.ok(end < 2000, `hold ${hold}s ended ${Math.round(end)} ms`);
    assert.ok(r.latency.recoveredWithin(1500, 10 + hold) < 10, `hold ${hold}s: back under 1.5 s within 10 s`);
  }
});

test('an underrun grows T to 1.5 x the gap that was missed and not further', () => {
  const r = simulate({ seconds: 40, net: { base: 0.003, jitter: 0.01, holds: [[10, 3]] } });
  assert.ok(r.stats.targetMs <= 2500);
  assert.ok(r.stats.targetMs >= 1.5 * 1000 * 1.0, String(r.stats.targetMs));
  const small = simulate({ seconds: 40, net: PROFILES.stall300(40) });
  assert.equal(small.stats.targetMs, PLAYOUT_DEFAULTS.floor * 1000, 'stalls the buffer absorbs do not inflate T');
});

test('a blocked phone main thread: 0.5 s is invisible, 1.2 s too at T >= 1.3 s, 2.5 s costs one recoverable hole', () => {
  clean(simulate({ seconds: 30, net: PROFILES.clean(), freezes: [[10, 0.5]] }));
  const half = simulate({ seconds: 30, net: PROFILES.clean(), freezes: [[10, 0.5]] });
  assert.equal(half.analysis.dropouts, 0);
  const big = simulate({ seconds: 30, net: PROFILES.clean(), freezes: [[10, 1.2]], playout: { target: 1.4, floor: 1.4 } });
  clean(big);
  assert.equal(big.analysis.dropouts, 0);
  const long = simulate({ seconds: 40, net: PROFILES.clean(), freezes: [[10, 2.5]] });
  clean(long);
  assert.ok(long.analysis.dropouts <= 1);
  assert.ok(long.latency.endMs < 2600);
});

test('clock drift of +-1000 ppm over 5 minutes: no dropout, no click, rate trim within +-0.3 %, delay near T', () => {
  for (const drift of [-1000, -300, 300, 1000]) {
    const r = simulate({ seconds: 300, net: PROFILES.good(300), drift, seed: 3 });
    clean(r);
    assert.equal(r.analysis.dropouts, 0, `drift ${drift}`);
    assert.ok(Math.abs(r.stats.rate - 1) <= 0.003 + 1e-9);
    assert.ok(r.latency.endMs > 700 && r.latency.endMs < 1500, `drift ${drift}: ${Math.round(r.latency.endMs)} ms`);
    const rates = new Set(r.model.entries().filter(e => e.seg.kind === 'real').map(e => +e.seg.rate.toFixed(4)));
    assert.ok([...rates].every(x => Math.abs(x - 1) <= 0.0031));
  }
});

test('a gap of 1-2 packets (relay skipped them) is concealed: no hole, no click; a longer one is skipped with a crossfade', () => {
  const short = simulate({ seconds: 30, net: { base: 0.003, jitter: 0.01, holds: [[10, 1.5]], relayQueue: 3, kernel: 2 }, playout: { target: 2.2, floor: 2.2 } });
  clean(short);
  const long = simulate({ seconds: 30, net: { base: 0.003, jitter: 0.01, holds: [[10, 1.5]], relayQueue: 3, kernel: 2 } });
  clean(long);
  // an unordered transport that really loses packets: concealment fills each one
  for (const lose of [0.02, 0.08]) {
    const r = simulate({ seconds: 40, net: { base: 0.01, jitter: 0.02, lose, reorder: 0.05 }, playout: { ordered: false }, seed: 11 });
    clean(r);
    assert.equal(r.analysis.dropouts, 0, `loss ${lose}`);
    assert.ok(r.stats.concealedPackets > 0);
  }
});

test('duplicates, reordered and late packets are ignored, never played twice', () => {
  const r = simulate({ seconds: 20, net: PROFILES.good(20), dupes: 0.3, seed: 5 });
  clean(r);
  assert.ok(r.stats.duplicates > 20);
  assert.equal(r.analysis.dropouts, 0);
  const real = r.model.entries().filter(e => e.seg.kind === 'real').map(e => e.seg.src);
  assert.equal(new Set(real).size, real.length, 'each packet plays at most once');
});

test('the sequence number wraps at 2^32 without any change in behaviour', () => {
  const play = start => {
    let now = 0;
    const p = createPlayout({ clock: () => now });
    const out = [];
    for (let i = 0; i < 400; i++) {
      now = i * PACKET;
      for (const op of p.push({ seq: (start + i) >>> 0, ts: ((start + i) * FRAMES) >>> 0, frames: FRAMES })) if (op.op === 'play') out.push(+op.seg.at.toFixed(6));
      now += 0.03;
      for (const op of p.pump(now)) if (op.op === 'play') out.push(+op.seg.at.toFixed(6));
    }
    return out;
  };
  const plain = play(1000), wrapped = play(0xfffffffe - 150);
  assert.ok(plain.length > 300);
  assert.deepEqual(wrapped, plain);
});

test('a sequence that restarts from zero (new broadcast) is a new stream: old sound is stopped, not mixed in', () => {
  const d = driver();
  for (let i = 0; i < 3000; i++) { d.at(i * PACKET).push(10000 + i); d.pump(); }
  const before = d.plays.length;
  const ops = d.at(3000 * PACKET).push(0);
  assert.ok(d.p.stats().resets >= 1);
  assert.ok(ops.every(op => op.op !== 'play'), 'the new stream first buffers');
  assert.ok(before > 100);
  for (let i = 1; i < 30; i++) d.at(3000 * PACKET + i * PACKET).push(i);
  assert.ok(d.plays.at(-1).src < 100, 'new stream plays');
});

test('stop() fades what is sounding, cancels what has not started and forgets the stream', () => {
  const d = driver();
  for (let i = 0; i < 40; i++) d.at(i * PACKET).push(i);
  d.at(40 * PACKET);
  const ops = d.p.stop();
  assert.ok(ops.some(op => op.op === 'cancel'));
  const updates = ops.filter(op => op.op === 'update');
  assert.ok(updates.every(op => op.seg.stopAt <= d.now + 0.0201 && op.seg.fadeOut > 0));
  assert.equal(d.p.mode, 'idle');
  assert.equal(d.p.needed().size, 0);
});

test('needed() lists exactly what the caller must keep: queued, sounding, and the concealment source', () => {
  const d = driver();
  for (let i = 0; i < 5; i++) d.at(i * PACKET).push(i);
  assert.deepEqual([...d.p.needed()].sort((a, b) => a - b), [0, 1, 2, 3, 4], 'still buffering');
  for (let i = 5; i < 20; i++) d.at(i * PACKET).push(i);
  const need = d.p.needed();
  assert.ok(need.has(19) && need.size > 1);
  d.at(100).pump();
  assert.ok(d.p.needed().size <= 1, 'long after the end only the last packet remains');
});

test('random networks: never a click, never an operation in the past, a hole only where an underrun happened (30 scenarios)', () => {
  const random = rng(2024);
  for (let n = 0; n < 30; n++) {
    const holds = [];
    for (let k = Math.floor(random() * 4); k > 0; k--) holds.push([6 + random() * 18, 0.2 + random() * 2.8]);
    holds.sort((a, b) => a[0] - b[0]);
    const clearHolds = holds.filter((h, i) => i === 0 || h[0] > holds[i - 1][0] + holds[i - 1][1] + 0.5);
    const net = { base: random() * 0.03, jitter: random() * 0.1, holds: clearHolds, relayQueue: 3 + Math.floor(random() * 8), kernel: Math.floor(random() * 12) };
    const freezes = random() < 0.4 ? [[8 + random() * 10, 0.3 + random() * 1.5]] : [];
    const underruns = [];
    const r = simulate({ seconds: 32, net, freezes, drift: (random() - 0.5) * 1000, seed: n + 1,
      playout: { onEvent: (name, data) => { if (name === 'underrun') underruns.push(data.at); } } });
    const label = `scenario ${n}: ${JSON.stringify({ net, freezes })}`;
    assert.equal(r.analysis.discontinuities, 0, label);
    assert.deepEqual(Object.values(r.violations), [0, 0, 0, 0], label);
    const before = underruns.filter(t => t < 33).length;
    assert.ok(r.analysis.dropouts <= before, `${label}: ${r.analysis.dropouts} holes, ${before} underruns`);
    const longest = Math.max(0, ...clearHolds.map(h => h[1]), ...freezes.map(f => f[1]));
    if (longest <= 0.9 && net.jitter <= 0.1) assert.equal(r.analysis.dropouts, 0, label);
  }
});

test('100,000 random arrivals: the schedule stays sane (no operation in the past, no overlap beyond a crossfade, bounded memory)', () => {
  const random = rng(99);
  let now = 0;
  const p = createPlayout({ clock: () => now });
  let seq = 0, lastEnd = 0, plays = 0;
  const live = new Map();
  const apply = ops => {
    for (const op of ops) {
      if (op.op === 'play') {
        plays++;
        assert.ok(op.seg.at >= now - 1e-9, 'never starts in the past');
        assert.ok(op.seg.at >= lastEnd - 0.0061, `overlap beyond a crossfade: ${lastEnd - op.seg.at}`);
        assert.ok(op.seg.len > 0 && Number.isFinite(op.seg.at));
        live.set(op.seg.id, op.seg);
        lastEnd = Math.max(lastEnd, op.seg.end);
      } else if (op.op === 'cancel') {
        const seg = live.get(op.id);
        assert.ok(seg && seg.at >= now - 1e-9, 'only unstarted segments are cancelled');
        live.delete(op.id);
        lastEnd = Math.max(0, ...[...live.values()].map(s => s.end));
      } else if (op.op === 'update') assert.ok(live.has(op.seg.id));
    }
    for (const [id, s] of live) if (s.end < now - 1) live.delete(id);
  };
  for (let i = 0; i < 100000; i++) {
    now += random() < 0.0005 ? random() * 3 : random() * 0.1; // about one packet per 85 ms on average, with the odd stall
    const kind = random();
    if (kind < 0.6) apply(p.push({ seq: seq >>> 0, ts: (seq++ * FRAMES) >>> 0, frames: FRAMES }));
    else if (kind < 0.65) apply(p.push({ seq: Math.max(0, seq - 1 - Math.floor(random() * 30)), ts: 0, frames: FRAMES })); // late / duplicate
    else if (kind < 0.67) seq += Math.floor(random() * 6); // loss
    else apply(p.pump(now));
    if (i % 5000 === 0) assert.ok(p.stats().queuedPackets < 200, 'queue bounded');
  }
  assert.ok(plays > 5000, String(plays));
  assert.ok(p.stats().bufferedMs < 6000);
});

test('options are checked and the defaults are the documented ones', () => {
  assert.throws(() => createPlayout({}), /clock/);
  assert.equal(PLAYOUT_DEFAULTS.fade, 0.005);
  assert.equal(PLAYOUT_DEFAULTS.maxTarget, 2.5);
  assert.equal(PLAYOUT_DEFAULTS.maxTrim, 0.003);
  assert.ok(Object.isFrozen(PLAYOUT_DEFAULTS));
});

// ---- the stateful resampler (used only when the AudioContext cannot be pinned to 48 kHz) ----------------------------------

import { createResampler } from '../src/audio/playout.js';

test('resampler: cutting the input into packets does not change the output (no phase step at packet joins)', () => {
  const tone = (n, from) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (from + i)) / 48000));
  const whole = createResampler(48000, 44100).process([tone(4096 * 6, 0)])[0];
  const r = createResampler(48000, 44100);
  const parts = [0, 1, 2, 3, 4, 5].map(k => r.process([tone(4096, k * 4096)])[0]);
  const joined = Float32Array.from(parts.flatMap(p => [...p]));
  assert.ok(Math.abs(joined.length - whole.length) <= 1, `${joined.length} vs ${whole.length}`);
  for (let i = 0; i < Math.min(joined.length, whole.length); i++) assert.ok(Math.abs(joined[i] - whole[i]) < 1e-5, `sample ${i}`);
  let maxStep = 0;
  for (let i = 1; i < joined.length; i++) maxStep = Math.max(maxStep, Math.abs(joined[i] - joined[i - 1]));
  assert.ok(maxStep < 0.04, `largest step ${maxStep}`);
  // the packet sizes are the 3763/3764 that a 4096 block really yields at 44.1 kHz
  assert.ok(parts.every(p => p.length === 3763 || p.length === 3764));
});

test('resampler: 48 kHz to 32 kHz and to 96 kHz keep a sine continuous too', () => {
  for (const out of [32000, 96000, 44100, 48000]) {
    const r = createResampler(48000, out);
    const samples = [];
    for (let k = 0; k < 8; k++) samples.push(...r.process([Float32Array.from({ length: 4096 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * (k * 4096 + i)) / 48000))])[0]);
    let maxStep = 0;
    for (let i = 1; i < samples.length; i++) maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]));
    assert.ok(maxStep < 0.05, `${out}: ${maxStep}`);
    assert.ok(Math.abs(samples.length - (8 * 4096 * out) / 48000) <= 2);
  }
});
