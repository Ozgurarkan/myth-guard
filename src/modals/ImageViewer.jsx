/**
 * Full-screen zoomable / pannable image viewer.
 *
 * Used by the GM (private preview) and on every player's screen (a shared handout).
 *
 *   Wheel / pinch  → zoom toward the cursor or fingers
 *   Drag           → pan
 *   Double-click   → toggle fit / zoomed in
 *   + / - / 0      → zoom in / out / fit
 *   Esc            → close (when a close handler is given)
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { clamp } from '../utils';
import { Button, IconButton, Icon } from '../ui';

const MIN_SCALE = 0.5;
const MAX_SCALE = 10;
const STEP = 1.25;

export default function ImageViewer({ src, alt = 'image', onClose, title, subtitle, closeLabel = 'Close', player = false }) {
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const pointers = useRef(new Map());      // pointerId → { x, y }
  const gesture = useRef(null);            // pan or pinch in progress
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // A cached or data-URL image can finish loading before this effect runs, so check `complete` instead of
  // blindly resetting (otherwise the picture would stay hidden behind the spinner).
  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 });
    const img = imgRef.current;
    setLoaded(!!(img && img.complete && img.naturalWidth > 0));
  }, [src]);

  /** Zoom by `factor`, keeping the point under (clientX, clientY) fixed; omit them to zoom about the centre. */
  const zoomAt = useCallback((factor, clientX, clientY) => {
    setView(v => {
      const s = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
      const k = s / v.s;
      if (k === 1) return v;
      let px = 0, py = 0;
      if (clientX != null && wrapRef.current) {
        const r = wrapRef.current.getBoundingClientRect();
        px = clientX - (r.left + r.width / 2);
        py = clientY - (r.top + r.height / 2);
      }
      return { s, x: px - k * (px - v.x), y: py - k * (py - v.y) };
    });
  }, []);
  const reset = useCallback(() => setView({ s: 1, x: 0, y: 0 }), []);

  // React's onWheel is passive, so attach a native listener that may preventDefault
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = event => { event.preventDefault(); zoomAt(event.deltaY < 0 ? STEP : 1 / STEP, event.clientX, event.clientY); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = event => {
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
      if (event.key === '+' || event.key === '=') zoomAt(STEP);
      else if (event.key === '-' || event.key === '_') zoomAt(1 / STEP);
      else if (event.key === '0') reset();
      else if (event.key === 'Escape' && onClose) onClose();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomAt, reset, onClose]);

  // ── Pointer gestures: one finger pans, two fingers pinch ──
  const onPointerDown = event => {
    if (event.button > 1) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 1) gesture.current = { type: 'pan', x: event.clientX, y: event.clientY };
    else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { type: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }
    setBusy(true);
  };
  const onPointerMove = event => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'pan' && pointers.current.size === 1) {
      const dx = event.clientX - g.x, dy = event.clientY - g.y;
      gesture.current = { ...g, x: event.clientX, y: event.clientY };
      setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else if (g.type === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (g.distance > 0) zoomAt(distance / g.distance, cx, cy);
      setView(v => ({ ...v, x: v.x + (cx - g.cx), y: v.y + (cy - g.cy) }));
      gesture.current = { type: 'pinch', distance, cx, cy };
    }
  };
  const endPointer = event => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) { gesture.current = null; setBusy(false); }
    else if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      gesture.current = { type: 'pan', x: p.x, y: p.y };
    }
  };

  return (
    <div ref={wrapRef} className={`viewer${player ? ' viewer--player' : ''}${busy ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer}
      onDoubleClick={event => { if (view.s > 1.05) reset(); else zoomAt(2.5 / view.s, event.clientX, event.clientY); }}
      role="dialog" aria-modal="true" aria-label={title || alt}>
      <div className="viewer__stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transition: busy ? 'none' : 'transform .12s ease-out' }}>
        <figure className={`viewer__frame${loaded ? ' is-loaded' : ''}`}>
          <img ref={imgRef} src={src} alt={alt} draggable={false} onLoad={() => setLoaded(true)} />
        </figure>
      </div>

      {(title || subtitle) && (
        <header className="viewer__title" onPointerDown={event => event.stopPropagation()}>
          {subtitle && <span className="eyebrow">{subtitle}</span>}
          {title && <h2>{title}</h2>}
        </header>
      )}
      {!loaded && <div className="viewer__loading"><Icon name="loader-circle" size={28} className="dlg-spin" /></div>}

      <div className="viewer__controls" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <IconButton icon="minus" label="Zoom out (−)" variant="ghost" onClick={() => zoomAt(1 / STEP)} />
        <span className="viewer__zoom">{Math.round(view.s * 100)}%</span>
        <IconButton icon="plus" label="Zoom in (+)" variant="ghost" onClick={() => zoomAt(STEP)} />
        <IconButton icon="expand" label="Fit to screen (0)" variant="ghost" onClick={reset} />
        {onClose && <Button size="sm" variant={player ? 'secondary' : 'danger'} icon={player ? 'eye-off' : 'x'} onClick={onClose}>{closeLabel}</Button>}
      </div>
      <p className="viewer__hint">Scroll or pinch to zoom · drag to move · double-tap to zoom in</p>
    </div>
  );
}
