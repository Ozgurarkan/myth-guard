// The fallback audio relay (design 5.4): the GM's page sends RFA3 packets over /__realm/audio, this fans them out to the
// phones that are on the WebSocket path.
//
// What is different from the old relay (server/audioRelay.js), and why:
//   * Authentication is the hub's job (the same upgrade check as the control socket); this module gets `(ws, auth)`.
//   * A listener receives nothing unless audioSignal marked it ELIGIBLE (selected by the GM, listening, on the fallback path).
//   * Each listener has a BOUNDED queue: at most 8 packets (about 680 ms) and 64 KB. When it overflows the OLDEST packets are
//     dropped (skip to live), and the number dropped is written into the `flags` byte of the next packet that is sent, so
//     the phone knows the gap is permanent instead of waiting for it.
//   * Packets are handed to the socket only while it has little unsent data and at most two writes are in flight (the `send`
//     callback tells when a write has left), so a frozen phone cannot make this process hold more than the queue bound.
//   * The GM's packet handler never waits for a listener: it queues and returns.
//   * A listener that makes no progress for `slowCloseMs` is closed with 4009 (it reconnects and resumes).
import { peekRfa3, withFlags } from '../../src/audio/pcm.js';
import { LIMITS, CLOSE } from '../../src/net/protocol.js';

export const RELAY_DEFAULTS = Object.freeze({
  maxPackets: 8,
  maxBytes: 64 * 1024,
  maxInflight: 2,
  highWater: 8 * 1024,          // do not write while the socket already holds more than this unsent
  socketsPerDevice: 2,
  maxStrayFrames: 20,           // frames a listener may send before it is closed (it should send none)
  maxPacketBytes: LIMITS.audioMaxPayload,
});

const OPEN = 1; // WebSocket.OPEN, without importing ws

