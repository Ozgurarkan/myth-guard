// What the table is allowed to see.
//
// The GM publishes the complete scene to the server. Everything a player's
// browser receives passes through this projection first, so hidden tokens,
// hidden markers, private fields and exact NPC hit points never travel over
// the network at all — hiding them on screen would not be enough, because
// anyone can open their browser's developer tools.
import { playerCombat } from './combat.js';

/** Tokens covered by fog cannot be seen (or moved) by players. */
export function tokenUnderFog(token, fog, gridSize) {
  if (!fog.size) return false;
  const col = Math.floor(token.x / gridSize);
  const row = Math.floor(token.y / gridSize);
  const span = Math.ceil(token.gridSize || 1);
  for (let x = 0; x < span; x++) {
    for (let y = 0; y < span; y++) if (fog.has(`${col + x},${row + y}`)) return true;
  }
  return false;
}

const assign = (target, source, keys) => {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
  return target;
};

const TOKEN_FIELDS = ['id', 'x', 'y', 'gridSize', 'name', 'color', 'borderWidth', 'imageSrc', 'showNumber', 'number', 'ownerId'];
const MARKER_FIELDS = ['id', 'type', 'x', 'y', 'size', 'color', 'label', 'filled', 'opacity'];
// A spell area is a circle, a rectangle or a cone (see areaShape / AreaFill in canvas/shared.jsx). Anything else on it,
// now or added later, stays with the GM until it is listed here.
const AREA_FIELDS = ['id', 'type', 'x', 'y', 'color', 'opacity', 'radius', 'width', 'height', 'angle', 'rotation'];
const VIEW_RECT_FIELDS = ['x', 'y', 'width', 'height'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function projectForPlayers(scene) {
  const tokens = Array.isArray(scene.tokens) ? scene.tokens : [];
  const gridSize = scene.gridSize || 50;
  const fogOn = scene.showFog !== false;
  // Fog squares are a set: players' copies are patched as one, so a repeated square would make their checksum disagree
  // with the server's and trigger a resync again and again. The GM screen never produces one; this keeps it that way.
  const fog = new Set(fogOn && Array.isArray(scene.fogCells) ? scene.fogCells : []);
  const fogCells = [...fog];

  const visibleTokens = tokens
    .filter(token => token.visibleToPlayers !== false && !tokenUnderFog(token, fog, gridSize))
    .map(token => {
      const out = assign({}, token, TOKEN_FIELDS);
      // The initiative portrait is only worth sending when it differs from the token art.
      if (token.portraitSrc && token.portraitSrc !== token.imageSrc) out.portraitSrc = token.portraitSrc;
      return out;
    });

  return {
    mapImageSrc: scene.mapImageSrc ?? null,
    mapWidth: scene.mapWidth,
    mapHeight: scene.mapHeight,
    showGrid: scene.showGrid !== false,
    gridSize,
    gridColor: scene.gridColor,
    gridOpacity: scene.gridOpacity,
    feetPerCell: scene.feetPerCell,
    snapToGrid: scene.snapToGrid !== false,
    playerCanMoveTokens: scene.playerCanMoveTokens !== false,
    showFog: fogOn,
    fogCells,
    fogColor: scene.fogColor,
    fogOpacity: scene.fogOpacity,
    areaEffects: (Array.isArray(scene.areaEffects) ? scene.areaEffects : []).filter(isObject).map(effect => assign({}, effect, AREA_FIELDS)),
    markers: (scene.markers ?? []).filter(marker => marker.visibleToPlayers).map(marker => assign({}, marker, MARKER_FIELDS)),
    playerViewRect: isObject(scene.playerViewRect) ? assign({}, scene.playerViewRect, VIEW_RECT_FIELDS) : undefined,
    tokens: visibleTokens,
    combat: playerCombat(scene.combat, { ...scene, tokens, gridSize, fogCells }),
    handoutSrc: scene.handoutSrc ?? null,
    handoutName: scene.handoutName || '',
  };
}
