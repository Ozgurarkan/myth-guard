// The canary test (design 3.8 / F1-F5): every GM-only field of every collection holds a unique marker, and every byte
// that any player socket receives - snapshot, patches, resume, reconnect, pings - is searched for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHub } from '../server/net/hub.js';
import { createStateSync } from '../server/net/stateSync.js';
import { createSession } from '../server/net/session.js';
import { createFakeSocket } from '../test-support/fakeSocket.js';
import { startTable } from '../test-support/fakeAccess.js';
import { projectForPlayers } from '../src/playerView.js';

const NPC_HP = 424242;
const NPC_MAX = 818181;

const secretToken = (id, extra = {}) => ({
  id, x: 100, y: 100, gridSize: 1, ownerId: undefined,
  notes: 'CANARY-token-notes', gmNotes: 'CANARY-token-gmNotes', npcId: 'CANARY-npcId', portraitSource: 'CANARY-portraitSource',
  secretLabel: 'CANARY-token-secretLabel', maxHp: NPC_MAX, hp: NPC_HP, ...extra,
});

function canaryScene(alice) {
  return {
    mapImageSrc: '/__realm/assets/map', mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: ['30,30'],
    playerCanMoveTokens: true, showGrid: true, snapToGrid: true,
    gmNotes: 'CANARY-scene-gmNotes', stageX: 5, selectedId: 'CANARY-hidden-id', activeAreaColor: 'CANARY-scene-color',
    playerViewRect: { x: 1, y: 2, width: 300, height: 200, secret: 'CANARY-viewrect' },
    tokens: [
      secretToken('hero', { name: 'Aria', ownerId: alice, visibleToPlayers: true, characterType: 'pc', x: 0, y: 0, hp: 8, maxHp: 20 }),
      secretToken('goblin', { name: 'Goblin', visibleToPlayers: true, characterType: 'npc', x: 200, y: 0 }),
      secretToken('CANARY-hidden-id', { name: 'CANARY-hidden-name', visibleToPlayers: false, characterType: 'npc', x: 300, y: 0 }),
      secretToken('fogged', { name: 'Lurker', visibleToPlayers: true, characterType: 'npc', x: 1500, y: 1500 }), // under fog cell 30,30
      secretToken('flipper', { name: 'Flipper', visibleToPlayers: false, characterType: 'npc', x: 400, y: 0 }),
    ],
    markers: [
      { id: 'm1', type: 'star', x: 1, y: 1, size: 10, color: '#fff', label: 'Door', visibleToPlayers: true, gmNote: 'CANARY-marker-gmNote' },
      { id: 'm2', type: 'star', x: 2, y: 2, size: 10, color: '#fff', label: 'CANARY-marker-hidden-label', visibleToPlayers: false },
    ],
    areaEffects: [{ id: 'e1', type: 'circle', x: 5, y: 5, radius: 100, color: '#f00', opacity: 0.4, gmNote: 'CANARY-area-gmNote', owner: 'CANARY-area-owner' }],
    combat: { round: 2, activeId: 'goblin', entries: [
      { tokenId: 'hero', initiative: 15, hp: 8, maxHp: 20 },
      { tokenId: 'goblin', initiative: 10, hp: NPC_HP, maxHp: NPC_MAX },
      { tokenId: 'CANARY-hidden-id', initiative: 20, hp: NPC_HP, maxHp: NPC_MAX },
      { tokenId: 'fogged', initiative: 5, hp: NPC_HP, maxHp: NPC_MAX },
    ] },
    handoutSrc: null, handoutName: '',
  };
}

const FORBIDDEN = ['CANARY', 'Hidden', String(NPC_HP), String(NPC_MAX), 'npcId', 'portraitSource', 'gmNote', 'secret'];
function assertClean(texts, where) {
  const all = texts.join('\n');
  for (const needle of FORBIDDEN) assert.equal(all.includes(needle), false, `"${needle}" reached a player (${where})`);
}

