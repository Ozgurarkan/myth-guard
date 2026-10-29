#!/usr/bin/env node
// Combat stress test: a whole fight at a table with 10 devices (default), over real sockets against the real server.
//
//   node scripts/stress-combat.mjs                 10 devices, 3 rounds, loopback
//   node scripts/stress-combat.mjs --wifi          4 of the devices sit behind a "bad home Wi-Fi" link (delay, jitter, loss, stalls)
//   node scripts/stress-combat.mjs --devices=12 --rounds=5
//   node scripts/stress-combat.mjs --quick         2 rounds
//
// What it plays: a goblin ambush. Ten heroes (one per device) and twenty creatures (three of them hidden from the players) on
// a 4096 x 4096 map with thousands of fog squares. Every turn the GM moves the order on and applies damage and fog; on a hero's
// turn that player drags their token (a stream of moves), pings, and ends the turn, which the GM then acts on. During the fight:
// a handout is revealed and hidden, two phones drop off the network and come back, and one phone freezes for a few seconds.
//
// What it measures: how long every action takes to reach every other device, bytes sent, snapshot/patch counts, whether any
// device ever disagrees with the server, whether anything hidden ever reaches a player, rejected or lost actions, and the
// server's CPU, memory and event-loop delay while all this happens.
//
// Everything runs on this computer over loopback, so it measures the SERVER and the protocol, not your router or your phones.
// `--wifi` adds a delay/jitter/loss model to some links; real phones and real Wi-Fi are still the only real test.
// The server runs in its own process on a free port (never 5173) with a temporary data folder.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startTable, makeScene, joinDevice, connectPlayer, quantiles, sleep, stateHash, ROOT } from '../test-support/table.js';
import { createTcpImpair } from '../test-support/tcpImpair.js';

// ── options ──────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const hit = args.find(a => a.startsWith(`--${name}=`)); return hit ? Number(hit.split('=')[1]) : fallback; };
const DEVICES = Math.max(3, option('devices', 10));
const ROUNDS = flag('quick') ? 2 : Math.max(1, option('rounds', 3));
const WIFI = flag('wifi');
const CREATURES = 20;
const HIDDEN = 3;
const IMPAIRED = WIFI ? new Set([DEVICES - 1, DEVICES - 2, DEVICES - 3, DEVICES - 4].filter(i => i >= 0)) : new Set();
const ms = value => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const rand = (low, high) => low + Math.floor(Math.random() * (high - low + 1));
const pick = list => list[Math.floor(Math.random() * list.length)];

// What must never reach a player.
const CANARY_NAME = 'HIDDEN-CANARY';
const secretHp = hp => hp >= 91 && hp <= 140;   // creature hit points are in this range; heroes' are not

// ── set up the table ─────────────────────────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'rf-stress-'));
const table = await startTable({ stack: 'v3', players: 0, child: true, dataDir }).catch(error => {
  console.error(`Cannot start the server: ${error.message}`);
  process.exit(2);
});
const { server, gm } = table;
const proxies = [];
const players = [];
const identities = [];
const names = Array.from({ length: DEVICES }, (_, i) => `Hero${i + 1}`);

for (let i = 0; i < DEVICES; i += 1) {
  const identity = await joinDevice(server, table.invite.invite, { name: names[i] });
  identities.push(identity);
  let link = server;
  if (IMPAIRED.has(i)) {
    const proxy = createTcpImpair({ targetPort: server.port });
    await proxy.listen();
    Object.assign(proxy.state, { baseMs: 14, jitterMs: 26, loss: 0.01, upBaseMs: 10, upJitterMs: 14 });
    proxies.push(proxy);
    link = { ...server, port: proxy.port };
  }
  players.push(await connectPlayer(link, identity, { name: names[i] }));
}
if (proxies.length) {
  // every few seconds the bad links stall for a moment, like a phone changing access point
  const stallTimer = setInterval(() => { for (const proxy of proxies) if (Math.random() < 0.5) proxy.stall(rand(250, 700)); }, 4500);
  stallTimer.unref();
}

