// The rules for what a player may do at the table: pure functions, no sockets, no clock of their own.
//
// Each rule looks at the server's copy of the scene and says what should happen:
//   ack     what to tell the sender ({ ok:true } or { ok:false, reason }), or null for "nothing"
//   toGm    a message for the GM window
//   mutate  how to apply the effect to the server's scene copy (the hub publishes the result at once)
//   ping    a MAP_PING to show everyone
//
// Behaviour is exactly what server/sessionSync.js did (and its tests pinned): owner-only moves, GM-away / pause / fog
// refusals, clamped to the map, a 700 ms ping cooldown, end-turn only for the active hero, a 1.5 s double-tap guard.
// `memory` is the per-device scratch space the caller keeps between calls ({ lastPing, lastEndTurn }).
import { canPlayerMoveToken } from '../../src/ownership.js';
import { tokenUnderFog } from '../../src/playerView.js';
import { tokenKind, reduceCombat, turnOrder, normalizeCombat } from '../../src/combat.js';
import { playerEffect, addPlayerEffect, removePlayerEffects } from '../../src/areas.js';

export const PING_COOLDOWN_MS = 700;
export const END_TURN_GUARD_MS = 1500;
export const REASONS = Object.freeze(['blocked', 'paused', 'away', 'not-your-turn', 'rate', 'invalid']);

const reject = reason => ({ ok: false, reason });
const ok = () => ({ ok: true });
const findToken = (scene, id) => (Array.isArray(scene?.tokens) ? scene.tokens.find(token => token?.id === id) : undefined);
/** Keep a point on the map: a stray drag must not lose a token (or a ping) off the edge. */
const onMap = (value, size) => Math.max(0, Math.min(value, Number(size) || value));

/** A fresh per-device memory object. */
export const createMemory = () => ({ lastPing: null, lastEndTurn: null });

/**
 * @param {{ scene: object|null, actor: { playerId: string }, msg: { id: string, x: number, y: number }, gmPresent: boolean }} input
 * @returns {{ ack: object, toGm?: object, mutate?: (scene: object) => void }}
 */