test('F1 / F2 / F3: no GM-only byte reaches a player through snapshot, patches, resume, reconnect or pings', async t => {
  const net = await table(t);
  const alice = net.device({ name: 'Alice' });
  const bob = net.device({ name: 'Bob' });
  const gm = net.gm();
  await gm.until(c => c.of('REQUEST_FULL_STATE').length === 1);
  const scene = canaryScene(alice.playerId);
  const publish = () => gm.send({ type: 'SCENE', scene: structuredClone(scene) });
  const settle = () => delay(30);

  publish();
  const a = net.player(alice);
  const b = net.player(bob);
  await Promise.all([a, b].map(c => c.until(x => x.of('STATE_FULL').length === 1)));
  const full = a.of('STATE_FULL')[0].state;
  assert.deepEqual(full.tokens.map(token => token.id).sort(), ['goblin', 'hero'], 'only visible, unfogged tokens');
  assert.equal(full.combat.entries.find(e => e.tokenId === 'hero').hp, 8, 'PC hit points are shown (documented)');
  const goblin = full.combat.entries.find(e => e.tokenId === 'goblin');
  assert.equal(goblin.hp, undefined);
  assert.ok(goblin.condition, 'an NPC shows a condition instead of numbers');
  assert.deepEqual(Object.keys(full.areaEffects[0]).sort(), ['color', 'id', 'opacity', 'radius', 'type', 'x', 'y']);
  assert.deepEqual(full.playerViewRect, { x: 1, y: 2, width: 300, height: 200 });
  assertClean(a.texts, 'first snapshot');
  assert.equal(a.texts.join('').includes('Lurker'), false, 'a token under fog is not sent');

  // every kind of edit, one revision each
  const steps = [
    () => { scene.tokens[0].x = 60; },                                                              // a move
    () => { scene.tokens[1].hp = NPC_HP + 1; scene.combat.entries[1].hp = NPC_HP + 1; },            // NPC hit points change
    () => { scene.markers.push({ id: 'm3', type: 'star', x: 3, y: 3, label: 'Visible', visibleToPlayers: true, gmNote: 'CANARY-marker3' }); },
    () => { scene.markers[1].visibleToPlayers = true; scene.markers[1].label = 'Revealed'; },     // reveal, then hide again below
    () => { scene.markers[1].visibleToPlayers = false; scene.markers[1].label = 'CANARY-marker-hidden-label'; },
    () => { scene.areaEffects.push({ id: 'e2', type: 'rect', x: 1, y: 1, width: 50, height: 60, color: '#00f', gmNote: 'CANARY-area2' }); },
    () => { scene.areaEffects[0].gmNote = 'CANARY-area-changed'; scene.areaEffects[0].radius = 120; },
    () => { scene.tokens[4].visibleToPlayers = true; scene.tokens[4].name = 'Flipper'; },           // reveal a token (its GM-only fields stay home)
    () => { scene.tokens[4].notes = 'CANARY-notes-after-reveal'; scene.tokens[4].hp = NPC_HP + 7; },
    () => { scene.tokens[4].visibleToPlayers = false; },                                            // hide it again
    () => { scene.fogCells.push('0,0'); },                                                          // fog over the hero
    () => { scene.fogCells = []; scene.tokens[3].x = 200; scene.tokens[3].y = 200; },               // fog off: the fogged token walks into view
    () => { scene.tokens[3].visibleToPlayers = false; scene.tokens[3].name = 'Lurker'; },
    () => { scene.gmNotes = 'CANARY-scene-changed'; scene.selectedId = 'CANARY-selected'; scene.stageScale = 3; },
    () => { scene.combat.entries[2].hp = NPC_HP - 5; scene.combat.activeId = 'hero'; },
    () => { scene.handoutSrc = '/__realm/assets/handout'; scene.handoutName = 'Map of the vault'; },
  ];
  for (const edit of steps) { edit(); publish(); await settle(); }
  await a.until(c => c.of('STATE_PATCH').length >= steps.length - 3, 'the patches');
  assertClean(a.texts, 'patches');
  assertClean(b.texts, 'patches (second player)');

  // a ping carries a name, never GM data
  a.send({ type: 'PLAYER_PING', x: 10, y: 10 });
  await b.until(c => c.of('MAP_PING').length === 1);
  assertClean(b.texts, 'MAP_PING');

  // reconnect with a snapshot, with a resumed patch sequence, and with a revision from nowhere
  const lastRev = b.of('STATE_PATCH').at(-1).rev;
  const baseRev = b.of('STATE_FULL')[0].rev;
  b.terminate();
  await b.done;
  const resumed = net.player(bob, { rev: baseRev + 5 });
  await resumed.until(c => c.of('STATE_PATCH').length === lastRev - baseRev - 5, 'the resumed patch sequence');
  const fresh = net.player(bob);
  await fresh.until(c => c.of('STATE_FULL').length === 1);
  const stranger = net.player(bob, { rev: 7 });
  await stranger.until(c => c.of('STATE_FULL').length === 1);
  for (const [name, client] of [['resumed', resumed], ['fresh', fresh], ['stranger', stranger]]) assertClean(client.texts, name);
  assert.equal(fresh.of('STATE_FULL')[0].state.handoutName, 'Map of the vault');

  // the roster and table messages go to the GM only
  assert.ok(gm.of('PLAYER_ROSTER').length > 0);
  for (const client of [a, b, resumed, fresh, stranger]) {
    assert.equal(client.of('PLAYER_ROSTER').length + client.of('TABLE').length + client.of('JOIN_REQUEST').length, 0);
  }
  // and the whole frame list a player ever saw only has types from the player catalogue
  const { SERVER_TO_PLAYER } = await import('../src/net/protocol.js');
  for (const client of [a, b, resumed, fresh, stranger]) for (const frame of client.frames) assert.ok(SERVER_TO_PLAYER.has(frame.type), frame.type);
});

const table = (t, options) => startTable(t, createHub, { hubOptions: { revBase: 1000 }, ...options });