// ── the scene ────────────────────────────────────────────────────────────────────────────────────
const owners = players.map(p => p.playerId);
const scene = makeScene({ fog: 3000, tokens: DEVICES + CREATURES, owners, extra: { handoutSrc: null, handoutName: '' } });
scene.gridSize = 50;
const tokenOfHero = i => scene.tokens[i];
scene.tokens.forEach((token, i) => {
  if (i < DEVICES) {
    Object.assign(token, { name: names[i], characterType: 'pc', ownerId: owners[i], x: 3100 + (i % 5) * 60, y: 3300 + Math.floor(i / 5) * 60, visibleToPlayers: true, color: '#a58bff' });
  } else {
    const k = i - DEVICES;
    const hidden = k >= CREATURES - HIDDEN;
    Object.assign(token, {
      name: hidden ? `${CANARY_NAME}-${k}` : `Goblin ${k + 1}`, characterType: 'npc', ownerId: null,
      x: 3600 + (k % 8) * 55, y: 3000 + Math.floor(k / 8) * 55, visibleToPlayers: !hidden, color: '#e0384f',
    });
  }
});
const entries = scene.tokens.map((token, i) => {
  const hero = i < DEVICES;
  const maxHp = hero ? rand(30, 60) : rand(91, 140);
  return { tokenId: token.id, initiative: hero ? rand(8, 22) : rand(4, 18), hp: maxHp, maxHp };
});
scene.combat = { entries, activeId: null, round: 1 };
const order = [...entries].sort((a, b) => b.initiative - a.initiative);
const entryOf = id => scene.combat.entries.find(e => e.tokenId === id);
const heroIndex = id => (id.startsWith('tok') && Number(id.slice(3)) < DEVICES ? Number(id.slice(3)) : -1);

// publishing: like the GM window, at most one scene every 40 ms, coalesced
let publishTimer = null;
const publishSoon = () => { if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; gm.publish(scene); }, 40); };
const publishNow = () => { clearTimeout(publishTimer); publishTimer = null; gm.publish(scene); };

// ── instrumentation ──────────────────────────────────────────────────────────────────────────────
const lat = { move: [], moveBad: [], turn: [], turnBad: [], ping: [], pingBad: [], handout: [], handoutBad: [], moveFrozen: [], endTurn: [], endTurnAck: [] };
const counts = { movesSent: 0, movesNoticedByGm: 0, pingsSent: 0, pingsMissed: 0, moveMissed: 0, turnMissed: 0, endTurnsSent: 0, endTurnsHeard: 0, leaks: 0, rejected: {}, closes: [], reconnects: 0 };
const patchSizes = [];
const watchers = new Set();
const fullsBaseline = new Map();

function watch(peers, predicate, timeoutMs = 4000) {
  const t0 = performance.now();
  return new Promise(resolve => {
    const pending = new Set(peers);
    const times = new Map();
    const w = {
      check(peer, at) {
        if (pending.has(peer) && predicate(peer)) { pending.delete(peer); times.set(peer, at - t0); if (!pending.size) finish(); }
      },
    };
    const finish = () => { clearTimeout(timer); watchers.delete(w); resolve({ times, missing: [...pending] }); };
    const timer = setTimeout(finish, timeoutMs);
    watchers.add(w);
  });
}

