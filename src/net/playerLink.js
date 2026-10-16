// A player's side of the table (logic moved out of broadcast.js; design 4.5, 4.10).
//
//   server -> player  HELLO, STATE_FULL / STATE_PATCH, GM_STATUS, MAP_PING, ACK, PONG, KICKED, TABLE_LOCKED, WAIT, ADMITTED
//   player -> server  RESUME (by the connection), PLAYER_NAME, PLAYER_TOKEN_MOVE{aid}, PLAYER_PING, PLAYER_END_TURN{aid}
//
// What is new compared with broadcast.js: the link first makes sure this browser is a member of the table (joinClient),
// remembers the revision across reconnects so the server can answer with a few patches instead of a snapshot, turns the v3
// `ACK` into the old `onMoveRejected` / `onTurnRejected` calls, and reports kicks, locks and the waiting room.
import { applyPatch } from '../syncPatch.js';
import { cleanName, fnv1a } from './protocol.js';
import { createConnection, createSystemClock } from './connection.js';
import { createJoinClient } from './joinClient.js';
import { deviceStore } from './deviceStore.js';

/**
 * JSON with sorted keys and without undefined values: the text the server hashes for the optional `sum` of every 50th
 * patch (server/net/stateSync.js canonicalJson). Both sides must agree on it byte for byte.
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

/** How long to wait before asking the table again, per reason a join was refused. */
const RETRY_MS = { locked: 15000, full: 15000, rate: 15000, banned: 60000, network: 3000, server: 5000, refused: 15000 };

/**
 * Handlers (all optional, passed in the options object as before):
 *   onState(publicScene)  onConnection(open, status)  onGm(present)  onIdentity(playerId)  onLatency(ms)
 *   onMoveRejected({ id, reason })  onPing({ id, name, x, y })  onTurnRejected({ reason })          as before
 *   onKicked({ reason })         removed by the GM ('kicked'), refused ('denied'), or no longer known ('auth'): stop and
 *                                show the "removed" screen; the link does not reconnect by itself
 *   onLocked({ reason })         the table is 'locked' (or 'full' / 'banned'): show the lock screen; retries on its own
 *   onWaiting(waiting, message)  true while the GM has not let this device in ('ask' mode); false once admitted
 *   onNetStats(stats)            { rtt:{last,p50,p95}, reconnects, sinceMs, bytesIn, bytesOut, patches, fulls, ... }
 *   onAudio(message)             AUDIO_OFFER / AUDIO_CONTROLS / AUDIO_STATUS / AUDIO_FALLBACK / AUDIO_STOP (the audio package)
 *   onJoinError(error)           a JoinError (bad-proof, rogue-server, ...): `error.code`, `error.message` fit to show
 * Status strings given to onConnection: connecting reconnecting open waiting locked full banned kicked outdated
 * unauthorized needs-invite rogue-server.
 */