test('F4 areaEffects: unknown fields are dropped, the drawing fields survive', () => {
  const view = projectForPlayers({
    gridSize: 50,
    areaEffects: [
      { id: 'c', type: 'cone', x: 1, y: 2, radius: 30, angle: 60, rotation: 45, color: '#f00', opacity: 0.3, gmNote: 'CANARY', owner: 'CANARY' },
      { id: 'r', type: 'rect', x: 1, y: 2, width: 10, height: 20, color: '#00f', hidden: true },
      null, 'text',
    ],
  });
  assert.deepEqual(view.areaEffects, [
    { id: 'c', type: 'cone', x: 1, y: 2, radius: 30, angle: 60, rotation: 45, color: '#f00', opacity: 0.3 },
    { id: 'r', type: 'rect', x: 1, y: 2, width: 10, height: 20, color: '#00f' },
  ]);
  assert.deepEqual(projectForPlayers({ gridSize: 50 }).areaEffects, []);
});

test('F5 property: over random scenes and edits no snapshot or patch ever contains a planted canary', () => {
  let seed = 99;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = list => list[Math.floor(random() * list.length)];
  const sync = createStateSync({ revBase: 10 });
  const socket = createFakeSocket();
  const session = createSession({ socket, role: 'player', auth: { device: 'd'.repeat(32), playerId: 'p' } });
  const planted = (field) => `CANARY-${field}-${Math.floor(random() * 1e6)}`;
  const makeToken = i => ({
    id: `t${i}`, name: `T${i}`, x: Math.floor(random() * 2000), y: Math.floor(random() * 1500), gridSize: 1,
    visibleToPlayers: random() < 0.6, ownerId: pick(['p', undefined]), characterType: pick(['npc', 'pc']),
    notes: planted('notes'), gmNotes: planted('gmNotes'), npcId: planted('npc'), portraitSource: planted('src'), secretLabel: planted('label'),
    hp: 424243 + i, maxHp: 818182 + i,
  });
  const scene = { mapWidth: 2000, mapHeight: 1500, gridSize: 50, showFog: true, fogCells: [], tokens: Array.from({ length: 8 }, (_, i) => makeToken(i)),
    markers: [], areaEffects: [], combat: { entries: [], activeId: null, round: 1 }, gmNotes: planted('scene'), playerViewRect: { x: 0, y: 0, width: 5, height: 5, secret: planted('rect') } };
  sync.attach(session, null);
  for (let step = 0; step < 400; step++) {
    const token = pick(scene.tokens);
    const roll = random();
    if (roll < 0.25) { token.x = Math.floor(random() * 2000); token.y = Math.floor(random() * 1500); }
    else if (roll < 0.4) token.visibleToPlayers = !token.visibleToPlayers;
    else if (roll < 0.5) { token.notes = planted('notes'); token.hp += 1; }
    else if (roll < 0.6) scene.fogCells = random() < 0.5 ? [...scene.fogCells, `${Math.floor(random() * 40)},${Math.floor(random() * 30)}`] : scene.fogCells.slice(1);
    else if (roll < 0.7) scene.markers = random() < 0.6 ? [...scene.markers, { id: `m${step}`, type: 'star', x: 1, y: 1, label: 'Lbl', visibleToPlayers: random() < 0.5, gmNote: planted('mk') }] : scene.markers.slice(1);
    else if (roll < 0.8) scene.areaEffects = random() < 0.6 ? [...scene.areaEffects, { id: `a${step}`, type: 'circle', x: 1, y: 1, radius: 5, color: '#fff', gmNote: planted('area') }] : scene.areaEffects.slice(1);
    else if (roll < 0.9) scene.combat = { round: 1, activeId: token.id, entries: scene.tokens.slice(0, 4).map(tk => ({ tokenId: tk.id, initiative: 10, hp: tk.hp, maxHp: tk.maxHp })) };
    else scene.gmNotes = planted('scene');
    sync.setScene(structuredClone(scene));
    if (step % 100 === 50) { // a reconnect in the middle
      const joiner = createSession({ socket: createFakeSocket(), role: 'player', auth: { device: 'e'.repeat(32), playerId: 'q' } });
      sync.attach(joiner, step % 200 === 50 ? null : sync.rev - 3);
      for (const entry of joiner.socket.sent) assert.equal(entry.data.includes('CANARY'), false);
    }
  }
  assert.ok(socket.sent.length > 100);
  for (const entry of socket.sent) {
    assert.equal(entry.data.includes('CANARY'), false, 'a canary leaked');
  }
  // NPC numbers never appear as combat hit points: collect every combat entry that was ever sent
  for (const entry of socket.sent) {
    const message = JSON.parse(entry.data);
    const combat = message.state?.combat ?? message.patch?.set?.combat;
    for (const e of combat?.entries ?? []) {
      const token = scene.tokens.find(tk => tk.id === e.tokenId);
      if (token?.characterType === 'npc') assert.equal('hp' in e || 'maxHp' in e, false, 'NPC numbers in a combat entry');
    }
  }
});
