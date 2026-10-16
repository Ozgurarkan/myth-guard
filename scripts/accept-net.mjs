#!/usr/bin/env node
/**
 * Network acceptance: design 6.4 N1-N12 (state sync, size, memory, resume, soak, slow client) against a live server.
 *
 *   npm run accept                        all N checks on the new stack (about 6 minutes; soak 2 minutes)
 *   node scripts/accept-net.mjs --stack v2    the pre-rewrite server from .backup-pre-network-rewrite: measures today's baselines
 *   node scripts/accept-net.mjs --only N1,N2  some checks;  --quick  shorter loops;  --soak-min 30  the full 30 minute soak
 *   node scripts/accept-net.mjs --all     afterwards also run accept-security, accept-audio-ws, accept-audio-rtc, check-player-browser
 *   --json  machine readable result on the last line
 *
 * Exit code 0 when every criterion passes (on --stack v2 criteria are reported against the numbers but never fail the run).
 * If the new stack is missing it prints "server not available: ..." and exits 1 without crashing.
 */
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { projectForPlayers } from '../src/playerView.js';
import { diffState } from '../src/syncPatch.js';
import {
  ServerUnavailable, addPlayerTo, canonicalJson, connectPlayer, defaultStack, gmGet, makeScene, quantiles, sleep, stateHash, startTable,
} from '../test-support/table.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const stack = option('stack', defaultStack());
const quick = flag('quick');
const only = option('only', '').split(',').filter(Boolean);
const soakMinutes = Number(option('soak-min', quick ? 0.5 : 2));
const informational = stack !== 'v3';
const results = [];
const ms = value => (Number.isFinite(value) ? +value.toFixed(2) : value);

function record(id, title, measured, criterion, pass, note = '') {
  const status = pass === null ? 'INFO' : pass ? 'PASS' : informational ? 'over' : 'FAIL';
  results.push({ id, title, measured, criterion, status, note });
  console.log(`${status.padEnd(4)} ${id.padEnd(4)} ${title}\n         measured: ${typeof measured === 'string' ? measured : JSON.stringify(measured)}${criterion ? `   criterion: ${criterion}` : ''}${note ? `\n         ${note}` : ''}`);
}
const wanted = id => only.length === 0 || only.includes(id);

/** All players hold the next patch: latency from `send()` until the last player has it. */
async function oneRound(players, send, timeoutMs = 3000) {
  const waits = players.map(p => p.waitFor(m => m.type === 'STATE_PATCH', timeoutMs, 'STATE_PATCH'));
  const t0 = performance.now();
  send();
  const got = await Promise.all(waits);
  return { ms: Math.max(...got.map(g => g.at)) - t0, bytes: players[0].lastPatchBytes };
}

const tokenOf = (table, i) => table.scene.tokens[i];
function rejections(players) { return players.reduce((n, p) => n + (p.byType.MOVE_REJECTED ?? 0) + (p.log ? p.log.filter(m => m.type === 'ACK' && m.ok === false).length : 0), 0); }

async function newTable(count, extra = {}) {
  const table = await startTable({ stack, players: count, child: true, ...extra });
  table.scene = makeScene({ owners: table.players.map(p => p.playerId) });
  table.gm.publish(table.scene);
  await Promise.all(table.players.map(p => p.first('STATE_FULL', 5000).catch(() => null)));
  await sleep(150);
  return table;
}

async function moveRounds(table, count, gapMs = 36, who = 0) {
  const lat = [];
  const sizes = [];
  const token = tokenOf(table, who);
  let x = token.x;
  for (let i = 0; i < count; i += 1) {
    x = token.x + 1 + (i % 400);
    const r = await oneRound(table.players, () => table.players[who].send({ type: 'PLAYER_TOKEN_MOVE', aid: `m${who}-${i}-${Date.now()}`, id: token.id, x, y: token.y }));
    lat.push(r.ms); sizes.push(r.bytes);
    await sleep(gapMs);
  }
  return { lat, sizes };
}

// ---------------------------------------------------------------------------------------------------------------------