export function createPlayerLink({
  onState, onConnection, onGm, onIdentity, onLatency, onMoveRejected, onPing, onTurnRejected,
  onKicked, onLocked, onWaiting, onNetStats, onAudio, onJoinError,
  createTransport = createConnection, transportOptions = {}, readName = () => '',
  store = deviceStore, join, clock = transportOptions.clock ?? createSystemClock(), verifySum = true,
} = {}) {
  const joinClient = join ?? createJoinClient({ store, fetchImpl: transportOptions.fetchImpl, url: transportOptions.url });
  let state = null;
  let rev = null;
  let serverId = null;
  let helloName;
  let connection = null;
  let closed = false;
  let retryTimer = null;
  let resyncTimer = null;
  let joinFailures = 0;
  let kickedReported = false;
  let lastReported = null;
  let run = 0;

  const report = status => {
    lastReported = status;
    onConnection?.(status === 'open', status);
  };

  // ── joining and connecting ─────────────────────────────────────────────────
  function later(delay, fn) {
    clock.clearTimeout(retryTimer);
    retryTimer = clock.setTimeout(() => { retryTimer = null; fn(); }, delay);
  }

  async function start() {
    if (closed) return;
    const mine = ++run;
    joinClient.captureInvite?.();
    report('connecting');
    let result;
    try { result = await joinClient.ensureJoined(); } catch (error) {
      if (closed || mine !== run) return;
      joinFailed(error);
      return;
    }
    if (closed || mine !== run) return;
    joinFailures = 0;
    if (result.status === 'needs-invite') { report('needs-invite'); return; }
    connect();
  }

  function joinFailed(error) {
    onJoinError?.(error);
    const code = error.code;
    if (code === 'bad-proof' || code === 'bad-invite' || code === 'bad-code') { report('needs-invite'); return; }
    if (code === 'rogue-server') { report('rogue-server'); return; }
    if (code === 'locked' || code === 'full' || code === 'banned') {
      report(code);
      onLocked?.({ reason: code });
    } else report('reconnecting');
    joinFailures++;
    const base = RETRY_MS[code] ?? RETRY_MS.server;
    later(code === 'network' || code === 'server' ? Math.min(base * 2 ** Math.min(joinFailures - 1, 3), 15000) : base, start);
  }

  function connect() {
    kickedReported = false;
    connection = createTransport({
      ...transportOptions,
      clock,
      role: 'player',
      device: () => store.device(),
      dk: () => store.dk(),
      resume: () => ({ rev }),
      onStatus: status => report(status),
      onLatency: rtt => { onLatency?.(rtt); onNetStats?.(connection?.stats); },
      onOpen(active) {
        const name = readName();
        // The server already has the name this device joined with; only a different one needs saying.
        if (helloName === undefined || cleanName(name) !== helloName) active.send({ type: 'PLAYER_NAME', name });
        onNetStats?.(active.stats);
      },
      onMessage: handle,
      onClose: info => closedByTransport(info),
    });
  }

  function closedByTransport(info) {
    if (info.code === 4002) removed('kicked');
    else if (info.code === 4003) onLocked?.({ reason: 'locked' });
    else if (info.status === 'unauthorized') {
      // The table no longer knows this device's key (table reset, device forgotten). With an invite for this tab, join again.
      store.forgetKey();
      if (store.invite()) start(); else removed('auth');
    }
    onNetStats?.(connection?.stats);
  }

  function removed(reason, message) {
    if (kickedReported) return;
    kickedReported = true;
    store.forget();
    connection?.close(); // final: no reconnecting
    if (lastReported !== 'kicked' && reason !== 'auth') report('kicked');
    onKicked?.({ reason, ...(message?.reason ? { detail: message.reason } : {}) });
  }

  // ── messages ───────────────────────────────────────────────────────────────
  const resync = () => {
    rev = null;
    connection?.send({ type: 'RESYNC' });
    clock.clearTimeout(resyncTimer);
    // A RESYNC the server rate-limited away must not leave this player frozen on a stale scene.
    resyncTimer = clock.setTimeout(() => { if (rev === null && connection?.open) resync(); }, 3000);
  };

  function handle(message, info = {}) {
    switch (message.type) {
      case 'HELLO':
        // A restarted server counts revisions from the start again: a revision of another server means nothing.
        if (message.server?.id !== undefined) {
          if (serverId !== null && message.server.id !== serverId) rev = null;
          serverId = message.server.id;
        }
        helloName = typeof message.name === 'string' ? message.name : undefined;
        if (typeof message.playerId === 'string') onIdentity?.(message.playerId);
        break;
      case 'PLAYER_ID': onIdentity?.(message.id); break;
      case 'GM_STATUS': onGm?.(message.connected); break;
      case 'MOVE_REJECTED': onMoveRejected?.(message); break;
      case 'TURN_REJECTED': onTurnRejected?.(message); break;
      case 'ACK':
        if (message.ok === false && info.action) {
          if (info.action.type === 'PLAYER_TOKEN_MOVE') onMoveRejected?.({ id: info.action.id, reason: message.reason });
          else if (info.action.type === 'PLAYER_END_TURN') onTurnRejected?.({ reason: message.reason });
        }
        break;
      case 'MAP_PING': onPing?.(message); break;
      case 'STATE_FULL':
        clock.clearTimeout(resyncTimer);
        state = message.state;
        rev = message.rev;
        onState?.(state);
        break;
      case 'STATE_PATCH': {
        if (rev === null) break; // Ignore patches until a snapshot (or a resumable revision) is in place.
        if (message.base !== rev || !state) { resync(); break; }
        let next;
        try { next = applyPatch(state, message.patch); } catch { resync(); break; }
        if (verifySum && Number.isFinite(message.sum) && fnv1a(canonicalJson(next)) !== message.sum) {
          connection?.count('divergence');
          resync();
          break;
        }
        state = next;
        rev = message.rev;
        onState?.(state);
        break;
      }
      case 'KICKED': removed('kicked', message); break;
      case 'DENIED': removed('denied', message); break;
      case 'TABLE_LOCKED': onLocked?.({ reason: 'locked' }); break;
      case 'WAIT': onWaiting?.(true, message); break;
      case 'ADMITTED': onWaiting?.(false, message); break;
      case 'AUDIO_OFFER': case 'AUDIO_CONTROLS': case 'AUDIO_STATUS': case 'AUDIO_FALLBACK': case 'AUDIO_STOP':
        onAudio?.(message);
        break;
      default:
    }
  }

  const act = (fields, withAid) => {
    if (!connection?.open) return false;
    return connection.send(fields, withAid ? { aid: store.nextAid() } : undefined);
  };

  const link = {
    sendMove: (id, x, y) => act({ type: 'PLAYER_TOKEN_MOVE', id, x, y }, true),
    sendPing: (x, y) => act({ type: 'PLAYER_PING', x, y }, false),
    sendEndTurn: tokenId => act({ type: 'PLAYER_END_TURN', tokenId }, true),
    setName: name => act({ type: 'PLAYER_NAME', name }, false),
    /** Pass-through for the audio package (AUDIO_LISTEN, AUDIO_ANSWER, AUDIO_STATS). */
    send: message => act(message, false),
    /** Join with the typed table code, then connect. Rejects with a JoinError (also given to onJoinError). */
    async joinWithCode(code) {
      try { await joinClient.joinWithCode(code); } catch (error) { onJoinError?.(error); throw error; }
      link.retry();
    },
    async joinWithLink(hash) {
      try { await joinClient.joinWithLink(hash); } catch (error) { onJoinError?.(error); throw error; }
      link.retry();
    },
    /** Try again from the top (after a lock, a refused code, a kick followed by a new invite). */
    retry() {
      if (closed) return;
      clock.clearTimeout(retryTimer);
      connection?.close();
      connection = null;
      start();
    },
    nudge() { connection?.nudge(); },
    get stats() { return connection?.stats ?? null; },
    get open() { return !!connection?.open; },
    get rev() { return rev; },
    close() {
      closed = true;
      run++;
      clock.clearTimeout(retryTimer); clock.clearTimeout(resyncTimer);
      connection?.close();
    },
  };

  start();
  return link;
}
