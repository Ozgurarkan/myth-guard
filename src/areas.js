// Spell areas that players draw.
//
// A player casts a circle, a square or a cone on the map, or a circle BOUND to one of their heroes: a bound circle has no
// position of its own, it is drawn round its hero's token and so follows it wherever the token goes. The same rules run in the
// server (what it accepts and shows at once) and in the GM window (which owns the scene), so they live here, once.
//
// An effect keeps the shape the GM's own spell areas have ({ id, type, x, y, radius | width + height, angle, rotation, color,
// opacity }) plus `ownerId` (the player who cast it, so only they can take it back) and, for a bound circle, `boundTo` (a token id).
import { isId } from './net/protocol.js';

export const AREA_SHAPES = ['circle', 'rect', 'cone'];
/** Each player may have this many effects up; casting another one takes down their oldest. */
export const MAX_PLAYER_AREAS = 8;
/** The colours players choose from: the damage colours the GM's spell panel uses (fire, lightning, acid, cold, necrotic, force). */
export const PLAYER_AREA_COLORS = ['#e5533d', '#f3d44f', '#8bd24f', '#6fb4e8', '#9d7bd4', '#e08ad0'];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** The largest a player's area may be, in squares: a 120 ft circle at 5 ft squares is already bigger than most maps. */
export const AREA_LIMITS = Object.freeze({ circle: 24, side: 48, cone: 48, cellFraction: 0.25 });

/**
 * The effect a player's request stands for, or `{ error }` ('invalid' for nonsense, 'blocked' for a hero that is not theirs).
 * `msg` is { id, shape, color, x, y, radius | width + height, angle?, rotation?, boundTo? }; `scene` gives the grid, the map
 * size and the tokens. Sizes are in map pixels, clamped to what the grid allows; a point is kept on the map.
 */
export function playerEffect(msg, scene, playerId) {
  if (!msg || !playerId || !AREA_SHAPES.includes(msg.shape) || !isId(msg.id)) return { error: 'invalid' };
  const cell = Number(scene?.gridSize) > 0 ? Number(scene.gridSize) : 50;
  const size = (value, squares) => (finite(value) ? clamp(value, cell * AREA_LIMITS.cellFraction, cell * squares) : null);
  const effect = {
    id: msg.id, type: msg.shape, opacity: 0.4, ownerId: playerId,
    color: typeof msg.color === 'string' && HEX_COLOR.test(msg.color) ? msg.color.toLowerCase() : PLAYER_AREA_COLORS[0],
  };
  if (msg.shape === 'rect') {
    effect.width = size(msg.width, AREA_LIMITS.side);
    effect.height = size(msg.height, AREA_LIMITS.side);
    if (effect.width === null || effect.height === null) return { error: 'invalid' };
  } else {
    effect.radius = size(msg.radius, msg.shape === 'circle' ? AREA_LIMITS.circle : AREA_LIMITS.cone);
    if (effect.radius === null) return { error: 'invalid' };
  }
  if (msg.shape === 'cone') {
    effect.angle = finite(msg.angle) ? clamp(msg.angle, 15, 180) : 60;
    effect.rotation = finite(msg.rotation) ? ((msg.rotation % 360) + 360) % 360 : 0;
  }
  if (msg.boundTo !== undefined) {
    if (msg.shape !== 'circle' || !isId(msg.boundTo)) return { error: 'invalid' };
    const token = (Array.isArray(scene?.tokens) ? scene.tokens : []).find(item => item?.id === msg.boundTo);
    // only your own hero, and only one the table can see (a bound circle would give away where a hidden token is)
    if (!token || token.ownerId !== playerId || token.visibleToPlayers === false) return { error: 'blocked' };
    effect.boundTo = token.id;
    effect.x = 0;
    effect.y = 0;
    return { effect };
  }
  if (!finite(msg.x) || !finite(msg.y)) return { error: 'invalid' };
  effect.x = clamp(msg.x, 0, Number(scene?.mapWidth) || Math.abs(msg.x));
  effect.y = clamp(msg.y, 0, Number(scene?.mapHeight) || Math.abs(msg.y));
  return { effect };
}

/**
 * `effects` with `effect` added. The same id twice is one cast (a resent message); a new bound circle for a hero replaces the
 * old one (a hero wears one); and a player already at the limit loses their oldest effect to make room.
 */
export function addPlayerEffect(effects, effect) {
  const list = Array.isArray(effects) ? effects : [];
  if (list.some(item => item?.id === effect.id)) return list;
  let next = effect.boundTo ? list.filter(item => !(item?.boundTo === effect.boundTo && item?.ownerId === effect.ownerId)) : list;
  const mine = next.filter(item => item?.ownerId === effect.ownerId);
  if (mine.length >= MAX_PLAYER_AREAS) next = next.filter(item => item !== mine[0]);
  return [...next, effect];
}

/** `effects` without the ones `ownerId` cast: one by `id`, or all of them. Other people's effects are never touched. */
export function removePlayerEffects(effects, ownerId, { id, all = false } = {}) {
  return (Array.isArray(effects) ? effects : []).filter(item => !(item?.ownerId === ownerId && (all || item.id === id)));
}

/** The effects a player cast. */
export const effectsOf = (effects, playerId) => (Array.isArray(effects) ? effects : []).filter(item => item?.ownerId === playerId);

/** The bound circles by token id, so a token can draw its own. Tokens with none are not in the map. */
export function aurasByToken(effects) {
  const map = new Map();
  for (const item of Array.isArray(effects) ? effects : []) {
    if (!item?.boundTo) continue;
    if (!map.has(item.boundTo)) map.set(item.boundTo, []);
    map.get(item.boundTo).push(item);
  }
  return map;
}

/** The effects with a place of their own on the map (everything except bound circles). */
export const freeEffects = effects => (Array.isArray(effects) ? effects : []).filter(item => !item?.boundTo);
