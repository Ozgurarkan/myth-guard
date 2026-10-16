// The test harness is tested too: an untested impairment tool already misled the audit once (design 5.6, 8.2).
// Everything here runs on loopback with ephemeral ports and without a browser.
// Set HARNESS_BROWSER=1 to also run the Edge self-test of the AudioWorklet tap (needs Microsoft Edge).
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFakeClock } from '../test-support/fakeClock.js';
import { createFakeSocket, createFakeWebSocketClass, createSocketPair, OPEN, CLOSED } from '../test-support/fakeSocket.js';
import { createTcpImpair } from '../test-support/tcpImpair.js';
import { createUdpRelay } from '../test-support/udpImpair.js';
import { PROFILE_NAMES, getProfile, eventsFor, applyProfile, geParams, seededRandom, supports } from '../test-support/profiles.js';
import { analyzeSine, makeSine } from '../test-support/sineAnalysis.js';
import { styleOf, checkFile, expectedStyle } from '../scripts/check-eol.mjs';

// ---------------------------------------------------------------------------------------------------------------------
// TCP proxy: strict FIFO
// ---------------------------------------------------------------------------------------------------------------------

const RECORD = 8;

/** A server that writes `count` numbered 8-byte records (four separate writes per tick), `gapMs` apart, then ends. */
async function recordServer(count, gapMs) {
  const server = net.createServer(socket => {
    socket.setNoDelay(true);
    let n = 0;
    const timer = setInterval(() => {
      for (let k = 0; k < 4 && n < count; k += 1) {
        const record = Buffer.alloc(RECORD);
        record.writeUInt32BE(n++, 4);
        socket.write(record);
      }
      if (n >= count) { clearInterval(timer); setTimeout(() => socket.end(), 50); }
    }, gapMs);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }) };
}

/** Read records from `port` until the server ends. Returns the sequence numbers in arrival order. */
function readRecords(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const seen = [];
    let rest = Buffer.alloc(0);
    socket.on('data', data => {
      rest = Buffer.concat([rest, data]);
      while (rest.length >= RECORD) { seen.push(rest.readUInt32BE(4)); rest = rest.subarray(RECORD); }
    });
    socket.on('close', () => resolve(seen));
    socket.on('error', reject);
  });
}

const inversions = seen => seen.reduce((count, value, i) => count + (i > 0 && value < seen[i - 1] ? 1 : 0), 0);

/** The bug this harness once had: every chunk gets its own random timer, so later chunks can overtake earlier ones. */
async function naiveReorderingProxy(targetPort, jitterMs) {
  const server = net.createServer(client => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    upstream.setNoDelay(true);
    upstream.on('data', chunk => setTimeout(() => { if (!client.destroyed) client.write(chunk); }, Math.random() * jitterMs));
    const end = () => { client.destroy(); upstream.destroy(); };
    upstream.on('close', () => setTimeout(end, jitterMs + 50));
    client.on('close', end); client.on('error', end); upstream.on('error', end);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }) };
}

test('TCP proxy is strict FIFO under jitter, loss stalls and manual stalls: 400 records arrive complete and in order', async () => {
  const origin = await recordServer(400, 2);
  const proxy = createTcpImpair({ listenPort: 0, targetPort: origin.port, random: seededRandom(7) });
  await proxy.listen();
  Object.assign(proxy.state, { baseMs: 5, jitterMs: 60, loss: 0.02, rto: 40 });
  setTimeout(() => proxy.stall(150), 300);
  const seen = await readRecords(proxy.port);
  assert.equal(seen.length, 400, 'no record lost or duplicated');
  assert.equal(inversions(seen), 0, 'no record overtook another');
  assert.deepEqual(seen, [...Array(400).keys()]);
  assert.ok(proxy.state.lossEvents > 0, 'the loss model actually fired (otherwise this test proves nothing)');
  assert.ok(proxy.stats.bytesDown >= 400 * RECORD);
  await proxy.close();
  await origin.close();
});

test('the order checker catches a reordering proxy (negative control for the FIFO test)', async () => {
  const origin = await recordServer(300, 2);
  const naive = await naiveReorderingProxy(origin.port, 80);
  const seen = await readRecords(naive.port);
  assert.ok(seen.length > 100, `records arrived (${seen.length})`);
  assert.ok(inversions(seen) > 5, `the naive proxy reorders and the checker sees it (${inversions(seen)} inversions)`);
  await naive.close();
  await origin.close();
});

