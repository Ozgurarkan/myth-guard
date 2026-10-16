import { emptyCombat, normalizeCombat, reduceCombat } from './combat.js';
import { createContext, useContext, useReducer, useEffect } from 'react';
import { nanoid } from './utils';
import { broadcastState } from './broadcast';

/** Area-drawing tools ↔ the shape they produce */
export const AREA_TOOL_TYPES = { areaCircle: 'circle', areaRect: 'rect', areaCone: 'cone' };

const INITIAL = {
  mapImageSrc: null,
  mapWidth: 2000,
  mapHeight: 1500,
  currentMapName: 'Untitled Map',
  currentMapId: null,

  stageX: 0,
  stageY: 0,
  stageScale: 1,

  showGrid: true,
  gridSize: 50,
  gridColor: '#c6d0f2',
  gridOpacity: 0.18,
  snapToGrid: true,
  // Real-world scale — one grid square is this many feet
  feetPerCell: 5,

  players: [],
  tokens: [],
  combat: emptyCombat(),
  selectedId: null,

  showFog: true,
  fogCells: [],
  fogColor: '#000000',
  fogOpacity: 0.88,
  fogBrushSize: 1,

  areaEffects: [],
  activeAreaType: 'circle',
  activeAreaColor: '#e5533d',

  // Area sizing: 'drag' = freehand, 'exact' = the measurements below (in feet)
  areaSizeMode: 'drag',
  areaRadiusFt: 15,
  areaWidthFt: 20,
  areaHeightFt: 20,
  areaConeLengthFt: 30,
  areaConeAngle: 60,

  // Markers (free-placed shapes, no grid snap)
  markers: [],
  activeMarkerType: 'circle',
  activeMarkerColor: '#a58bff',
  activeMarkerSize: 24,
  activeMarkerLabel: '',
  activeMarkerFilled: false,
  activeMarkerOpacity: 0.85,

  playerViewEnabled: false,
  playerViewRect: { x: 100, y: 100, width: 800, height: 600 },
  // Players may drag tokens around on the player window
  playerCanMoveTokens: true,

  activeTool: 'select',

  // Handout image currently pushed to the player screen
  handoutSrc: null,
  handoutName: '',
  handoutId: null,
  // GM-local full-screen preview (never broadcast)
  previewSrc: null,
  previewName: '',
  // Library picker modal
  showImagePicker: false,

  // ── Character sheets (PDF quick-switcher) ──
  // Open sheets stay mounted in the viewer so switching between them is instant.
  showSheets: false,
  sheetTabs: [],            // [{ id, name }] in the order they were opened
  activeSheetId: null,
  sheetLayout: 'dock',      // 'dock' = beside the map · 'full' = whole window
  sheetDockWidth: 620,

  rightTab: 'scenes',
  showTokenModal: false,
  editingToken: null,
  editingPresetId: null,
  contextMenu: null,

  // Connection to the player server: { status: 'connecting' | 'open' | 'reconnecting', latency: ms | null }
  net: { status: 'connecting', latency: null },
  // References to the scene as last saved or loaded; compared by identity to spot unsaved edits.
  saved: null,
};

/** The parts of the state a saved scene stores. */
export const SAVED_KEYS = ['mapImageSrc', 'mapWidth', 'mapHeight', 'tokens', 'combat', 'fogCells', 'fogColor', 'fogOpacity',
  'fogBrushSize', 'showFog', 'areaEffects', 'markers', 'gridSize', 'gridColor', 'gridOpacity', 'showGrid', 'snapToGrid',
  'feetPerCell', 'playerViewRect', 'activeAreaColor'];
// Brush size and the spell colour in hand are tool settings, not changes to the scene itself.
const TRACKED_KEYS = SAVED_KEYS.filter(key => key !== 'fogBrushSize' && key !== 'activeAreaColor');
const snapshot = state => Object.fromEntries(TRACKED_KEYS.map(key => [key, state[key]]));
INITIAL.saved = snapshot(INITIAL);

/** True when the scene on the table differs from what is stored in the library. */
export const hasUnsavedChanges = state => !!state.saved && TRACKED_KEYS.some(key => state[key] !== state.saved[key]);

/** Is there anything worth saving on the table? */
export const sceneHasContent = state => !!(state.mapImageSrc || state.tokens.length || state.areaEffects.length || state.markers.length || state.fogCells.length);