export function createAudioRelay({ metrics, clock, config = {} } = {}) {
  const cfg = { ...RELAY_DEFAULTS, ...config };
  const now = () => clock?.now?.() ?? Date.now();
  const count = (name, n = 1) => { try { metrics?.inc?.(name, n); } catch { /* metrics must never break audio */ } };
  const log = line => { try { metrics?.log?.(line); } catch { /* ignore */ } };

  let gm = null;                       // { ws }
  let active = false;
  const listeners = new Map();         // device -> Set<entry>
  const eligible = new Set();          // devices that may receive frames
  const totals = { packetsIn: 0, rejected: 0, sent: 0, dropped: 0, skippedFlagged: 0, slowClosed: 0 };

  const entriesOf = device => listeners.get(device) ?? new Set();

  function closeSocket(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* already gone */ }
  }

  // ---- per-listener queue ------------------------------------------------------------------------------------------
  function pump(entry) {
    const { ws } = entry;
    while (entry.queue.length && entry.inflight < cfg.maxInflight && ws.readyState === OPEN && (ws.bufferedAmount ?? 0) <= cfg.highWater) {
      const item = entry.queue.shift();
      entry.queueBytes -= item.bytes.length;
      let data = item.bytes;
      if (entry.skips > 0) {
        data = withFlags(item.bytes, Math.min(255, (item.flags || 0) + entry.skips));
        totals.skippedFlagged += entry.skips;
        entry.skips = 0;
      }
      if (entry.inflight === 0) entry.progressAt = now();
      entry.inflight++;
      entry.sent++;
      totals.sent++;
      try {
        ws.send(data, { binary: true, compress: false }, error => {
          entry.inflight = Math.max(0, entry.inflight - 1);
          entry.progressAt = now();
          if (error) { count('audio.relay.sendError'); return; }
          pump(entry);
        });
      } catch {
        entry.inflight = Math.max(0, entry.inflight - 1);
        count('audio.relay.sendError');
        break;
      }
    }
  }

  function enqueue(entry, bytes, flags) {
    let dropped = 0;
    while (entry.queue.length && (entry.queue.length >= cfg.maxPackets || entry.queueBytes + bytes.length > cfg.maxBytes)) {
      entry.queueBytes -= entry.queue.shift().bytes.length;
      dropped++;
    }
    if (dropped) { entry.skips += dropped; entry.dropped += dropped; totals.dropped += dropped; count('audio.relay.dropped', dropped); }
    if (!entry.queue.length && entry.inflight === 0) entry.progressAt = now();
    entry.queue.push({ bytes, flags });
    entry.queueBytes += bytes.length;
    pump(entry);
  }

  function checkSlow(entry, at) {
    if ((entry.inflight > 0 || entry.queue.length > 0) && at - entry.progressAt >= LIMITS.slowCloseMs) {
      totals.slowClosed++;
      count('audio.relay.slowClosed');
      log(`audio relay: closing slow listener ${entry.device.slice(0, 8)}`);
      closeSocket(entry.ws, CLOSE.SLOW, 'slow');
      entry.queue.length = 0;
      entry.queueBytes = 0;
    }
  }

  // ---- the GM's packets --------------------------------------------------------------------------------------------
  function fromGm(data, isBinary) {
    if (!isBinary) { totals.rejected++; count('audio.relay.gmText'); return; }
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (bytes.length > cfg.maxPacketBytes) { totals.rejected++; count('audio.relay.oversize'); return; }
    const info = peekRfa3(bytes);
    if (!info) { totals.rejected++; count('audio.relay.malformed'); return; }
    if (!active) return;
    totals.packetsIn++;
    const at = now();
    for (const device of eligible) {
      for (const entry of entriesOf(device)) {
        if (entry.ws.readyState !== OPEN) continue;
        checkSlow(entry, at);
        enqueue(entry, bytes, info.flags);
      }
    }
  }

  // ---- sockets -----------------------------------------------------------------------------------------------------
  function startHeartbeat(ws, onDead) {
    if (!clock?.setInterval || typeof ws.ping !== 'function') return () => {};
    let lastSeen = now();
    ws.on?.('pong', () => { lastSeen = now(); });
    ws.on?.('message', () => { lastSeen = now(); });
    const timer = clock.setInterval(() => {
      if (now() - lastSeen > LIMITS.serverDeadMs) { onDead(); return; }
      try { ws.ping(); } catch { /* closing */ }
    }, LIMITS.serverPingMs);
    return () => clock.clearInterval?.(timer);
  }

  function attachGm(ws) {
    const previous = gm;
    gm = { ws };
    if (previous && previous.ws !== ws) closeSocket(previous.ws, CLOSE.REPLACED, 'replaced');
    ws.on('message', fromGm);
    const stop = startHeartbeat(ws, () => { try { ws.terminate?.(); } catch { /* ignore */ } });
    ws.on('close', () => { stop(); if (gm?.ws === ws) gm = null; });
    ws.on('error', () => {});
  }

  function attachListener(ws, auth) {
    const device = auth.device;
    const set = listeners.get(device) ?? new Set();
    listeners.set(device, set);
    const entry = { ws, device, queue: [], queueBytes: 0, inflight: 0, skips: 0, dropped: 0, sent: 0, strays: 0, progressAt: now() };
    set.add(entry);
    while (set.size > cfg.socketsPerDevice) {
      const oldest = set.values().next().value;
      set.delete(oldest);
      closeSocket(oldest.ws, 1000, 'replaced');
    }
    ws.on('message', () => {
      // A listener has nothing to say on this socket; tolerate a little, then close it.
      count('audio.relay.listenerFrame');
      if (++entry.strays > cfg.maxStrayFrames) closeSocket(ws, CLOSE.ABUSE, 'abuse');
    });
    const stop = startHeartbeat(ws, () => { try { ws.terminate?.(); } catch { /* ignore */ } });
    ws.on('close', () => {
      stop();
      set.delete(entry);
      if (!set.size && listeners.get(device) === set) listeners.delete(device);
    });
    ws.on('error', () => {});
  }

  return {
    /** The handler for hub.upgradeAudio: (ws, auth) with auth.role 'gm' or 'player' and auth.device. */
    attach(ws, auth) {
      if (auth?.role === 'gm') attachGm(ws);
      else if (auth?.role === 'player' && typeof auth.device === 'string') attachListener(ws, auth);
      else closeSocket(ws, CLOSE.AUTH, 'auth');
    },
    /** Frames go only to eligible devices. Turning eligibility on starts from an empty queue (no stale sound). */
    setEligible(device, on) {
      if (on) {
        if (!eligible.has(device)) for (const entry of entriesOf(device)) { entry.queue.length = 0; entry.queueBytes = 0; entry.skips = 0; }
        eligible.add(device);
      } else {
        eligible.delete(device);
        for (const entry of entriesOf(device)) { entry.queue.length = 0; entry.queueBytes = 0; }
      }
    },
    /** The GM said whether it is broadcasting; when it stops, nothing stays queued. */
    setActive(on) {
      active = on === true;
      if (!active) for (const set of listeners.values()) for (const entry of set) { entry.queue.length = 0; entry.queueBytes = 0; entry.skips = 0; }
    },
    isEligible: device => eligible.has(device),
    hasListenerSocket: device => entriesOf(device).size > 0,
    hasGm: () => gm !== null,
    stats() {
      return {
        ...totals, gm: gm !== null, active, eligible: [...eligible],
        listeners: [...listeners.entries()].map(([device, set]) => ({
          device, sockets: set.size,
          queued: [...set].reduce((s, e) => s + e.queue.length, 0), queuedBytes: [...set].reduce((s, e) => s + e.queueBytes, 0),
          sent: [...set].reduce((s, e) => s + e.sent, 0), dropped: [...set].reduce((s, e) => s + e.dropped, 0),
        })),
      };
    },
    close() {
      for (const set of listeners.values()) for (const entry of set) closeSocket(entry.ws, CLOSE.SHUTDOWN, 'shutdown');
      if (gm) closeSocket(gm.ws, CLOSE.SHUTDOWN, 'shutdown');
      listeners.clear();
      eligible.clear();
      gm = null;
    },
  };
}