test('TCP proxy: a stall holds everything and releases it in order; delay is applied; both directions pass bytes', async () => {
  const echo = net.createServer(socket => { socket.on('data', d => socket.write(d)); socket.on('error', () => {}); });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const proxy = createTcpImpair({ listenPort: 0, targetPort: echo.address().port });
  await proxy.listen();
  const client = net.connect(proxy.port, '127.0.0.1');
  await new Promise(resolve => client.once('connect', resolve));
  const arrivals = [];
  let text = '';
  client.on('data', d => { text += d.toString(); arrivals.push(Date.now()); });

  proxy.state.baseMs = 60;
  let t0 = Date.now();
  client.write('a');
  while (!text.includes('a')) await sleep(5);
  const delayed = Date.now() - t0;
  assert.ok(delayed >= 55, `base delay applied (${delayed} ms)`);

  proxy.state.baseMs = 0;
  proxy.stall(300);
  t0 = Date.now();
  client.write('b'); await sleep(20); client.write('c'); await sleep(20); client.write('d');
  await sleep(150);
  assert.ok(!text.includes('b'), 'nothing arrives during the stall');
  while (!text.includes('d')) await sleep(5);
  assert.ok(Date.now() - t0 >= 280, 'stall length respected');
  assert.equal(text, 'abcd', 'released in order');
  client.destroy();
  await proxy.close();
  await new Promise(resolve => { echo.close(resolve); echo.closeAllConnections?.(); });
});

test('TCP proxy against a plain echo server: 2 MB survive byte for byte through delay, jitter and loss', async () => {
  const echo = net.createServer(socket => { socket.on('data', d => socket.write(d)); socket.on('error', () => {}); });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const proxy = createTcpImpair({ listenPort: 0, targetPort: echo.address().port, random: seededRandom(3) });
  await proxy.listen();
  Object.assign(proxy.state, { baseMs: 2, jitterMs: 20, loss: 0.01, rto: 30 });
  const payload = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + (i >> 8)) & 0xff;
  const client = net.connect(proxy.port, '127.0.0.1');
  const chunks = [];
  let got = 0;
  const done = new Promise(resolve => client.on('data', d => { chunks.push(d); got += d.length; if (got >= payload.length) resolve(); }));
  client.write(payload);
  await done;
  assert.ok(Buffer.concat(chunks).equals(payload), 'identical bytes in identical order');
  client.destroy();
  await proxy.close();
  await new Promise(resolve => { echo.close(resolve); echo.closeAllConnections?.(); });
});

// ---------------------------------------------------------------------------------------------------------------------
// UDP relay: loss rate
// ---------------------------------------------------------------------------------------------------------------------

/** Send `count` numbered datagrams from the "player" through the relay to the "GM". Returns what the GM received, in arrival order. */
async function throughRelay(relay, count, { gapMs = 0, batch = 20 } = {}) {
  const gm = dgram.createSocket('udp4');
  const player = dgram.createSocket('udp4');
  const received = [];
  gm.on('message', message => received.push(message.readUInt32BE(0)));
  await Promise.all([new Promise(r => gm.bind(0, '127.0.0.1', r)), new Promise(r => player.bind(0, '127.0.0.1', r))]);
  try { gm.setRecvBufferSize(4 * 1024 * 1024); } catch { /* default */ }
  relay.gmPort = gm.address().port;
  relay.playerPort = player.address().port;
  for (let i = 0; i < count; i += 1) {
    const packet = Buffer.alloc(8);
    packet.writeUInt32BE(i, 0);
    player.send(packet, relay.playerFacingPort, '127.0.0.1');
    if (gapMs) await sleep(gapMs);
    else if (i % batch === batch - 1) await (i % 1000 === 999 ? sleep(2) : new Promise(resolve => setImmediate(resolve)));
  }
  await sleep(300);
  gm.close(); player.close();
  return received;
}

test('UDP relay with no impairment delivers every datagram (control: the OS does not drop on loopback)', async () => {
  const relay = await createUdpRelay({ random: seededRandom(1) }).ready();
  const received = await throughRelay(relay, 10000);
  assert.equal(received.length, 10000);
  assert.equal(relay.stats.dropped, 0);
  relay.close();
});