function reducer(state, action) {
  if (action.type.startsWith('COMBAT_')) return { ...state, combat: reduceCombat(state.combat, action, state.tokens) };
  switch (action.type) {

    case 'PLAYERS_SET': {
      // The server's roster is complete: every remembered device, online or not, admitted or waiting (design 4.3).
      return { ...state, players: action.players.map(p => ({ ...p, online: p.online !== false, admitted: p.admitted !== false })) };
    }
    case 'NET_SET':
      return { ...state, net: { ...state.net, ...action.net } };
    case 'STAGE_SET':
      return { ...state, stageX: action.x, stageY: action.y, stageScale: action.scale };

    case 'MAP_LOAD':
      return {
        ...state,
        mapImageSrc: action.src,
        mapWidth: action.width,
        mapHeight: action.height,
        stageX: 0, stageY: 0, stageScale: 1,
        currentMapId: action.keepId ? state.currentMapId : null,
      };

    case 'SCENE_RENAME':
      return { ...state, currentMapName: action.name };

    case 'MAP_SET_META':
      return { ...state, currentMapName: action.name, currentMapId: action.id, saved: snapshot(state) };

    case 'MAP_LOAD_FULL': {
      const p = action.payload;
      const loaded = {
        ...INITIAL,
        players: state.players,
        mapImageSrc:     p.mapImageSrc     ?? null,
        mapWidth:        p.mapWidth        ?? 2000,
        mapHeight:       p.mapHeight       ?? 1500,
        tokens:          p.tokens          ?? [],
        combat: normalizeCombat(p.combat, p.tokens ?? []),
        fogCells:        p.fogCells        ?? [],
        fogColor:        p.fogColor        ?? '#000000',
        fogOpacity:      p.fogOpacity      ?? 0.88,
        fogBrushSize:    p.fogBrushSize    ?? 1,
        showFog:         p.showFog         ?? true,
        areaEffects:     p.areaEffects     ?? [],
        markers:         p.markers         ?? [],
        gridSize:        p.gridSize        ?? 50,
        gridColor:       p.gridColor       ?? INITIAL.gridColor,
        gridOpacity:     p.gridOpacity     ?? 0.18,
        showGrid:        p.showGrid        ?? true,
        snapToGrid:      p.snapToGrid      ?? true,
        feetPerCell:     p.feetPerCell     ?? 5,
        playerViewRect:  p.playerViewRect  ?? INITIAL.playerViewRect,
        activeAreaColor: p.activeAreaColor ?? INITIAL.activeAreaColor,
        currentMapName:  p.name            ?? 'Untitled Map',
        currentMapId:    p.id              ?? null,
        stageX: 0, stageY: 0, stageScale: 1,
        selectedId: null, contextMenu: null,
        showTokenModal: false, editingToken: null, editingPresetId: null,
        playerViewEnabled: false, activeTool: 'select',
        // Handouts are independent of the loaded map — keep whatever is on screen
        handoutSrc: state.handoutSrc, handoutName: state.handoutName, handoutId: state.handoutId,
        // So are character sheets — a map change must not close what you were reading
        showSheets: state.showSheets, sheetTabs: state.sheetTabs,
        activeSheetId: state.activeSheetId, sheetLayout: state.sheetLayout,
        sheetDockWidth: state.sheetDockWidth,
        playerCanMoveTokens: state.playerCanMoveTokens,
        net: state.net,
        rightTab: state.rightTab,
      };
      return { ...loaded, saved: snapshot(loaded) };
    }

    case 'MAP_NEW':
      return {
        ...INITIAL,
        players: state.players,
        gridSize:    state.gridSize,
        gridColor:   state.gridColor,
        gridOpacity: state.gridOpacity,
        snapToGrid:  state.snapToGrid,
        feetPerCell: state.feetPerCell,
        handoutSrc:  state.handoutSrc,
        handoutName: state.handoutName,
        handoutId:   state.handoutId,
        showSheets:     state.showSheets,
        sheetTabs:      state.sheetTabs,
        activeSheetId:  state.activeSheetId,
        sheetLayout:    state.sheetLayout,
        sheetDockWidth: state.sheetDockWidth,
        playerCanMoveTokens: state.playerCanMoveTokens,
        net: state.net,
        rightTab: state.rightTab,
      };

    case 'GRID_TOGGLE':
      return { ...state, showGrid: !state.showGrid };
    case 'GRID_SET':
      return { ...state, ...action.payload };

    case 'TOKEN_ADD':
      return { ...state, tokens: [...state.tokens, action.token], showTokenModal: false, editingToken: null, editingPresetId: null };
    case 'TOKEN_UPDATE':
      return {
        ...state,
        tokens: state.tokens.map(t => t.id === action.token.id ? { ...t, ...action.token } : t),
        showTokenModal: false, editingToken: null, editingPresetId: null,
      };
    case 'TOKEN_MOVE':
      return { ...state, tokens: state.tokens.map(t => t.id === action.id ? { ...t, x: action.x, y: action.y } : t) };
    case 'TOKEN_DELETE':
      return {
        ...state,
        tokens: state.tokens.filter(t => t.id !== action.id),
        combat: reduceCombat(state.combat, { type: 'COMBAT_REMOVE', id: action.id }, state.tokens),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
        contextMenu: null,
      };
    case 'TOKEN_TOGGLE_NUMBER': {
      const t = state.tokens.find(t => t.id === action.id);
      if (!t) return state;
      return {
        ...state,
        tokens: state.tokens.map(tok => tok.id === action.id ? { ...tok, showNumber: !tok.showNumber } : tok),
        contextMenu: null,
      };
    }
    case 'TOKEN_TOGGLE_PLAYER_VISIBLE':
      return {
        ...state,
        tokens: state.tokens.map(t => t.id === action.id ? { ...t, visibleToPlayers: !(t.visibleToPlayers ?? true) } : t),
        contextMenu: null,
      };

    case 'SELECT':
      return { ...state, selectedId: action.id, contextMenu: null };

    case 'FOG_TOGGLE':
      return { ...state, showFog: !state.showFog };
    case 'FOG_ADD_CELL': {
      const toAdd = [];
      const bs = state.fogBrushSize;
      for (let dc = -bs + 1; dc < bs; dc++)
        for (let dr = -bs + 1; dr < bs; dr++)
          if (dc * dc + dr * dr < bs * bs) {
            const key = `${action.col + dc},${action.row + dr}`;
            if (!state.fogCells.includes(key)) toAdd.push(key);
          }
      if (!toAdd.length) return state;
      return { ...state, fogCells: [...state.fogCells, ...toAdd] };
    }
    // A whole brush stroke segment at once: `cells` are the squares the cursor passed over.
    case 'FOG_PAINT': {
      const bs = state.fogBrushSize;
      const cols = Math.ceil(state.mapWidth / state.gridSize);
      const rows = Math.ceil(state.mapHeight / state.gridSize);
      const stamp = [];
      for (let dc = -bs + 1; dc < bs; dc++)
        for (let dr = -bs + 1; dr < bs; dr++)
          if (dc * dc + dr * dr < bs * bs) stamp.push([dc, dr]);
      const fog = new Set(state.fogCells);
      let changed = false;
      for (const { col, row } of action.cells) {
        for (const [dc, dr] of stamp) {
          const c = col + dc, r = row + dr;
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          const key = `${c},${r}`;
          if (action.erase) { if (fog.delete(key)) changed = true; }
          else if (!fog.has(key)) { fog.add(key); changed = true; }
        }
      }
      return changed ? { ...state, fogCells: [...fog] } : state;
    }
    case 'FOG_REMOVE_CELL': {
      const toRemove = new Set();
      const bs = state.fogBrushSize;
      for (let dc = -bs + 1; dc < bs; dc++)
        for (let dr = -bs + 1; dr < bs; dr++)
          if (dc * dc + dr * dr < bs * bs)
            toRemove.add(`${action.col + dc},${action.row + dr}`);
      return { ...state, fogCells: state.fogCells.filter(k => !toRemove.has(k)) };
    }
    case 'FOG_FILL': {
      const cols = Math.ceil(state.mapWidth / state.gridSize);
      const rows = Math.ceil(state.mapHeight / state.gridSize);
      const all = [];
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++)
          all.push(`${c},${r}`);
      return { ...state, fogCells: all };
    }
    case 'FOG_CLEAR':
      return { ...state, fogCells: [] };
    case 'FOG_SET':
      return { ...state, fogColor: action.color ?? state.fogColor, fogOpacity: action.opacity ?? state.fogOpacity, fogBrushSize: action.brushSize ?? state.fogBrushSize };

    case 'AREA_ADD':
      return { ...state, areaEffects: [...state.areaEffects, action.effect] };
    case 'AREA_MOVE':
      return { ...state, areaEffects: state.areaEffects.map(e => e.id === action.id ? { ...e, x: action.x, y: action.y } : e) };
    case 'AREA_UPDATE':
      return { ...state, areaEffects: state.areaEffects.map(e => e.id === action.effect.id ? { ...e, ...action.effect } : e), contextMenu: null };
    case 'AREA_DELETE':
      return {
        ...state,
        areaEffects: state.areaEffects.filter(e => e.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
        contextMenu: null,
      };
    case 'AREA_SET_TYPE':
      return { ...state, activeAreaType: action.areaType };
    case 'AREA_SET_COLOR':
      return { ...state, activeAreaColor: action.color };
    case 'AREA_SET_PROP':
      return { ...state, [action.key]: action.value };

    // ── Markers ──
    case 'MARKER_ADD':
      return { ...state, markers: [...state.markers, action.marker] };
    case 'MARKER_UPDATE':
      return { ...state, markers: state.markers.map(m => m.id === action.marker.id ? { ...m, ...action.marker } : m) };
    case 'MARKER_DELETE':
      return {
        ...state,
        markers: state.markers.filter(m => m.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
        contextMenu: null,
      };
    case 'MARKER_MOVE':
      return { ...state, markers: state.markers.map(m => m.id === action.id ? { ...m, x: action.x, y: action.y } : m) };
    case 'MARKER_TOGGLE_VISIBLE':
      return {
        ...state,
        markers: state.markers.map(m => m.id === action.id ? { ...m, visibleToPlayers: !m.visibleToPlayers } : m),
        contextMenu: null,
      };
    case 'MARKER_SET_PROP':
      return { ...state, [action.key]: action.value };

    case 'PV_TOGGLE':
      return { ...state, playerViewEnabled: !state.playerViewEnabled };
    case 'PV_TOGGLE_TOKEN_MOVE':
      return { ...state, playerCanMoveTokens: !state.playerCanMoveTokens };
    case 'PV_SET_RECT':
      return { ...state, playerViewRect: action.rect };

    case 'TOOL_SET': {
      // Picking an area tool also becomes the shape the size fields apply to
      const areaType = AREA_TOOL_TYPES[action.tool];
      return {
        ...state,
        activeTool: action.tool,
        activeAreaType: areaType ?? state.activeAreaType,
        selectedId: null, contextMenu: null,
      };
    }

    // ── Handouts ──
    case 'HANDOUT_SHOW':
      return { ...state, handoutSrc: action.src, handoutName: action.name || '', handoutId: action.id ?? null };
    case 'HANDOUT_CLEAR':
      return { ...state, handoutSrc: null, handoutName: '', handoutId: null };
    case 'PREVIEW_SHOW':
      return { ...state, previewSrc: action.src, previewName: action.name || '' };
    case 'PREVIEW_HIDE':
      return { ...state, previewSrc: null, previewName: '' };
    case 'MODAL_IMAGES_SHOW':
      return { ...state, showImagePicker: true };
    case 'MODAL_IMAGES_HIDE':
      return { ...state, showImagePicker: false };

    // ── Character sheets ──
    case 'SHEET_OPEN': {
      // Open (or re-focus) a sheet and show the viewer
      const already = state.sheetTabs.some(t => t.id === action.sheet.id);
      return {
        ...state,
        showSheets: true,
        activeSheetId: action.sheet.id,
        sheetTabs: already ? state.sheetTabs : [...state.sheetTabs, { id: action.sheet.id, name: action.sheet.name }],
      };
    }
    case 'SHEET_CLOSE_TAB': {
      const tabs = state.sheetTabs.filter(t => t.id !== action.id);
      const wasActive = state.activeSheetId === action.id;
      const idx = state.sheetTabs.findIndex(t => t.id === action.id);
      const next = wasActive ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : state.activeSheetId;
      return { ...state, sheetTabs: tabs, activeSheetId: next, showSheets: tabs.length ? state.showSheets : false };
    }
    case 'SHEET_SET_ACTIVE':
      return { ...state, activeSheetId: action.id, showSheets: true };
    case 'SHEET_RENAME_TAB':
      return { ...state, sheetTabs: state.sheetTabs.map(t => t.id === action.id ? { ...t, name: action.name } : t) };
    case 'SHEETS_TOGGLE':
      return { ...state, showSheets: !state.showSheets };
    case 'SHEETS_HIDE':
      return { ...state, showSheets: false };
    case 'SHEETS_SET_LAYOUT':
      return { ...state, sheetLayout: action.layout };
    case 'SHEETS_SET_DOCK_WIDTH':
      return { ...state, sheetDockWidth: action.width };
    case 'SHEETS_CLOSE_ALL':
      return { ...state, sheetTabs: [], activeSheetId: null, showSheets: false };

    case 'TAB_SET':
      return { ...state, rightTab: action.tab };
    case 'MODAL_TOKEN_SHOW':
      return { ...state, showTokenModal: true, editingToken: action.token || null, editingPresetId: null };
    case 'MODAL_PRESET_SHOW':
      return { ...state, showTokenModal: true, editingToken: action.preset, editingPresetId: action.preset.id };
    case 'MODAL_TOKEN_HIDE':
      return { ...state, showTokenModal: false, editingToken: null, editingPresetId: null };
    case 'CONTEXT_MENU_SHOW':
      return { ...state, contextMenu: action.menu };
    case 'CONTEXT_MENU_HIDE':
      return { ...state, contextMenu: null };

    default:
      return state;
  }
}

const GMContext = createContext(null);

export function GMProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  useEffect(() => { broadcastState(state); }, [state]);
  // Development only: lets browser tests drive the table. Compiled out of the production build.
  if (import.meta.env?.DEV) window.__realm = { state, dispatch };
  return <GMContext.Provider value={{ state, dispatch }}>{children}</GMContext.Provider>;
}

export function useGM() { return useContext(GMContext); }
export { nanoid };