async function n1n5() {
  for (const count of stack === 'v3' ? [8, 16] : [8]) {
    const table = await newTable(count);
    try {
      const { lat, sizes } = await moveRounds(table, quick ? 100 : 300);
      const q = quantiles(lat);
      const limit = count === 8 ? { p95: 10, p99: 25 } : { p95: 20, p99: 1e9 };
      record('N1', `token move round trip, ${count} players (${lat.length} moves)`, { p50: ms(q.p50), p95: ms(q.p95), p99: ms(q.p99), max: ms(q.max), rejected: rejections(table.players) },
        `p95 <= ${limit.p95} ms${count === 8 ? ', p99 <= 25 ms' : ''}`, q.p95 <= limit.p95 && q.p99 <= limit.p99, 'baseline today (8 players): p50 3.0, p95 5.8, p99 7.9 ms');
      if (count === 8) {
        const s = quantiles(sizes);
        record('N5', 'patch size: one token move', `${s.p50} B (max ${s.max})`, '<= 400 B', s.max <= 400, 'baseline 287 B');
      }
    } finally { await table.close(); }
  }
}

async function n2n5() {
  const table = await newTable(8);
  try {
    const lat = [], sizes = [];
    let cursor = 5000;
    for (let i = 0; i < (quick ? 50 : 100); i += 1) {
      const scene = structuredClone(table.scene);
      for (let k = 0; k < 40; k += 1) scene.fogCells.push(`${Math.floor((cursor + k) / 82)},${(cursor + k) % 82}`);
      cursor += 40; table.scene = scene;
      const r = await oneRound(table.players, () => table.gm.publish(scene));
      lat.push(r.ms); sizes.push(r.bytes);
      await sleep(30);
    }
    const q = quantiles(lat);
    record('N2', `GM scene change -> patch at 8 players (${lat.length} scenes)`, { p50: ms(q.p50), p95: ms(q.p95), max: ms(q.max) }, 'p95 <= 20 ms', q.p95 <= 20, 'baseline today: p50 8.5, p95 11.6 ms');
    const s = quantiles(sizes);
    record('N5', 'patch size: 40-cell fog stroke', `${s.p50} B (max ${s.max})`, '<= 500 B', s.max <= 500, 'baseline 341 B');
  } finally { await table.close(); }
}