test('UDP relay: independent loss matches its setting within 1 % (5 % and 20 %)', async () => {
  for (const loss of [0.05, 0.2]) {
    const relay = await createUdpRelay({ random: seededRandom(11) }).ready();
    relay.impair.loss = loss;
    const N = 20000;
    const received = await throughRelay(relay, N);
    const seenLoss = 1 - received.length / N;
    const relayLoss = relay.stats.dropped / relay.stats.in;
    assert.equal(relay.stats.in, N, 'every datagram reached the relay');
    assert.ok(Math.abs(seenLoss - loss) < 0.01, `loss ${loss}: receiver saw ${(seenLoss * 100).toFixed(2)} %`);
    assert.ok(Math.abs(relayLoss - loss) < 0.01, `loss ${loss}: relay counted ${(relayLoss * 100).toFixed(2)} %`);
    assert.equal(relay.stats.dropped + received.length, N, 'dropped + delivered = sent');
    relay.close();
  }
});

test('UDP relay: Gilbert-Elliott burst loss has the requested average (5 %) and mean burst (4 packets)', async () => {
  const relay = await createUdpRelay({ random: seededRandom(5) }).ready();
  relay.impair.burst = geParams(0.05, 4);
  const N = 40000;
  const received = await throughRelay(relay, N);
  const got = new Set(received);
  const loss = 1 - got.size / N;
  assert.ok(Math.abs(loss - 0.05) < 0.01, `average loss ${(loss * 100).toFixed(2)} %`);
  // mean length of runs of consecutive missing sequence numbers
  const runs = [];
  let run = 0;
  for (let i = 0; i < N; i += 1) { if (!got.has(i)) run += 1; else if (run) { runs.push(run); run = 0; } }
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  assert.ok(mean > 3 && mean < 5, `mean burst ${mean.toFixed(2)} packets`);
  relay.close();
});