// where two copies of the scene differ (first few places), to explain a checksum mismatch
function diffPaths(a, b, path = '', out = []) {
  if (out.length >= 6) return out;
  if (a === b) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) { out.push(`${path || '/'}: ${JSON.stringify(a)?.slice(0, 80)}  vs  ${JSON.stringify(b)?.slice(0, 80)}`); return out; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${path}: array vs object`); return out; }
  if (Array.isArray(a) && a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { if (out.length >= 6) break; diffPaths(a[k], b[k], `${path}/${k}`, out); }
  return out;
}
const divergenceNotes = [];

function instrument(peer, index) {
  const orig = peer.onFrame;
  peer.index = index;
  peer.pingSeen = new Set();
  peer.onFrame = (msg, at, data) => {
    const divergedBefore = peer.divergence;
    orig?.(msg, at, data);
    if (peer.divergence > divergedBefore) peer.wrongState = { state: peer.state, rev: msg.rev, patchBytes: data.length };
    if (msg.type === 'STATE_FULL' && peer.wrongState) {
      if (divergenceNotes.length < 3) divergenceNotes.push({ device: peer.index, rev: peer.wrongState.rev, differences: diffPaths(peer.wrongState.state, msg.state) });
      peer.wrongState = null;
    }
    if (msg.type === 'MAP_PING') peer.pingSeen.add(`${Math.round(msg.x)},${Math.round(msg.y)}`);
    if (msg.type === 'ACK' && msg.ok === false) counts.rejected[msg.reason ?? 'unknown'] = (counts.rejected[msg.reason ?? 'unknown'] ?? 0) + 1;
    if (msg.type === 'MOVE_REJECTED' || msg.type === 'TURN_REJECTED') counts.rejected[msg.reason ?? msg.type] = (counts.rejected[msg.reason ?? msg.type] ?? 0) + 1;
    if (msg.type === 'STATE_PATCH') patchSizes.push(data.length);
    if (msg.type === 'STATE_FULL' || msg.type === 'STATE_PATCH') {
      // anything the GM wants kept from players must never appear in what a player receives
      const text = data.toString('utf8');
      if (text.includes(CANARY_NAME)) counts.leaks += 1;
      for (const m of text.matchAll(/"maxHp":(\d+)/g)) if (secretHp(Number(m[1]))) { counts.leaks += 1; break; }
      for (const m of text.matchAll(/"hp":(\d+)/g)) if (secretHp(Number(m[1]))) { counts.leaks += 1; break; }
    }
    for (const w of [...watchers]) w.check(peer, at);
  };
  fullsBaseline.set(peer, peer.fulls);
}
players.forEach(instrument);

const send = (peer, message) => { try { peer.send(message); return true; } catch { return false; } };   // a phone that just dropped cannot be written to
const wifiPeers = () => players.filter(p => IMPAIRED.has(p.index));
const goodPeers = () => players.filter(p => !IMPAIRED.has(p.index));
const addTimes = (result, good, bad) => {
  for (const [peer, t] of result.times) (IMPAIRED.has(peer.index) ? bad : good).push(t);
  return result.missing.filter(p => p.open).length;
};

// let everybody receive the first snapshot
publishNow();
await Promise.all(players.map(p => p.first('STATE_FULL', 8000).catch(() => null)));
await sleep(400);
const joined = players.filter(p => p.state).length;
console.log(`${joined}/${DEVICES} devices connected and holding the scene${WIFI ? ` (${IMPAIRED.size} on a bad-Wi-Fi link)` : ''}`);
if (joined < DEVICES) { console.error('Not every device received the scene. Stopping.'); await table.close(); process.exit(1); }

// server sampling in the background
const baseMemory = await server.memory();
const samples = [];
const sampler = setInterval(async () => { try { samples.push({ at: Date.now(), ...(await server.memory()) }); } catch { /* ignore */ } }, 1000);
const gmFramesAtStart = gm.framesIn;
const bytesAtStart = players.map(p => p.bytesIn);
const startedAt = performance.now();

// ── the fight ────────────────────────────────────────────────────────────────────────────────────
let frozen = null;       // { peer, index }
let churnOutcome = [];
let freezeOutcome = null;
let handoutShown = false;
let fogCol = 0;
let lastPingAt = new Array(DEVICES).fill(0);
const currentPeers = () => players.filter(p => p !== frozen?.peer && p.open);

async function ping(peer, idx) {
  if (performance.now() - lastPingAt[idx] < 1000) return;      // the server allows one every 700 ms
  lastPingAt[idx] = performance.now();
  const x = rand(3000, 4000), y = rand(3000, 3700);
  const key = `${x},${y}`;
  const others = currentPeers().filter(p => p !== peer);
  const wait = watch(others, p => p.pingSeen.has(key), 3000);
  if (!send(peer, { type: 'PLAYER_PING', x, y })) return;
  counts.pingsSent += 1;
  counts.pingsMissed += addTimes(await wait, lat.ping, lat.pingBad);
}

async function dragHero(idx) {
  const peer = players[idx];
  const token = tokenOfHero(idx);
  const moves = rand(7, 11);
  let x = token.x, y = token.y;
  for (let i = 0; i < moves; i += 1) {
    x = Math.min(3990, Math.max(3105, x + rand(-45, 55)));
    y = Math.min(3650, Math.max(3105, y + rand(-35, 35)));
    const target = x * 10000 + y;
    const aim = { x, y };
    const others = currentPeers().filter(p => p !== peer);
    const wait = watch(others, p => { const t = p.state?.tokens?.find(k => k.id === token.id); return t && t.x === aim.x && t.y === aim.y; }, 3500);
    counts.movesSent += 1;
    if (!send(peer, { type: 'PLAYER_TOKEN_MOVE', aid: `m${idx}-${counts.movesSent}`, id: token.id, x, y })) { counts.movesSent -= 1; break; }
    token.x = x; token.y = y;                              // the GM's copy follows once the server forwards it; keep ours in step
    const result = await wait;
    counts.moveMissed += addTimes(result, frozen ? lat.moveFrozen : lat.move, lat.moveBad);
    await sleep(45);
  }
}

function gmTurnActions(entry) {
  // GM drives creatures: step a token, hit a hero, now and then paint or lift fog
  const token = scene.tokens.find(t => t.id === entry.tokenId);
  const isCreature = heroIndex(entry.tokenId) < 0;
  if (isCreature) { token.x = 3500 + rand(0, 450); token.y = 3000 + rand(0, 600); }
  const victim = entryOf(`tok${rand(0, DEVICES - 1)}`);
  if (isCreature && victim) victim.hp = Math.max(0, victim.hp - rand(1, 9));
  const target = entryOf(`tok${DEVICES + rand(0, CREATURES - 1)}`);
  if (!isCreature && target) target.hp = Math.max(0, target.hp - rand(2, 14));
  if (Math.random() < 0.6) { for (let i = 0; i < 30; i += 1) { fogCol += 1; scene.fogCells.push(`${fogCol % 40},${82 + Math.floor(fogCol / 40)}`); } }
  if (Math.random() < 0.15) scene.fogCells.splice(rand(0, 200), 25);
  if (Math.random() < 0.08) { const hid = scene.tokens[DEVICES + rand(0, CREATURES - 4)]; hid.visibleToPlayers = !hid.visibleToPlayers; }
}

async function churn(indices) {
  // phones lose their connection mid-fight and come back (the app resumes from the revision it holds)
  await Promise.all(indices.map(async idx => {
    const old = players[idx];
    const held = { rev: old.rev, state: old.state, aids: [] };
    old.terminate();
    await sleep(500);
    const t0 = performance.now();
    const link = IMPAIRED.has(idx) ? { ...server, port: proxies[[...IMPAIRED].sort().indexOf(idx)].port } : server;
    const fresh = await connectPlayer(link, identities[idx], { name: names[idx], resume: held });
    players[idx] = fresh;
    instrument(fresh, idx);
    counts.reconnects += 1;
    const target = Math.max(...currentPeers().filter(p => p !== fresh).map(p => p.rev ?? 0));
    const caught = await watch([fresh], p => (p.rev ?? 0) >= target, 5000);
    churnOutcome.push({ device: idx, caughtUpMs: caught.times.has(fresh) ? ms(performance.now() - t0) : null, fullSnapshots: fresh.fulls, patches: fresh.patches });
  }));
}

async function freezePhone(idx) {
  // one phone stops reading for a few seconds while the fight goes on (a locked screen, a bad moment)
  const peer = players[idx];
  const socket = peer.ws._socket;
  frozen = { peer, index: idx };
  socket.pause();
  const closedBefore = peer.closeCode;
  await sleep(3200);
  socket.resume();
  const t0 = performance.now();
  const target = Math.max(...players.filter(p => p !== peer && p.open).map(p => p.rev ?? 0));
  const result = await watch([peer], p => (p.rev ?? 0) >= target, 6000);
  frozen = null;
  freezeOutcome = {
    device: idx, closedByServer: peer.closeCode, caughtUpMs: result.times.has(peer) ? ms(result.times.get(peer)) : null,
    fullsAfter: peer.fulls, gaps: peer.gaps, stillOpen: peer.open && closedBefore === null,
  };
  if (!peer.open || freezeOutcome.caughtUpMs === null) {
    // the server dropped it (that is its protection for the others): the phone reconnects like the app does
    const held = { rev: peer.rev, state: peer.state, aids: [] };
    const again = await connectPlayer(server, identities[idx], { name: names[idx], resume: held });
    players[idx] = again; instrument(again, idx);
    const back = await watch([again], p => (p.rev ?? 0) >= target, 5000);
    freezeOutcome.reconnectedMs = back.times.has(again) ? ms(performance.now() - t0) : null;
    counts.reconnects += 1;
  }
}

const endTurnWaiters = [];
console.log(`Fight starts: ${DEVICES} heroes vs ${CREATURES} creatures (${HIDDEN} hidden), ${ROUNDS} rounds...`);
let turnNumber = 0;
const tasks = [];
for (let round = 1; round <= ROUNDS; round += 1) {
  for (const entry of order) {
    turnNumber += 1;
    scene.combat.activeId = entry.tokenId;
    scene.combat.round = round;
    gmTurnActions(entry);
    const seenByPlayers = scene.tokens.find(t => t.id === entry.tokenId)?.visibleToPlayers !== false;
    const goal = { id: seenByPlayers ? entry.tokenId : null, round };   // a hidden creature's turn is not announced to players
    const shown = p => p.state?.combat?.activeId === goal.id && p.state?.combat?.round === goal.round;
    if (currentPeers().every(shown)) publishNow();                      // nothing on the players' side changes: nothing to time
    else {
      const turnWatch = watch(currentPeers(), shown, 4000);
      publishNow();
      counts.turnMissed += addTimes(await turnWatch, lat.turn, lat.turnBad);
    }

    const idx = heroIndex(entry.tokenId);
    if (idx >= 0 && players[idx].open) {
      // the player's turn: drag, maybe ping, then end the turn
      await dragHero(idx);
      if (Math.random() < 0.7) await ping(players[idx], idx);
      const heard = gm.next('PLAYER_END_TURN', 3000);
      const t0 = performance.now();
      const sent = send(players[idx], { type: 'PLAYER_END_TURN', aid: `e${idx}-${turnNumber}`, tokenId: entry.tokenId });
      if (sent) counts.endTurnsSent += 1;
      try { await heard; if (sent) { counts.endTurnsHeard += 1; lat.endTurn.push(performance.now() - t0); } } catch { /* counted as missing */ }
    } else {
      // creature turn: the GM acts for a moment; the others sometimes ping at the monster
      await sleep(rand(60, 140));
      const idle = rand(0, DEVICES - 1);
      if (Math.random() < 0.25 && players[idle].open && players[idle] !== frozen?.peer) await ping(players[idle], idle);
    }

    // scripted trouble
    if (round === Math.min(2, ROUNDS) && turnNumber % order.length === 3 && !handoutShown) {
      handoutShown = true;
      scene.handoutSrc = `http://x/__realm/assets/${'b'.repeat(64)}`;
      scene.handoutName = 'A map of the sunken vault';
      const w = watch(currentPeers(), p => p.state?.handoutSrc === scene.handoutSrc, 3000);
      publishNow();
      counts.turnMissed += addTimes(await w, lat.handout, lat.handoutBad);
      await sleep(900);
      scene.handoutSrc = null; scene.handoutName = '';
      publishNow();
    }
    if (round === Math.min(2, ROUNDS) && turnNumber % order.length === 8) { tasks.push(churn([1, DEVICES - 2].filter(i => i >= 0))); }
    if (round === ROUNDS && turnNumber % order.length === 5) { tasks.push(freezePhone(DEVICES - 1)); }
    publishSoon();
  }
  console.log(`  round ${round} done (${((performance.now() - startedAt) / 1000).toFixed(0)} s)`);
}
await Promise.all(tasks);
publishNow();
await sleep(800);
clearInterval(sampler);

