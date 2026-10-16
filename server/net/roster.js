// Who is at the table, as the GM sees it (PLAYER_ROSTER).
//
// One entry per DEVICE: several browser windows of one phone collapse into one line with the best round-trip time.
// Devices that the table remembers but that are not connected are listed with online:false, so the GM can still
// rename or remove them. Updates are debounced so a burst of joins is one message; a message identical to the last
// one is not sent again.
import { timers, safeMetrics } from './session.js';

/**
 * @param {object} options
 * @param {object} [options.clock]
 * @param {object} [options.metrics]
 * @param {() => Iterable<object>} options.sessions   live player sessions (pending ones included)
 * @param {() => Array<object>} [options.registry]    access.table.list(): { device, playerId, name, label, status }
 * @param {(device: string) => object|null|undefined} [options.audioOf]  extra per-device audio status (WP5)
 * @param {(message: object) => boolean} options.sendToGm
 */
export function createRoster({ clock, metrics, sessions, registry, audioOf, sendToGm }) {
  const t = timers(clock);
  const m = safeMetrics(metrics);
  let cancel = null;
  let dueAt = Infinity;
  let last = null;
  let disposed = false;

  function entries() {
    const byDevice = new Map();
    let remembered = [];
    try { remembered = registry ? [...(registry() ?? [])] : []; } catch { m.inc('handlerErrors'); }
    for (const known of remembered) {
      if (!known || typeof known.device !== 'string') continue;
      if (known.status === 'revoked' || known.status === 'denied') continue;
      byDevice.set(known.device, {
        id: known.playerId ?? known.id ?? known.device,
        deviceId: known.device,
        name: known.name || known.label || '',
        device: known.label || '',
        rtt: null,
        loss: null,
        online: false,
        admitted: known.status === 'admitted',
        audio: null,
      });
    }
    for (const session of sessions()) {
      if (!session.isOpen || session.role !== 'player' || !session.device) continue;
      let entry = byDevice.get(session.device);
      if (!entry) {
        entry = { id: session.playerId, deviceId: session.device, name: '', device: '', rtt: null, loss: null, online: false, admitted: !session.pending, audio: null };
        byDevice.set(session.device, entry);
      }
      entry.online = true;
      entry.admitted = !session.pending;
      entry.name = session.name || entry.name || session.label;
      entry.device = session.label || entry.device;
      // One person may have several windows open; show their best connection.
      if (session.rtt !== null && (entry.rtt === null || session.rtt < entry.rtt)) { entry.rtt = session.rtt; entry.loss = session.loss; }
    }
    if (audioOf) {
      for (const entry of byDevice.values()) {
        try { entry.audio = audioOf(entry.deviceId) ?? null; } catch { m.inc('handlerErrors'); }
      }
    }
    return [...byDevice.values()];
  }

  function send({ force = false } = {}) {
    cancel = null;
    dueAt = Infinity;
    if (disposed) return false;
    const message = { type: 'PLAYER_ROSTER', players: entries() };
    const text = JSON.stringify(message);
    if (!force && text === last) return false;
    const sent = sendToGm(message);
    if (sent) last = text;
    return sent;
  }

  return {
    entries,
    /** Send a roster in `delay` ms (an earlier request wins over a later one). */
    soon(delay = 40) {
      if (disposed) return;
      const due = t.now() + delay;
      if (cancel && dueAt <= due) return;
      cancel?.();
      dueAt = due;
      cancel = t.after(delay, () => send());
    },
    /** Send right now, even if nothing changed (a GM window just connected). */
    now() { cancel?.(); return send({ force: true }); },
    /** Forget what was last sent, so the next update goes out. */
    reset() { last = null; },
    dispose() { disposed = true; cancel?.(); cancel = null; },
  };
}
