// Audio packets for the player broadcast.
//
// Three formats share the wire so older GM windows keep working:
//   "NCGA"  raw 16-bit stereo PCM          (1.5 Mbit/s per listener at 48 kHz)
//   "RFA2"  IMA ADPCM, 4 bits per sample   (0.38 Mbit/s per listener at 48 kHz); still decoded for one release
//   "RFA3"  RFA2 plus a sequence number, a sample timestamp and a flags byte (design 5.4). Layout, big endian:
//             0 magic(4)  4 seq(u32)  8 ts(u32: sample index at 48 kHz of the first frame)  12 rate(u32)
//             16 channels(u8)  17 flags(u8: packets the relay skipped just before this one, saturating)  18 frames(u16)
//             20 per channel: predictor(i16) index(u8) pad(u8)   then the 4-bit ADPCM data
//           The sequence number is what lets a receiver notice a gap, drop a late or duplicate packet and measure jitter.
//
// Every packet is self-contained — ADPCM packets carry the codec state they
// start from — so a dropped or late packet never corrupts the ones after it and
// listeners can join a running broadcast at any packet boundary.
const MAGIC_PCM = 0x4e434741;
const MAGIC_ADPCM = 0x52464132;
const MAGIC_ADPCM3 = 0x52464133;
const MAX_FRAMES = 8192;
/** Bytes before the per-channel codec state in an RFA3 packet. */
export const RFA3_HEADER = 20;

// ── Raw PCM ──────────────────────────────────────────────────────────────────
export function encodePCM(channels, sampleRate) {
  const frames = channels[0].length;
  const packet = new ArrayBuffer(12 + frames * channels.length * 2);
  const view = new DataView(packet);
  view.setUint32(0, MAGIC_PCM);
  view.setUint32(4, sampleRate);
  view.setUint16(8, channels.length);
  view.setUint16(10, frames);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(12 + (frame * channels.length + channel) * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return packet;
}

export function readPCM(packet) {
  if (!(packet instanceof ArrayBuffer) || packet.byteLength < 12) return null;
  const view = new DataView(packet);
  const sampleRate = view.getUint32(4);
  const channels = view.getUint16(8);
  const frames = view.getUint16(10);
  if (view.getUint32(0) !== MAGIC_PCM || sampleRate < 8000 || sampleRate > 192000 ||
      channels < 1 || channels > 2 || frames < 1 || frames > MAX_FRAMES ||
      packet.byteLength !== 12 + frames * channels * 2) return null;
  return { view, sampleRate, channels, frames };
}

// ── IMA ADPCM ────────────────────────────────────────────────────────────────
const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];
const clamp16 = value => (value > 32767 ? 32767 : value < -32768 ? -32768 : value);
const clampIndex = value => (value > 88 ? 88 : value < 0 ? 0 : value);

/** Advance the predictor by one 4-bit code; shared by encoder and decoder. */
function advance(state, code) {
  const step = STEPS[state.index];
  let delta = step >> 3;
  if (code & 4) delta += step;
  if (code & 2) delta += step >> 1;
  if (code & 1) delta += step >> 2;
  state.predictor = clamp16(state.predictor + (code & 8 ? -delta : delta));
  state.index = clampIndex(state.index + INDEX_SHIFT[code & 7]);
}

function quantize(sample, state) {
  const step = STEPS[state.index];
  let diff = sample - state.predictor;
  let code = 0;
  if (diff < 0) { code = 8; diff = -diff; }
  if (diff >= step) { code |= 4; diff -= step; }
  if (diff >= step >> 1) { code |= 2; diff -= step >> 1; }
  if (diff >= step >> 2) code |= 1;
  advance(state, code);
  return code;
}

/**
 * Stateful encoder: keeps the codec state between packets so the stream
 * stays smooth, while still writing that state into each packet header.
 */
export function createAdpcmEncoder() {
  const states = [];
  return {
    /**
     * Without `meta` this writes the original RFA2 packet. With `meta = { seq, ts }` it writes RFA3
     * (seq and ts are taken modulo 2^32).
     */
    encode(channels, sampleRate, meta) {
      const count = channels.length;
      const frames = channels[0].length;
      while (states.length < count) states.push({ predictor: 0, index: 0 });
      const dataBytes = Math.ceil((frames * count) / 2);
      const v3 = meta != null;
      const head = v3 ? RFA3_HEADER : 12;
      const packet = new ArrayBuffer(head + 4 * count + dataBytes);
      const view = new DataView(packet);
      const bytes = new Uint8Array(packet);
      if (v3) {
        view.setUint32(0, MAGIC_ADPCM3);
        view.setUint32(4, meta.seq >>> 0);
        view.setUint32(8, (meta.ts ?? 0) >>> 0);
        view.setUint32(12, sampleRate);
        view.setUint8(16, count);
        view.setUint8(17, 0);
        view.setUint16(18, frames);
      } else {
        view.setUint32(0, MAGIC_ADPCM);
        view.setUint32(4, sampleRate);
        view.setUint8(8, count);
        view.setUint16(10, frames);
      }
      for (let channel = 0; channel < count; channel++) {
        view.setInt16(head + channel * 4, states[channel].predictor);
        view.setUint8(head + 2 + channel * 4, states[channel].index);
      }
      const base = head + 4 * count;
      let nibble = 0;
      for (let frame = 0; frame < frames; frame++) {
        for (let channel = 0; channel < count; channel++) {
          const input = Math.max(-1, Math.min(1, channels[channel][frame]));
          const code = quantize(Math.round(input * (input < 0 ? 32768 : 32767)), states[channel]);
          const at = base + (nibble >> 1);
          bytes[at] = nibble & 1 ? bytes[at] | (code << 4) : code;
          nibble++;
        }
      }
      return packet;
    },
  };
}

