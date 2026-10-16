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
