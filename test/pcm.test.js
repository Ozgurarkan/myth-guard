import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePCM, readPCM, createAdpcmEncoder, decodeAudioPacket, readAudioPacket, peekRfa3, withFlags, seqDiff, RFA3_HEADER,
} from '../src/audio/pcm.js';

// The five codec tests below are the ones from test/audio.test.js, moved here with their assertions unchanged.

function tone(frames, offset = 0, hz = 440, amplitude = 0.5, rate = 48000) {
  return Float32Array.from({ length: frames }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * (i + offset)) / rate));
}
const snr = (original, decoded) => {
  let signal = 0, noise = 0;
  for (let i = 0; i < original.length; i++) { signal += original[i] ** 2; noise += (original[i] - decoded[i]) ** 2; }
  return 10 * Math.log10(signal / Math.max(noise, 1e-12));
};

test('PCM preserves stereo samples, clips peaks, and rejects malformed packets', () => {
  const packet = encodePCM([new Float32Array([-2, -0.5, 0, 0.5, 2]), new Float32Array([1, 0, -1, 0, 1])], 48000);
  const pcm = readPCM(packet);
  assert.equal(pcm.sampleRate, 48000);
  assert.equal(pcm.channels, 2);
  assert.equal(pcm.frames, 5);
  assert.equal(pcm.view.getInt16(12, true), -32768);
  assert.equal(pcm.view.getInt16(14, true), 32767);
  assert.equal(pcm.view.getInt16(16, true), -16384);
  assert.equal(readPCM(packet.slice(0, -1)), null);
  assert.equal(readPCM(new ArrayBuffer(0)), null);
  new DataView(packet).setUint16(8, 3);
  assert.equal(readPCM(packet), null);
});

test('ADPCM packets are a quarter of the size of PCM and decode back to clean audio', () => {
  const encoder = createAdpcmEncoder();
  const left = tone(4096), right = tone(4096, 0, 660);
  const packet = encoder.encode([left, right], 48000);
  assert.equal(packet.byteLength, 12 + 8 + 4096, 'about 4 KB instead of 16 KB');
  assert.ok(packet.byteLength < encodePCM([left, right], 48000).byteLength / 3.9);
  assert.deepEqual(readAudioPacket(packet), { format: 'adpcm', sampleRate: 48000, channels: 2, frames: 4096 });
  const decoded = decodeAudioPacket(packet);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.data[0].length, 4096);
  assert.ok(snr(left.subarray(256), decoded.data[0].subarray(256)) > 25, 'left channel stays clean');
  assert.ok(snr(right.subarray(256), decoded.data[1].subarray(256)) > 25, 'right channel stays clean');
});

test('ADPCM packets are independent: a lost packet does not corrupt the next', () => {
  const encoder = createAdpcmEncoder();
  const packets = [0, 1, 2, 3].map(n => ({ n, packet: encoder.encode([tone(2048, n * 2048), tone(2048, n * 2048)], 48000) }));
  // Packets 1 and 2 never arrive; 3 must still decode as if the stream were intact.
  const intact = decodeAudioPacket(packets[3].packet);
  const afterLoss = decodeAudioPacket(packets[3].packet);
  assert.deepEqual(intact.data[0], afterLoss.data[0]);
  assert.ok(snr(tone(1792, 3 * 2048 + 256), intact.data[0].subarray(256)) > 25);
});

test('mono, odd lengths, silence and clipping survive ADPCM', () => {
  const encoder = createAdpcmEncoder();
  const loud = Float32Array.from({ length: 1001 }, (_, i) => (i % 2 ? 3 : -3));
  const decoded = decodeAudioPacket(encoder.encode([loud], 44100));
  assert.equal(decoded.sampleRate, 44100);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.frames, 1001);
  assert.ok(decoded.data[0].every(sample => sample >= -1 && sample <= 1));
  const silence = decodeAudioPacket(createAdpcmEncoder().encode([new Float32Array(512), new Float32Array(512)], 48000));
  assert.ok(silence.data[0].every(sample => Math.abs(sample) < 0.01));
});

test('both audio formats decode, and malformed ADPCM is rejected', () => {
  const pcm = encodePCM([new Float32Array([0.5, -0.5, 0.25])], 48000);
  assert.ok(Math.abs(decodeAudioPacket(pcm).data[0][0] - 0.5) < 0.001);
  const packet = createAdpcmEncoder().encode([tone(100), tone(100)], 48000);
  assert.ok(decodeAudioPacket(packet));
  assert.equal(readAudioPacket(packet.slice(0, -1)), null);
  assert.equal(readAudioPacket(new ArrayBuffer(11)), null);
  const bad = packet.slice(0);
  new DataView(bad).setUint8(14, 200); // step index out of range
  assert.equal(readAudioPacket(bad), null);
  const wrongMagic = packet.slice(0);
  new DataView(wrongMagic).setUint32(0, 1234);
  assert.equal(readAudioPacket(wrongMagic), null);
});

