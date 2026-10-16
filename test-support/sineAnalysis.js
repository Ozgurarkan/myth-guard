// Offline analysis of a recorded steady sine wave (the audio acceptance signal, design 5.6 / 5.9).
//
//  dropout        digital silence (|x| < silenceEps) of at least `minDropoutMs` BETWEEN two stretches of sound.
//                 (Leading and trailing silence is not a dropout.) Shorter silences of at least `minHoleMs` are listed as `holes`.
//  discontinuity  a jump between neighbouring samples larger than `jumpThreshold` (the sine's own largest step is
//                 amp * 2*pi*freq/rate = 0.03 for 0.5 at 440 Hz / 48 kHz; the threshold is 0.12).
//  phase jump     the phase of the tone, fitted block by block, steps by more than `phaseThresholdRad` between two
//                 non-overlapping blocks. This sees phase steps that are too small to show up as a sample jump
//                 (a jump near the sine's crest) and tells a hole from a slip.
//
// The same thresholds are used by the AudioWorklet tap in signal.js, which does the first two online in the browser.

/** x(n) = amp * sin(2*pi*freq*n/rate + phase) as a Float32Array. */
export function makeSine({ seconds = 1, rate = 48000, freq = 440, amp = 0.5, phase = 0, startSample = 0 } = {}) {
  const length = Math.round(seconds * rate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * (startSample + i)) / rate + phase);
  return out;
}

const wrap = angle => {
  let a = angle % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

export function analyzeSine(samples, {
  rate = 48000, freq = 440, amp = 0.5,
  silenceEps = 1e-4, minHoleMs = 0.4, minDropoutMs = 10,
  jumpThreshold = 0.12, phaseThresholdRad = 0.25, blockMs = 2.5, phaseTracking = true,
} = {}) {
  const ms = index => (index / rate) * 1000;
  const minHole = Math.max(1, Math.round((minHoleMs / 1000) * rate));
  const holes = [];
  const discontinuities = [];
  let run = 0;
  let seen = false;
  let previous = null;

  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i];
    if (Math.abs(v) < silenceEps) {
      run += 1;
    } else {
      if (seen && run >= minHole) holes.push({ atMs: ms(i - run), ms: ms(run), startSample: i - run, samples: run });
      run = 0;
      seen = true;
      if (previous !== null && Math.abs(v - previous) > jumpThreshold) discontinuities.push({ atMs: ms(i), size: Math.abs(v - previous), sample: i });
    }
    previous = v;
  }
  const dropouts = holes.filter(hole => hole.ms >= minDropoutMs);

  const phaseJumps = [];
  if (phaseTracking) {
    const block = Math.max(16, Math.round((blockMs / 1000) * rate));
    const hop = Math.max(1, block >> 1);
    const w = (2 * Math.PI * freq) / rate;
    const fits = [];
    for (let start = 0; start + block <= samples.length; start += hop) {
      let cc = 0, ss = 0, cs = 0, xc = 0, xs = 0;
      for (let n = start; n < start + block; n += 1) {
        const c = Math.cos(w * n), s = Math.sin(w * n), x = samples[n];
        cc += c * c; ss += s * s; cs += c * s; xc += x * c; xs += x * s;
      }
      const det = cc * ss - cs * cs;
      const a = (xc * ss - xs * cs) / det;
      const b = (xs * cc - xc * cs) / det;
      const amplitude = Math.hypot(a, b);
      // x = a cos + b sin = A cos(wn + phi) with phi = atan2(-b, a)
      fits.push({ start, amplitude, phi: Math.atan2(-b, a), valid: Math.abs(amplitude - amp) < 0.25 * amp });
    }
    // Compare block k with block k+3: a gap of one hop lies between them, so a step at any position falls into the gap
    // of some pair and is seen whole by that pair (pairs that see it partly report less; we keep the largest).
    let open = null;
    for (let k = 0; k + 3 < fits.length; k += 1) {
      const first = fits[k], second = fits[k + 3];
      // A silence between the two blocks is reported as a hole; do not report it a second time as a phase step.
      const end = second.start + block;
      const holeBetween = holes.some(hole => hole.startSample < end && hole.startSample + hole.samples > first.start);
      const flagged = first.valid && second.valid && !holeBetween && Math.abs(wrap(second.phi - first.phi)) > phaseThresholdRad;
      if (flagged) {
        const delta = wrap(second.phi - first.phi);
        if (open && k - open.lastK <= 1) { open.lastK = k; if (Math.abs(delta) > Math.abs(open.rad)) open.rad = delta; } else {
          if (open) phaseJumps.push(finish(open));
          open = { firstK: k, lastK: k, rad: delta, atSample: first.start + block };
        }
      } else if (open && k - open.lastK > 1) { phaseJumps.push(finish(open)); open = null; }
    }
    if (open) phaseJumps.push(finish(open));
    function finish(event) {
      return { atMs: ms(event.atSample), rad: event.rad, samples: (event.rad / w) * -1 };
    }
  }

  return {
    rate, samples: samples.length, seconds: samples.length / rate,
    holes, dropouts, discontinuities, phaseJumps,
    totalDropoutMs: dropouts.reduce((sum, hole) => sum + hole.ms, 0),
    maxStep: maxStep(samples),
  };
}

function maxStep(samples) {
  let max = 0;
  for (let i = 1; i < samples.length; i += 1) max = Math.max(max, Math.abs(samples[i] - samples[i - 1]));
  return max;
}

/** What the plain pass criteria of 5.9 ask: dropouts and discontinuities per minute. */
export function perMinute(count, seconds) { return seconds > 0 ? (count * 60) / seconds : 0; }
