import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateSync, canonicalJson, stateSum } from '../server/net/stateSync.js';
import { createSession } from '../server/net/session.js';
import { createFakeClock } from '../server/net/clock.js';
import { createFakeSocket } from '../test-support/fakeSocket.js';
import { createFakeMetrics } from '../test-support/fakeAccess.js';
import { applyPatch } from '../src/syncPatch.js';
import { projectForPlayers } from '../src/playerView.js';
import { CLOSE, LIMITS } from '../src/net/protocol.js';

const HASH = 'a'.repeat(64);
const baseScene = () => ({
  mapImageSrc: `/__realm/assets/${HASH}`, mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [],
  playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
  tokens: [
    { id: 'hero', name: 'Aria', x: 0, y: 0, gridSize: 1, imageSrc: '/img/a', visibleToPlayers: true, notes: 'GM ONLY' },
    { id: 'ambusher', name: 'Hidden Assassin', x: 100, y: 0, gridSize: 1, visibleToPlayers: false },
  ],
  markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 },
  stageX: 0, stageY: 0, stageScale: 1, selectedId: null,
});

function setup({ revBase = 1000 } = {}) {
  const clock = createFakeClock();
  const metrics = createFakeMetrics();
  const sync = createStateSync({ clock, metrics, revBase });
  let count = 0;
  const join = (rev = null, attach = true) => {
    const socket = createFakeSocket();
    const session = createSession({ socket, role: 'player', clock, metrics, auth: { device: String(count++).padStart(32, '0'), playerId: `p${count}` } });
    socket.on('close', () => session.markClosed());
    const frames = () => socket.sent.map(entry => JSON.parse(entry.data));
    const result = attach ? sync.attach(session, rev) : null;
    return { socket, session, frames, result };
  };
  return { clock, metrics, sync, join };
}

test('the first scene reaches every attached player as one filtered STATE_FULL', () => {
  const { sync, join } = setup();
  const a = join();
  const b = join();
  assert.equal(a.result, 'waiting');
  sync.setScene(baseScene());
  for (const p of [a, b]) {
    const [full] = p.frames();
    assert.equal(full.type, 'STATE_FULL');
    assert.equal(full.rev, 1001);
    assert.deepEqual(full.state.tokens.map(t => t.id), ['hero']);
    const text = p.socket.sent[0].data;
    assert.equal(text.includes('Hidden Assassin'), false);
    assert.equal(text.includes('GM ONLY'), false);
  }
});

test('panning and zooming the GM view publishes nothing; a token move is one small patch on the right base', () => {
  const { sync, join } = setup();
  const p = join();
  sync.setScene(baseScene());
  const rev = sync.rev;
  sync.setScene({ ...baseScene(), stageX: 40, stageScale: 2, selectedId: 'hero' });
  assert.equal(sync.rev, rev);
  assert.equal(p.frames().length, 1);

  const moved = baseScene();
  moved.tokens[0].x = 150;
  sync.setScene(moved);
  const patch = p.frames()[1];
  assert.equal(patch.type, 'STATE_PATCH');
  assert.equal(patch.base, rev);
  assert.equal(patch.rev, rev + 1);
  assert.deepEqual(Object.keys(patch.patch), ['coll']);
  assert.deepEqual(patch.patch.coll.tokens.put.map(t => t.x), [150]);
  assert.ok(p.socket.sent[1].data.length < 300);

  const revealed = { ...moved, tokens: moved.tokens.map(t => ({ ...t, visibleToPlayers: true })) };
  sync.setScene(revealed);
  assert.ok(p.frames()[2].patch.coll.tokens.put.some(t => t.id === 'ambusher'), 'revealing publishes the token');
});

test('a late joiner is served from the server copy; the first scene after an empty start reaches waiting players', () => {
  const { sync, join } = setup();
  sync.setScene(baseScene());
  const late = join();
  assert.equal(late.result, 'full');
  assert.equal(late.frames()[0].state.tokens[0].name, 'Aria');
  assert.equal(late.session.syncedRev, sync.rev);
});