/** Header-only validation, used by the relay before it forwards anything. */
export function readAudioPacket(packet) {
  if (!(packet instanceof ArrayBuffer) || packet.byteLength < 12) return null;
  const view = new DataView(packet);
  const magic = view.getUint32(0);
  if (magic === MAGIC_PCM) {
    const pcm = readPCM(packet);
    return pcm && { format: 'pcm', sampleRate: pcm.sampleRate, channels: pcm.channels, frames: pcm.frames };
  }
  if (magic === MAGIC_ADPCM3) {
    if (packet.byteLength < RFA3_HEADER + 4) return null;
    const sampleRate = view.getUint32(12);
    const channels = view.getUint8(16);
    const frames = view.getUint16(18);
    if (sampleRate < 8000 || sampleRate > 192000 || channels < 1 || channels > 2 ||
        frames < 1 || frames > MAX_FRAMES ||
        packet.byteLength !== RFA3_HEADER + 4 * channels + Math.ceil((frames * channels) / 2)) return null;
    for (let channel = 0; channel < channels; channel++) {
      if (view.getUint8(RFA3_HEADER + 2 + channel * 4) > 88) return null;
    }
    return { format: 'adpcm', version: 3, sampleRate, channels, frames,
      seq: view.getUint32(4), ts: view.getUint32(8), flags: view.getUint8(17) };
  }
  if (magic !== MAGIC_ADPCM) return null;
  const sampleRate = view.getUint32(4);
  const channels = view.getUint8(8);
  const frames = view.getUint16(10);
  if (sampleRate < 8000 || sampleRate > 192000 || channels < 1 || channels > 2 ||
      frames < 1 || frames > MAX_FRAMES ||
      packet.byteLength !== 12 + 4 * channels + Math.ceil((frames * channels) / 2)) return null;
  for (let channel = 0; channel < channels; channel++) {
    if (view.getUint8(14 + channel * 4) > 88) return null;
  }
  return { format: 'adpcm', sampleRate, channels, frames };
}

/** Decode either format to Float32 channel arrays, or `null` if malformed. */
export function decodeAudioPacket(packet) {
  const info = readAudioPacket(packet);
  if (!info) return null;
  const { channels, frames, sampleRate } = info;
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  const view = new DataView(packet);
  if (info.format === 'pcm') {
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        data[channel][frame] = view.getInt16(12 + (frame * channels + channel) * 2, true) / 32768;
      }
    }
    return { sampleRate, channels, frames, data };
  }
  const bytes = new Uint8Array(packet);
  const head = info.version === 3 ? RFA3_HEADER : 12;
  const states = Array.from({ length: channels }, (_, channel) => ({
    predictor: view.getInt16(head + channel * 4), index: view.getUint8(head + 2 + channel * 4),
  }));
  const base = head + 4 * channels;
  let nibble = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const byte = bytes[base + (nibble >> 1)];
      advance(states[channel], nibble & 1 ? byte >> 4 : byte & 15);
      data[channel][frame] = states[channel].predictor / 32768;
      nibble++;
    }
  }
  return info.version === 3
    ? { sampleRate, channels, frames, data, seq: info.seq, ts: info.ts, flags: info.flags }
    : { sampleRate, channels, frames, data };
}

// ── RFA3 helpers for the relay (they work on bytes without copying the audio) ────────────────────────────────────────
/** Header of an RFA3 packet held in a Uint8Array/Buffer, or null. Cheap: nothing is decoded. */
export function peekRfa3(bytes) {
  if (!bytes || bytes.byteLength < RFA3_HEADER + 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== MAGIC_ADPCM3) return null;
  const sampleRate = view.getUint32(12);
  const channels = view.getUint8(16);
  const frames = view.getUint16(18);
  if (sampleRate < 8000 || sampleRate > 192000 || channels < 1 || channels > 2 || frames < 1 || frames > MAX_FRAMES ||
      bytes.byteLength !== RFA3_HEADER + 4 * channels + Math.ceil((frames * channels) / 2)) return null;
  for (let channel = 0; channel < channels; channel++) {
    if (view.getUint8(RFA3_HEADER + 2 + channel * 4) > 88) return null;
  }
  return { seq: view.getUint32(4), ts: view.getUint32(8), sampleRate, channels, frames, flags: view.getUint8(17) };
}

/** A copy of an RFA3 packet with the flags byte (skipped-packet count, 0-255) replaced. */
export function withFlags(bytes, flags) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  copy[17] = Math.max(0, Math.min(255, flags | 0));
  return copy;
}

/** Signed distance from sequence number `b` to `a` with wrap-around (positive: `a` is newer). */
export const seqDiff = (a, b) => (a - b) | 0;