// ── results ──────────────────────────────────────────────────────────────────────────────────────
const wallSeconds = (performance.now() - startedAt) / 1000;
const finalMemory = await server.memory();
await server.gc();
await sleep(300);
const afterGc = await server.memory();
const mb = bytes => Math.round(bytes / 1048576 * 10) / 10;
const q = values => { const s = quantiles(values); return { n: s.n, p50: ms(s.p50), p95: ms(s.p95), p99: ms(s.p99), max: ms(s.max) }; };
const peakRss = Math.max(...samples.map(s => s.rss), finalMemory.rss);
const totalBytesIn = players.reduce((sum, p, i) => sum + p.bytesIn - (bytesAtStart[i] ?? 0), 0);
const patchStats = patchSizes.length ? quantiles(patchSizes) : null;
const divergence = players.reduce((n, p) => n + p.divergence, 0);
const gaps = players.reduce((n, p) => n + p.gaps, 0);
const unexpectedFulls = players.reduce((n, p) => n + Math.max(0, p.fulls - 1 - 0), 0);
const closedUnexpectedly = players.filter(p => !p.open).length;

// the GM's view: how many accepted moves were forwarded to it
counts.movesNoticedByGm = gm.byType.PLAYER_TOKEN_MOVE ?? 0;

// final agreement: every device ends up showing what the server shows
const finalHashes = players.map(p => (p.state ? stateHash(p.state) : null));
const agree = finalHashes.filter(h => h !== null && h === finalHashes[0]).length;

