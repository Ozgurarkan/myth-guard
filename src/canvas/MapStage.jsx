/**
 * MapStage – the GM's Konva canvas:
 *   Map → Grid → Spell areas → Fog → Markers → Tokens → Player-view frame
 */
import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Stage, Layer, Image as KImg, Rect, Circle, Text, Group, Arc } from 'react-konva';
import useImage from 'use-image';
import { useGM, AREA_TOOL_TYPES } from '../store';
import { nanoid, snapTo, ftToPx, areaSizeLabel, roundFt, clamp } from '../utils';
import { usePings } from '../pings';
import { useTokenLive, createLiveSender } from '../liveTokens';
import { sendGmTokenLive } from '../broadcast';
import { getStage, setStage, useStage } from '../stageView';
import { GridLines, FogCells, TokenArt, MarkerShape, AreaFill, Pings, useMapProxy, useInteracting, areaShape, useFontsVersion, FONT_BODY, CYAN, CYAN_HI, SURFACE_1, INK, INK_STROKE } from './shared';

// ── Tokens ────────────────────────────────────────────────────────────────────
// While a token is dragged its position is passed to the players as it moves (the server drops it for hidden or fogged tokens).
const liveSender = createLiveSender(sendGmTokenLive);

function TokenItem({ token, selected, turn, hp, onSelect, onMove, onContextMenu, snap, gridSize }) {
  const hidden = token.visibleToPlayers === false;
  const [dragging, setDragging] = useState(false);
  const group = useRef(null);
  const latest = useRef(token);
  latest.current = token;
  const home = useCallback(() => ({ x: latest.current.x, y: latest.current.y }), []);
  useTokenLive(token.id, group, home); // a player dragging their own hero moves it here too
  return (
    <Group
      ref={group} x={token.x} y={token.y} draggable opacity={dragging ? 0.8 : 1}
      onDragMove={event => { if (!hidden) liveSender.move(token.id, event.target.x(), event.target.y()); }}
      onMouseDown={event => { event.cancelBubble = true; onSelect(token.id); }}
      onDragStart={() => setDragging(true)}
      onContextMenu={event => {
        event.evt.preventDefault(); event.cancelBubble = true;
        onContextMenu({ type: 'token', id: token.id, x: event.evt.clientX, y: event.evt.clientY });
      }}
      onDragEnd={event => {
        setDragging(false);
        let x = event.target.x(), y = event.target.y();
        if (snap) { x = snapTo(x, gridSize); y = snapTo(y, gridSize); event.target.position({ x, y }); }
        if (!hidden) liveSender.end(token.id, x, y);
        onMove(token.id, x, y);
      }}
    >
      <TokenArt token={token} gridSize={gridSize} selected={selected} turn={turn} hp={hp} dragging={dragging} ghost={hidden} />
    </Group>
  );
}

function MarkerItem({ marker, selected, onSelect, onMove, onContextMenu }) {
  const hidden = !marker.visibleToPlayers;
  return (
    <Group
      x={marker.x} y={marker.y} draggable opacity={hidden ? 0.55 : 1}
      onMouseDown={event => { event.cancelBubble = true; onSelect(marker.id); }}
      onContextMenu={event => {
        event.evt.preventDefault(); event.cancelBubble = true;
        onContextMenu({ type: 'marker', id: marker.id, x: event.evt.clientX, y: event.evt.clientY });
      }}
      onDragEnd={event => onMove(marker.id, event.target.x(), event.target.y())}
    >
      {/* The marker shapes do not listen; this invisible disc gives them a hit area. */}
      <Circle radius={Math.max(marker.size, 12)} fill="transparent" />
      <MarkerShape marker={marker} selected={selected} />
    </Group>
  );
}

// ── Spell areas ───────────────────────────────────────────────────────────────
/** Where the "30 ft" caption sits relative to the shape anchor */
function areaLabelOffset(effect) {
  if (effect.type === 'rect') return { x: effect.width / 2, y: effect.height / 2 - 7 };
  if (effect.type === 'circle') return { x: 0, y: -7 };
  return { x: 0, y: -20 };
}