test('resume: N revisions behind gets exactly N patches in order; current gets nothing; too far behind gets a snapshot', () => {
  const { sync, join, metrics } = setup();
  sync.setScene(baseScene());
  const first = sync.rev;
  const scene = baseScene();
  for (let i = 1; i <= 20; i++) { scene.tokens[0].x = i * 10; sync.setScene(structuredClone(scene)); }
  assert.equal(sync.rev, first + 20);

  const current = join(sync.rev);
  assert.equal(current.result, 'current');
  assert.equal(current.frames().length, 0);

  const ten = join(sync.rev - 10);
  assert.equal(ten.result, 'patches');
  assert.deepEqual(ten.frames().map(f => f.rev), Array.from({ length: 10 }, (_, i) => sync.rev - 9 + i));
  assert.ok(ten.frames().every(f => f.type === 'STATE_PATCH'));
  assert.ok(ten.socket.sent.reduce((n, e) => n + e.bytes, 0) < 5 * 1024, 'ten patches are far smaller than a snapshot');

  const edge = join(sync.rev - LIMITS.resumeMaxPatches);
  assert.equal(edge.result, 'patches');
  assert.equal(edge.frames().length, LIMITS.resumeMaxPatches);

  const far = join(sync.rev - LIMITS.resumeMaxPatches - 1);
  assert.equal(far.result, 'full');
  assert.equal(far.frames().length, 1);
  assert.equal(far.frames()[0].type, 'STATE_FULL');

  assert.equal(join(null).result, 'full');
  assert.equal(join(sync.rev + 5).result, 'full', 'a revision from the future (an older server run) is never trusted');
  assert.equal(join(first - 1).result, 'full', 'before the first snapshot there is no patch to replay');
  assert.ok(metrics.count('sync.resumePatches') >= 2);
});

test('the patch history keeps the last 64: older revisions fall back to a snapshot', () => {
  const { sync, join } = setup();
  sync.setScene(baseScene());
  const scene = baseScene();
  for (let i = 1; i <= 100; i++) { scene.tokens[0].x = i; sync.setScene(structuredClone(scene)); }
  assert.equal(sync.historyLength, LIMITS.patchHistory);
  assert.equal(join(sync.rev - 5).result, 'patches');
  assert.equal(join(sync.rev - 70).result, 'full');
});

test('revisions start at a random point, so a phone from an earlier server run never looks current', () => {
  const a = createStateSync({});
  const b = createStateSync({});
  a.setScene(baseScene()); b.setScene(baseScene());
  assert.notEqual(a.rev, b.rev);
  assert.ok(Number.isSafeInteger(a.rev) && a.rev > 0);
});

test('a player that cannot keep up is skipped, marked stale, given one snapshot when it drains, and closed if it never does', () => {
  const { sync, join, clock, metrics } = setup();
  sync.setScene(baseScene());
  const slow = join();
  const fast = join();
  slow.socket.test.setBuffered(LIMITS.backlogStopBytes + 1);
  const scene = baseScene();
  scene.tokens[0].x = 10; sync.setScene(structuredClone(scene));
  scene.tokens[0].x = 20; sync.setScene(structuredClone(scene));
  assert.equal(slow.session.stale, true);
  assert.equal(slow.frames().length, 1, 'no patches queued for the slow phone');
  assert.equal(fast.frames().length, 3, 'the others never wait');

  sync.tick();
  assert.equal(slow.frames().length, 1, 'still backed up: nothing is sent');
  slow.socket.test.setBuffered(LIMITS.backlogResumeBytes - 1);
  sync.tick();
  const frames = slow.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].type, 'STATE_FULL');
  assert.equal(frames[1].rev, sync.rev);
  assert.equal(slow.session.stale, false);
  assert.equal(slow.session.syncedRev, sync.rev);

  // follows patches again afterwards
  scene.tokens[0].x = 30; sync.setScene(structuredClone(scene));
  assert.equal(slow.frames().at(-1).type, 'STATE_PATCH');

  // never drains: closed with 4009
  slow.socket.test.setBuffered(LIMITS.backlogStopBytes * 4);
  scene.tokens[0].x = 40; sync.setScene(structuredClone(scene));
  assert.equal(slow.session.stale, true);
  clock.advance(LIMITS.slowCloseMs);
  sync.tick();
  assert.equal(slow.socket.closed.code, CLOSE.SLOW);
  assert.equal(metrics.count('sessions.slow'), 1);
  assert.equal(fast.socket.closed, null);
});