// ---- RFA3: sequence number, timestamp and flags (design 5.4) ---------------------------------------------------------

test('RFA3 carries seq, ts, rate, channels, frames and flags, and decodes to the same audio as RFA2', () => {
  const left = tone(4096), right = tone(4096, 0, 660);
  const v2 = createAdpcmEncoder().encode([left, right], 48000);
  const v3 = createAdpcmEncoder().encode([left, right], 48000, { seq: 1234, ts: 5_000_000 });
  assert.equal(v3.byteLength, v2.byteLength + 8, 'only the 8-byte header grows');
  assert.equal(v3.byteLength, RFA3_HEADER + 8 + 4096);
  assert.equal(new TextDecoder().decode(v3.slice(0, 4)), 'RFA3');
  assert.deepEqual(readAudioPacket(v3), { format: 'adpcm', version: 3, sampleRate: 48000, channels: 2, frames: 4096, seq: 1234, ts: 5_000_000, flags: 0 });
  const a = decodeAudioPacket(v2), b = decodeAudioPacket(v3);
  assert.deepEqual(b.data[0], a.data[0]);
  assert.deepEqual(b.data[1], a.data[1]);
  assert.equal(b.seq, 1234);
  assert.equal(b.ts, 5_000_000);
  assert.deepEqual(peekRfa3(new Uint8Array(v3)), { seq: 1234, ts: 5_000_000, sampleRate: 48000, channels: 2, frames: 4096, flags: 0 });
});

test('RFA2 packets still decode and are not mistaken for RFA3', () => {
  const v2 = createAdpcmEncoder().encode([tone(512)], 48000);
  assert.equal(readAudioPacket(v2).version, undefined);
  assert.ok(decodeAudioPacket(v2));
  assert.equal(peekRfa3(new Uint8Array(v2)), null);
});

test('RFA3 packets stay independent and the encoder state carries on across numbered packets', () => {
  const encoder = createAdpcmEncoder();
  const packets = [0, 1, 2, 3].map(n => encoder.encode([tone(2048, n * 2048)], 48000, { seq: n, ts: n * 2048 }));
  const alone = decodeAudioPacket(packets[3]);
  assert.ok(snr(tone(1792, 3 * 2048 + 256), alone.data[0].subarray(256)) > 25, 'packet 3 decodes without 0-2');
});

test('RFA3 seq and ts wrap modulo 2^32, and seqDiff orders across the wrap', () => {
  const encoder = createAdpcmEncoder();
  const packet = encoder.encode([tone(64)], 48000, { seq: 2 ** 32 + 5, ts: 2 ** 32 + 7 });
  const info = readAudioPacket(packet);
  assert.equal(info.seq, 5);
  assert.equal(info.ts, 7);
  assert.equal(seqDiff(3, 0xfffffffe), 5, 'seq 3 is 5 after 0xfffffffe');
  assert.equal(seqDiff(0xfffffffe, 3), -5);
  assert.equal(seqDiff(10, 10), 0);
});

test('RFA3 rejects truncated, oversized, and corrupt packets', () => {
  const packet = createAdpcmEncoder().encode([tone(100), tone(100)], 48000, { seq: 1, ts: 0 });
  assert.ok(readAudioPacket(packet));
  assert.equal(readAudioPacket(packet.slice(0, -1)), null);
  assert.equal(readAudioPacket(packet.slice(0, RFA3_HEADER + 2)), null);
  const badIndex = packet.slice(0);
  new DataView(badIndex).setUint8(RFA3_HEADER + 2, 200);
  assert.equal(readAudioPacket(badIndex), null);
  const badChannels = packet.slice(0);
  new DataView(badChannels).setUint8(16, 3);
  assert.equal(readAudioPacket(badChannels), null);
  const badFrames = packet.slice(0);
  new DataView(badFrames).setUint16(18, 0);
  assert.equal(readAudioPacket(badFrames), null);
  assert.equal(peekRfa3(new Uint8Array(packet.slice(0, 10))), null);
  assert.equal(peekRfa3(null), null);
});

test('withFlags copies the packet and only changes the flags byte', () => {
  const packet = new Uint8Array(createAdpcmEncoder().encode([tone(256)], 48000, { seq: 9, ts: 99 }));
  const flagged = withFlags(packet, 7);
  assert.notEqual(flagged, packet);
  assert.equal(packet[17], 0, 'the original is untouched');
  assert.equal(flagged[17], 7);
  assert.equal(peekRfa3(flagged).flags, 7);
  assert.deepEqual([...flagged.slice(0, 17)], [...packet.slice(0, 17)]);
  assert.deepEqual([...flagged.slice(18)], [...packet.slice(18)]);
  assert.equal(withFlags(packet, 9999)[17], 255, 'saturates');
  assert.equal(withFlags(packet, -4)[17], 0);
  assert.deepEqual(decodeAudioPacket(flagged.buffer).data[0], decodeAudioPacket(packet.buffer).data[0]);
});
