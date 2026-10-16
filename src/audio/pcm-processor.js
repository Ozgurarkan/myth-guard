import { createAdpcmEncoder } from './pcm.js';

class PCMCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffers = [new Float32Array(4096), new Float32Array(4096)];
    this.offset = 0;
    // Every packet carries a sequence number and the sample index of its first frame (RFA3), so listeners can
    // detect gaps, drop late or duplicate packets and measure jitter.
    // A rebuilt encoder carries on from the numbers of the one it replaces (wsSender passes them in), so the listeners see no restart.
    const start = options?.processorOptions ?? {};
    this.seq = (start.seq ?? 0) >>> 0;
    this.samples = (start.samples ?? 0) >>> 0;
    // 4-bit ADPCM sends a quarter of the data of raw PCM — the difference
    // between a busy Wi-Fi network coping and stuttering with several players.
    this.encoder = createAdpcmEncoder();
  }
  process(inputs) {
    const input = inputs[0];
    if (!input?.length) return true;
    for (let frame = 0; frame < input[0].length; frame++) {
      this.buffers[0][this.offset] = input[0][frame];
      this.buffers[1][this.offset] = (input[1] ?? input[0])[frame];
      if (++this.offset === 4096) {
        const packet = this.encoder.encode(this.buffers, sampleRate, { seq: this.seq, ts: this.samples });
        this.seq = (this.seq + 1) >>> 0;
        this.samples = (this.samples + 4096) >>> 0;
        this.port.postMessage(packet, [packet]);
        this.offset = 0;
      }
    }
    // Output remains silent; the captured PC audio already plays locally.
    return true;
  }
}
registerProcessor('realm-forge-pcm', PCMCapture);