const results = [];
const check = (id, title, measured, criterion, pass) => results.push({ id, title, measured, criterion, pass });
const good = (arr) => (arr.length ? quantiles(arr) : null);
const gMove = good(lat.move), gTurn = good(lat.turn), gPing = good(lat.ping);

check('S1', `drag a token: arrives on the other ${DEVICES - 1 - IMPAIRED.size} good devices (${lat.move.length} samples)`, q(lat.move), 'p95 <= 40 ms, p99 <= 100 ms', gMove && gMove.p95 <= 40 && gMove.p99 <= 100);
check('S2', 'turn passes: every good device shows the new turn', q(lat.turn), 'p95 <= 60 ms', gTurn && gTurn.p95 <= 60);
check('S3', 'ping: shown on every other good device', q(lat.ping), 'p95 <= 40 ms', gPing && gPing.p95 <= 40);
check('S4', 'nothing lost: moves, pings, turn changes and end-turns all arrived', { movesMissed: counts.moveMissed, pingsMissed: counts.pingsMissed, turnMissed: counts.turnMissed, endTurnsHeard: `${counts.endTurnsHeard}/${counts.endTurnsSent}`, movesAtGm: `${counts.movesNoticedByGm}/${counts.movesSent}` },
  'all zero / all delivered (bad-Wi-Fi devices may be late but must arrive)', counts.moveMissed === 0 && counts.pingsMissed === 0 && counts.turnMissed === 0 && counts.endTurnsHeard === counts.endTurnsSent && counts.movesNoticedByGm >= counts.movesSent - Object.values(counts.rejected).reduce((a, b) => a + b, 0));