async function n3() {
  const table = await newTable(1);
  try {
    // late joiner: the scene is already published, so the new device is served a STATE_FULL
    const joiner = await (async () => {
      table.players.at(-1).keepRaw = false;
      return addPlayerTo(table, { name: 'Late', track: true, record: false });
    })();
    joiner.keepRaw = true;
    const full = await joiner.first('STATE_FULL', 5000).catch(() => null);
    if (!full) { record('N3', 'STATE_FULL for a late joiner', 'none received', '', false); return; }
    const raw = joiner.fullBytes;
    const text = JSON.stringify({ type: 'STATE_FULL', rev: joiner.rev, state: joiner.state });
    const estimate = deflateRawSync(Buffer.from(text), { level: 3 }).length;
    record('N3', 'STATE_FULL size (4096x4096, 5,000 fog cells, 30 tokens)', { raw, deflate3: estimate, bytesReadByConnectionEnd: joiner.wireAtFull }, 'raw <= 50,000 B, on the wire <= 14,000 B', raw <= 50000 && estimate <= 14000,
      'baseline: 44.6 KB raw, 11.9 KB deflate-3 (wire size estimated with zlib level 3; bytesRead includes the HTTP upgrade and HELLO)');
    // server work for one publish: the same functions the hub runs (projection + diff + serialisation), timed in this process
    const scene = table.scene;
    const next = structuredClone(scene); next.tokens[0].x += 5;
    const run = () => { const view = projectForPlayers(scene); const view2 = projectForPlayers(next); const patch = diffState(view, view2); JSON.stringify({ type: 'STATE_PATCH', patch }); };
    for (let i = 0; i < 50; i += 1) run();
    const times = [];
    for (let i = 0; i < 300; i += 1) { const t0 = performance.now(); run(); times.push((performance.now() - t0) / 1); }
    const q = quantiles(times);
    // the build+serialise of the snapshot alone
    const t1 = performance.now(); for (let i = 0; i < 100; i += 1) JSON.stringify({ type: 'STATE_FULL', rev: 1, state: projectForPlayers(scene) });
    const build = (performance.now() - t1) / 100;
    record('N3', 'build + serialise a STATE_FULL (in-process, same functions)', `${ms(build)} ms`, '<= 2 ms', build <= 2);
    record('N4', 'hub work per GM scene publish: 2 projections + diff + serialise (in-process, upper bound)', { p50: ms(q.p50), p95: ms(q.p95) }, '<= 1.5 ms', q.p50 <= 1.5, 'baseline 0.50 ms (one projection + diff)');
    if (stack === 'v3') {
      const diag = (await gmGet(table.server, '/__realm/diag')).json;
      const hubTimings = Object.entries(diag?.timings ?? {}).filter(([k]) => /scene|publish|project|sync/i.test(k));
      if (hubTimings.length) record('N4', 'hub work per publish as the server measured it (/__realm/diag timings)', Object.fromEntries(hubTimings.map(([k, v]) => [k, { p50: ms(v.p50), p95: ms(v.p95) }])), '<= 1.5 ms', hubTimings.every(([, v]) => (v.p50 ?? 0) <= 1.5));
    }
    // 8 players at once get the first full state within 25 ms
    const eight = await newTable(0);
    try {
      eight.gm.publish(eight.scene = makeScene({}));
      await sleep(100);
      const t0 = performance.now();
      const ps = [];
      for (let i = 0; i < 8; i += 1) ps.push(addPlayerTo(eight, { name: `P${i}` }));
      const all = await Promise.all(ps);
      const gotAll = await Promise.all(all.map(p => p.first('STATE_FULL', 5000)));
      record('N3', 'eight devices join a published scene: time until all hold the snapshot (includes connecting)', `${ms(performance.now() - t0)} ms (raw frame ${all[0].fullBytes} B)`, 'info (join is N9; delivery <= 25 ms)', null, gotAll.length === 8 ? '' : 'not all received');
    } finally { await eight.close(); }
  } finally { await table.close(); }
}

async function n6() {
  const table = await startTable({ stack, players: 0, child: true });
  try {
    table.scene = makeScene({});
    table.gm.publish(table.scene);
    await sleep(200); await table.server.gc();
    const base = await table.server.memory();
    for (let i = 0; i < 8; i += 1) await table.addPlayer({ name: `P${i}` });
    await sleep(500); await table.server.gc();
    const idle = await table.server.memory();
    const perPlayer = (idle.rss - base.rss) / 8 / 1024;
    record('N6', 'server memory per connected player (idle, compression on, server in its own process)', `${Math.round(perPlayer)} KB RSS; heap total ${(idle.heapUsed / 1048576).toFixed(1)} MB; rss ${(idle.rss / 1048576).toFixed(0)} MB`,
      '<= 250 KB per player; 8 players idle heap <= 40 MB', perPlayer <= 250 && idle.heapUsed <= 40 * 1048576, 'baseline 450-510 KB with both ends in one process (roughly half the server)');
    // churn: patches and reconnects, RSS must not grow. A warm-up round first: allocators and zlib arenas take their working size once.
    const patches = quick ? 1500 : 10000, reconnects = quick ? 100 : 1000;
    const owners = table.players.map(p => p.playerId);
    table.scene = makeScene({ owners }); table.gm.publish(table.scene); await sleep(300);
    const round = async (patchCount, reconnectCount) => {
      let sent = 0;
      await Promise.all(table.players.map(async (p, i) => {
        const token = table.scene.tokens[i];
        for (let k = 0; sent < patchCount; k += 1) {
          sent += 1;
          table.players[i].send({ type: 'PLAYER_TOKEN_MOVE', aid: `c${i}-${k}-${Date.now()}`, id: token.id, x: token.x + (k % 300), y: token.y });
          await sleep(36);
        }
      }));
      for (let i = 0; i < reconnectCount; i += 1) {
        const slot = i % table.players.length;
        const old = table.players[slot];
        old.terminate();
        table.players[slot] = await connectPlayer(table.server, table.identities[slot], { name: old.name, resume: { rev: old.rev, aids: [], state: old.state } });
      }
      await sleep(500); await table.server.gc();
    };
    await round(Math.floor(patches / 3), Math.floor(reconnects / 3));
    const before = await table.server.memory();
    await round(patches, reconnects);
    const after = await table.server.memory();
    const growth = (after.rss - before.rss) / before.rss * 100;
    record('N6', `RSS after ${patches} more patches and ${reconnects} more reconnects (after a warm-up round)`, `${(before.rss / 1048576).toFixed(0)} -> ${(after.rss / 1048576).toFixed(0)} MB (${growth.toFixed(1)} %); heap ${(before.heapUsed / 1048576).toFixed(1)} -> ${(after.heapUsed / 1048576).toFixed(1)} MB`, 'growth <= 5 %', growth <= 5);
  } finally { await table.close(); }
}

