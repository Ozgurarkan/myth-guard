#!/usr/bin/env node
// FPS check: how smooth the GM screen and a phone's player screen are while you actually use them.
//
//   node scripts/fps-check.mjs               GM screen at normal speed and with the CPU slowed 4x, phone with the CPU slowed 4x
//   node scripts/fps-check.mjs --quick       shorter actions
//   node scripts/fps-check.mjs --cpu=6       use another slow-down for the "weak machine" pass
//   node scripts/fps-check.mjs --no-fail     report only, always exit 0
//   node scripts/fps-check.mjs --profile=zoom   also list where the time goes during actions whose name contains 'zoom'
//
// The scene: a 4096 x 3072 map picture (generated in the page, a few MB of JPEG detail), 30 tokens, a running combat
// (so the active-turn ring animates), fog painted by hand. Every action is fed at mouse speed (one event about every
// 16 ms), the way a real hand moves, and the frame times are recorded with requestAnimationFrame.
//
//   GM:    idle with the turn ring pulsing · pings rippling · wheel zoom · panning · dragging a token · painting fog
//   Phone: idle with the turn ring · pings · mouse-wheel zoom · one-finger pan · two-finger pinch
//          (390 x 844 at 3x screen density, touch input, mobile emulation)
//
// Reported per action: average frames per second, the "1% low" (the speed of the slowest 1% of frames, which is what
// feels like stutter), how many frames took longer than 33 ms and 50 ms, and the single worst frame.
//
// Headless Edge draws in software (no graphics card), so the absolute numbers are CONSERVATIVE for a real computer with a
// GPU; they are meant for comparing builds and spotting regressions, and for checking that nothing is badly slow.
// It cannot tell you how a particular phone feels. Port 5173 is never used: the server starts on a free port.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, browserAvailable, sleep } from '../test-support/cdp.js';
import { startSiteServer, ensureBuilt, ROOT } from '../test-support/table.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const hit = args.find(a => a.startsWith(`--${name}=`)); return hit ? Number(hit.split('=')[1]) : fallback; };
const QUICK = flag('quick');
const WEAK = option('cpu', 4);
const PROFILE = (args.find(a => a.startsWith('--profile=')) ?? '').slice(10).toLowerCase();
const PACE = 16;                       // ms between input events: about one per screen frame, like a real mouse
const scale = QUICK ? 0.5 : 1;
const steps = n => Math.max(20, Math.round(n * scale));

// What "smooth enough" means. Average speed and the slowest 1% of frames, in frames per second.
const TARGET = { 1: { avg: 50, low: 30 }, weak: { avg: 30, low: 15 } };

if (!browserAvailable()) { console.error('Microsoft Edge was not found (set EDGE_PATH).'); process.exit(2); }
await ensureBuilt();
const dataDir = mkdtempSync(join(tmpdir(), 'rf-fps-'));
const site = await startSiteServer({ host: '127.0.0.1', port: 0, dataDir }).catch(error => { console.error(error.message); process.exit(2); });
const base = `http://localhost:${site.port}`;
const browser = await launch({ args: ['--window-size=1440,900'] });
const results = [];
const fmt = value => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

// ── frame recorder (lives in the page) ───────────────────────────────────────────────────────────
const RECORDER = `(() => {
  if (window.__fps) return;
  window.__fps = {
    start() { this.t = []; this.on = true; const loop = ts => { if (!this.on) return; this.t.push(ts); requestAnimationFrame(loop); }; requestAnimationFrame(loop); },
    stop() {
      this.on = false;
      const t = this.t, d = [];
      for (let i = 1; i < t.length; i += 1) d.push(t[i] - t[i - 1]);
      if (d.length < 3) return JSON.stringify({ frames: d.length });
      const sorted = [...d].sort((a, b) => a - b);
      const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      const seconds = (t[t.length - 1] - t[0]) / 1000;
      return JSON.stringify({ frames: d.length, seconds, avgFps: d.length / seconds, lowFps: 1000 / q(0.99), p50Ms: q(0.5), p99Ms: q(0.99), over33: d.filter(x => x > 33.4).length, over50: d.filter(x => x > 50).length, maxMs: sorted[sorted.length - 1] });
    },
  };
})()`;