check('S5', 'privacy: hidden tokens and creature hit points never reached a player', { leakedFrames: counts.leaks }, '0', counts.leaks === 0);
check('S6', 'integrity: no device ever disagreed with the server', { divergence, patchGaps: gaps, devicesAgreeingAtEnd: `${agree}/${DEVICES}` }, 'divergence 0, all devices agree at the end', divergence === 0 && agree === DEVICES);
check('S7', 'rejected actions (should be none in a normal fight)', counts.rejected, 'none', Object.keys(counts.rejected).length === 0);
check('S8', 'phones that dropped and came back caught up', churnOutcome.map(o => ({ device: o.device, caughtUpMs: o.caughtUpMs, patchesNotFull: !o.usedFullSnapshot })), 'each caught up within 3 s', churnOutcome.length > 0 && churnOutcome.every(o => o.caughtUpMs !== null && o.caughtUpMs <= 3000));
check('S9', 'a frozen phone did not hurt anyone else, and recovered', { freeze: freezeOutcome, othersDuringFreezeP95: lat.moveFrozen.length ? q(lat.moveFrozen).p95 : null },
  'others p95 <= 100 ms; the phone caught up or was dropped and reconnected within 6 s', !!freezeOutcome && (freezeOutcome.caughtUpMs !== null || freezeOutcome.reconnectedMs != null) && (lat.moveFrozen.length === 0 || q(lat.moveFrozen).p95 <= 100));