const caption = (x, y, text, color = INK) => (
  <Text x={x - 70} y={y} width={140} text={text} fontSize={13} fontStyle="bold" fontFamily={FONT_BODY} fill={color} align="center"
    stroke={INK_STROKE} strokeWidth={3} fillAfterStrokeEnabled listening={false} />
);

function AreaItem({ effect, selected, onSelect, onMove, onContextMenu, gridSize, feetPerCell }) {
  const offset = areaLabelOffset(effect);
  return (
    <Group
      x={effect.x} y={effect.y} draggable
      onMouseDown={event => { event.cancelBubble = true; onSelect(effect.id); }}
      onContextMenu={event => {
        event.evt.preventDefault(); event.cancelBubble = true;
        onContextMenu({ type: 'effect', id: effect.id, x: event.evt.clientX, y: event.evt.clientY });
      }}
      onDragEnd={event => onMove(effect.id, event.target.x(), event.target.y())}
    >
      <AreaFill effect={effect} selected={selected} />
      {selected && caption(offset.x, offset.y, areaSizeLabel(effect, gridSize, feetPerCell))}
    </Group>
  );
}

function GhostArea({ shape, color, gridSize, feetPerCell }) {
  if (!shape) return null;
  const offset = areaLabelOffset(shape);
  return (
    <Group x={shape.x} y={shape.y} listening={false}>
      {areaShape(shape, { fill: `${color}55`, stroke: color, strokeWidth: 1.8, dash: [7, 4] })}
      {caption(offset.x, offset.y, areaSizeLabel(shape, gridSize, feetPerCell), color)}
    </Group>
  );
}

function TempArea({ temp, color, coneAngle, gridSize, feetPerCell }) {
  if (!temp) return null;
  const ft = px => roundFt(px, gridSize, feetPerCell);
  const style = { fill: `${color}66`, stroke: color, strokeWidth: 1.8, dash: [7, 4], listening: false };
  if (temp.type === 'circle') return <>
    <Circle x={temp.x} y={temp.y} radius={temp.r} {...style} />
    {caption(temp.x, temp.y - 7, `R ${ft(temp.r)} ft`, color)}
  </>;
  if (temp.type === 'rect') {
    const rx = temp.w < 0 ? temp.x + temp.w : temp.x;
    const ry = temp.h < 0 ? temp.y + temp.h : temp.y;
    const rw = Math.abs(temp.w), rh = Math.abs(temp.h);
    return <>
      <Rect x={rx} y={ry} width={rw} height={rh} {...style} />
      {caption(rx + rw / 2, ry + rh / 2 - 7, `${ft(rw)} × ${ft(rh)} ft`, color)}
    </>;
  }
  if (temp.type === 'cone') return <>
    <Arc x={temp.x} y={temp.y} innerRadius={0} outerRadius={temp.r} angle={coneAngle} rotation={temp.rot - coneAngle / 2} {...style} />
    {caption(temp.x, temp.y - 20, `${ft(temp.r)} ft · ${Math.round(coneAngle)}°`, color)}
  </>;
  return null;
}

// ── Player view frame ─────────────────────────────────────────────────────────
function PlayerViewOverlay({ rect, onUpdate }) {
  const resize = event => onUpdate({ x: rect.x, y: rect.y, width: Math.max(100, event.target.x() + 9 - rect.x), height: Math.max(80, event.target.y() + 9 - rect.y) });
  return (
    <Layer>
      <Rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} stroke={CYAN} strokeWidth={2.5} strokeScaleEnabled={false} dash={[14, 7]} fill="rgba(79,216,238,.06)"
        draggable onDragEnd={event => onUpdate({ ...rect, x: event.target.x(), y: event.target.y() })} />
      <Text x={rect.x + 8} y={rect.y + 8} text="WHAT THE PLAYERS SEE" fontSize={11} letterSpacing={2} fontFamily={FONT_BODY} fontStyle="bold" fill={CYAN_HI}
        stroke={INK_STROKE} strokeWidth={3} fillAfterStrokeEnabled listening={false} />
      <Rect x={rect.x + rect.width - 9} y={rect.y + rect.height - 9} width={18} height={18} fill={CYAN} stroke={SURFACE_1} strokeWidth={2} cornerRadius={4}
        draggable onDragMove={resize} onDragEnd={resize} />
    </Layer>
  );
}

