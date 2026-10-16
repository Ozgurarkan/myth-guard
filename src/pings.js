// Map pings: a short-lived "look here" that every screen at the table draws for a few seconds.
// Pings are not part of the scene. They arrive as messages, are shown, and are forgotten.
import { useEffect, useState } from 'react';

export const PING_EVENT = 'realm:ping';
export const PING_MS = 3600;
const MAX_PINGS = 8;

// Each player keeps one colour for the whole session, so "who pinged" reads at a glance.
const COLORS = ['#4fd8ee', '#a58bff', '#4fe3a1', '#ffc15a', '#ff6f8e', '#6fb0ff'];
export function pingColor(id = '') {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

/** Hand a ping received from the table to every ping layer on this screen. */
export function emitPing(ping) {
  if (!ping || !Number.isFinite(ping.x) || !Number.isFinite(ping.y)) return;
  window.dispatchEvent(new CustomEvent(PING_EVENT, { detail: ping }));
}

let nextKey = 1;

/** The pings that are still on screen. Each is `{ key, id, name, x, y, color, at }` (`at` is performance.now()). */
export function usePings() {
  const [pings, setPings] = useState([]);
  useEffect(() => {
    const timers = new Set();
    const onPing = event => {
      const { id, name, x, y } = event.detail;
      const ping = { key: nextKey++, id, name: String(name || '').slice(0, 24), x, y, color: pingColor(id), at: performance.now() };
      setPings(current => [...current.slice(-(MAX_PINGS - 1)), ping]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setPings(current => current.filter(item => item.key !== ping.key));
      }, PING_MS);
      timers.add(timer);
    };
    window.addEventListener(PING_EVENT, onPing);
    return () => {
      window.removeEventListener(PING_EVENT, onPing);
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);
  return pings;
}
