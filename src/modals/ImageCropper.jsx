/**
 * ImageCropper — choose the part of a picture that becomes a token.
 *
 *  • shape "circle":   the round token on the map (exports 256×256, transparent corners)
 *  • shape "portrait": the taller initiative-bar portrait (exports 256×288)
 *
 * Drag inside the outline to move it; drag the round handle to resize.
 * Pointer events, so it works with a mouse, a pen or a finger.
 */
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Button } from '../ui';

const CANVAS_PX = 320;
const HANDLE_R = 10;
const MIN_CROP_R = 20;
const OUTPUT_PX = 256;
// Konva/canvas cannot read CSS variables, so these mirror --accent / --accent-2 / --text-on-accent in tokens.css.
const ACCENT = '#a58bff';
const CYAN = '#4fd8ee';
const INK = '#0d0a26';

export default function ImageCropper({ src, onCrop, onCancel, shape = 'circle' }) {
  const isPortrait = shape === 'portrait';
  const ASPECT = isPortrait ? 76 / 86 : 1;
  const canvasRef = useRef(null);
  const previewRef = useRef(null);
  const [imgEl, setImgEl] = useState(null);
  const [imgRect, setImgRect] = useState(null);
  const [circle, setCircle] = useState(null);
  const [box, setBox] = useState(null);
  const [cursor, setCursor] = useState('default');
  const dragRef = useRef(null);

  // Load the image and start with the largest crop that fits.
  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      const scale = Math.min(CANVAS_PX / img.width, CANVAS_PX / img.height);
      const sw = img.width * scale, sh = img.height * scale;
      const sx = (CANVAS_PX - sw) / 2, sy = (CANVAS_PX - sh) / 2;
      setImgRect({ sx, sy, sw, sh });
      if (isPortrait) {
        const w = Math.min(sw - 16, (sh - 16) * ASPECT);
        const h = w / ASPECT;
        setBox({ x: sx + (sw - w) / 2, y: sy + (sh - h) / 2, w, h });
      } else {
        setCircle({ x: sx + sw / 2, y: sy + sh / 2, r: Math.max(MIN_CROP_R, Math.min(sw, sh) / 2 - 8) });
      }
    };
    img.src = src;
  }, [src, isPortrait, ASPECT]);

  // Paint: dimmed picture, bright crop area, thirds grid, outline and a clear round handle.
  useEffect(() => {
    if (!imgEl || (!circle && !box) || !imgRect || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    const { sx, sy, sw, sh } = imgRect;
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    ctx.save(); ctx.globalAlpha = 0.3; ctx.drawImage(imgEl, sx, sy, sw, sh); ctx.restore();

    const handle = (hx, hy) => {
      ctx.save();
      ctx.shadowColor = ACCENT; ctx.shadowBlur = 12;
      ctx.fillStyle = ACCENT; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = INK;
      ctx.beginPath(); ctx.arc(hx, hy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };
    // Rule-of-thirds guide lines inside the crop area
    const thirds = (x0, y0, w, h) => {
      ctx.save(); ctx.strokeStyle = CYAN; ctx.globalAlpha = 0.4; ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(x0 + (w * i) / 3, y0); ctx.lineTo(x0 + (w * i) / 3, y0 + h);
        ctx.moveTo(x0, y0 + (h * i) / 3); ctx.lineTo(x0 + w, y0 + (h * i) / 3);
      }
      ctx.stroke(); ctx.restore();
    };
    if (isPortrait && box) {
      ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip(); ctx.drawImage(imgEl, sx, sy, sw, sh); ctx.restore();
      thirds(box.x, box.y, box.w, box.h);
      ctx.save(); ctx.strokeStyle = CYAN; ctx.lineWidth = 1.5; ctx.shadowColor = CYAN; ctx.shadowBlur = 8; ctx.strokeRect(box.x, box.y, box.w, box.h); ctx.restore();
      // Corner brackets
      const L = 14;
      ctx.save(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath();
      [[box.x, box.y, 1, 1], [box.x + box.w, box.y, -1, 1], [box.x, box.y + box.h, 1, -1]].forEach(([cx, cy, dx, dy]) => {
        ctx.moveTo(cx + dx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * L);
      });
      ctx.stroke(); ctx.restore();
      handle(box.x + box.w, box.y + box.h);
      return;
    }
    const { x, y, r } = circle;
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(imgEl, sx, sy, sw, sh);
    thirds(x - r, y - r, r * 2, r * 2); ctx.restore();
    ctx.save(); ctx.strokeStyle = CYAN; ctx.lineWidth = 2.5; ctx.shadowColor = CYAN; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.strokeStyle = 'rgba(79, 216, 238, 0.7)'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke(); ctx.restore();
    handle(x + r, y);
  }, [imgEl, circle, box, imgRect, isPortrait]);

  // Live preview of what will be exported
  useEffect(() => {
    const out = previewRef.current;
    if (!out || !imgEl || !imgRect || (!circle && !box)) return;
    const ctx = out.getContext('2d');
    const w = out.width, h = out.height;
    ctx.clearRect(0, 0, w, h);
    const crop = isPortrait ? box : { x: circle.x - circle.r, y: circle.y - circle.r, w: circle.r * 2, h: circle.r * 2 };
    if (!crop) return;
    const kx = imgEl.width / imgRect.sw, ky = imgEl.height / imgRect.sh;
    ctx.drawImage(imgEl, (crop.x - imgRect.sx) * kx, (crop.y - imgRect.sy) * ky, crop.w * kx, crop.h * ky, 0, 0, w, h);
  }, [imgEl, circle, box, imgRect, isPortrait]);

  const getPos = useCallback(event => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (CANVAS_PX / rect.width), y: (event.clientY - rect.top) * (CANVAS_PX / rect.height) };
  }, []);

  const hitTest = useCallback(pos => {
    if (isPortrait && box) {
      if (Math.hypot(pos.x - (box.x + box.w), pos.y - (box.y + box.h)) <= HANDLE_R + 8) return 'resize';
      return pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h ? 'move' : 'none';
    }
    if (!circle) return 'none';
    if (Math.hypot(pos.x - (circle.x + circle.r), pos.y - circle.y) <= HANDLE_R + 8) return 'resize';
    return Math.hypot(pos.x - circle.x, pos.y - circle.y) <= circle.r ? 'move' : 'none';
  }, [circle, box, isPortrait]);

  const onPointerDown = useCallback(event => {
    if (!circle && !box) return;
    const pos = getPos(event);
    const hit = hitTest(pos);
    if (hit === 'none') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { type: hit, ox: pos.x, oy: pos.y, oc: { ...(isPortrait ? box : circle) } };
  }, [circle, box, getPos, hitTest, isPortrait]);

  const onPointerMove = useCallback(event => {
    if ((!circle && !box) || !imgRect) return;
    const pos = getPos(event);
    if (!dragRef.current) {
      const hit = hitTest(pos);
      setCursor(hit === 'resize' ? 'nwse-resize' : hit === 'move' ? 'move' : 'default');
      return;
    }
    const { type, ox, oy, oc } = dragRef.current;
    const { sx, sy, sw, sh } = imgRect;
    if (isPortrait && box) {
      if (type === 'move') {
        setBox({ ...oc, x: Math.max(sx, Math.min(sx + sw - oc.w, oc.x + pos.x - ox)), y: Math.max(sy, Math.min(sy + sh - oc.h, oc.y + pos.y - oy)) });
      } else {
        const maxW = Math.min(sx + sw - oc.x, (sy + sh - oc.y) * ASPECT);
        const w = Math.max(34, Math.min(maxW, Math.max(pos.x - oc.x, 34)));
        setBox({ ...oc, w, h: w / ASPECT });
      }
    } else if (type === 'move') {
      setCircle(prev => ({ ...prev, x: Math.max(sx + oc.r, Math.min(sx + sw - oc.r, oc.x + pos.x - ox)), y: Math.max(sy + oc.r, Math.min(sy + sh - oc.r, oc.y + pos.y - oy)) }));
    } else {
      const maxR = Math.min(oc.x - sx, sx + sw - oc.x, oc.y - sy, sy + sh - oc.y);
      setCircle(prev => ({ ...prev, r: Math.min(Math.max(MIN_CROP_R, Math.hypot(pos.x - oc.x, pos.y - oc.y)), maxR) }));
    }
  }, [circle, box, imgRect, getPos, hitTest, isPortrait, ASPECT]);

  const endDrag = useCallback(() => { dragRef.current = null; }, []);

  const confirm = useCallback(() => {
    if (!imgEl || (!circle && !box) || !imgRect) return;
    const out = document.createElement('canvas');
    out.width = OUTPUT_PX;
    out.height = isPortrait ? 288 : OUTPUT_PX;
    const ctx = out.getContext('2d');
    if (!isPortrait) { ctx.beginPath(); ctx.arc(OUTPUT_PX / 2, OUTPUT_PX / 2, OUTPUT_PX / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip(); }
    const kx = imgEl.width / imgRect.sw, ky = imgEl.height / imgRect.sh;
    const crop = isPortrait ? box : { x: circle.x - circle.r, y: circle.y - circle.r, w: circle.r * 2, h: circle.r * 2 };
    ctx.drawImage(imgEl, (crop.x - imgRect.sx) * kx, (crop.y - imgRect.sy) * ky, crop.w * kx, crop.h * ky, 0, 0, OUTPUT_PX, out.height);
    onCrop(out.toDataURL('image/png'));
  }, [imgEl, circle, box, imgRect, onCrop, isPortrait]);

  return (
    <div className="dlg-cropper">
      <div className="dlg-cropper__stage">
        <canvas ref={canvasRef} width={CANVAS_PX} height={CANVAS_PX} className="dlg-cropper__canvas" style={{ cursor }}
          aria-label={isPortrait ? 'Crop the initiative portrait' : 'Crop the token'}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} />
      </div>
      <div className="dlg-cropper__bar">
        <canvas ref={previewRef} width={isPortrait ? 100 : 112} height={112} className={`dlg-cropper__preview${isPortrait ? ' is-portrait' : ''}`} role="img" aria-label="Preview of the crop" />
        <p className="dlg-cropper__hint">Drag <strong>inside</strong> the {isPortrait ? 'frame' : 'circle'} to move it · drag the <strong>round handle</strong> to resize it.</p>
      </div>
      <div className="dlg-cropper__actions">
        <Button variant="ghost" icon="chevron-left" onClick={onCancel}>Back</Button>
        <Button variant="primary" icon="check" onClick={confirm}>Use this crop</Button>
      </div>
    </div>
  );
}