// ── Stage ─────────────────────────────────────────────────────────────────────
/** The map picture, on its own layer. Draws the lighter copy while the view is moving (see useMapProxy). */
const MapPicture = React.memo(function MapPicture({ frame, mapImage, mapProxy, moving, mapWidth, mapHeight }) {
  return (
    <Layer listening={false}>
      <Rect {...frame} fill="#03050d" stroke="#4458a0" strokeWidth={2} strokeScaleEnabled={false} />
      {mapImage
        ? <KImg image={moving && mapProxy ? mapProxy : mapImage} x={0} y={0} width={mapWidth} height={mapHeight} />
        : <Rect x={0} y={0} width={mapWidth} height={mapHeight} fill="#0e1430" />}
    </Layer>
  );
});

/**
 * Everything drawn on the map: grid, spell areas, fog, markers, tokens, pings. Memoised on purpose. Panning and zooming change
 * only the stage's position, so none of these props change and React skips every one of these shapes on each step.
 */
const SceneLayers = React.memo(function SceneLayers({ state, dispatch, select, menu, fonts, tempArea, ghost, exactMode, turnId, pings, moving }) {
  // While the view is moving nobody is clicking tokens, so Konva skips redrawing its hidden click-detection copy of every shape.
  const interactive = !moving;
  const hpOf = id => {
    const entry = state.combat.entries.find(e => e.tokenId === id);
    return entry?.maxHp ? { fraction: Math.max(0, Math.min(1, entry.hp / entry.maxHp)) } : null;
  };
  return (
    <>
      {/* 2. Grid */}
      {state.showGrid && <Layer listening={false}><GridLines gridSize={state.gridSize} color={state.gridColor} opacity={state.gridOpacity} mapW={state.mapWidth} mapH={state.mapHeight} /></Layer>}

      {/* 3. Spell areas */}
      <Layer key={`areas-${fonts}`} listening={interactive}>
        {state.areaEffects.map(effect => (
          <AreaItem key={effect.id} effect={effect} selected={state.selectedId === effect.id} onSelect={select}
            onMove={(id, x, y) => dispatch({ type: 'AREA_MOVE', id, x, y })} onContextMenu={menu} gridSize={state.gridSize} feetPerCell={state.feetPerCell} />
        ))}
        <TempArea temp={tempArea} color={state.activeAreaColor} coneAngle={state.areaConeAngle} gridSize={state.gridSize} feetPerCell={state.feetPerCell} />
        {exactMode && <GhostArea shape={ghost} color={state.activeAreaColor} gridSize={state.gridSize} feetPerCell={state.feetPerCell} />}
      </Layer>

      {/* 4. Fog of war */}
      {state.showFog && state.fogCells.length > 0 && (
        <Layer listening={false}><FogCells cells={state.fogCells} gridSize={state.gridSize} color={state.fogColor} opacity={Math.min(state.fogOpacity, 0.82)} /></Layer>
      )}

      {/* 5. Markers — above fog so the GM always sees them */}
      <Layer key={`markers-${fonts}`} listening={interactive}>
        {state.markers.map(marker => (
          <MarkerItem key={marker.id} marker={marker} selected={state.selectedId === marker.id} onSelect={select}
            onMove={(id, x, y) => dispatch({ type: 'MARKER_MOVE', id, x, y })} onContextMenu={menu} />
        ))}
      </Layer>

      {/* 6. Tokens */}
      <Layer key={`tokens-${fonts}`} listening={interactive}>
        {state.tokens.map(token => (
          <TokenItem key={token.id} token={token} selected={state.selectedId === token.id} turn={turnId === token.id} hp={hpOf(token.id)}
            onSelect={select} onMove={(id, x, y) => dispatch({ type: 'TOKEN_MOVE', id, x, y })} onContextMenu={menu}
            snap={state.snapToGrid} gridSize={state.gridSize} />
        ))}
        {/* Pings from the players: a short ripple where they pointed */}
        <Pings pings={pings} />
      </Layer>
    </>
  );
});

