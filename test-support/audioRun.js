// One audio acceptance run in Edge: the REAL built app (GM page + a phone page) on the REAL server, a test tone instead of PC
// capture, an impaired network in between, and the AudioWorklet tap measuring what comes out (design 5.6, 5.9, 6.5).
// Shared by scripts/accept-audio-ws.mjs (fallback path) and scripts/accept-audio-rtc.mjs (WebRTC path).
//
// Everything that depends on the UI lives in UI below: if a label or id changes, change it here and nowhere else.
import { createTcpImpair } from './tcpImpair.js';
import { createUdpRelay } from './udpImpair.js';
import { applyProfile } from './profiles.js';
import { fakeCaptureScript, rtcPageScript, summarizeTap, tapPageScript } from './signal.js';
import { launch, sleep } from './cdp.js';
import { ServerUnavailable, ensureBuilt, fetchInvite, startSiteServer } from './table.js';

export const UI = {
  gmSoundTab: `document.getElementById('workspace-tab-sound')?.click()`,
  gmBroadcastButton: /Broadcast PC audio/i,
  gmDeviceCheckbox: '[data-device-id] input[type="checkbox"]',
  playerNameInput: 'input[placeholder*="name" i]',
  playerJoinButton: /take your seat|join|enter|save/i,
  playerPageReady: `Boolean(document.querySelector('.player-page'))`,
  playerTapPill: /tap to hear/i,
};

const TARGET_MS = { ws: 900, rtc: 800 };       // the receivers' default delay targets (5.2, 5.4)
export const PROXY_PORT = 5298;                 // the only port this harness listens on besides the server's own free port

/** The pass rules of design 5.9. -> { pass, reasons[] } */
export function judge(mode, profile, s, extra = {}) {
  const reasons = [];
  const fail = text => reasons.push(text);
  const strict = ['clean', 'good', 'busy', 'bad', 'jitter80', 'stall300', 'stall700', 'stall1000', 'drop400'];
  const target = TARGET_MS[mode];
  const last = s.latency?.last;
  const recovered = last === undefined || last <= target + (mode === 'ws' ? 150 : 300) + 150; // + the capture/send path
  if (!s.available) { fail(`tap unavailable: ${s.error ?? 'no signal measured'}`); return { pass: false, reasons }; }
  if (strict.includes(profile) && s.dropouts > 0) fail(`${s.dropouts} dropout(s) ${JSON.stringify(s.dropoutMs)} ms, expected 0`);
  if (profile.startsWith('jank')) {
    if (s.dropouts > 1) fail(`${s.dropouts} dropouts after a frozen page`);
  }
  if (profile === 'wifi' && (s.dropouts > 1 || Math.max(0, ...s.dropoutMs) > (mode === 'rtc' ? 300 : 1300))) fail(`wifi: ${s.dropouts} dropouts ${JSON.stringify(s.dropoutMs)} ms`);
  if (profile === 'wifi' && mode === 'rtc' && s.latency && s.latency.mean > 1000) fail(`wifi: mean delay ${s.latency.mean} ms > 1000`);
  if (profile === 'roam' && (s.dropouts > 1 || Math.max(0, ...s.dropoutMs) > (mode === 'rtc' ? 2500 : 3000))) fail(`roam: ${s.dropouts} dropouts ${JSON.stringify(s.dropoutMs)} ms`);
  if (s.discontinuitiesPerMinute > 1 && !profile.startsWith('jank')) fail(`${s.discontinuities} discontinuities (${s.discontinuitiesPerMinute}/min), expected <= 1/min`);
  if (/^rate/.test(profile) && (s.discontinuities > 0 || s.dropouts > 0)) fail(`forced ${profile}: ${s.discontinuities} discontinuities, ${s.dropouts} dropouts, expected 0`);
  if (!recovered) fail(`delay did not come back: last beacon ${last} ms (target ${target} ms)`);
  if (mode === 'rtc' && profile === 'bad' && extra.concealedPct > 8) fail(`concealed ${extra.concealedPct} % > 8 %`);
  if (!s.latency && !/^rate/.test(profile)) fail('no beacon was heard: the sound never arrived or the tap did not see it');
  return { pass: reasons.length === 0, reasons };
}