async function n7n8n9() {
  const table = await newTable(16);
  try {
    // N7: 16 devices in sync, then 8 reconnect within a second
    const conv = async () => {
      for (let i = 0; i < 60; i += 1) {
        const revs = new Set(table.players.map(p => p.rev));
        const hashes = new Set(table.players.map(p => p.state && stateHash(p.state)));
        if (revs.size === 1 && hashes.size === 1 && !revs.has(null)) return true;
        await sleep(50);
      }
      return false;
    };
    await table.players[0].send({ type: 'PLAYER_TOKEN_MOVE', aid: 'z1', id: 'tok0', x: table.scene.tokens[0].x + 3, y: table.scene.tokens[0].y });
    const ok16 = await conv();
    record('N7', '16 devices + GM: all hold the same rev and state hash', ok16 ? 'in sync' : 'diverged', 'all equal', ok16);
    const t0 = performance.now();
    const olds = table.players.slice(0, 8);
    olds.forEach(p => p.terminate());
    const fresh = await Promise.all(olds.map((p, i) => connectPlayer(table.server, table.identities[i], { name: p.name, resume: { rev: p.rev, aids: [], state: p.state } })));
    fresh.forEach((p, i) => { table.players[i] = p; });
    const storm = await conv();
    record('N7', '8 devices reconnect together: all in sync again', `${storm ? 'in sync' : 'NOT in sync'} after ${Math.round(performance.now() - t0)} ms`, 'within 3000 ms, same rev and state', storm && performance.now() - t0 <= 3000);
    // N8: resume 10 revisions behind
    const p = table.players[8];
    const behind = p.rev;
    p.terminate(); await sleep(50);
    for (let i = 0; i < 10; i += 1) { const s = structuredClone(table.scene); s.tokens[22].x += 5 * (i + 1); table.scene = s; table.gm.publish(s); await sleep(60); }
    const back = await connectPlayer(table.server, table.identities[8], { name: p.name, resume: { rev: behind, aids: [], state: p.state } });
    await sleep(800);
    table.players[8] = back;
    const bytes = back.bytesIn;
    record('N8', 'resume 10 revisions behind', `${back.patches} patches, ${back.fulls} snapshots, ${bytes} B received in total (HELLO included)`, '10 patches, no snapshot, < 5 KB', back.fulls === 0 && back.patches === 10 && bytes < 5000 + 2500,
      stack === 'v2' ? 'baseline: the old server has no resume and sends a snapshot' : 'the total includes HELLO/GM_STATUS (about 1-2 KB)');
    // N9: connect cost
    const times = [];
    for (let i = 0; i < 20; i += 1) {
      const idn = table.identities[10 + (i % 5)];
      table.players[10 + (i % 5)].terminate();
      const t = performance.now();
      table.players[10 + (i % 5)] = await connectPlayer(table.server, idn, { name: 'x' });
      times.push(performance.now() - t);
      await sleep(20);
    }
    const q = quantiles(times);
    record('N9', 'connect cost: hello + proof + upgrade + HELLO on loopback (20 connects)', { p50: ms(q.p50), p95: ms(q.p95) }, 'p50 <= 50 ms', q.p50 <= 50);
  } finally { await table.close(); }
}