export default function MapStage({ containerRef }) {
  const { state, dispatch } = useGM();
  const stageRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [mapImage] = useImage(state.mapImageSrc || '');
  const mapProxy = useMapProxy(mapImage);
  const [moving, poke] = useInteracting();
  const stage = useStage();
  const commitTimer = useRef(null);
  const committed = useRef(null);
  // Pan and zoom change dozens of times a second. They live in a store of their own (stageView.js), so only this map redraws
  // on each step; the shared scene state hears about the new view once, shortly after the movement stops.
  const moveStage = useCallback(next => {
    setStage(next);
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      const v = getStage();
      committed.current = v;
      dispatch({ type: 'STAGE_SET', x: v.x, y: v.y, scale: v.scale });
    }, 160);
  }, [dispatch]);
  useEffect(() => () => clearTimeout(commitTimer.current), []);
  // A scene load or reset changes the view from outside: follow it (but never rewind our own, newer movement).
  useEffect(() => {
    const mine = committed.current;
    if (mine && mine.x === state.stageX && mine.y === state.stageY && mine.scale === state.stageScale) return;
    setStage({ x: state.stageX, y: state.stageY, scale: state.stageScale });
  }, [state.stageX, state.stageY, state.stageScale]);
  const [tempArea, setTempArea] = useState(null);
  const [ghost, setGhost] = useState(null);
  const fonts = useFontsVersion();
  const pings = usePings();

  const isPanning = useRef(false);
  const panLast = useRef({ x: 0, y: 0 });
  const isPaintingFog = useRef(false);
  const lastFogCell = useRef(null);
  const isDrawingArea = useRef(false);
  const areaOrigin = useRef({ x: 0, y: 0 });
  const isAimingCone = useRef(false);
  const fitted = useRef('');

  const areaType = AREA_TOOL_TYPES[state.activeTool] ?? null;
  const exactMode = areaType !== null && state.areaSizeMode === 'exact';

  useEffect(() => {
    const el = containerRef?.current;
    if (!el) return undefined;
    const obs = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [containerRef]);

  // ── Camera: fit, zoom buttons ──
  const fit = useCallback(() => {
    if (!size.width || !size.height) return;
    const scale = clamp(Math.min(size.width / state.mapWidth, size.height / state.mapHeight) * 0.94, 0.04, 4);
    moveStage({ scale, x: (size.width - state.mapWidth * scale) / 2, y: (size.height - state.mapHeight * scale) / 2 });
  }, [size, state.mapWidth, state.mapHeight, moveStage]);

  // Each new map (or scene) starts fitted to the window.
  const mapKey = `${state.mapImageSrc ? state.mapImageSrc.length : 0}:${state.mapWidth}x${state.mapHeight}:${state.currentMapId}`;
  useEffect(() => {
    if (!size.width || fitted.current === mapKey) return;
    fitted.current = mapKey;
    fit();
  }, [mapKey, size.width, fit]);

  useEffect(() => {
    const onView = event => {
      const detail = event.detail || {};
      if (detail.fit) { fit(); return; }
      const cur = getStage();
      const scale = detail.reset ? 1 : clamp(cur.scale * (detail.zoom || 1), 0.04, 12);
      const cx = size.width / 2, cy = size.height / 2;
      const mx = (cx - cur.x) / cur.scale, my = (cy - cur.y) / cur.scale;
      moveStage({ scale, x: cx - mx * scale, y: cy - my * scale });
    };
    window.addEventListener('realm:view', onView);
    return () => window.removeEventListener('realm:view', onView);
  }, [fit, size, moveStage]);

  const toMap = useCallback(() => {
    const pos = stageRef.current?.getPointerPosition();
    if (!pos) return { x: 0, y: 0 };
    const cur = getStage();
    return { x: (pos.x - cur.x) / cur.scale, y: (pos.y - cur.y) / cur.scale };
  }, []);

  /** Build a shape of exactly the feet the GM typed, anchored at `pt`. */
  const buildExactShape = useCallback((pt, rotation = 0) => {
    if (!areaType) return null;
    const { gridSize, feetPerCell, snapToGrid } = state;
    const px = feet => ftToPx(Math.max(0.5, Number(feet) || 0), gridSize, feetPerCell);
    if (areaType === 'rect') {
      const width = px(state.areaWidthFt), height = px(state.areaHeightFt);
      let x = pt.x - width / 2, y = pt.y - height / 2;
      if (snapToGrid) { x = snapTo(x, gridSize); y = snapTo(y, gridSize); }
      return { type: 'rect', x, y, width, height };
    }
    let x = pt.x, y = pt.y;
    if (snapToGrid) { x = snapTo(x, gridSize); y = snapTo(y, gridSize); }
    if (areaType === 'circle') return { type: 'circle', x, y, radius: px(state.areaRadiusFt) };
    return { type: 'cone', x, y, radius: px(state.areaConeLengthFt), angle: state.areaConeAngle, rotation };
  }, [areaType, state]);

  useEffect(() => { if (!exactMode) { setGhost(null); isAimingCone.current = false; } }, [exactMode]);

  const handleWheel = useCallback(event => {
    event.evt.preventDefault();
    poke();
    const stage = stageRef.current;
    const pointer = stage.getPointerPosition();
    const { x: sx, y: sy, scale: old } = getStage();
    const scale = clamp(event.evt.deltaY < 0 ? old * 1.08 : old / 1.08, 0.04, 12);
    const mp = { x: (pointer.x - sx) / old, y: (pointer.y - sy) / old };
    moveStage({ x: pointer.x - mp.x * scale, y: pointer.y - mp.y * scale, scale });
  }, [moveStage, poke]);

  const cellOf = pt => ({ col: Math.floor(pt.x / state.gridSize), row: Math.floor(pt.y / state.gridSize) });

  /** Paint from the last square to this one, so a fast stroke leaves no gaps. */
  const paintFog = erase => {
    const to = cellOf(toMap());
    const from = lastFogCell.current ?? to;
    const cells = [];
    const steps = Math.max(Math.abs(to.col - from.col), Math.abs(to.row - from.row), 1);
    for (let i = 0; i <= steps; i++) {
      cells.push({ col: Math.round(from.col + ((to.col - from.col) * i) / steps), row: Math.round(from.row + ((to.row - from.row) * i) / steps) });
    }
    lastFogCell.current = to;
    dispatch({ type: 'FOG_PAINT', cells, erase });
  };

  const handleMouseDown = useCallback(event => {
    const { activeTool } = state;
    const button = event.evt.button;
    if (button === 1 || activeTool === 'pan') {
      isPanning.current = true;
      panLast.current = { x: event.evt.clientX, y: event.evt.clientY };
      event.evt.preventDefault();
      return;
    }
    if (button !== 0) return;
    const onBackground = event.target === event.target.getStage();

    if (activeTool === 'fog' || activeTool === 'fogErase') {
      isPaintingFog.current = true;
      lastFogCell.current = null;
      paintFog(activeTool === 'fogErase');
    } else if (exactMode) {
      const pt = toMap();
      areaOrigin.current = { x: pt.x, y: pt.y };
      isAimingCone.current = true;
      setGhost(buildExactShape(pt));
    } else if (areaType) {
      isDrawingArea.current = true;
      const pt = toMap();
      areaOrigin.current = { x: pt.x, y: pt.y };
      setTempArea({ type: areaType, x: pt.x, y: pt.y, r: 0, w: 0, h: 0, rot: 0 });
    } else if (activeTool === 'marker' && onBackground) {
      const pt = toMap();
      dispatch({ type: 'MARKER_ADD', marker: {
        id: nanoid(), type: state.activeMarkerType, x: pt.x, y: pt.y, size: state.activeMarkerSize, color: state.activeMarkerColor,
        label: state.activeMarkerLabel, filled: state.activeMarkerFilled, opacity: state.activeMarkerOpacity, visibleToPlayers: true,
      } });
    } else if (activeTool === 'select' && onBackground) {
      dispatch({ type: 'SELECT', id: null });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, dispatch, toMap, areaType, exactMode, buildExactShape]);

  const handleMouseMove = useCallback(event => {
    if (isPanning.current) {
      const dx = event.evt.clientX - panLast.current.x;
      const dy = event.evt.clientY - panLast.current.y;
      panLast.current = { x: event.evt.clientX, y: event.evt.clientY };
      poke();
      const cur = getStage();
      moveStage({ x: cur.x + dx, y: cur.y + dy, scale: cur.scale });
      return;
    }
    if (isPaintingFog.current) paintFog(state.activeTool === 'fogErase');
    if (isDrawingArea.current && tempArea) {
      const pt = toMap();
      const dx = pt.x - areaOrigin.current.x, dy = pt.y - areaOrigin.current.y;
      setTempArea(prev => ({ ...prev, r: Math.max(1, Math.hypot(dx, dy)), w: dx, h: dy, rot: Math.atan2(dy, dx) * 180 / Math.PI }));
    }
    if (exactMode) {
      const pt = toMap();
      if (isAimingCone.current) {
        const o = areaOrigin.current;
        setGhost(buildExactShape(o, Math.atan2(pt.y - o.y, pt.x - o.x) * 180 / Math.PI));
      } else setGhost(buildExactShape(pt));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, dispatch, toMap, tempArea, exactMode, buildExactShape]);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
    isPaintingFog.current = false;
    lastFogCell.current = null;
    if (isAimingCone.current && ghost) {
      isAimingCone.current = false;
      dispatch({ type: 'AREA_ADD', effect: { ...ghost, id: nanoid(), color: state.activeAreaColor, opacity: 0.4 } });
    }
    isAimingCone.current = false;
    if (isDrawingArea.current && tempArea && tempArea.r > 10) {
      const effect = { id: nanoid(), type: tempArea.type, x: areaOrigin.current.x, y: areaOrigin.current.y, color: state.activeAreaColor, opacity: 0.4 };
      if (tempArea.type === 'circle') effect.radius = Math.max(10, tempArea.r);
      else if (tempArea.type === 'rect') {
        effect.x = tempArea.w < 0 ? areaOrigin.current.x + tempArea.w : areaOrigin.current.x;
        effect.y = tempArea.h < 0 ? areaOrigin.current.y + tempArea.h : areaOrigin.current.y;
        effect.width = Math.max(10, Math.abs(tempArea.w));
        effect.height = Math.max(10, Math.abs(tempArea.h));
      } else if (tempArea.type === 'cone') {
        effect.radius = Math.max(10, tempArea.r);
        effect.angle = state.areaConeAngle;
        effect.rotation = tempArea.rot;
      }
      dispatch({ type: 'AREA_ADD', effect });
    }
    isDrawingArea.current = false;
    setTempArea(null);
  }, [state, dispatch, tempArea, ghost]);

  const cursor = { pan: 'grab', fog: 'cell', fogErase: 'cell', areaCircle: 'crosshair', areaRect: 'crosshair', areaCone: 'crosshair', marker: 'crosshair' }[state.activeTool] ?? 'default';
  const turnId = state.combat.activeId;
  const select = useCallback(id => dispatch({ type: 'SELECT', id }), [dispatch]);
  const menu = useCallback(m => dispatch({ type: 'CONTEXT_MENU_SHOW', menu: m }), [dispatch]);
  const frame = useMemo(() => ({ x: -10, y: -10, width: state.mapWidth + 20, height: state.mapHeight + 20 }), [state.mapWidth, state.mapHeight]);

  // Konva cannot draw into a zero-sized canvas, so wait for the first real measurement.
  if (!size.width || !size.height) return null;

  return (
    <Stage
      ref={stageRef} width={size.width} height={size.height}
      x={stage.x} y={stage.y} scaleX={stage.scale} scaleY={stage.scale}
      onWheel={handleWheel} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}
      onMouseLeave={() => { isPanning.current = false; isAimingCone.current = false; setGhost(null); }}
      onClick={() => { if (state.contextMenu) dispatch({ type: 'CONTEXT_MENU_HIDE' }); }}
      style={{ cursor, display: 'block' }}
    >
      <MapPicture frame={frame} mapImage={mapImage} mapProxy={mapProxy} moving={moving} mapWidth={state.mapWidth} mapHeight={state.mapHeight} />
      <SceneLayers state={state} dispatch={dispatch} select={select} menu={menu} fonts={fonts} tempArea={tempArea} ghost={ghost} exactMode={exactMode} turnId={turnId} pings={pings} moving={moving} />

      {/* 7. Player view frame (GM only) */}
      {state.playerViewEnabled && <PlayerViewOverlay rect={state.playerViewRect} onUpdate={rect => dispatch({ type: 'PV_SET_RECT', rect })} />}
    </Stage>
  );
}
