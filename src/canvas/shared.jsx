// Map drawing parts shared by the GM canvas and the players' canvas.
//
// Fog and grid are each drawn as ONE shape instead of one node per cell/line.
// A 5,000-square fog bank used to be 5,000 canvas objects that every phone had
// to build and redraw; now it is a single path.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Konva from 'konva';
import { Shape, Group, Circle, Rect, Text, Line, Ellipse, Image as KImg, Arc, RegularPolygon, Star } from 'react-konva';
import useImage from 'use-image';
import { PING_MS } from '../pings';

// Canvases are drawn at no more than 1.75x the screen's pixel size. A phone reports 3x, which means nine times the pixels
// to repaint on every frame of a pan, zoom or pulse, for a sharpness nobody can see on a battle map.
if (typeof window !== 'undefined') Konva.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);

// Family names are the ones @fontsource-variable registers ('Inter Variable', 'Cormorant Variable').
export const FONT_BODY = "'Inter Variable', Inter, system-ui, 'Segoe UI', sans-serif";
export const FONT_DISPLAY = "'Cormorant Variable', Cormorant, Georgia, serif";

// Konva cannot read CSS variables, so the "moonlit spell-library" palette (src/styles/tokens.css) is mirrored here as literals.
export const ACCENT = '#a58bff';        // --accent        arcane violet
export const ACCENT_HI = '#cbbcff';     // --accent-hi
export const ACCENT_LO = '#6a4fd6';     // --accent-lo
export const CYAN = '#4fd8ee';          // --accent-2      spell-cyan (active turn, player frame)
export const CYAN_HI = '#9bebf7';       // --accent-2-hi
export const DANGER = '#ff6f8e';        // --danger
export const SUCCESS = '#4fe3a1';       // --success
export const WARNING = '#ffc15a';       // --warning
export const SURFACE_0 = '#060916';     // --surface-0
export const SURFACE_1 = '#0b1024';     // --surface-1
export const TEXT_3 = '#a0acd6';        // --text-3
export const INK = '#eef2ff';           // --text
export const INK_STROKE = '#060916';    // dark halo behind map text, so labels read on any map
export const DEFAULT_TOKEN_COLOR = '#8591c0';   // --text-4

/** Canvas text is painted once, so it must wait for the web fonts. Returns a number that changes when they arrive. */
export function useFontsVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!document.fonts?.load) return undefined;
    let live = true;
    Promise.all([
      document.fonts.load(`600 12px ${FONT_BODY}`), document.fonts.load(`700 12px ${FONT_BODY}`), document.fonts.load(`600 12px ${FONT_DISPLAY}`), document.fonts.load(`700 12px ${FONT_DISPLAY}`),
    ]).then(() => { if (live) setVersion(v => v + 1); }, () => {});
    return () => { live = false; };
  }, []);
  return version;
}

// ── Grid ─────────────────────────────────────────────────────────────────────
export function GridLines({ gridSize, color, opacity, mapW, mapH }) {
  return (
    <Shape listening={false} perfectDrawEnabled={false} stroke={color} strokeWidth={0.7} opacity={opacity}
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        for (let x = 0; x <= mapW; x += gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, mapH); }
        for (let y = 0; y <= mapH; y += gridSize) { ctx.moveTo(0, y); ctx.lineTo(mapW, y); }
        ctx.strokeShape(shape);
      }} />
  );
}

// ── Fog ──────────────────────────────────────────────────────────────────────
export function FogCells({ cells, gridSize, color, opacity }) {
  const coordinates = useMemo(() => {
    const out = new Int32Array(cells.length * 2);
    cells.forEach((key, i) => {
      const comma = key.indexOf(',');
      out[i * 2] = Number(key.slice(0, comma));
      out[i * 2 + 1] = Number(key.slice(comma + 1));
    });
    return out;
  }, [cells]);
  return (
    <Shape listening={false} perfectDrawEnabled={false} fill={color} opacity={opacity}
      sceneFunc={(ctx, shape) => {
        ctx.beginPath();
        // One path for every square: no seams between neighbours, one fill for the whole bank.
        for (let i = 0; i < coordinates.length; i += 2) ctx.rect(coordinates[i] * gridSize, coordinates[i + 1] * gridSize, gridSize, gridSize);
        ctx.fillShape(shape);
      }} />
  );
}