let cpuNote = null;
try {
  const metrics = await server.metrics?.();
  if (metrics) {
    cpuNote = metrics;
    check('S10', 'server: event loop stayed responsive', { loopDelayP99Ms: ms(metrics.loop?.p99), loopDelayMaxMs: ms(metrics.loop?.max), cpuPercentOfOneCore: metrics.cpuPercent }, 'p99 delay <= 25 ms', (metrics.loop?.p99 ?? 0) <= 25);
  }
} catch { /* optional */ }
// RSS (what Task Manager shows) includes memory V8 has reserved and gives back lazily, so it is reported but not judged.
// What decides "leak or not" is the memory that still holds data after a full garbage collection.
const liveGrowth = mb(afterGc.heapUsed - baseMemory.heapUsed);
const externalGrowth = mb(afterGc.external - baseMemory.external);
check('S11', 'server memory: nothing piles up', {
  liveHeapGrowthMB: liveGrowth, externalGrowthMB: externalGrowth,
  info: { processStart: `${mb(baseMemory.rss)} MB`, processPeak: `${mb(peakRss)} MB`, processEnd: `${mb(finalMemory.rss)} MB`, processAfterGc: `${mb(afterGc.rss)} MB`, v8ReservedHeap: `${mb(afterGc.heapTotal)} MB (start ${mb(baseMemory.heapTotal)})` },
}, 'live heap and external memory growth <= 8 MB each after a full garbage collection', liveGrowth <= 8 && externalGrowth <= 8);
check('S12', 'traffic', { fightSeconds: Math.round(wallSeconds), receivedPerDeviceKB: Math.round(totalBytesIn / DEVICES / 1024), perDeviceKBps: Math.round(totalBytesIn / DEVICES / 1024 / wallSeconds * 10) / 10, patchBytes: patchStats ? { p50: patchStats.p50, p95: patchStats.p95, max: patchStats.max, count: patchStats.n } : null, fullSnapshots: players.reduce((n, p) => n + p.fulls, 0), unexpectedClosed: closedUnexpectedly }, 'about one snapshot per device (plus reconnects); no device closed', closedUnexpectedly === 0);
if (WIFI) {
  const gBad = (arr) => (arr.length ? q(arr) : null);
  check('W1', `bad-Wi-Fi devices (${IMPAIRED.size}): drag, turn and ping still arrive`, { move: gBad(lat.moveBad), turn: gBad(lat.turnBad), ping: gBad(lat.pingBad) }, 'informational (14 ms base, 26 ms jitter, 1% loss, stalls up to 0.7 s)', null);
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
const failed = results.filter(r => r.pass === false);
if (divergenceNotes.length) { console.log('\nFirst disagreements (device / revision / how the device copy differed from the server copy):'); for (const note of divergenceNotes) console.log('  ', JSON.stringify(note)); }
const lines = [];
lines.push(`# Combat stress test`, '', `${new Date().toISOString()}  |  ${DEVICES} devices, ${ROUNDS} rounds, ${DEVICES} heroes vs ${CREATURES} creatures (${HIDDEN} hidden)${WIFI ? `, ${IMPAIRED.size} devices on a simulated bad Wi-Fi link` : ', loopback only'}`, '',
  'Runs on this computer over loopback, so it measures the server and the protocol, not your router or phones.', '', '| | Check | Result | Criterion | |', '|---|---|---|---|---|');
for (const r of results) lines.push(`| ${r.id} | ${r.title} | \`${JSON.stringify(r.measured)}\` | ${r.criterion} | ${r.pass === null ? 'info' : r.pass ? 'PASS' : '**FAIL**'} |`);
lines.push('', failed.length ? `**${failed.length} check(s) failed.**` : '**All checks passed.**');
const report = lines.join('\n');
for (const r of results) console.log(`${r.pass === null ? 'INFO' : r.pass ? 'PASS' : 'FAIL'} ${r.id.padEnd(4)} ${r.title}\n         ${JSON.stringify(r.measured)}   [${r.criterion}]`);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : '\nAll checks passed');
mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(join(ROOT, 'docs', WIFI ? 'stress-combat-report-wifi.md' : 'stress-combat-report.md'), report + '\n');
console.log(`Report saved to docs/${WIFI ? 'stress-combat-report-wifi.md' : 'stress-combat-report.md'}`);

for (const proxy of proxies) await proxy.close?.();
await table.close();
process.exit(failed.length ? 1 : 0);