test('a session that missed a revision (not just a busy one) is repaired with a snapshot, not left diverged', () => {
  const { sync, join } = setup();
  sync.setScene(baseScene());
  const p = join();
  p.session.syncedRev = sync.rev - 7;           // something went wrong for this socket
  const scene = baseScene(); scene.tokens[0].x = 5;
  sync.setScene(scene);
  assert.equal(p.frames().length, 1, 'no patch is applied on top of the wrong base');
  assert.equal(p.session.stale, true);
  sync.tick();
  assert.equal(p.frames().at(-1).type, 'STATE_FULL');
});

test('scenes that arrive in the same turn are coalesced: only the newest is processed', async () => {
  const { sync, join } = setup();
  const p = join();
  sync.setScene(baseScene());
  const rev = sync.rev;
  for (let x = 1; x <= 5; x++) { const s = baseScene(); s.tokens[0].x = x; sync.setScene(s, { defer: true }); }
  assert.equal(p.frames().length, 1, 'nothing is processed yet');
  assert.equal(sync.view.tokens[0].x, 5, 'reading the state flushes the queued scene first');
  assert.equal(sync.rev, rev + 1, 'five scenes, one revision');
  const s = baseScene(); s.tokens[0].x = 99;
  sync.setScene(s, { defer: true });
  await Promise.resolve();                       // without anyone reading, the microtask flushes it
  assert.equal(p.frames().at(-1).patch.coll.tokens.put[0].x, 99);
});

test('mutate() applies an accepted player move to the server copy and publishes it at once', () => {
  const { sync, join } = setup();
  assert.equal(sync.mutate(() => {}), false, 'nothing to change before a scene exists');
  sync.setScene(baseScene());
  const p = join();
  assert.equal(sync.mutate(scene => { scene.tokens[0].x = 321; }), true);
  assert.equal(p.frames().at(-1).patch.coll.tokens.put[0].x, 321);
  assert.equal(sync.scene.tokens[0].x, 321);
  assert.equal(sync.mutate(() => { throw new Error('boom'); }), false);
});

test('a snapshot request is honoured at once, a second within 2 s is delivered when the 2 s are up', () => {
  const { sync, join, clock } = setup();
  sync.setScene(baseScene());
  const p = join();
  clock.advance(100);
  assert.equal(sync.requestFull(p.session), false, 'the attach snapshot was 100 ms ago');
  assert.equal(p.frames().length, 1);
  sync.tick();
  assert.equal(p.frames().length, 1);
  clock.advance(1900);
  sync.tick();
  assert.equal(p.frames().length, 2, 'delivered by the next tick after the gap');
  assert.equal(sync.requestFull(p.session), false);
  clock.advance(2000);
  assert.equal(sync.requestFull(p.session), true);
});

test('every 50th revision carries a checksum that a client replaying the patches reproduces', () => {
  const { sync, join } = setup({ revBase: 0 });
  const p = join();
  const scene = baseScene();
  sync.setScene(structuredClone(scene));
  for (let i = 1; i <= 120; i++) {
    if (i % 3 === 0) scene.fogCells = [...scene.fogCells, `${i},${i}`];
    scene.tokens[0].x = i;
    scene.tokens[0].color = i % 2 ? undefined : '#fff'; // keys appearing and vanishing change key order on a client
    sync.setScene(structuredClone(scene));
  }
  let client = null;
  const sums = [];
  for (const frame of p.frames()) {
    if (frame.type === 'STATE_FULL') client = frame.state;
    else {
      client = applyPatch(client, frame.patch);
      if (frame.sum !== undefined) { sums.push(frame.rev); assert.equal(frame.sum, stateSum(client), `checksum at ${frame.rev}`); }
    }
  }
  assert.deepEqual(sums, [50, 100]);
  assert.equal(canonicalJson(client), canonicalJson(sync.view));
});

test('canonicalJson ignores key order and undefined values', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }, null] }), canonicalJson({ a: [{ c: undefined, d: 1 }, null], b: 1 }));
  assert.equal(canonicalJson({ a: undefined }), '{}');
  assert.equal(canonicalJson('x'), '"x"');
  assert.notEqual(stateSum({ a: 1 }), stateSum({ a: 2 }));
});