async function openGm(browser, base, relay) {
  const setup = fakeCaptureScript({ beacon: { everyMs: 5000, lenMs: 60, hz: 880, count: 60, firstMs: 3000 } }) + (relay ? rtcPageScript({ role: 'gm', relay }) : '');
  const gm = await browser.page(`http://localhost:${new URL(base).port}/`, setup);
  await browser.waitFor(gm, `document.readyState === 'complete' && Boolean(document.getElementById('workspace-tab-sound'))`, 20000, 'the GM screen with its Sound tab');
  await browser.eval(gm, UI.gmSoundTab);
  await browser.waitFor(gm, `[...document.querySelectorAll('button')].some(b => /Broadcast PC audio/i.test(b.textContent) && !b.disabled)`, 15000, 'the "Broadcast PC audio" button to be enabled').catch(error => { throw new Error(`${error.message}. The GM screen could not reach the server for audio (is the app wired to the new network stack?). Page problems: ${browser.problems(gm).slice(0, 4).join(' | ') || 'none'}`); });
  return gm;
}

async function openPlayer(browser, origin, secret, name, setup) {
  const page = await browser.page(`${origin}/player.html${secret ? `#join=${secret}` : ''}`, setup);
  await browser.waitFor(page, `document.readyState === 'complete'`, 20000, 'the player page');
  // the join gate asks for a name
  const gate = await browser.eval(page, `Boolean(document.querySelector(${JSON.stringify(UI.playerNameInput)}))`).catch(() => false);
  if (gate || await browser.waitFor(page, `Boolean(document.querySelector(${JSON.stringify(UI.playerNameInput)}))`, 8000).catch(() => false)) {
    await browser.eval(page, `(() => {
      const input = document.querySelector(${JSON.stringify(UI.playerNameInput)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(100);
    await browser.click(page, UI.playerJoinButton);
  }
  await browser.waitFor(page, UI.playerPageReady, 20000, 'the player screen (joined)');
  return page;
}

/** Tick every unticked "who hears it" box on the GM screen. */
async function selectAllDevices(browser, gm, count = 1) {
  await browser.waitFor(gm, `document.querySelectorAll(${JSON.stringify(UI.gmDeviceCheckbox)}).length >= ${count}`, 20000, `${count} device row(s) in the Sound panel`);
  await browser.eval(gm, `[...document.querySelectorAll(${JSON.stringify(UI.gmDeviceCheckbox)})].forEach(i => { if (!i.checked) i.click(); })`);
}

const tapNow = (browser, page) => browser.eval(page, `JSON.stringify(window.__tap)`).then(JSON.parse);

/**
 * @param {object} options
 *   mode 'ws' | 'rtc';  profile name from profiles.js or one of: jank<ms>, rate<hz>, icefail
 *   seconds measured window (default 60);  browser  an open cdp.js browser;  site  a startSiteServer() result
 * @returns {Promise<{ profile, mode, summary, verdict, rtc? }>}
 */
export async function runAudioProfile({ mode, profile, seconds = 60, browser, site, log = () => {} }) {
  const forceRate = Number(/^rate(\d+)$/.exec(profile)?.[1] ?? 0);
  const jankMs = Number(/^jank(\d+)$/.exec(profile)?.[1] ?? 0);
  const netProfile = forceRate || jankMs || profile === 'icefail' ? 'clean' : profile;
  const relay = mode === 'rtc' ? await createUdpRelay().ready() : null;
  const relayHint = relay && { host: '127.0.0.1', gmFacingPort: relay.gmFacingPort, playerFacingPort: relay.playerFacingPort };
  const proxy = mode === 'ws' ? createTcpImpair({ listenPort: PROXY_PORT, targetPort: site.port }) : null;
  if (proxy) await proxy.listen();
  const pages = [];
  let poll = null;
  try {
    const { secret, code } = await fetchInvite(site);
    if (!secret && !code) throw new Error('the server gave no invite');
    const gm = await openGm(browser, site.base, relayHint);
    pages.push(gm);
    const origin = mode === 'ws' ? `http://localhost:${PROXY_PORT}` : `http://localhost:${site.port}`;
    const setup = mode === 'ws'
      ? `delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;` + tapPageScript({ tapDestination: true, tapStream: false, forceRate })
      : tapPageScript({ tapDestination: false, tapStream: true, forceRate }) + rtcPageScript({ role: 'player', relay: relayHint });
    const player = await openPlayer(browser, origin, secret, 'Tester', setup);
    pages.push(player);
    if (relay) {
      if (profile === 'icefail') relay.impair.loss = 1;
      poll = setInterval(async () => {
        try {
          relay.gmPort ||= await browser.eval(gm, 'window.__udpPort ? __udpPort() : 0');
          relay.playerPort ||= await browser.eval(player, 'window.__udpPort ? __udpPort() : 0');
        } catch { /* page navigating */ }
      }, 50);
    }
    await browser.click(gm, UI.gmBroadcastButton);
    const selectedAt = Date.now();
    await selectAllDevices(browser, gm);
    await browser.eval(player, `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await browser.click(player, UI.playerTapPill).catch(() => {});

    if (profile === 'icefail') {
      await browser.waitFor(player, `window.__tap && window.__tap.beacons.length >= 1`, 25000, 'sound through the fallback after the UDP path was blocked');
      const tap = await tapNow(browser, player);
      const heard = tap.beacons[0].wall - selectedAt;
      const summary = summarizeTap(tap, { seconds, sourceBeaconWalls: await browser.eval(gm, 'window.__beaconWalls') });
      const pass = heard <= 8000 + 3000 + 1500; // fallback within 8 s + the first beacon is scheduled 3 s after capture starts
      return { profile, mode, summary, verdict: { pass, reasons: pass ? [] : [`first sound ${heard} ms after selecting the device (limit about 12500 incl. 3000 ms beacon offset)`] }, firstSoundMs: heard };
    }

    await browser.waitFor(player, `window.__tap && window.__tap.available !== false && window.__tap.beacons.length >= 2`, 40000, 'two pitch beacons at the phone (sound is flowing)').catch(async error => {
      const tap = await tapNow(browser, player).catch(() => null);
      throw new Error(`${error.message}; tap state: ${JSON.stringify(tap && { available: tap.available, error: tap.error, contexts: tap.contexts, beacons: tap.beacons.length })}; problems: ${browser.problems(player).slice(0, 3).join(' | ')}`);
    });
    const firstSoundMs = (await tapNow(browser, player)).startedWall - selectedAt;
    const rtcBefore = mode === 'rtc' ? await browser.eval(player, 'window.__rtcStats ? __rtcStats() : []') : null;
    const sinceWall = Date.now();
    const run = netProfile === 'clean' ? null : applyProfile(proxy ?? relay, proxy ? 'tcp' : 'udp', netProfile, { seconds });
    if (jankMs) setTimeout(() => browser.eval(player, `(() => { const t = Date.now(); while (Date.now() - t < ${jankMs}) {} return 1; })()`).catch(() => {}), 10000);
    log(`measuring ${seconds} s (${profile})`);
    await sleep(seconds * 1000);
    run?.stop();
    await sleep(500);
    const tap = await tapNow(browser, player);
    const beaconWalls = await browser.eval(gm, 'window.__beaconWalls');
    const summary = summarizeTap(tap, { seconds, sourceBeaconWalls: beaconWalls, sinceWall });
    const out = { profile, mode, seconds, summary, firstSoundMs, network: proxy ? { lossEvents: proxy.state.lossEvents, stalledMs: proxy.state.stalledMs } : relay.stats };
    if (mode === 'rtc') {
      const after = await browser.eval(player, 'window.__rtcStats ? __rtcStats() : []');
      const a = after[0]?.inbound ?? {}, b = rtcBefore?.[0]?.inbound ?? {};
      const d = key => (a[key] ?? 0) - (b[key] ?? 0);
      out.rtc = {
        connection: after[0]?.state, packetsLost: d('packetsLost'), packetsReceived: d('packetsReceived'),
        concealedPct: +(100 * d('concealedSamples') / Math.max(1, d('totalSamplesReceived'))).toFixed(2),
        avgJitterBufferMs: Math.round(1000 * d('jitterBufferDelay') / Math.max(1, d('jitterBufferEmittedCount'))),
      };
    }
    out.verdict = judge(mode, profile, summary, out.rtc);
    return out;
  } finally {
    clearInterval(poll);
    for (const page of pages) await browser.closePage(page).catch(() => {});
    relay?.close();
    await proxy?.close();
  }
}

/** 8 phones on WebRTC: all must reach 'connected'; the GM renderer must stay under 35 % of one core (5.9). */
export async function runCpu8({ browser, site, seconds = 20 }) {
  const pages = [];
  try {
    const { secret } = await fetchInvite(site);
    const gm = await openGm(browser, site.base, null);
    pages.push(gm);
    const players = [];
    for (let i = 0; i < 8; i += 1) {
      const page = await openPlayer(browser, `http://localhost:${site.port}`, secret, `Phone ${i + 1}`, rtcPageScript({ role: 'player', relay: null }));
      players.push(page); pages.push(page);
    }
    await browser.click(gm, UI.gmBroadcastButton);
    await selectAllDevices(browser, gm, 8);
    for (const page of players) await browser.eval(page, `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    const states = async () => Promise.all(players.map(page => browser.eval(page, 'window.__rtcStats ? __rtcStats().then(r => r[0]?.state) : null')));
    let connected = 0;
    for (let i = 0; i < 60 && connected < 8; i += 1) { connected = (await states()).filter(x => x === 'connected').length; await sleep(500); }
    const before = await browser.cpu(); const t0 = Date.now();
    await sleep(seconds * 1000);
    const after = await browser.cpu(); const wall = (Date.now() - t0) / 1000;
    const byId = new Map(before.map(p => [p.id, p]));
    const rows = after.map(p => ({ type: p.type, id: p.id, cpuPct: +(100 * (p.cpuTime - (byId.get(p.id)?.cpuTime ?? 0)) / wall).toFixed(1) })).sort((a, b) => b.cpuPct - a.cpuPct);
    // the GM page's renderer is the busiest renderer (it encodes eight streams); the phones' renderers only decode
    const gmRenderer = rows.find(r => r.type === 'renderer');
    const reasons = [];
    if (connected < 8) reasons.push(`only ${connected} of 8 phones reached "connected"`);
    if (gmRenderer && gmRenderer.cpuPct > 35) reasons.push(`GM renderer used ${gmRenderer.cpuPct} % of one core (limit 35 %)`);
    return { profile: 'cpu8', mode: 'rtc', summary: { available: true, dropouts: 0, dropoutMs: [], discontinuities: 0, latency: null }, firstSoundMs: 0, rtc: { connected, top: rows.slice(0, 4) }, verdict: { pass: reasons.length === 0, reasons } };
  } finally { for (const page of pages) await browser.closePage(page).catch(() => {}); }
}

/** Shared command line driver of the two scripts. */
export async function main(mode, defaults) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const seconds = Number(option('seconds', args.includes('--quick') ? 20 : 60));
  const profiles = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--seconds')).length
    ? args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--seconds') : defaults;
  const results = [];
  let browser, site;
  try {
    await ensureBuilt();
    site = await startSiteServer({ host: '0.0.0.0' });
    browser = await launch();
    for (const profile of profiles) {
      process.stdout.write(`${mode.toUpperCase()} ${profile.padEnd(10)} `);
      try {
        const r = profile === 'cpu8' ? await runCpu8({ browser, site, seconds: Math.min(seconds, 30) }) : await runAudioProfile({ mode, profile, seconds: profile.startsWith('rate') ? Math.max(seconds, 20) : seconds, browser, site, log: () => {} });
        results.push(r);
        const s = r.summary;
        if (profile === 'cpu8') { console.log(`${r.verdict.pass ? 'PASS' : 'FAIL'}  ${JSON.stringify(r.rtc)}${r.verdict.reasons.length ? '\n     ' + r.verdict.reasons.join('\n     ') : ''}`); continue; }
        console.log(`${r.verdict.pass ? 'PASS' : 'FAIL'}  dropouts ${s.dropouts} ${JSON.stringify(s.dropoutMs)} ms | discontinuities ${s.discontinuities} | delay ${s.latency ? `${s.latency.first}->${s.latency.last} ms (max ${s.latency.max})` : 'n/a'} | first sound ${Math.round(r.firstSoundMs)} ms${r.rtc ? ` | concealed ${r.rtc.concealedPct} % lost ${r.rtc.packetsLost} jb ${r.rtc.avgJitterBufferMs} ms` : ''}${r.verdict.reasons.length ? `\n     ${r.verdict.reasons.join('\n     ')}` : ''}`);
      } catch (error) {
        results.push({ profile, mode, verdict: { pass: false, reasons: [error.message] } });
        console.log(`FAIL  ${error.message}`);
      }
    }
  } catch (error) {
    if (error instanceof ServerUnavailable) { console.error(error.message); process.exitCode = 1; return results; }
    console.error(`accept-audio-${mode}: ${error.message}`);
    process.exitCode = 1;
    return results;
  } finally {
    await browser?.close();
    await site?.close();
  }
  const failed = results.filter(r => !r.verdict.pass).length;
  console.log(`\naccept-audio-${mode}: ${results.length - failed} of ${results.length} profiles pass`);
  if (args.includes('--json')) console.log(JSON.stringify(results));
  process.exitCode = failed ? 1 : 0;
  return results;
}