export function moveToken({ scene, actor, msg, gmPresent }) {
  if (typeof msg?.id !== 'string' || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return { ack: reject('invalid') };
  const token = findToken(scene, msg.id);
  if (!token || !actor?.playerId || token.ownerId !== actor.playerId) return { ack: reject('blocked') };
  if (!gmPresent) return { ack: reject('away') };
  if (scene.playerCanMoveTokens === false) return { ack: reject('paused') };
  if (!canPlayerMoveToken(scene, token, actor.playerId)) return { ack: reject('blocked') };
  const x = onMap(msg.x, scene.mapWidth);
  const y = onMap(msg.y, scene.mapHeight);
  return {
    ack: ok(),
    toGm: { type: 'PLAYER_TOKEN_MOVE', playerId: actor.playerId, id: token.id, x, y },
    // Show the move to everyone now; the GM's next scene will agree with it.
    mutate(target) {
      const live = findToken(target, token.id);
      if (live) { live.x = x; live.y = y; }
    },
  };
}

/**
 * A ping is a short-lived "look here": nothing is stored, it is only passed on to everyone.
 * Returns null when it should be dropped (no scene, nonsense numbers, inside the cooldown).
 */
export function mapPing({ scene, actor, msg, memory, now }) {
  if (!scene || !Number.isFinite(msg?.x) || !Number.isFinite(msg?.y)) return null;
  if (memory.lastPing !== null && now - memory.lastPing < PING_COOLDOWN_MS) return null;
  memory.lastPing = now;
  return {
    ping: { type: 'MAP_PING', id: actor.playerId, name: actor.name || actor.label || '', x: onMap(msg.x, scene.mapWidth), y: onMap(msg.y, scene.mapHeight) },
  };
}

export const INITIATIVE_LIMIT = 99;
export const MAX_HP_LIMIT = 99999;
const clampInt = (value, low, high) => Math.max(low, Math.min(high, Math.round(value)));

/**
 * A player changes the hit points or the initiative of their OWN hero while a fight is on. The server checks who owns the
 * token, that the GM allows it and that the hero is in the fight, clamps the numbers, and tells the GM, whose window owns
 * the scene and applies the change. Hit points stay between 0 and the hero's maximum (which the player may change too, 1 to
 * 99999); initiative between -99 and 99. Creatures are the GM's: only their initiative can be touched, never their numbers.
 */
export function editCombat({ scene, actor, msg, gmPresent }) {
  if (typeof msg?.tokenId !== 'string') return { ack: reject('invalid') };
  const token = findToken(scene, msg.tokenId);
  if (!token || !actor?.playerId || token.ownerId !== actor.playerId || token.visibleToPlayers === false) return { ack: reject('blocked') };
  if (!gmPresent) return { ack: reject('away') };
  if (scene.playerCanEditCombat === false) return { ack: reject('paused') };
  const entry = Array.isArray(scene.combat?.entries) ? scene.combat.entries.find(item => item?.tokenId === token.id) : undefined;
  if (!entry) return { ack: reject('blocked') };
  const patch = {};
  const numbers = tokenKind(token) !== 'npc';
  if (msg.maxHp !== undefined) {
    if (!Number.isFinite(msg.maxHp)) return { ack: reject('invalid') };
    if (numbers) patch.maxHp = clampInt(msg.maxHp, 1, MAX_HP_LIMIT);
  }
  if (msg.hp !== undefined) {
    if (!Number.isFinite(msg.hp)) return { ack: reject('invalid') };
    const ceiling = patch.maxHp ?? entry.maxHp;
    if (numbers && ceiling > 0) patch.hp = clampInt(msg.hp, 0, ceiling);
  }
  if (patch.maxHp !== undefined && patch.hp === undefined) {
    // a new maximum keeps the hit points the hero has (cut down to fit); a hero without hit points starts at full
    patch.hp = Number.isFinite(entry.hp) ? Math.min(entry.hp, patch.maxHp) : patch.maxHp;
  }
  if (msg.initiative !== undefined) {
    if (!Number.isFinite(msg.initiative)) return { ack: reject('invalid') };
    patch.initiative = clampInt(msg.initiative, -INITIATIVE_LIMIT, INITIATIVE_LIMIT);
  }
  if (!Object.keys(patch).length) return { ack: reject('invalid') };
  return {
    ack: ok(),
    toGm: { type: 'PLAYER_COMBAT_EDIT', playerId: actor.playerId, tokenId: token.id, ...patch },
    // Show it to everyone now; the GM's next scene will agree with it.
    mutate(target) {
      const live = Array.isArray(target.combat?.entries) ? target.combat.entries.find(item => item?.tokenId === token.id) : undefined;
      if (live) Object.assign(live, patch);
    },
  };
}

/**
 * "I wait": the hero whose turn it is steps out and acts right after another HERO who comes LATER this round; next round
 * they are back in their own place. Only the active hero's owner may do it, once per round, and only after a combatant of their
 * own kind that the players can see (a hidden token is never named, and nobody waits for a creature). The turn passes on at
 * once; the GM's window applies the same rule to its scene.
 */
export function delayTurn({ scene, actor, msg, gmPresent }) {
  if (typeof msg?.tokenId !== 'string' || typeof msg?.after !== 'string') return { ack: reject('invalid') };
  const token = findToken(scene, msg.tokenId);
  if (!token || !actor?.playerId || token.ownerId !== actor.playerId || token.visibleToPlayers === false) return { ack: reject('blocked') };
  if (!gmPresent) return { ack: reject('away') };
  if (scene.combat?.activeId !== token.id) return { ack: reject('not-your-turn') };
  const target = findToken(scene, msg.after);
  const fog = fogOf(scene);
  if (!target || target.id === token.id || tokenKind(target) !== tokenKind(token) || target.visibleToPlayers === false || tokenUnderFog(target, fog, scene.gridSize || 50)) return { ack: reject('blocked') };
  const combat = normalizeCombat(scene.combat, scene.tokens ?? []);
  const turns = turnOrder(combat);
  const from = turns.findIndex(entry => entry.tokenId === token.id);
  const to = turns.findIndex(entry => entry.tokenId === target.id);
  if (from < 0 || to <= from || (combat.delays ?? []).some(delay => delay.tokenId === token.id)) return { ack: reject('blocked') };
  return {
    ack: ok(),
    toGm: { type: 'PLAYER_DELAY_TURN', playerId: actor.playerId, tokenId: token.id, after: target.id },
    mutate(copy) { copy.combat = reduceCombat(copy.combat, { type: 'COMBAT_DELAY', tokenId: token.id, after: target.id }, copy.tokens ?? []); },
  };
}

/**
 * A player casts a spell area (a circle, a square or a cone) or a circle bound to one of their heroes. Everyone at the table sees it
 * at once (the server's copy gets it, the GM's window is told so the scene agrees). The caster must have a hero on the map; the GM can
 * switch casting off for the table (`playerCanCast`); a bound circle only goes on the caster's own visible hero. The rules for what an
 * effect may look like, and for replacing and limiting them, are in src/areas.js, which the GM's window runs too.
 */
export function addArea({ scene, actor, msg, gmPresent }) {
  if (!scene || !actor?.playerId) return { ack: reject('blocked') };
  if (!gmPresent) return { ack: reject('away') };
  if (scene.playerCanCast === false) return { ack: reject('paused') };
  const hasHero = (Array.isArray(scene.tokens) ? scene.tokens : []).some(token => token?.ownerId === actor.playerId && token.visibleToPlayers !== false);
  if (!hasHero) return { ack: reject('blocked') };
  const made = playerEffect(msg, scene, actor.playerId);
  if (made.error) return { ack: reject(made.error) };
  const { type: _type, aid: _aid, ...request } = msg;
  return {
    ack: ok(),
    toGm: { type: 'PLAYER_AREA_ADD', playerId: actor.playerId, ...request },
    mutate(copy) { copy.areaEffects = addPlayerEffect(copy.areaEffects, made.effect); },
  };
}

/** A player takes back one of their own effects (`id`) or all of them (`all`). Taking back is allowed even when casting is switched off. */
export function removeArea({ scene, actor, msg, gmPresent }) {
  if (!scene || !actor?.playerId) return { ack: reject('blocked') };
  const all = msg?.all === true;
  if (!all && typeof msg?.id !== 'string') return { ack: reject('invalid') };
  if (!gmPresent) return { ack: reject('away') };
  const mine = (Array.isArray(scene.areaEffects) ? scene.areaEffects : []).filter(effect => effect?.ownerId === actor.playerId);
  if (!all && !mine.some(effect => effect.id === msg.id)) return { ack: reject('blocked') };
  return {
    ack: ok(),
    toGm: { type: 'PLAYER_AREA_REMOVE', playerId: actor.playerId, ...(all ? { all: true } : { id: msg.id }) },
    mutate(copy) { copy.areaEffects = removePlayerEffects(copy.areaEffects, actor.playerId, { id: msg.id, all }); },
  };
}

/** Only the player whose hero is acting may end that turn; the GM's window then moves the order on. */
export function endTurn({ scene, actor, msg, gmPresent, memory, now }) {
  if (typeof msg?.tokenId !== 'string') return { ack: reject('invalid') };
  if (!gmPresent) return { ack: reject('away') };
  const token = findToken(scene, msg.tokenId);
  if (!token || !actor?.playerId || token.ownerId !== actor.playerId || scene.combat?.activeId !== token.id) return { ack: reject('not-your-turn') };
  const last = memory.lastEndTurn;
  // A double tap counts once: the second one is answered as done, and the GM hears of the first only.
  if (last?.id === token.id && now - last.at < END_TURN_GUARD_MS) return { ack: ok() };
  memory.lastEndTurn = { id: token.id, at: now };
  return { ack: ok(), toGm: { type: 'PLAYER_END_TURN', playerId: actor.playerId, tokenId: token.id, name: token.name || '' } };
}

// ── A token that is being dragged right now ──────────────────────────────────────────────────────────────────────
// Live positions are shown to the others while a hand is still on the token. They are never stored: the scene only changes
// when the drop arrives as a normal move. The same privacy rule as the scene projection applies to every single frame:
// a hidden token, or one standing under fog, is not announced, so a player cannot learn where it is by watching the wire.

const fogSets = new WeakMap(); // fogCells array -> Set. The GM replaces the whole array when fog changes, so identity is a safe key.
const NO_FOG = new Set();
function fogOf(scene) {
  if (scene.showFog === false || !Array.isArray(scene.fogCells) || !scene.fogCells.length) return NO_FOG;
  let set = fogSets.get(scene.fogCells);
  if (!set) { set = new Set(scene.fogCells); fogSets.set(scene.fogCells, set); }
  return set;
}

/** The frame to pass on, or null to drop it. `byPlayer` is the sender's playerId, or null when the GM is dragging. */
function liveFrame({ scene, msg, byPlayer, gmPresent }) {
  if (!scene || typeof msg?.id !== 'string' || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return null;
  const token = findToken(scene, msg.id);
  if (!token || token.visibleToPlayers === false) return null;
  const gridSize = scene.gridSize || 50;
  const fog = fogOf(scene);
  if (byPlayer !== null) {
    if (!gmPresent || scene.playerCanMoveTokens === false || token.ownerId !== byPlayer || token.dead === true) return null;
    if (tokenUnderFog(token, fog, gridSize)) return null; // it could not be moved from there
  }
  const x = onMap(msg.x, scene.mapWidth);
  const y = onMap(msg.y, scene.mapHeight);
  if (tokenUnderFog({ x, y, gridSize: token.gridSize }, fog, gridSize)) return null; // dragged into fog: it vanishes from the players' view on the drop
  return { type: 'TOKEN_LIVE', id: token.id, x, y };
}

/** A player is dragging their own hero. Everyone else, and the GM, may watch. */
export function playerLiveMove({ scene, actor, msg, gmPresent }) {
  if (!actor?.playerId) return null;
  const frame = liveFrame({ scene, msg, byPlayer: actor.playerId, gmPresent });
  return frame && { ...frame, playerId: actor.playerId };
}

/** The GM is dragging any token. Only a token the players can see is announced. */
export function gmLiveMove({ scene, msg }) {
  return liveFrame({ scene, msg, byPlayer: null, gmPresent: true });
}