// ── Tokens ───────────────────────────────────────────────────────────────────
const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Active turn: a pulsing cyan ring PLUS a pointer above the token. The pointer is a shape cue, so the turn
 * stays readable without colour or motion (the pulse is skipped when the viewer prefers reduced motion).
 */
function TurnRing({ radius }) {
  const ring = useRef(null);
  useEffect(() => {
    const node = ring.current;
    if (!node || prefersReducedMotion()) return undefined;
    let last = -1000;
    const animation = new Konva.Animation(frame => {
      if (frame.time - last < 45) return false;   // ~22 fps is plenty for a pulse; every frame repaints the whole layer
      last = frame.time;
      const wave = (Math.sin(frame.time / 280) + 1) / 2;
      node.opacity(0.5 + wave * 0.5);
      node.strokeWidth(2.5 + wave * 2);
    }, node.getLayer());
    animation.start();
    return () => animation.stop();
  }, []);
  return (
    <>
      <Circle x={radius} y={radius} radius={radius + 9} stroke={CYAN} strokeWidth={10} opacity={0.2} listening={false} />
      <Circle ref={ref => { ring.current = ref; }} x={radius} y={radius} radius={radius + 9} stroke={CYAN} strokeWidth={3.5} listening={false} />
      <RegularPolygon x={radius} y={-19} sides={3} radius={7} rotation={180} fill={CYAN} stroke={INK_STROKE} strokeWidth={1.5} listening={false} />
    </>
  );
}

/** Small eye-with-a-slash badge: this token is hidden from the players (a shape cue, not just the faded look). */
function HiddenBadge({ x, y }) {
  return (
    <Group x={x} y={y} listening={false}>
      <Circle radius={10} fill={SURFACE_1} stroke={TEXT_3} strokeWidth={1.4} />
      <Ellipse radiusX={5.5} radiusY={3.4} stroke={TEXT_3} strokeWidth={1.3} />
      <Circle radius={1.6} fill={TEXT_3} />
      <Line points={[-5.5, 5.5, 5.5, -5.5]} stroke={SURFACE_1} strokeWidth={4} lineCap="round" />
      <Line points={[-5.5, 5.5, 5.5, -5.5]} stroke={INK} strokeWidth={1.6} lineCap="round" />
    </Group>
  );
}

/**
 * The token's picture, ring, number badge and name. Interaction is added by the caller's Group.
 * States, each with a non-colour cue:  selected = extra solid halo ring · active turn = pulsing ring + pointer above ·
 * hidden (`ghost`) = faded + dashed ring + eye-slash badge · down (hp 0) = dimmed + a cross over the token + empty HP bar.
 */