test('UDP relay: a blackout drops, a holding blackout queues and releases the burst; delay and jitter are applied', async () => {
  // drop
  let relay = await createUdpRelay({ random: seededRandom(2) }).ready();
  relay.blackout(250, false);
  let received = await throughRelay(relay, 100, { gapMs: 5 });
  const lost = [...Array(100).keys()].filter(i => !received.includes(i));
  assert.ok(lost.length >= 5 && lost.length <= 60, `datagrams sent during the 250 ms blackout were dropped (${lost.length})`);
  assert.equal(lost.at(-1) - lost[0] + 1, lost.length, 'the lost datagrams are one contiguous run');
  assert.equal(relay.stats.dropped, lost.length);
  assert.equal(lost[0], 0, 'the blackout began at once');
  relay.close();
  // hold: everything arrives, bunched at the end of the blackout
  relay = await createUdpRelay({ random: seededRandom(2) }).ready();
  relay.blackout(250, true);
  const gm = dgram.createSocket('udp4'); const player = dgram.createSocket('udp4');
  const times = [];
  gm.on('message', () => times.push(Date.now()));
  await Promise.all([new Promise(r => gm.bind(0, '127.0.0.1', r)), new Promise(r => player.bind(0, '127.0.0.1', r))]);
  relay.gmPort = gm.address().port; relay.playerPort = player.address().port;
  const start = Date.now();
  for (let i = 0; i < 40; i += 1) { player.send(Buffer.alloc(8), relay.playerFacingPort, '127.0.0.1'); await sleep(5); }
  await sleep(400);
  assert.equal(times.length, 40, 'nothing lost when the blackout holds');
  const early = times.filter(t => t - start < 230).length;
  assert.equal(early, 0, 'nothing arrived during the blackout');
  gm.close(); player.close(); relay.close();
  // delay + jitter
  relay = await createUdpRelay({ random: seededRandom(2) }).ready();
  relay.impair.delay = 40; relay.impair.jitter = 40;
  const t0 = Date.now();
  received = await throughRelay(relay, 20, { gapMs: 1 });
  assert.equal(received.length, 20);
  assert.ok(Date.now() - t0 >= 330, 'the 300 ms drain wait ran, so delivery of delayed packets was awaited');
  relay.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------------------------------

test('profiles: every name of design 6.5 exists, UDP-only and TCP-only differences are right', () => {
  assert.deepEqual([...PROFILE_NAMES].sort(), ['bad', 'busy', 'clean', 'drop400', 'good', 'jitter80', 'roam', 'stall1000', 'stall300', 'stall700', 'wifi']);
  for (const name of PROFILE_NAMES) {
    const profile = getProfile(name);
    assert.ok(profile.udp, `${name} has a UDP model`);
    assert.ok(profile.about);
  }
  assert.equal(supports('drop400', 'tcp'), false);
  assert.equal(supports('clean', 'tcp'), true);
  assert.throws(() => getProfile('nope'), /Unknown impairment profile/);
  assert.equal(getProfile('bad').tcp.loss, 0.06);
  assert.equal(getProfile('busy').tcp.loss, 0.03);
  assert.equal(getProfile('good').udp.loss, 0.005);
  const { p, q } = getProfile('bad').udp.burst;
  assert.ok(Math.abs(p / (p + q) - 0.05) < 1e-9, 'bad: stationary loss 5 %');
  assert.ok(Math.abs(1 / q - 4) < 1e-9, 'bad: mean burst 4');
  assert.equal(eventsFor('clean', 60).length, 0);
  assert.deepEqual(eventsFor('roam', 60), [{ atMs: 10000, holdMs: 3000, kind: 'hold' }]);
  assert.equal(eventsFor('stall1000', 60).length, 4); // 8, 23, 38, 53 s
  assert.ok(eventsFor('drop400', 60).every(e => e.kind === 'drop' && e.holdMs === 400));
  const wifi = eventsFor('wifi', 60, seededRandom(1));
  assert.ok(wifi.some(e => e.holdMs === 1300 && e.atMs === 25000));
  assert.ok(wifi.every(e => e.holdMs >= 250 && e.holdMs <= 1300));
});

test('applyProfile sets the live state of a TCP proxy / UDP relay and schedules its events (injected timers)', () => {
  const scheduled = [];
  const timers = { setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, clearTimer: id => { scheduled[id - 1].cancelled = true; } };
  const tcp = { state: {}, stalls: [], stall(ms) { this.stalls.push(ms); } };
  const run = applyProfile(tcp, 'tcp', 'stall700', { seconds: 30, ...timers });
  assert.deepEqual(tcp.state, { baseMs: 0, jitterMs: 0, loss: 0 });
  assert.deepEqual(scheduled.map(s => s.ms), [8000, 18000, 28000]);
  scheduled[0].fn();
  assert.deepEqual(tcp.stalls, [700]);
  run.stop();
  assert.ok(scheduled.every(s => s.cancelled));

  scheduled.length = 0;
  const udp = { impair: {}, blackouts: [], blackout(ms, hold) { this.blackouts.push([ms, hold]); } };
  applyProfile(udp, 'udp', 'drop400', { seconds: 20, ...timers });
  scheduled[0].fn();
  assert.deepEqual(udp.blackouts, [[400, false]]);
  applyProfile(udp, 'udp', 'stall300', { seconds: 20, ...timers });
  scheduled.at(-1).fn();
  assert.deepEqual(udp.blackouts.at(-1), [300, true]);
  applyProfile(udp, 'udp', 'bad', { seconds: 5, ...timers });
  assert.equal(udp.impair.delay, 15);
  assert.ok(udp.impair.burst.p > 0);
  assert.throws(() => applyProfile(tcp, 'tcp', 'drop400', timers), /not defined for TCP/);
});

test('seededRandom is deterministic and roughly uniform', () => {
  const a = seededRandom(42), b = seededRandom(42);
  const xs = Array.from({ length: 1000 }, a);
  assert.deepEqual(xs, Array.from({ length: 1000 }, b));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(mean > 0.45 && mean < 0.55 && xs.every(x => x >= 0 && x < 1));
});

// ---------------------------------------------------------------------------------------------------------------------
// Sine analyser
// ---------------------------------------------------------------------------------------------------------------------

test('sine analyser: a clean 440 Hz sine has no dropout, no discontinuity, no phase jump', () => {
  const result = analyzeSine(makeSine({ seconds: 3 }));
  assert.equal(result.dropouts.length, 0);
  assert.equal(result.holes.length, 0);
  assert.equal(result.discontinuities.length, 0);
  assert.equal(result.phaseJumps.length, 0);
  assert.ok(Math.abs(result.maxStep - 0.5 * 2 * Math.PI * 440 / 48000) < 0.002, `own max step ${result.maxStep}`);
});

test('sine analyser: a planted 12 ms hole is found (position and length), a 9 ms one is only a hole, leading silence is ignored', () => {
  const rate = 48000;
  const x = makeSine({ seconds: 2 });
  const at = 70000;
  x.fill(0, at, at + Math.round(0.012 * rate));
  const result = analyzeSine(x);
  assert.equal(result.dropouts.length, 1);
  assert.ok(Math.abs(result.dropouts[0].ms - 12) < 0.1, `length ${result.dropouts[0].ms}`);
  assert.ok(Math.abs(result.dropouts[0].atMs - (at / rate) * 1000) < 0.5, `position ${result.dropouts[0].atMs}`);

  const y = makeSine({ seconds: 2 });
  y.fill(0, at, at + Math.round(0.009 * rate));
  const small = analyzeSine(y);
  assert.equal(small.dropouts.length, 0, '9 ms is below the 10 ms dropout threshold');
  assert.equal(small.holes.length, 1);

  const z = makeSine({ seconds: 2 });
  z.fill(0, 0, 4800);               // 100 ms of leading silence
  z.fill(0, z.length - 4800);       // and trailing silence
  assert.equal(analyzeSine(z).dropouts.length, 0, 'silence at the edges is not a dropout');
});

test('sine analyser: a planted phase jump is found, including one too small to show as a sample jump', () => {
  const rate = 48000, freq = 440, w = (2 * Math.PI * freq) / rate;
  const make = (jumpAt, rad) => {
    const x = new Float32Array(2 * rate);
    for (let n = 0; n < x.length; n += 1) x[n] = 0.5 * Math.sin(w * n + (n >= jumpAt ? rad : 0));
    return x;
  };
  // 1) a big step: 59.6 samples of a 440 Hz sine = what one lost 4096-sample packet looks like (design 5.6)
  const big = analyzeSine(make(60000, (59.6 * w)));
  assert.equal(big.phaseJumps.length, 1, JSON.stringify(big.phaseJumps));
  const wrapped = 59.6 * w - 2 * Math.PI; // 3.43 rad seen modulo a full turn
  assert.ok(Math.abs(big.phaseJumps[0].rad - wrapped) < 0.05, `size ${big.phaseJumps[0].rad}`);
  assert.ok(Math.abs(big.phaseJumps[0].atMs - 1250) < 6, `position ${big.phaseJumps[0].atMs}`);
  // 2) a step planted at the crest of the wave: the sample-to-sample jump stays below 0.12 (the old detector is blind to it)
  let crest = 70000;                                        // a sample index at a crest of the wave
  for (let n = 70000; n < 70200; n += 1) if (Math.sin(w * n) > Math.sin(w * crest)) crest = n;
  const small = analyzeSine(make(crest, 0.4));
  assert.equal(small.discontinuities.length, 0, 'invisible to the sample-jump detector');
  assert.equal(small.phaseJumps.length, 1, JSON.stringify(small.phaseJumps));
  assert.ok(Math.abs(small.phaseJumps[0].rad - 0.4) < 0.05);
  // 3) the sample-jump detector sees a dropped packet: 4096 samples missing from the stream
  const stream = makeSine({ seconds: 2 });
  const spliced = new Float32Array(stream.length - 4096);
  spliced.set(stream.subarray(0, 50000), 0);
  spliced.set(stream.subarray(50000 + 4096), 50000);
  const gap = analyzeSine(spliced);
  assert.ok(gap.phaseJumps.length >= 1, 'removing a packet is a phase jump');
  assert.equal(gap.dropouts.length, 0, 'but it is not a silence');
  // 4) no false alarm on a sine whose frequency is a little off (resampling) and whose level is lower
  const drift = analyzeSine(makeSine({ seconds: 5, freq: 440.02, amp: 0.45 }), { amp: 0.5 });
  assert.equal(drift.phaseJumps.length, 0);
});

test('sine analyser: a jump larger than 0.12 between neighbours is a discontinuity, one-sample drop-outs too', () => {
  const x = makeSine({ seconds: 1 });
  let peak = 30000;                   // a single sample dropped to zero at a crest (the 44.1 kHz click of the old path)
  for (let i = 30000; i < 30200; i += 1) if (Math.abs(x[i]) > Math.abs(x[peak])) peak = i;
  x[peak] = 0;
  const result = analyzeSine(x);
  assert.equal(result.discontinuities.length, 1, 'one event (the tap counts the jump back up from the silent sample, like the worklet does)');
  assert.ok(result.discontinuities[0].size > 0.4);
  assert.equal(result.dropouts.length, 0);
  assert.equal(result.holes.length, 0, 'one sample is not a hole');
  assert.equal(analyzeSine(makeSine({ seconds: 1 })).discontinuities.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fake clock and fake sockets
// ---------------------------------------------------------------------------------------------------------------------

test('fake clock: timers fire in time order, ties in creation order, nested timers inside the window, intervals repeat, clear works', () => {
  const clock = createFakeClock({ start: 1000 });
  const log = [];
  clock.setTimeout(() => log.push('b@50'), 50);
  clock.setTimeout(() => log.push('a@10'), 10);
  clock.setTimeout(() => log.push('c@50'), 50);
  clock.setTimeout(() => { log.push('n@20'); clock.setTimeout(() => log.push('nested@25'), 5); }, 20);
  const dropped = clock.setTimeout(() => log.push('never'), 30);
  clock.clearTimeout(dropped);
  const ticks = clock.setInterval(() => log.push('i'), 40);
  assert.equal(clock.now(), 1000);
  clock.advance(60);
  assert.deepEqual(log, ['a@10', 'n@20', 'nested@25', 'i', 'b@50', 'c@50']);
  assert.equal(clock.now(), 1060);
  clock.clearInterval(ticks);
  clock.advance(1000);
  assert.equal(log.filter(entry => entry === 'i').length, 1);
  assert.equal(clock.pending, 0);
  assert.equal(clock.nextIn(), null);
  assert.equal(clock.tick(), false);
  clock.setTimeout(() => log.push('t'), 7);
  assert.equal(clock.nextIn(), 7);
  assert.equal(clock.tick(), true);
  assert.equal(log.at(-1), 't');
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.setTimeout('x', 1), TypeError);
});

test('fake clock: a timer handle survives unref and clearTimeout with the handle or its id', () => {
  const clock = createFakeClock();
  let fired = 0;
  const handle = clock.setTimeout(() => { fired += 1; }, 5);
  assert.equal(handle.unref(), handle);
  clock.clearTimeout(Number(handle));
  clock.advance(10);
  assert.equal(fired, 0);
});

test('fake server socket: records frames, buffers when frozen, closes asynchronously, refuses writes after close', async () => {
  const socket = createFakeSocket();
  const events = [];
  socket.on('close', (code, reason) => events.push(['close', code, reason.toString()]));
  socket.on('message', (data, binary) => events.push(['message', data.toString(), binary]));
  socket.send(JSON.stringify({ type: 'HELLO' }));
  socket.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(socket.frames, [{ type: 'HELLO' }]);
  assert.equal(socket.sent[1].binary, true);
  assert.equal(socket.framesOfType('HELLO').length, 1);
  socket.test.freeze();
  socket.send('x'.repeat(1000));
  assert.equal(socket.bufferedAmount, 1000);
  socket.test.thaw();
  assert.equal(socket.bufferedAmount, 0);
  socket.test.receive({ type: 'PING', t: 1 });
  socket.test.receive(Buffer.from([9]));
  assert.deepEqual(events, [['message', '{"type":"PING","t":1}', false], ['message', '\t', true]]);
  socket.close(4002, 'kicked');
  assert.equal(socket.readyState, 2);
  await Promise.resolve();
  assert.equal(socket.readyState, CLOSED);
  assert.deepEqual(events.at(-1), ['close', 4002, 'kicked']);
  assert.throws(() => socket.send('late'), /not open/);
  let reported = null;
  socket.send('late', error => { reported = error; });
  assert.ok(reported instanceof Error);
  const other = createFakeSocket();
  other.terminate();
  assert.equal(other.terminated, true);
  assert.equal(other.closed.code, 1006);
  assert.equal(OPEN, 1);
});

test('fake browser WebSocket class: constructor log, open/message/close events, listeners, close handshake', async () => {
  const FakeWebSocket = createFakeWebSocketClass();
  const ws = new FakeWebSocket('ws://x/__realm/ws?role=player', ['rf3', 'auth.a.b.c']);
  const seen = [];
  ws.onopen = () => seen.push('open');
  ws.addEventListener('message', event => seen.push(event.data));
  ws.onclose = event => seen.push(`close ${event.code}`);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(FakeWebSocket.log[0].protocols, ['rf3', 'auth.a.b.c']);
  assert.throws(() => ws.send('too early'), /not open/);
  ws.test.open();
  assert.equal(ws.protocol, 'rf3');
  ws.send('hello');
  ws.send(JSON.stringify({ type: 'PING' }));
  assert.deepEqual(ws.test.sentJson, [{ type: 'PING' }]);
  ws.test.serverSend({ type: 'HELLO' });
  ws.test.serverClose(4002, 'kicked');
  ws.test.serverSend('after close is ignored');
  assert.deepEqual(seen, ['open', '{"type":"HELLO"}', 'close 4002']);

  const auto = createFakeWebSocketClass({ autoOpen: true });
  const second = new auto('ws://y/');
  let opened = false;
  second.onopen = () => { opened = true; };
  await Promise.resolve();
  assert.equal(opened, true);
  second.close(1000, 'bye');
  await Promise.resolve();
  assert.equal(second.readyState, CLOSED);
});

test('fake socket pair: frames cross in order, with latency under a fake clock', () => {
  const clock = createFakeClock();
  const { client, server } = createSocketPair({ clock, latencyMs: 30 });
  const clientGot = [];
  const serverGot = [];
  client.onmessage = event => clientGot.push(event.data);
  server.on('message', data => serverGot.push(data.toString()));
  client.send('one'); client.send('two');
  server.send('A'); server.send('B');
  assert.deepEqual([clientGot, serverGot], [[], []]);
  clock.advance(29);
  assert.deepEqual([clientGot, serverGot], [[], []]);
  clock.advance(1);
  assert.deepEqual(clientGot, ['A', 'B']);
  assert.deepEqual(serverGot, ['one', 'two']);
  let closeCode = null;
  client.onclose = event => { closeCode = event.code; };
  server.close(4001, 'replaced');
  clock.advance(30);
  assert.equal(closeCode, 4001);
});

// ---------------------------------------------------------------------------------------------------------------------
// check-eol
// ---------------------------------------------------------------------------------------------------------------------

test('check-eol: classifies CRLF / LF / mixed / lone CR from bytes and knows the 7.10 lists', () => {
  assert.equal(styleOf(Buffer.from('a\r\nb\r\n')).style, 'crlf');
  assert.equal(styleOf(Buffer.from('a\nb\n')).style, 'lf');
  assert.equal(styleOf(Buffer.from('a\r\nb\n')).style, 'mixed');
  assert.equal(styleOf(Buffer.from('abc')).style, 'none');
  assert.equal(styleOf(Buffer.from('a\rb\n')).cr, 1);
  assert.equal(expectedStyle('src/App.jsx'), 'crlf');
  assert.equal(expectedStyle('src/gm/Header.jsx'), 'mixed');
  assert.equal(expectedStyle('src/net/protocol.js'), 'lf');
  assert.equal(expectedStyle('test-support/table.js'), 'lf');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'App.jsx'), 'a\nb\n');           // listed CRLF, now LF: violation
    fs.writeFileSync(path.join(dir, 'src', 'new.js'), 'a\r\nb\r\n');        // new file must be LF: violation
    fs.writeFileSync(path.join(dir, 'src', 'ok.js'), 'a\nb\n');
    assert.equal(checkFile('src/App.jsx', dir).ok, false);
    assert.equal(checkFile('src/new.js', dir).ok, false);
    assert.equal(checkFile('src/ok.js', dir).ok, true);
    assert.equal(checkFile('src/gone.js', dir).ok, true, 'a missing file is only noted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


// ---------------------------------------------------------------------------------------------------------------------
// Optional: the in-browser instruments (AudioWorklet tap, pitch beacons, forced sample rate). Needs Edge, ~25 s.
//   HARNESS_BROWSER=1 node --test test/harness.test.js
// ---------------------------------------------------------------------------------------------------------------------

test('browser self-test: the tap finds a planted 12 ms hole, sees the 44.1 kHz clicks, and the beacons measure delay', { skip: process.env.HARNESS_BROWSER !== '1' }, async () => {
  const { createServer } = await import('node:http');
  const { launch } = await import('../test-support/cdp.js');
  const { tapPageScript, createSineSource, summarizeTap } = await import('../test-support/signal.js');
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>tap</title>'); });
  await new Promise(resolve => server.listen(5298, '127.0.0.1', resolve));
  const browser = await launch();
  const scenario = (plantHole, seconds) => `(async () => {
    const createSineSource = ${createSineSource.toString()};
    const ctx = new AudioContext(); await ctx.resume();
    const gain = ctx.createGain();
    const source = createSineSource({ rate: 48000, freq: 440, amp: 0.5, beacon: { everyMs: 1500, lenMs: 60, hz: 880, firstMs: 1500 } });
    const FR = 4096, SR = 48000;
    const total = ${seconds} * SR / FR;
    const schedule = [];
    let next = ctx.currentTime + 0.5;
    for (let k = 0; k < total; k++) {
      const frames = source.next(FR);
      if (${plantHole} && k === 20) frames.fill(0, 1000, 1000 + 576); // 12 ms of digital silence
      const buffer = ctx.createBuffer(1, FR, SR); buffer.getChannelData(0).set(frames);
      const node = ctx.createBufferSource(); node.buffer = buffer; node.connect(gain); node.start(next);
      schedule.push([k * FR, next]);
      next += buffer.duration;
      if (k % 8 === 7) await new Promise(r => setTimeout(r, 400));
      if (k === 0) gain.connect(ctx.destination);
    }
    await new Promise(r => setTimeout(r, 1200 + Math.max(0, next - ctx.currentTime) * 1000));
    const nowAudio = ctx.currentTime, nowWall = Date.now();
    const beaconWalls = source.beaconStarts().map(sample => {
      const entry = schedule.find(e => sample >= e[0] && sample < e[0] + FR);
      return nowWall - (nowAudio - (entry[1] + (sample - entry[0]) / SR)) * 1000;
    });
    return JSON.stringify({ tap: window.__tap, beaconWalls, rate: ctx.sampleRate });
  })()`;
  const play = async (forceRate, plantHole, seconds) => {
    const page = await browser.page('http://localhost:5298/', tapPageScript({ forceRate }));
    await browser.waitFor(page, 'document.readyState === "complete"');
    return JSON.parse(await browser.eval(page, scenario(plantHole, seconds)));
  };
  try {
    // 1) 48 kHz context, one planted 12 ms hole
    const a = await play(0, true, 7);
    const sa = summarizeTap(a.tap, { seconds: 7, sourceBeaconWalls: a.beaconWalls });
    assert.equal(a.tap.error, null, 'tap installed');
    assert.equal(sa.dropouts, 1, JSON.stringify(sa));
    assert.ok(Math.abs(sa.dropoutMs[0] - 12) <= 1, 'planted 12 ms measured as ' + sa.dropoutMs[0]);
    // the hard edge where the hole ends shows up as one or two steps (the browser places a buffer at a fractional sample)
    assert.ok(sa.discontinuities <= 2, 'a 48 kHz context has no clicks of its own, only the edge of the planted hole: ' + JSON.stringify(a.tap.jumps));
    assert.ok(sa.latency && sa.latency.samples >= 2, 'beacons seen: ' + JSON.stringify(sa.latency));
    assert.ok(Math.abs(sa.latency.mean) < 200, 'beacon delay of a direct playout is small: ' + sa.latency.mean + ' ms');
    // 2) 44.1 kHz context: the forced rate is applied, and the old path clicks
    const b = await play(44100, false, 8);
    const sb = summarizeTap(b.tap, { seconds: 8 });
    assert.equal(b.rate, 44100);
    assert.ok(sb.discontinuities >= 3, 'clicks at 44.1 kHz: ' + sb.discontinuities);
  } finally {
    await browser.close();
    server.close();
  }
});
