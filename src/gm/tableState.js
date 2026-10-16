// What the GM page knows about admission: the table's mode and the devices waiting to be let in.
//
// Fed by the handlers App.jsx passes to subscribeGM (onTable, onJoinRequest, onRoster). Kept outside React state so the
// header pill, the join-request cards and the invite dialog all read one source, and requests survive the dialog closing.
import { useSyncExternalStore } from 'react';
import { sendTableCommand } from '../broadcast';

const REQUEST_TTL_MS = 5 * 60 * 1000; // the server forgets a pending device after 5 minutes
const GRACE_MS = 2500;                // a roster that is slightly behind must not erase a brand-new request

let snapshot = { table: null, requests: [] };
const listeners = new Set();
const set = next => { snapshot = next; for (const listener of [...listeners]) listener(); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

/** `{ table: { mode, locked, code } | null, requests: [{ device, name, label, ip, at }] }` */
export const useTableState = () => useSyncExternalStore(subscribe, () => snapshot);

export function setTable(table) { set({ ...snapshot, table }); }

export function addJoinRequest(request) {
  if (!request || typeof request.device !== 'string' || !request.device) return;
  const entry = {
    device: request.device,
    name: String(request.name || '').trim(),
    label: String(request.label || '').trim(),
    ip: String(request.ip || ''),
    at: Date.now(),
  };
  const others = snapshot.requests.filter(item => item.device !== entry.device);
  set({ ...snapshot, requests: [...others, entry].slice(-8) });
}

export function removeJoinRequest(device) {
  if (!snapshot.requests.some(item => item.device === device)) return;
  set({ ...snapshot, requests: snapshot.requests.filter(item => item.device !== device) });
}

/** Called with every roster: drop requests that were answered elsewhere, timed out, or whose device has gone. */
export function reconcileRequests(players) {
  const now = Date.now();
  const stillPending = new Set((players ?? []).filter(player => player.admitted === false).map(player => player.deviceId));
  const kept = snapshot.requests.filter(item => now - item.at < REQUEST_TTL_MS && (now - item.at < GRACE_MS || stillPending.has(item.device)));
  if (kept.length !== snapshot.requests.length) set({ ...snapshot, requests: kept });
}

export function answerRequest(device, admit) {
  const sent = sendTableCommand(admit ? 'admit' : 'deny', { device });
  if (sent) removeJoinRequest(device);
  return sent;
}

/** "Thorin (iPhone / Safari, 192.168.1.42)": whatever is known about the asker. */
export function describeRequest(request) {
  const detail = [request.label, request.ip].filter(Boolean).join(', ');
  return `${request.name || 'A new device'}${detail ? ` (${detail})` : ''}`;
}
