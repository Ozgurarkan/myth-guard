// The player-facing copy of the scene, and how it reaches the phones (design 4.5 - 4.7).
//
//   GM scene (complete) --project--> view (what players may see) --diffState--> patch {rev, base}
//
// The server owns `view`. Late joiners and reconnects are served from it without troubling the GM. Every change of
// the view bumps `rev` by one and is kept as a pre-serialised string in a history of the last 64 patches, so a phone
// that blinked for two seconds gets two small patches instead of a snapshot. A phone that is too far behind, or
// whose revision this server never produced, gets one STATE_FULL.
//
// The raw scene (hidden tokens, NPC hit points, GM notes) lives only in this file's closure and in actions.js. The
// only things that ever go to a player socket from here are the projected view, patches between projected views and
// `rev` numbers.
import { projectForPlayers } from '../../src/playerView.js';
import { diffState } from '../../src/syncPatch.js';
import { LIMITS, fnv1a } from '../../src/net/protocol.js';
import { timers, safeMetrics } from './session.js';

const SUM_EVERY = 50;
const FULL_MIN_GAP_MS = 2000; // at most one STATE_FULL per 2 s per socket (4.6)
const ASSET_URL = /\/__realm\/assets\/([0-9a-f]{64})/g;

/**
 * JSON with sorted keys and without undefined values, so the server and a client that applied the same patches
 * compute the same text whatever order their keys were created in. `sum` is fnv1a(canonicalJson(state)).
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

export const stateSum = state => fnv1a(canonicalJson(state));

export function createStateSync({ project = projectForPlayers, diff = diffState, clock, limits = LIMITS, metrics, revBase } = {}) {
  const t = timers(clock);
  const m = safeMetrics(metrics);
  const sessions = new Set();

  let scene = null;        // the GM's complete scene, as last published (GM-only data included)
  let view = null;         // what players may see of it
  let pendingScene = null; // the newest scene that arrived but was not processed yet (coalescing)
  let scheduled = false;
  // Revisions start at a random point: a phone remembering revision 7 of an earlier server run must not be mistaken
  // for "exactly current" by a new run that also reached 7.
  let rev = Number.isSafeInteger(revBase) && revBase >= 0 ? revBase : Math.floor(Math.random() * 0x3fffffff);
  let history = [];        // [{ rev, text }], oldest first, contiguous
  let fullCache = null;    // { rev, text }
  let pinCache = null;     // { scene, hashes }

  const fullText = () => {
    if (fullCache?.rev !== rev) fullCache = { rev, text: JSON.stringify({ type: 'STATE_FULL', rev, state: view }) };
    return fullCache.text;
  };

  function sendFull(session) {
    if (!view) return false;
    const sent = session.send(fullText());
    if (sent) {
      session.syncedRev = rev;
      session.clearStale();
      session.fullDue = null;
      session.lastFullAt = t.now();
      m.inc('sync.full');
    }
    return sent;
  }

  /** Install a new projected view. Returns true when players were told about it. */
  function publish(next) {
    const first = view === null;
    const patch = first ? null : diff(view, next);
    view = next;
    if (!first && !patch) return false;
    rev += 1;
    if (first) {
      for (const session of sessions) sendFull(session);
      history = [];
      return true;
    }
    const message = { type: 'STATE_PATCH', rev, base: rev - 1, patch };
    if (rev % SUM_EVERY === 0) message.sum = stateSum(view);
    const text = JSON.stringify(message);
    history.push({ rev, text });
    if (history.length > limits.patchHistory) history.splice(0, history.length - limits.patchHistory);
    m.inc('sync.patch');
    m.gauge('sync.rev', rev);
    for (const session of sessions) {
      if (session.closed || !session.isOpen) continue;
      if (session.syncedRev !== rev - 1 || session.bufferedAmount > limits.backlogStopBytes) { session.markStale(); continue; }
      if (session.send(text)) session.syncedRev = rev;
    }
    return true;
  }

  /** Process the newest scene that arrived. Safe to call at any time; errors never escape. */
  function flush() {
    scheduled = false;
    const next = pendingScene;
    pendingScene = null;
    if (!next) return false;
    try {
      const projected = project(next);
      scene = next;
      publish(projected);
      return true;
    } catch (error) {
      m.inc('sync.sceneRejected'); // a scene the projection cannot handle is the GM's problem, not a hub fault
      m.log(`scene rejected: ${error?.message ?? error}`);
      return false;
    }
  }

  return {
    /**
     * A complete scene from the GM. With `defer`, scenes that arrive in the same turn of the event loop are coalesced
     * (only the newest is processed); everything that reads the state flushes first, so nothing sees a stale scene.
     */
    setScene(next, { defer = false } = {}) {
      pendingScene = next;
      if (!defer) return flush();
      if (!scheduled) { scheduled = true; queueMicrotask(flush); }
      return true;
    },
    flush,
    /** Apply an optimistic change to the server's copy (an accepted player move) and publish it at once. */
    mutate(fn) {
      flush();
      if (!scene) return false;
      try {
        fn(scene);
        publish(project(scene));
        return true;
      } catch (error) {
        m.inc('handlerErrors');
        m.log(`mutation rejected: ${error?.message ?? error}`);
        return false;
      }
    },
    /** The raw scene. For actions.js and the hub's rule checks only; never serialise it toward a player. */
    get scene() { flush(); return scene; },
    get view() { flush(); return view; },
    get rev() { flush(); return rev; },
    get hasView() { flush(); return view !== null; },
    get historyLength() { return history.length; },
    fullText: () => { flush(); return view ? fullText() : null; },

    /**
     * Start serving a session. `resumeRev` is the revision it last applied (null: it has nothing).
     * Returns what it got: 'waiting' (no scene yet), 'current', 'patches', or 'full'.
     */
    attach(session, resumeRev = null) {
      flush();
      sessions.add(session);
      session.clearStale();
      session.syncedRev = null;
      if (!view) return 'waiting';
      if (Number.isSafeInteger(resumeRev)) {
        if (resumeRev === rev) { session.syncedRev = rev; m.inc('sync.resumeCurrent'); return 'current'; }
        const behind = rev - resumeRev;
        if (behind > 0 && behind <= limits.resumeMaxPatches) {
          const missing = history.filter(entry => entry.rev > resumeRev);
          if (missing.length === behind && missing[0].rev === resumeRev + 1) {
            for (const entry of missing) if (!session.send(entry.text)) return 'full';
            session.syncedRev = rev;
            m.inc('sync.resumePatches');
            return 'patches';
          }
        }
      }
      sendFull(session);
      return 'full';
    },
    detach(session) { sessions.delete(session); },
    has: session => sessions.has(session),
    get size() { return sessions.size; },

    /** A player asked for a fresh snapshot. Honoured at once, or after the 2 s minimum gap. */
    requestFull(session) {
      flush();
      if (!view || !sessions.has(session)) return false;
      const now = t.now();
      if (session.lastFullAt !== null && now - session.lastFullAt < FULL_MIN_GAP_MS) {
        session.fullDue = session.lastFullAt + FULL_MIN_GAP_MS;
        return false;
      }
      return sendFull(session);
    },

    /** Periodic work: snapshots for sessions that drained, deferred snapshots, and closing sessions that never drain. */
    tick() {
      flush();
      if (!view) return;
      for (const session of sessions) {
        if (session.closed) { sessions.delete(session); continue; }
        if (!session.isOpen) continue;
        const state = session.checkBacklog();
        if (state === 'drained') sendFull(session);
        else if (state === 'ok' && session.fullDue !== null && t.now() >= session.fullDue) sendFull(session);
      }
    },

    /** Hashes of every `/__realm/assets/<sha256>` the scene refers to (access pins these so they are never evicted). */
    pinnedHashes() {
      flush();
      if (!scene) return new Set();
      if (pinCache?.scene !== scene) {
        const hashes = new Set();
        try { for (const match of JSON.stringify(scene).matchAll(ASSET_URL)) hashes.add(match[1]); } catch { /* unserialisable scene: pin nothing */ }
        pinCache = { scene, hashes };
      }
      return pinCache.hashes;
    },
  };
}
