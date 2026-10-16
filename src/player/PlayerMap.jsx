// The players' map: pan with one finger, pinch to zoom, drag your own heroes.
//
// The GM's "player view" frame is the picture the table is meant to see. Players
// can zoom into it and look around inside it, but never beyond its edges, so
// nothing the GM kept out of frame is revealed by dragging the map.
//
// Two tools work on the map itself: PING (tap once to show everyone a spot) and MEASURE
// (drag to see the distance; it stays on this phone and is never sent anywhere).
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { Stage, Layer, Image as KImg, Rect, Group, Line, Circle, Text } from 'react-konva';
import useImage from 'use-image';
import { canPlayerMoveToken } from '../ownership.js';
import { snapTo, clamp } from '../utils';
import { GridLines, FogCells, TokenArt, MarkerShape, AreaFill, Pings, useMapProxy, useInteracting, useFontsVersion, CYAN, INK, INK_STROKE, FONT_BODY, SURFACE_1 } from '../canvas/shared';
import { usePings } from '../pings';

Konva.hitOnDragEnabled = true; // keep two-finger pinch working while a finger is already down

const MAX_ZOOM = 6;

/** Keep the visible area inside the GM's frame. `view` is zoom + the map point at the screen centre. */
export function clampView(view, size, rect) {
  const fit = Math.min(size.w / rect.width, size.h / rect.height);
  const z = clamp(view.z, 1, MAX_ZOOM);
  const scale = fit * z;
  const vw = size.w / scale, vh = size.h / scale;
  const cx = vw >= rect.width ? rect.x + rect.width / 2 : clamp(view.cx, rect.x + vw / 2, rect.x + rect.width - vw / 2);
  const cy = vh >= rect.height ? rect.y + rect.height / 2 : clamp(view.cy, rect.y + vh / 2, rect.y + rect.height - vh / 2);
  return { z, cx, cy, scale };
}

const trim = value => String(Math.round(value * 10) / 10);

/** The measuring line: dashed, with a pill saying how far it is. Drawn at a constant size on screen, whatever the zoom. */
function MeasureOverlay({ measure, gridSize, feetPerCell, snapped, scale }) {
  const { a, b } = measure;
  const dx = b.x - a.x, dy = b.y - a.y;
  // On a snapped grid squares are counted the way movement is (a diagonal step is one square); off the grid it is a straight line.
  const cells = snapped ? Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / gridSize) : Math.round((Math.hypot(dx, dy) / gridSize) * 10) / 10;
  const u = 1 / scale;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const points = [a.x, a.y, b.x, b.y];
  return (
    <Group listening={false}>
      <Line points={points} stroke={INK_STROKE} strokeWidth={8 * u} lineCap="round" opacity={0.55} />
      <Line points={points} stroke={CYAN} strokeWidth={3.5 * u} dash={[10 * u, 8 * u]} lineCap="round" />
      <Circle x={a.x} y={a.y} radius={7 * u} fill={CYAN} stroke={INK} strokeWidth={2 * u} />
      {cells > 0 && <Circle x={b.x} y={b.y} radius={7 * u} fill={INK} stroke={CYAN} strokeWidth={2.5 * u} />}
      {cells > 0 && (
        <Group x={mid.x - 75 * u} y={mid.y - 40 * u}>
          <Rect width={150 * u} height={30 * u} cornerRadius={15 * u} fill={SURFACE_1} opacity={0.94} stroke={CYAN} strokeWidth={1.5 * u} />
          <Text width={150 * u} height={30 * u} align="center" verticalAlign="middle" fontFamily={FONT_BODY} fontStyle="bold" fontSize={14 * u} fill={INK}
            text={`${trim(cells * (feetPerCell || 5))} ft · ${trim(cells)} sq`} />
        </Group>
      )}
    </Group>
  );
}

