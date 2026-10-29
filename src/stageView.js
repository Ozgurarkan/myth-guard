// The map's pan and zoom, kept apart from the scene state on purpose.
//
// A pan or a zoom changes the view dozens of times a second. If every step went through the shared scene state, the
// whole GM screen (header, every panel, thirty combatant cards) would re-render on every step, which is what made panning
// stutter on slower computers. Here only the map and the little zoom read-outs listen. The scene state is told about the
// view once, shortly after the movement stops (see MapStage).
import { useSyncExternalStore } from 'react';

let view = { x: 0, y: 0, scale: 1 };
const listeners = new Set();

export const getStage = () => view;

export function setStage(next) {
  if (next.x === view.x && next.y === view.y && next.scale === view.scale) return;
  view = { x: next.x, y: next.y, scale: next.scale };
  for (const listener of listeners) listener();
}

const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const useStage = () => useSyncExternalStore(subscribe, getStage);
