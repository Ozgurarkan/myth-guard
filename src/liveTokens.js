// Tokens that somebody else is dragging right now.
//
// Live positions are not part of the scene: they arrive as small messages while a hand is still on the token, are drawn
// a little smoothed, and are forgotten when the drop (a normal move) lands or when they stop coming. A token follows
// its own live feed by moving the Konva node directly, so nothing in React re-renders 60 times a second.
import { useEffect } from 'react';

const SMOOTHING_MS = 70;      // how quickly a token catches up with the newest position it was told about
const IDLE_MS = 900;          // no news for this long (and caught up): the token goes back to its real place
const SEND_EVERY_MS = 40;     // about 25 updates a second leave a phone, plenty for a smooth follow

const entries = new Map();    // id -> { x, y (shown), tx, ty (target), at (last news) }
const listeners = new Map();  // id -> Set(fn(position | null))
let frame = 0;
let lastTick = 0;

function notify(id, position) {
  for (const fn of listeners.get(id) ?? []) fn(position);
}

function tick(now) {
  frame = 0;
  const dt = Math.min(100, now - lastTick || 16);
  lastTick = now;
  const follow = 1 - Math.exp(-dt / SMOOTHING_MS);
  for (const [id, entry] of entries) {
    entry.x += (entry.tx - entry.x) * follow;
    entry.y += (entry.ty - entry.y) * follow;
    const settled = Math.abs(entry.tx - entry.x) < 0.25 && Math.abs(entry.ty - entry.y) < 0.25;
    if (settled) { entry.x = entry.tx; entry.y = entry.ty; }
    if (settled && now - entry.at > IDLE_MS) { entries.delete(id); notify(id, null); continue; }
    notify(id, { x: entry.x, y: entry.y });
  }
  if (entries.size) frame = requestAnimationFrame(tick);
}

/** A position for a token, received from the table. */
export function emitTokenLive({ id, x, y }) {
  if (typeof id !== 'string' || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const now = performance.now();
  const entry = entries.get(id);
  if (entry) { entry.tx = x; entry.ty = y; entry.at = now; }
  else entries.set(id, { x, y, tx: x, ty: y, at: now });
  if (!frame) { lastTick = now; frame = requestAnimationFrame(tick); }
}

/** Forget everything (a different scene, or the connection dropped): tokens go back to where the scene has them. */
export function clearTokenLive() {
  const ids = [...entries.keys()];
  entries.clear();
  for (const id of ids) notify(id, null);
}

/**
 * Let a token's Konva group follow its live feed. `nodeRef.current` is the group; `home` returns where the scene says
 * the token is. While the local hand is dragging the node, the feed is ignored.
 */
export function useTokenLive(id, nodeRef, home) {
  useEffect(() => {
    const move = position => {
      const node = nodeRef.current;
      if (!node || node.isDragging()) return;
      const target = position ?? home();
      if (node.x() === target.x && node.y() === target.y) return;
      node.position(target);
      node.getLayer()?.batchDraw();
    };
    let set = listeners.get(id);
    if (!set) { set = new Set(); listeners.set(id, set); }
    set.add(move);
    return () => { set.delete(move); if (!set.size) listeners.delete(id); };
  }, [id, nodeRef, home]);
}

/**
 * Sends a token's position while it is dragged, a few dozen times a second at most.
 *   const live = createLiveSender(send);   live.move(id, x, y) on every drag move;  live.end(id, x, y) on the drop.
 */
export function createLiveSender(send) {
  let last = 0;
  return {
    move(id, x, y) {
      const now = performance.now();
      if (now - last < SEND_EVERY_MS) return;
      last = now;
      send(id, x, y);
    },
    end(id, x, y) { last = 0; send(id, x, y); },
  };
}