test('a scene that cannot be projected is rejected and the table keeps the last good one', () => {
  const { sync, join, metrics } = setup();
  sync.setScene(baseScene());
  const p = join();
  const rev = sync.rev;
  assert.equal(sync.setScene({ tokens: [null], gridSize: 50 }), false);
  assert.equal(sync.rev, rev);
  assert.equal(p.frames().length, 1);
  assert.equal(metrics.count('sync.sceneRejected'), 1);
  assert.equal(sync.view.tokens[0].id, 'hero');
});

test('closed sessions are forgotten at the next tick', () => {
  const { sync, join } = setup();
  sync.setScene(baseScene());
  const p = join();
  assert.equal(sync.size, 1);
  p.socket.terminate();
  sync.tick();
  assert.equal(sync.size, 0);
});

test('pinnedHashes lists every asset the raw scene refers to, hidden or not, and is cached per scene', () => {
  const { sync } = setup();
  assert.equal(sync.pinnedHashes().size, 0);
  const scene = baseScene();
  scene.tokens[0].imageSrc = `http://127.0.0.1:5173/__realm/assets/${'b'.repeat(64)}`;
  scene.handoutSrc = `/__realm/assets/${'c'.repeat(64)}`;
  scene.tokens[1].notes = '/__realm/assets/not-a-hash';
  sync.setScene(scene);
  const first = sync.pinnedHashes();
  assert.deepEqual([...first].sort(), [HASH, 'b'.repeat(64), 'c'.repeat(64)]);
  assert.equal(sync.pinnedHashes(), first);
});

test('property: a client that resumes from any recent revision ends up exactly where a live client is', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const { sync, join } = setup({ revBase: 5 });
  const scene = baseScene();
  for (let i = 0; i < 6; i++) scene.tokens.push({ id: `t${i}`, name: `T${i}`, x: i * 50, y: 0, gridSize: 1, visibleToPlayers: true, ownerId: 'p1' });
  sync.setScene(structuredClone(scene));
  const live = join();
  const snapshots = new Map([[sync.rev, canonicalJson(sync.view)]]);
  for (let step = 0; step < 150; step++) {
    const token = scene.tokens[Math.floor(random() * scene.tokens.length)];
    const roll = random();
    if (roll < 0.4) { token.x = Math.floor(random() * 2000); token.y = Math.floor(random() * 1500); }
    else if (roll < 0.55) token.visibleToPlayers = !token.visibleToPlayers;
    else if (roll < 0.7) scene.fogCells = random() < 0.5 ? [...scene.fogCells, `${Math.floor(random() * 40)},${Math.floor(random() * 30)}`] : scene.fogCells.slice(1);
    else if (roll < 0.8) scene.markers = random() < 0.5 ? [...scene.markers, { id: `m${step}`, type: 'star', x: 1, y: 1, visibleToPlayers: random() < 0.5, label: 'L' }] : scene.markers.slice(1);
    else if (roll < 0.9) scene.areaEffects = random() < 0.5 ? [...scene.areaEffects, { id: `a${step}`, type: 'circle', x: 5, y: 5, radius: 20, color: '#f00', gmOnly: 'SECRET' }] : scene.areaEffects.slice(1);
    else scene.tokens = [...scene.tokens].reverse();
    sync.setScene(structuredClone(scene));
    snapshots.set(sync.rev, canonicalJson(sync.view));
  }
  const apply = frames => {
    let state = null;
    for (const frame of frames) state = frame.type === 'STATE_FULL' ? frame.state : applyPatch(state, frame.patch);
    return state;
  };
  assert.equal(canonicalJson(apply(live.frames())), canonicalJson(sync.view));
  for (const behind of [1, 2, 5, 16, 17, 40, 64, 65, 149]) {
    const from = sync.rev - behind;
    const known = snapshots.get(from);
    const joiner = join(from);
    // The client holds the state of revision `from`, then applies what it is sent.
    const frames = joiner.frames();
    if (joiner.result === 'full') assert.equal(canonicalJson(apply(frames)), canonicalJson(sync.view));
    else {
      let state = JSON.parse(known);
      for (const frame of frames) state = applyPatch(state, frame.patch);
      assert.equal(canonicalJson(state), canonicalJson(sync.view), `resumed from ${behind} behind`);
    }
  }
  assert.equal(JSON.stringify(live.frames()).includes('SECRET'), false);
  assert.equal(projectForPlayers(scene).areaEffects.every(e => !('gmOnly' in e)), true);
});