export function TokenArt({ token, gridSize, selected = false, dragging = false, turn = false, ghost = false, hp = null, showName = true }) {
  const [img] = useImage(token.imageSrc || '');
  const size = token.gridSize * gridSize;
  const half = size / 2;
  const ring = token.borderWidth ?? 8;
  const color = token.color || DEFAULT_TOKEN_COLOR;
  const inner = Math.max(1, half - ring / 2);
  const down = !!hp && hp.fraction <= 0;
  const fade = down ? 0.55 : 1;
  return (
    <>
      {turn && <TurnRing radius={half} />}
      {selected && <Circle x={half} y={half} radius={half + 4} stroke={ACCENT_HI} strokeWidth={2.5} listening={false} />}
      {dragging && <Circle x={half} y={half} radius={half + 5} stroke={ACCENT_HI} strokeWidth={2} dash={[6, 4]} listening={false} />}
      {/* A dark disc under the art keeps transparent portraits readable on any map. */}
      <Circle x={half} y={half} radius={inner} fill={SURFACE_1} opacity={(ghost ? 0.5 : 0.88) * fade} listening />
      {img && (
        // Konva only clips containers, so the picture goes in a Group shaped like the ring.
        <Group clipFunc={ctx => { ctx.beginPath(); ctx.arc(half, half, inner, 0, Math.PI * 2); ctx.closePath(); }} listening={false}>
          <KImg x={0} y={0} width={size} height={size} image={img} opacity={(ghost ? 0.55 : 1) * fade} />
        </Group>
      )}
      <Circle x={half} y={half} radius={inner} fill={img ? 'transparent' : `${color}33`} stroke={color} strokeWidth={ring}
        opacity={(ghost ? 0.6 : 1) * fade} dash={ghost ? [8, 5] : undefined} />
      {!img && token.name && (
        <Text x={0} y={half - size * 0.17} width={size} align="center" text={token.name.trim().slice(0, 2).toUpperCase()} fontFamily={FONT_DISPLAY}
          fontStyle="bold" fontSize={size * 0.34} fill={INK} opacity={fade} listening={false} />
      )}
      {down && (
        <Group x={half} y={half} listening={false}>
          {[[INK_STROKE, 7], [DANGER, 3.5]].map(([stroke, width]) => (
            <React.Fragment key={stroke}>
              <Line points={[-inner * 0.5, -inner * 0.5, inner * 0.5, inner * 0.5]} stroke={stroke} strokeWidth={width} lineCap="round" />
              <Line points={[inner * 0.5, -inner * 0.5, -inner * 0.5, inner * 0.5]} stroke={stroke} strokeWidth={width} lineCap="round" />
            </React.Fragment>
          ))}
        </Group>
      )}
      {ghost && <HiddenBadge x={9} y={-3} />}
      {token.showNumber && token.number !== null && token.number !== undefined && (
        <Group x={size - 9} y={-3} listening={false}>
          <Circle radius={10} fill={ACCENT_LO} stroke={ACCENT_HI} strokeWidth={1.4} />
          <Text x={-10} y={-5.5} width={20} text={String(token.number)} fontSize={11} fontStyle="bold" fontFamily={FONT_BODY} fill="#fff" align="center" />
        </Group>
      )}
      {hp && (
        <Group x={size * 0.12} y={size + 3} listening={false}>
          <Rect width={size * 0.76} height={6} fill="#050813" cornerRadius={3} stroke={INK_STROKE} strokeWidth={0.5} />
          <Rect x={0.5} y={0.5} width={Math.max(0, (size * 0.76 - 1) * hp.fraction)} height={5} fill={hp.fraction > 0.5 ? SUCCESS : hp.fraction > 0.25 ? WARNING : DANGER} cornerRadius={2.5} />
        </Group>
      )}
      {showName && token.name && (
        <Text x={-size * 0.6} y={size + (hp ? 11 : 4)} width={size * 2.2} align="center" text={token.name} fontFamily={FONT_BODY} fontStyle="bold"
          fontSize={Math.max(11, Math.min(15, gridSize * 0.26))} fill={INK} stroke={INK_STROKE} strokeWidth={3} fillAfterStrokeEnabled listening={false} />
      )}
    </>
  );
}

// ── Markers & spell areas ────────────────────────────────────────────────────
export function MarkerShape({ marker, selected = false }) {
  const { type, size, color, label, filled, opacity } = marker;
  const props = {
    fill: filled ? `${color}cc` : 'transparent', stroke: color, strokeWidth: selected ? 3 : 2, opacity, listening: false,
  };
  let shape = null;
  if (type === 'circle') shape = <Circle radius={size} {...props} />;
  else if (type === 'square') shape = <Rect x={-size} y={-size} width={size * 2} height={size * 2} {...props} />;
  else if (type === 'triangle') shape = <RegularPolygon sides={3} radius={size} {...props} />;
  else if (type === 'diamond') shape = <RegularPolygon sides={4} radius={size} rotation={45} {...props} />;
  else if (type === 'hexagon') shape = <RegularPolygon sides={6} radius={size} {...props} />;
  else if (type === 'star') shape = <Star numPoints={5} innerRadius={size * 0.45} outerRadius={size} {...props} />;
  return (
    <>
      {selected && <Circle radius={size + 6} stroke={ACCENT_HI} strokeWidth={1.6} dash={[4, 3]} listening={false} />}
      {shape}
      {label && <Text x={-70} y={size + 5} width={140} text={label} fontSize={13} fontStyle="bold" fontFamily={FONT_BODY} fill={INK} stroke={INK_STROKE} strokeWidth={3}
        fillAfterStrokeEnabled align="center" listening={false} />}
    </>
  );
}