async function measure(session, group, label, action, cpuLabel) {
  await browser.eval(session, RECORDER);
  await sleep(150);
  const profiling = PROFILE && label.toLowerCase().includes(PROFILE);
  if (profiling) { await browser.cmd('Profiler.enable', {}, session); await browser.cmd('Profiler.start', {}, session); }
  await browser.eval(session, 'window.__fps.start()');
  await action();
  const stats = JSON.parse(await browser.eval(session, 'window.__fps.stop()'));
  if (profiling) {
    const { profile } = await browser.cmd('Profiler.stop', {}, session);
    const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
    profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anonymous)'}  ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0)); });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log(`      where the time goes (${group} ${cpuLabel} ${label}, ${(total / 1000).toFixed(0)} ms sampled):`);
    for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)) console.log(`        ${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);
  }
  const goal = TARGET[cpuLabel === '1x' ? 1 : 'weak'];
  const pass = stats.frames >= 20 && stats.avgFps >= goal.avg && stats.lowFps >= goal.low;
  const row = { group, cpu: cpuLabel, action: label, frames: stats.frames, avgFps: fmt(stats.avgFps), lowFps: fmt(stats.lowFps), over33: stats.over33, over50: stats.over50, worstMs: fmt(stats.maxMs), pass, goal };
  results.push(row);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${group.padEnd(5)} ${cpuLabel.padEnd(4)} ${label.padEnd(26)} ${String(row.avgFps).padStart(5)} fps avg   1% low ${String(row.lowFps).padStart(5)} fps   >33 ms: ${String(row.over33).padStart(3)}   >50 ms: ${String(row.over50).padStart(3)}   worst ${row.worstMs} ms`);
  return row;
}