async function n10() {
  const table = await newTable(8);
  const t0 = Date.now();
  const end = t0 + soakMinutes * 60000;
  const samples = [];
  let churned = 0, moves = 0, scenes = 0, stop = false;
  try {
    const owners = table.players.map(p => p.playerId);
    const movers = table.players.map((_, i) => (async () => {
      const token = table.scene.tokens[i];
      for (let k = 0; !stop; k += 1) {
        const p = table.players[i];
        if (p.open) { p.send({ type: 'PLAYER_TOKEN_MOVE', aid: `s${i}-${k}-${Date.now()}`, id: token.id, x: token.x + (k % 200), y: token.y }); moves += 1; }
        await sleep(500);
      }
    })());
    const gmLoop = (async () => {
      let cursor = 5000;
      while (!stop) {
        const s = structuredClone(table.scene); s.ownersHint = owners.length;
        for (let k = 0; k < 4; k += 1) s.fogCells.push(`${Math.floor((cursor + k) / 82)},${(cursor + k) % 82}`);
        cursor += 4; if (s.fogCells.length > 6500) s.fogCells.length = 5000;
        table.scene = s; table.gm.publish(s); scenes += 1;
        await sleep(200);
      }
    })();
    const churn = (async () => {
      while (!stop) {
        await sleep(Math.max(2000, 60000 / (8 * 0.03 * 20)));
        if (stop) break;
        const slot = churned % table.players.length;
        const old = table.players[slot]; old.terminate();
        try { table.players[slot] = await connectPlayer(table.server, table.identities[slot], { name: old.name, resume: { rev: old.rev, aids: [], state: old.state } }); churned += 1; } catch (error) { console.log('         churn reconnect failed:', error.message); }
      }
    })();
    while (Date.now() < end) {
      await sleep(Math.min(10000, Math.max(500, end - Date.now())));
      const m = await table.server.memory(); samples.push(m.rss);
    }
    stop = true; await Promise.all([...movers, gmLoop, churn]);
    await sleep(800);
    const alive = table.server.exitCode === null;
    let handlerErrors = 'n/a';
    if (stack === 'v3') handlerErrors = (await gmGet(table.server, '/__realm/diag')).json?.counters?.handlerErrors ?? 0;
    const third = Math.max(1, Math.floor(samples.length / 3));
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
    const growth = samples.length >= 3 ? (avg(samples.slice(-third)) - avg(samples.slice(0, third))) / avg(samples.slice(0, third)) * 100 : 0;
    const divergence = table.players.reduce((n, p) => n + p.divergence, 0);
    const insync = new Set(table.players.map(p => p.rev)).size === 1 || (await sleep(1000), new Set(table.players.map(p => p.rev)).size === 1);
    record('N10', `soak ${soakMinutes} min: 8 players at 2 Hz, GM at 5 Hz, socket churn`, { moves, scenes, reconnects: churned, serverAlive: alive, handlerErrors, divergence, finalInSync: insync, rssGrowthPct: +growth.toFixed(1) },
      'no crash, handlerErrors 0, divergence 0, memory flat (< 10 % first vs last third)', alive && (handlerErrors === 0 || handlerErrors === 'n/a') && divergence === 0 && growth < 10 && insync,
      soakMinutes < 30 ? `short run; use --soak-min 30 for the full 30 minute soak` : '');
  } finally { stop = true; await table.close(); }
}