/** Spell area drawn at the group origin: circle centre · rectangle corner · cone apex. */
export function areaShape(effect, props) {
  if (effect.type === 'circle') return <Circle radius={effect.radius} {...props} />;
  if (effect.type === 'rect') return <Rect width={effect.width} height={effect.height} {...props} />;
  if (effect.type === 'cone') {
    const angle = effect.angle ?? 60;
    return <Arc innerRadius={0} outerRadius={effect.radius} angle={angle} rotation={(effect.rotation ?? 0) - angle / 2} {...props} />;
  }
  return null;
}

export function AreaFill({ effect, selected = false }) {
  return areaShape(effect, {
    fill: effect.color, opacity: effect.opacity ?? 0.4, listening: true,
    stroke: selected ? ACCENT_HI : effect.color, strokeWidth: selected ? 2 : 1.2, strokeScaleEnabled: false,
  });
}

// ── Pings ────────────────────────────────────────────────────────────────────
/**
 * One ping: three rings ripple out from a bright pin, with the pinger's name underneath. The ripple is skipped
 * when the viewer prefers reduced motion; the pin, one ring and the name still say where to look.
 */
function PingMarker({ ping, scale }) {
  const rings = useRef([]);
  // Sizes are in screen pixels (u converts them to map units), so a ping reads the same on a zoomed-out phone as on a big monitor.
  const u = 1 / (scale || 1);
  const near = 9 * u, far = 62 * u;
  useEffect(() => {
    const layer = rings.current.find(Boolean)?.getLayer();
    if (!layer || prefersReducedMotion()) return undefined;
    let last = -1000;
    const animation = new Konva.Animation(frame => {
      if (frame.time - last < 33) return false;   // ~30 fps
      last = frame.time;
      const age = performance.now() - ping.at;
      const fade = Math.max(0, Math.min(1, (PING_MS - age) / 500));
      rings.current.forEach((node, i) => {
        if (!node) return;
        const phase = (frame.time / 1250 + i / 3) % 1;
        node.radius(near + phase * (far - near));
        node.opacity((1 - phase) * 0.95 * fade);
        node.strokeWidth((1.5 + 3.5 * (1 - phase)) * u);
      });
    }, layer);
    animation.start();
    return () => animation.stop();
  }, [ping.at, near, far, u]);
  const dot = 6 * u;
  const reduced = prefersReducedMotion();
  return (
    <Group x={ping.x} y={ping.y} listening={false}>
      {[0, 1, 2].map(i => (
        <Circle key={i} ref={node => { rings.current[i] = node; }} radius={reduced ? near + (far - near) * 0.5 : near} stroke={ping.color}
          strokeWidth={3 * u} opacity={reduced ? (i === 0 ? 0.9 : 0) : 0.9} />
      ))}
      <Circle radius={dot * 1.9} fill={INK_STROKE} opacity={0.7} />
      <Circle radius={dot} fill={ping.color} stroke={INK} strokeWidth={2 * u} />
      {ping.name && (
        <Text text={ping.name} x={-90 * u} width={180 * u} y={16 * u} align="center" fontFamily={FONT_BODY} fontStyle="bold"
          fontSize={13 * u} fill={INK} stroke={INK_STROKE} strokeWidth={4 * u} fillAfterStrokeEnabled />
      )}
    </Group>
  );
}

/** Every ping that is still on screen. Place this inside a Konva layer; `scale` is the stage's zoom. */
export function Pings({ pings, scale }) {
  return pings.map(ping => <PingMarker key={ping.key} ping={ping} scale={scale} />);
}

// ── Smooth motion on big maps ────────────────────────────────────────────────
// Panning and zooming repaint the map picture on every frame. A 4096-pixel map is far more detail than a moving
// screen can show, so while the view is moving the lighter copy is drawn, and the full picture returns a moment after.
const PROXY_SIDE = 1400;
export function useMapProxy(image) {
  return useMemo(() => {
    if (!image || !image.width || typeof document === 'undefined') return null;
    const longest = Math.max(image.width, image.height);
    if (longest <= PROXY_SIDE * 1.3) return null;     // small maps are cheap enough as they are
    const scale = PROXY_SIDE / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }, [image]);
}

/** [moving, poke]: call poke() on every pan, zoom or pinch step; moving stays true until the view has rested for idleMs. */
export function useInteracting(idleMs = 140) {
  const [moving, setMoving] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const poke = useCallback(() => {
    setMoving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoving(false), idleMs);
  }, [idleMs]);
  return [moving, poke];
}