const press = (session, type, x, y, extra = {}) => browser.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }, session);
const wheel = (session, x, y, deltaY) => browser.cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, session);
const key = async (session, k) => { await browser.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: `Key${k.toUpperCase()}`, text: k, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }, session); await browser.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: `Key${k.toUpperCase()}`, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }, session); };
const clickText = (session, re) => browser.click(session, re);
const setInput = (session, selector, value) => browser.eval(session, `(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const rectOf = (session, selector) => browser.eval(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);

async function pingBurst(session, ms, area) {
  // a burst of pings on the map, the way several players might tap at once
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end) {
    await browser.eval(session, `window.dispatchEvent(new CustomEvent('realm:ping', { detail: { id: 'p${n % 6}', name: 'Player ${n % 6 + 1}', x: ${area.x + (n * 173) % area.w}, y: ${area.y + (n * 97) % area.h} } }))`);
    n += 1;
    await sleep(450);
  }
}

// ═════════════ GM screen ═════════════════════════════════════════════════════════════════════════
console.log(`Setting up the GM screen: big map, 30 tokens, a running combat${QUICK ? ' (quick mode)' : ''}...`);
const gm = await browser.page(`${base}/`);
await browser.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, gm);
await browser.waitFor(gm, `!!document.querySelector('.welcome')`, 20000, 'the welcome card');
const mapBytes = await browser.eval(gm, `(async () => {
  const c = document.createElement('canvas'); c.width = 4096; c.height = 3072;
  const x = c.getContext('2d');
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const g = x.createLinearGradient(0, 0, 4096, 3072); g.addColorStop(0, '#3b4a2f'); g.addColorStop(0.5, '#6b5a3c'); g.addColorStop(1, '#2d3b4f');
  x.fillStyle = g; x.fillRect(0, 0, 4096, 3072);
  for (let i = 0; i < 2600; i += 1) { x.fillStyle = 'hsla(' + Math.floor(rnd() * 70 + 20) + ',35%,' + Math.floor(rnd() * 40 + 20) + '%,0.5)'; x.beginPath(); x.arc(rnd() * 4096, rnd() * 3072, rnd() * 70 + 6, 0, 7); x.fill(); }
  for (let i = 0; i < 900; i += 1) { x.strokeStyle = 'rgba(0,0,0,0.35)'; x.lineWidth = rnd() * 4 + 1; x.beginPath(); x.moveTo(rnd() * 4096, rnd() * 3072); x.lineTo(rnd() * 4096, rnd() * 3072); x.stroke(); }
  const img = x.getImageData(0, 0, 4096, 3072); for (let i = 0; i < img.data.length; i += 4) { const n = (rnd() - 0.5) * 22; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; } x.putImageData(img, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'stress-map.jpg', { type: 'image/jpeg' }));
  const input = document.querySelector('input[aria-label="Import battle map"]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  return blob.size;
})()`);
await browser.waitFor(gm, `!document.querySelector('.welcome') && !!document.querySelector('.canvas-area canvas')`, 60000, 'the map to load');
await sleep(1500);
console.log(`  map picture: 4096 x 3072, ${(mapBytes / 1048576).toFixed(1)} MB`);

// tokens
await clickText(gm, /^Tokens$/); await sleep(400);
await clickText(gm, /Add your first token/); await sleep(700);
await setInput(gm, '.modal input[placeholder*="Aria"]', 'Goblin');
await clickText(gm, /Place token/); await sleep(700);
for (let i = 0; i < 29; i += 1) await browser.eval(gm, `document.querySelector('.token-row button[aria-label="Duplicate token"]')?.click()`);
await sleep(600);
// combat: everybody rolls, combat starts, the turn ring pulses on the active token
await clickText(gm, /^Combat$/); await sleep(500);
await clickText(gm, /Roll all/); await sleep(500);
await clickText(gm, /Start combat/); await sleep(800);
const tokenCount = await browser.eval(gm, `document.querySelectorAll('.combatant').length`);
console.log(`  ${tokenCount} combatants, combat running`);

async function gmScenarios(cpu, label) {
  await browser.cmd('Emulation.setCPUThrottlingRate', { rate: cpu }, gm);
  await sleep(300);
  const rect = await rectOf(gm, '.canvas-area canvas');
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const idle = QUICK ? 1500 : 3000;

  await measure(gm, 'GM', 'idle, turn ring pulsing', () => sleep(idle), label);
  await measure(gm, 'GM', 'pings rippling', () => pingBurst(gm, idle, { x: 800, y: 700, w: 2400, h: 1600 }), label);
  await measure(gm, 'GM', 'wheel zoom', async () => { for (let i = 0; i < steps(110); i += 1) { await wheel(gm, cx + Math.sin(i / 8) * 150, cy, (i % 22 < 11 ? -1 : 1) * 80); await sleep(PACE); } }, label);

  await key(gm, 'h');
  await measure(gm, 'GM', 'panning (H tool)', async () => {
    await press(gm, 'mousePressed', cx, cy);
    for (let i = 0; i < steps(150); i += 1) { await press(gm, 'mouseMoved', cx + Math.sin(i / 11) * 260, cy + Math.cos(i / 11) * 170); await sleep(PACE); }
    await press(gm, 'mouseReleased', cx, cy);
  }, label);

  // dragging a token: the first token was placed where the middle of the map was; find it by pressing and checking the selection
  await key(gm, 'v');
  const zoomPct = Number(await browser.eval(gm, `(document.body.innerText.match(/ZOOM\\s*(\\d+)%/) || [])[1] || 0`)) / 100;
  const tx = cx + 27 * (zoomPct || 0.4), ty = cy + 39 * (zoomPct || 0.4);
  let dragged = false;
  await measure(gm, 'GM', 'dragging a token', async () => {
    await press(gm, 'mousePressed', tx, ty);
    for (let i = 0; i < steps(120); i += 1) { await press(gm, 'mouseMoved', tx + Math.sin(i / 9) * 140, ty + Math.cos(i / 9) * 90); await sleep(PACE); }
    await press(gm, 'mouseReleased', tx, ty);
    dragged = await browser.eval(gm, `!!document.querySelector('.token-row.is-selected, .combatant.is-selected, .selection-bar, [data-selected="true"]')`).catch(() => false);
  }, label);
  void dragged;

  await key(gm, 'f');
  await measure(gm, 'GM', 'painting fog', async () => {
    await press(gm, 'mousePressed', rect.left + 120, rect.top + 120);
    const rows = 8, perRow = steps(24);
    for (let r = 0; r < rows; r += 1) for (let i = 0; i <= perRow; i += 1) {
      const x = rect.left + 120 + (r % 2 ? perRow - i : i) * (rect.width - 240) / perRow, y = rect.top + 120 + r * (rect.height - 240) / rows;
      await press(gm, 'mouseMoved', x, y); await sleep(PACE);
    }
    await press(gm, 'mouseReleased', cx, cy);
  }, label);
  await key(gm, 'v');
}

await gmScenarios(1, '1x');
await gmScenarios(WEAK, `${WEAK}x`);
await browser.cmd('Emulation.setCPUThrottlingRate', { rate: 1 }, gm);

// ═════════════ Phone ═════════════════════════════════════════════════════════════════════════════
console.log('Setting up the phone (390 x 844, 3x screen, touch)...');
const info = JSON.parse(await browser.eval(gm, `fetch('/__realm/info').then(r => r.text())`));
const joinUrl = (info.addresses || []).map(a => a.joinUrl).find(Boolean);
if (!joinUrl) { console.error('No network address found for the invite (connect to Wi-Fi or Ethernet). Skipping the phone.'); }
else {
  const secret = new URL(joinUrl).hash;
  const phone = await browser.page(`${base}/player.html${secret}`);
  const phoneMetrics = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
  await browser.cmd('Emulation.setDeviceMetricsOverride', phoneMetrics, phone);
  await browser.cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, phone);
  await browser.cmd('Page.reload', {}, phone);            // so the app starts at the phone's screen density, as on a real phone
  await browser.waitFor(phone, `!!document.querySelector('input')`, 20000, 'the name field');
  await setInput(phone, 'input', 'FPS tester');
  await browser.eval(phone, `document.querySelector('form')?.requestSubmit()`);
  await browser.waitFor(phone, `!!document.querySelector('.p-map canvas')`, 30000, 'the phone map');
  await sleep(4000);                                       // the map picture arrives and draws
  const ratio = await browser.eval(phone, `(() => { const c = document.querySelector('.p-map canvas'); return +(c.width / c.getBoundingClientRect().width).toFixed(2); })()`);
  console.log(`  phone canvas density: ${ratio}x (screen reports 3x)`);

  await browser.cmd('Emulation.setCPUThrottlingRate', { rate: WEAK }, phone);
  await sleep(300);
  const prect = await rectOf(phone, '.p-map canvas');
  const px = prect.left + prect.width / 2, py = prect.top + prect.height / 2;
  const touch = (type, points) => browser.cmd('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) }, phone);
  const label = `${WEAK}x`;
  const idle = QUICK ? 1500 : 3000;

  // the turn ring only pulses when a hero of this phone is active; pings and movement are what the phone always does
  await measure(phone, 'Phone', 'idle', () => sleep(idle), label);
  await measure(phone, 'Phone', 'pings rippling', () => pingBurst(phone, idle, { x: 800, y: 700, w: 2400, h: 1600 }), label);
  await measure(phone, 'Phone', 'wheel zoom', async () => { for (let i = 0; i < steps(100); i += 1) { await wheel(phone, px, py, (i % 20 < 10 ? -1 : 1) * 90); await sleep(PACE); } }, label);
  await measure(phone, 'Phone', 'one-finger pan', async () => {
    await touch('touchStart', [{ x: px, y: py }]);
    for (let i = 0; i < steps(140); i += 1) { await touch('touchMove', [{ x: px + Math.sin(i / 10) * 90, y: py + Math.cos(i / 10) * 140 }]); await sleep(PACE); }
    await touch('touchEnd', []);
  }, label);
  await measure(phone, 'Phone', 'two-finger pinch', async () => {
    await touch('touchStart', [{ x: px - 30, y: py }, { x: px + 30, y: py }]);
    for (let i = 0; i < steps(120); i += 1) { const d = 30 + Math.abs(Math.sin(i / 14)) * 110; await touch('touchMove', [{ x: px - d, y: py - d / 3 }, { x: px + d, y: py + d / 3 }]); await sleep(PACE); }
    await touch('touchEnd', []);
  }, label);
  results.push({ info: true, phoneCanvasDensity: ratio });
  console.log(`  problems on the phone page: ${browser.problems(phone).length}`);
}
const gmProblems = browser.problems(gm);

// ═════════════ report ════════════════════════════════════════════════════════════════════════════
const rows = results.filter(r => !r.info);
const failed = rows.filter(r => !r.pass);
const lines = [];
lines.push('# FPS test', '', `${new Date().toISOString()}  |  headless Edge (software drawing: conservative for a PC with a graphics card)  |  map 4096 x 3072, ${tokenCount} tokens, combat running  |  weak-machine slowdown ${WEAK}x`, '',
  `Targets: normal speed average >= ${TARGET[1].avg} fps and 1% low >= ${TARGET[1].low} fps; slowed ${WEAK}x average >= ${TARGET.weak.avg} fps and 1% low >= ${TARGET.weak.low} fps.`, '',
  '| Screen | CPU | Action | Avg fps | 1% low fps | Frames >33 ms | Frames >50 ms | Worst frame | |', '|---|---|---|---:|---:|---:|---:|---:|---|');
for (const r of rows) lines.push(`| ${r.group} | ${r.cpu} | ${r.action} | ${r.avgFps} | ${r.lowFps} | ${r.over33} | ${r.over50} | ${r.worstMs} ms | ${r.pass ? 'PASS' : '**FAIL**'} |`);
lines.push('', failed.length ? `**${failed.length} of ${rows.length} measurements below target.**` : `**All ${rows.length} measurements met the targets.**`);
if (gmProblems.length) lines.push('', `Page errors on the GM screen: ${gmProblems.slice(0, 5).join(' | ')}`);
mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(join(ROOT, 'docs', 'fps-report.md'), lines.join('\n') + '\n');
console.log(`\n${failed.length ? `${failed.length} of ${rows.length} measurements below target` : `All ${rows.length} measurements met the targets`}. Report saved to docs/fps-report.md`);
if (gmProblems.length) console.log(`Page errors on the GM screen: ${gmProblems.slice(0, 3).join(' | ')}`);

await browser.close();
await site.close();
process.exit(failed.length && !flag('no-fail') ? 1 : 0);
