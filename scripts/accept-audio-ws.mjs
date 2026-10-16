#!/usr/bin/env node
/**
 * Audio acceptance, FALLBACK path (hardened ADPCM over WebSocket), design 5.9 / 6.5.
 * The real built app in headless Edge: GM page broadcasting a test tone, a phone page without RTCPeerConnection (so the
 * fallback is used), a strict-FIFO TCP proxy (test-support/tcpImpair.js) between the phone and the server on port 5298,
 * and an AudioWorklet tap that measures dropouts (silence >= 10 ms), discontinuities (jump > 0.12) and pitch-beacon delay.
 *
 *   node scripts/accept-audio-ws.mjs                 clean good busy bad jitter80 stall300 stall700 stall1000 wifi roam jank1200 rate44100 (60 s each)
 *   node scripts/accept-audio-ws.mjs stall1000 --seconds 30
 *   node scripts/accept-audio-ws.mjs --quick         20 s per profile
 *   profiles: those of test-support/profiles.js, jank<ms> (the phone page freezes for <ms> at 10 s), rate<hz> (AudioContext forced to 32000/44100/48000/96000)
 *
 * Needs a built dist/ (it rebuilds when src/ is newer), Microsoft Edge, and the new server. Takes about 12 minutes for the default set.
 */
import { main } from '../test-support/audioRun.js';

await main('ws', ['clean', 'good', 'busy', 'bad', 'jitter80', 'stall300', 'stall700', 'stall1000', 'wifi', 'roam', 'jank1200', 'rate44100']);