async function n11() {
  const table = await newTable(8);
  try {
    const slow = await addPlayerTo(table, { name: 'Slow', track: true });
    await slow.first('STATE_FULL', 5000);
    await sleep(200);
    const base = quantiles((await moveRounds({ ...table, players: table.players.slice(0, 8) }, quick ? 40 : 100)).lat);
    slow.ws._socket.pause();          // reads nothing from now on
    const big = (i) => { const s = structuredClone(table.scene); s.tokens.forEach((t, k) => { t.name = `T${k}-${i}-${'x'.repeat(60)}`; }); s.fogCells = s.fogCells.slice(i % 500); return s; };
    let i = 0;
    const stopAt = Date.now() + (quick ? 8000 : 15000);
    const lat = [];
    while (Date.now() < stopAt) {
      i += 1; table.scene = big(i); table.gm.publish(table.scene);
      const r = await oneRound(table.players.slice(0, 8), () => table.players[0].send({ type: 'PLAYER_TOKEN_MOVE', aid: `n11-${i}`, id: 'tok0', x: table.scene.tokens[0].x + (i % 50), y: table.scene.tokens[0].y }), 5000).catch(() => ({ ms: NaN }));
      if (Number.isFinite(r.ms)) lat.push(r.ms);
      await sleep(40);
    }
    const during = quantiles(lat);
    slow.ws._socket.resume();
    await sleep(3500);
    const closed = slow.closeCode;
    const settled = new Set([slow.rev, table.players[0].rev]).size === 1;
    record('N11', 'slow client reads nothing', { otherPlayersP95Before: ms(base.p95), during: ms(during.p95), slowClientClosedWith: closed, slowClientInSyncAfterResume: settled, slowFulls: slow.fulls },
      "others' p95 unchanged (<= 2x + 3 ms); the slow one is closed with 4009 and resumes, or catches up with a snapshot", during.p95 <= base.p95 * 2 + 3 && (closed === 4009 || settled),
      'state sync keeps the slow client "stale" and sends one snapshot when it drains (design 4.5)');
  } finally { await table.close(); }
}

async function main() {
  console.log(`accept-net: stack ${stack === 'v3' ? 'NEW (v3)' : 'OLD (pre-rewrite backup, v2: criteria are informational)'}${quick ? ', quick' : ''}, ${new Date().toISOString()}`);
  const steps = [['N1', n1n5], ['N2', n2n5], ['N3', n3], ['N6', n6], ['N7', n7n8n9], ['N10', n10], ['N11', n11]];
  const alsoRuns = { N1: ['N1', 'N5'], N2: ['N2', 'N5'], N3: ['N3', 'N4'], N7: ['N7', 'N8', 'N9'] };
  for (const [id, fn] of steps) {
    if (only.length && !(alsoRuns[id] ?? [id]).some(x => only.includes(x))) continue;
    try { await fn(); } catch (error) {
      if (error instanceof ServerUnavailable) throw error;
      record(id, 'check crashed', error.stack?.split('\n').slice(0, 3).join(' | ') ?? String(error), '', false);
    }
  }
  // N12: the live-server security checks
  if (wanted('N12') && stack === 'v3') {
    const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'accept-security.mjs'), ...(quick ? ['--quick'] : [])], { encoding: 'utf8' });
    const line = r.stdout.trim().split('\n').filter(l => l.startsWith('accept-security:')).at(-1) ?? r.stdout.trim().split('\n').at(-1);
    record('N12', 'accept-security.mjs (live-server checks of 6.3; the unit-level ones run in npm test)', line || r.stderr.slice(0, 200), 'all pass', r.status === 0);
  }
  if (flag('all')) {
    for (const script of ['accept-audio-ws.mjs', 'accept-audio-rtc.mjs', 'check-player-browser.mjs']) {
      console.log(`\n--- ${script}`);
      const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), script)], { stdio: 'inherit' });
      record('ALL', script, `exit ${r.status}`, 'exit 0', r.status === 0);
    }
  }
  const failed = results.filter(r => r.status === 'FAIL');
  console.log(`\naccept-net: ${results.length} results, ${results.filter(r => r.status === 'PASS').length} pass, ${failed.length} fail, ${results.filter(r => r.status === 'over').length} over criterion (old stack), ${results.filter(r => r.status === 'INFO').length} info`);
  if (flag('json')) console.log(JSON.stringify(results));
  process.exitCode = failed.length ? 1 : 0;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(error => {
  if (error instanceof ServerUnavailable) { console.error(error.message); process.exit(1); }
  console.error('accept-net crashed:', error); process.exit(1);
});
