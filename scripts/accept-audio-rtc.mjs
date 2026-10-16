#!/usr/bin/env node
/**
 * Audio acceptance, PRIMARY path (WebRTC / Opus), design 5.9 / 6.5.
 * The real built app in headless Edge: GM page broadcasting a test tone (the harness replaces getDisplayMedia), a phone page,
 * and a UDP relay (test-support/udpImpair.js) that all media is forced through. Measured with the AudioWorklet tap on the
 * phone's <audio> stream (dropouts >= 10 ms, discontinuities > 0.12, pitch-beacon delay) and with getStats().
 *
 *   node scripts/accept-audio-rtc.mjs                 clean good busy bad jitter80 stall300 stall700 stall1000 drop400 wifi roam icefail (60 s each)
 *   node scripts/accept-audio-rtc.mjs wifi --seconds 30
 *   node scripts/accept-audio-rtc.mjs --quick         20 s per profile
 *   profiles: those of test-support/profiles.js (UDP model), icefail (UDP blocked: fallback audible within 8 s)
 *
 * The 8-listener CPU criterion needs eight phones; it is the `cpu8` profile: node scripts/accept-audio-rtc.mjs cpu8 (see below).
 * Needs a built dist/, Microsoft Edge and the new server.
 */
import { main } from '../test-support/audioRun.js';

await main('rtc', ['clean', 'good', 'busy', 'bad', 'jitter80', 'stall300', 'stall700', 'stall1000', 'drop400', 'wifi', 'roam', 'icefail']);