const PlayerMap = React.forwardRef(function PlayerMap({ ps, playerId, canMove, pending, tool = null, onPing, onMoveToken, onZoomChange }, ref) {
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const pinch = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState(null);       // null → centred on the frame at 1×
  const [mapImg] = useImage(ps.mapImageSrc || '');
  const mapProxy = useMapProxy(mapImg);
  const [moving, poke] = useInteracting();
  const fonts = useFontsVersion();
  const pings = usePings();
  const [measure, setMeasure] = useState(null);   // { a, b, live } in map coordinates
  const lastTap = useRef(0);
  useEffect(() => { if (tool !== 'measure') setMeasure(null); }, [tool]);

  const rect = useMemo(() => ps.playerViewRect ?? { x: 0, y: 0, width: ps.mapWidth, height: ps.mapHeight }, [ps.playerViewRect, ps.mapWidth, ps.mapHeight]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ w: Math.floor(box.width), h: Math.floor(box.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const current = useMemo(() => {
    if (!size.w || !size.h) return { z: 1, cx: 0, cy: 0, scale: 1 };
    return clampView(view ?? { z: 1, cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 }, size, rect);
  }, [view, size, rect]);
  const stageX = size.w / 2 - current.cx * current.scale;
  const stageY = size.h / 2 - current.cy * current.scale;

  useEffect(() => { onZoomChange?.(current.z); }, [current.z, onZoomChange]);

  const commit = useCallback(next => setView({ z: next.z, cx: next.cx, cy: next.cy }), []);

  /** Zoom to `z`, keeping the map point under screen position (px, py) where it is. */
  const zoomAround = useCallback((z, px, py) => {
    const point = { x: (px - stageX) / current.scale, y: (py - stageY) / current.scale };
    const fit = Math.min(size.w / rect.width, size.h / rect.height);
    const scale = fit * clamp(z, 1, MAX_ZOOM);
    commit(clampView({ z, cx: point.x - (px - size.w / 2) / scale, cy: point.y - (py - size.h / 2) / scale }, size, rect));
  }, [current.scale, stageX, stageY, size, rect, commit]);

  useImperativeHandle(ref, () => ({
    zoomBy: factor => zoomAround(current.z * factor, size.w / 2, size.h / 2),
    reset: () => setView(null),
    /** Centre on a map point. Returns false until the map has been measured. */
    focusOn: (x, y, z = Math.max(current.z, 2.2)) => {
      if (!size.w || !size.h) return false;
      commit(clampView({ z, cx: x, cy: y }, size, rect));
      return true;
    },
  }), [zoomAround, current.z, size, rect, commit]);

  const onWheel = event => {
    event.evt.preventDefault();
    poke();
    const pointer = stageRef.current.getPointerPosition();
    zoomAround(current.z * (event.evt.deltaY < 0 ? 1.15 : 1 / 1.15), pointer.x, pointer.y);
  };

  // ── Ping and measure ──
  const pointOnMap = () => stageRef.current?.getRelativePointerPosition() ?? null;
  /** A measuring end lands on the middle of a token if you touch one, otherwise on the middle of the square. */
  const snapPoint = point => {
    const hit = ps.tokens.find(token => {
      const span = (token.gridSize || 1) * ps.gridSize;
      return point.x >= token.x && point.x <= token.x + span && point.y >= token.y && point.y <= token.y + span;
    });
    if (hit) { const half = ((hit.gridSize || 1) * ps.gridSize) / 2; return { x: hit.x + half, y: hit.y + half }; }
    if (ps.snapToGrid) { const g = ps.gridSize; return { x: Math.floor(point.x / g) * g + g / 2, y: Math.floor(point.y / g) * g + g / 2 }; }
    return point;
  };
  const measureDown = event => {
    if (tool !== 'measure') return;
    if (event.evt.touches && event.evt.touches.length > 1) { setMeasure(null); return; }   // two fingers are a pinch
    const point = pointOnMap();
    if (!point) return;
    const start = snapPoint(point);
    setMeasure({ a: start, b: start, live: true });
  };
  const measureMove = event => {
    if (tool !== 'measure' || !measure?.live) return;
    if (event.evt.touches && event.evt.touches.length > 1) return;
    const point = pointOnMap();
    if (point) setMeasure(current => (current ? { ...current, b: snapPoint(point) } : current));
  };
  const measureUp = () => setMeasure(current => (current?.live ? { ...current, live: false } : current));
  const onStageTap = () => {
    if (tool !== 'ping') return;
    const now = Date.now();
    if (now - lastTap.current < 400) return;   // a touch can arrive as both a tap and a click
    lastTap.current = now;
    const point = pointOnMap();
    if (point) onPing?.(point.x, point.y);
  };

  // Two fingers: zoom and pan together
  const onTouchMove = event => {
    const touches = event.evt.touches;
    if (touches.length === 1) { measureMove(event); return; }
    if (touches.length !== 2) return;
    event.evt.preventDefault();
    poke();
    const stage = stageRef.current;
    if (stage.isDragging()) stage.stopDrag();
    const box = stage.container().getBoundingClientRect();
    const a = { x: touches[0].clientX - box.left, y: touches[0].clientY - box.top };
    const b = { x: touches[1].clientX - box.left, y: touches[1].clientY - box.top };
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const last = pinch.current;
    pinch.current = { distance, centre };
    if (!last || !last.distance) return;
    const z = clamp(current.z * (distance / last.distance), 1, MAX_ZOOM);
    const fit = Math.min(size.w / rect.width, size.h / rect.height);
    const scale = fit * z;
    // The map point that was under the previous centre must end up under the new centre.
    const point = { x: (last.centre.x - stageX) / current.scale, y: (last.centre.y - stageY) / current.scale };
    commit(clampView({ z, cx: point.x - (centre.x - size.w / 2) / scale, cy: point.y - (centre.y - size.h / 2) / scale }, size, rect));
  };
  const onTouchEnd = () => { pinch.current = null; measureUp(); };

  const dragBound = useCallback(position => {
    const next = clampView({ z: current.z, cx: (size.w / 2 - position.x) / current.scale, cy: (size.h / 2 - position.y) / current.scale }, size, rect);
    return { x: size.w / 2 - next.cx * current.scale, y: size.h / 2 - next.cy * current.scale };
  }, [current.z, current.scale, size, rect]);

  const onStageDragEnd = event => {
    if (event.target !== event.target.getStage()) return;
    commit(clampView({ z: current.z, cx: (size.w / 2 - event.target.x()) / current.scale, cy: (size.h / 2 - event.target.y()) / current.scale }, size, rect));
  };

  const fogOn = ps.showFog && ps.fogCells.length > 0;
  const turnId = ps.combat?.activeId;
  const hpOf = id => {
    const entry = ps.combat?.entries.find(e => e.tokenId === id);
    return entry?.maxHp && entry.hp !== undefined ? { fraction: Math.max(0, Math.min(1, entry.hp / entry.maxHp)) } : null;
  };
  const clip = { clipX: rect.x, clipY: rect.y, clipWidth: rect.width, clipHeight: rect.height };

  return (
    <div ref={wrapRef} className="p-map" aria-label="Battle map">
      {size.w > 0 && (
        <Stage ref={stageRef} width={size.w} height={size.h} x={stageX} y={stageY} scaleX={current.scale} scaleY={current.scale}
          draggable={tool !== 'measure'} dragBoundFunc={dragBound} dragDistance={4} onDragMove={poke} onDragEnd={onStageDragEnd}
          onWheel={onWheel} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
          onMouseDown={measureDown} onTouchStart={measureDown} onMouseMove={measureMove} onMouseUp={measureUp}
          onClick={onStageTap} onTap={onStageTap}>
          <Layer listening={false} {...clip}>
            <Rect x={0} y={0} width={ps.mapWidth} height={ps.mapHeight} fill="#0b1024" />
            {mapImg && <KImg image={moving && mapProxy ? mapProxy : mapImg} x={0} y={0} width={ps.mapWidth} height={ps.mapHeight} />}
          </Layer>
          {ps.showGrid && <Layer listening={false} {...clip}><GridLines gridSize={ps.gridSize} color={ps.gridColor} opacity={ps.gridOpacity} mapW={ps.mapWidth} mapH={ps.mapHeight} /></Layer>}
          <Layer listening={false} {...clip}>{ps.areaEffects.map(effect => <Group key={effect.id} x={effect.x} y={effect.y} listening={false}><AreaFill effect={effect} /></Group>)}</Layer>
          {fogOn && <Layer listening={false} {...clip}><FogCells cells={ps.fogCells} gridSize={ps.gridSize} color={ps.fogColor} opacity={ps.fogOpacity} /></Layer>}
          <Layer key={`m${fonts}`} listening={false} {...clip}>
            {ps.markers.map(marker => <Group key={marker.id} x={marker.x} y={marker.y} listening={false}><MarkerShape marker={marker} /></Group>)}
          </Layer>
          <Layer key={`t${fonts}`} {...clip}>
            {ps.tokens.map(token => {
              const local = pending[token.id];
              const shown = local ? { ...token, x: local.x, y: local.y } : token;
              const mine = !!playerId && token.ownerId === playerId;
              const draggable = canMove && tool !== 'measure' && canPlayerMoveToken(ps, token, playerId);
              return (
                <PlayerToken key={token.id} token={shown} gridSize={ps.gridSize} mine={mine} draggable={draggable} snap={ps.snapToGrid}
                  turn={turnId === token.id} hp={mine ? hpOf(token.id) : null} onMoved={onMoveToken} />
              );
            })}
            <Pings pings={pings} scale={current.scale} />
            {measure && <MeasureOverlay measure={measure} gridSize={ps.gridSize} feetPerCell={ps.feetPerCell} snapped={ps.snapToGrid} scale={current.scale} />}
          </Layer>
        </Stage>
      )}
    </div>
  );
});

const PlayerToken = React.memo(function PlayerToken({ token, gridSize, mine, draggable, snap, turn, hp, onMoved }) {
  const [dragging, setDragging] = useState(false);
  return (
    <Group x={token.x} y={token.y} listening={draggable} draggable={draggable} opacity={dragging ? 0.8 : 1}
      onDragStart={() => setDragging(true)}
      onDragEnd={event => {
        setDragging(false);
        let x = event.target.x(), y = event.target.y();
        if (snap) { x = snapTo(x, gridSize); y = snapTo(y, gridSize); event.target.position({ x, y }); }
        onMoved(token.id, x, y);
      }}
      onMouseEnter={event => { if (draggable) event.target.getStage().container().style.cursor = 'grab'; }}
      onMouseLeave={event => { if (draggable) event.target.getStage().container().style.cursor = 'default'; }}>
      <TokenArt token={token} gridSize={gridSize} selected={mine && !dragging} dragging={dragging} turn={turn} hp={hp} showName={false} />
    </Group>
  );
});

export default PlayerMap;
