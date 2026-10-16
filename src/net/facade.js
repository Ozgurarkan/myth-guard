/**
 * Table networking for the GM window and for every player's browser: the public API of the old src/broadcast.js, now
 * backed by src/net/{gmLink,playerLink,connection,joinClient,deviceStore}.js (design 4.10). After the switch,
 * src/broadcast.js is just `export * from './net/facade.js'`.
 *
 * Unchanged exports: SCENE_KEYS, buildScene, createGMLink, createPlayerLink, broadcastState, subscribeGM, subscribePlayer,
 * sendPlayerTokenMove, sendPlayerPing, sendPlayerEndTurn, setPlayerName, getPlayerName.
 *
 * Unchanged handlers.
 *   GM, passed to subscribeGM(handlers):
 *     onTokenMove(id, x, y)  onRoster(players)  onPing({ id, name, x, y })  onEndTurn({ playerId, tokenId, name })
 *     onStatus('connecting' | 'reconnecting' | 'open' | ...)  onLatency(ms)
 *   Player, passed to subscribePlayer(handlers):
 *     onState(publicScene)  onConnection(open, status)  onGm(present)  onIdentity(playerId)  onLatency(ms)
 *     onMoveRejected({ id, reason })  onPing({ id, name, x, y })  onTurnRejected({ reason })
 *
 * NEW optional handlers (nothing existing is removed; the UI owner wires them, see design 3.9):
 *   Player
 *     onKicked({ reason })     the GM removed this device ('kicked'), refused it ('denied'), or the table no longer knows it
 *                              ('auth'). The link has stopped and will not reconnect: show "You were removed from this table".
 *                              Joining again needs an invite (joinWithCode / a new QR link).
 *     onLocked({ reason })     the table is 'locked' (or 'full', 'banned'): show "The table is locked" with a Retry button
 *                              (retryPlayerConnection()). The link also retries by itself every 15 s.
 *     onWaiting(waiting, msg)  true while the GM has not admitted this device yet ('ask' mode): "Waiting for the GM to let you
 *                              in"; false when admitted.
 *     onNetStats(stats)        { rtt:{ last, p50, p95, samples }, reconnects, sinceMs, bytesIn, bytesOut, patches, fulls,
 *                              messagesIn, messagesOut, loss, divergence, expired, lastClose:{ code, reason, at } }; after
 *                              every latency sample (about every 4 s), on open and on close.
 *     onJoinError(error)       a JoinError: error.code (bad-proof | locked | full | banned | rate | rogue-server | network |
 *                              ...) and error.message (fit to show). For a typed-code form.
 *     onAudio(message)         AUDIO_OFFER / AUDIO_CONTROLS / AUDIO_STATUS / AUDIO_FALLBACK / AUDIO_STOP, for the audio package
 *     onConnection also receives these statuses: waiting, locked, full, banned, kicked, outdated ("reload the page", close
 *                              4004), unauthorized, needs-invite ("Enter the table code"), rogue-server.
 *   GM
 *     onJoinRequest({ device, name, label, ... })   'ask' mode: someone wants in; answer with sendTableCommand('admit'|'deny')
 *     onTable({ mode, locked, code, ... })          the table's admission mode / lock / code changed
 *     onAudio(message)                              AUDIO_LISTENER / AUDIO_ANSWER / AUDIO_STATS, for the audio package
 *     onNetStats(stats)                             as above, for the GM's own connection
 *     onAssetError(message)                         an image could not be shared ("Table image memory is full ...") or a scene
 *                                                   is too large; show it as a toast
 *   onStatus also receives: waiting (never for the GM), replaced (another GM window took over: final, 4001), outdated.
 *
 * Additions to the exports (so the new features are reachable without changing subscribeGM / subscribePlayer):
 *   sendTableCommand(op, fields)     GM: kick | admit | deny | lock | unlock | rotate | mode | rename, fields { device, mode, name }
 *   sendGmMessage(obj)               GM: any other message of the GM catalogue (the audio package's AUDIO_OFFER, ...)
 *   sendPlayerMessage(obj)           player: any other message of the player catalogue (AUDIO_LISTEN, AUDIO_ANSWER, AUDIO_STATS)
 *   joinWithCode(code), joinWithLink(hash)   first-time admission (resolve { status }, reject with a JoinError), then connect
 *   retryPlayerConnection()          try again from the top (after a lock screen, after a new invite)
 *   getPlayerNetStats(), getGMNetStats()   the current statistics object (or null)
 */
import { createGMLink, SCENE_KEYS, buildScene } from './gmLink.js';
import { createPlayerLink } from './playerLink.js';
import { createJoinClient } from './joinClient.js';
import { deviceStore } from './deviceStore.js';
import { playerServerUrl, tableAssets } from './playerServer.js';

export { SCENE_KEYS, buildScene, createGMLink, createPlayerLink };

// ── GM ───────────────────────────────────────────────────────────────────────
let gmLink = null;
const gm = () => (gmLink ??= createGMLink());

/** Called by the GM on every state change */
export function broadcastState(state) { gm().broadcastState(state); }

/**
 * The GM window listens for player actions here (handlers above).
 * Returns an unsubscribe function.
 */
export function subscribeGM(handlers) {
  const link = gm();
  link.setHandlers(handlers);
  return () => {
    link.close();
    if (gmLink === link) gmLink = null;
  };
}

/** GM: kick, admit, deny, lock, unlock, rotate, mode, rename. False when not connected or `op` is unknown. */
export function sendTableCommand(op, fields) { return gmLink?.tableCommand(op, fields) ?? false; }

/** GM: send another message of the GM catalogue (the server validates it). */
export function sendGmMessage(message) { return gmLink?.send(message) ?? false; }

export function getGMNetStats() { return gmLink?.stats ?? null; }

// ── Players ──────────────────────────────────────────────────────────────────
let playerLink = null;
let sharedJoin = null;
const joinClient = () => (sharedJoin ??= createJoinClient({ store: deviceStore, url: playerServerUrl() || undefined }));

/**
 * Used by the player page (handlers above). Any option of createPlayerLink may ride along in the same object
 * (`transportOptions`, `store`, `clock`, ...). Returns an unsubscribe function.
 */
export function subscribePlayer(handlers = {}) {
  const url = playerServerUrl() || undefined;
  const link = createPlayerLink({ readName: () => deviceStore.name(), ...handlers,
    transportOptions: { ...handlers.transportOptions, url },
    join: createJoinClient({ store: deviceStore, url }),
    onState: state => handlers.onState?.(tableAssets(state, url)),
  });
  playerLink = link;
  return () => {
    link.close();
    if (playerLink === link) playerLink = null;
  };
}

/** Called by the player window when a token is dragged to a new spot */
export function sendPlayerTokenMove(id, x, y) {
  return playerLink?.sendMove(id, x, y) ?? false;
}

/** A "look here" at a map point. Everyone at the table sees it for a few seconds. */
export function sendPlayerPing(x, y) {
  return playerLink?.sendPing(x, y) ?? false;
}

/** "My turn is over." The server checks it is really this hero's turn before the GM hears of it. */
export function sendPlayerEndTurn(tokenId) {
  return playerLink?.sendEndTurn(tokenId) ?? false;
}

export function setPlayerName(name) {
  deviceStore.setName(name); // storage trouble only means the name is not remembered; the visit still works
  playerLink?.setName(name);
}

export function getPlayerName() { return deviceStore.name(); }

export function sendPlayerMessage(message) { return playerLink?.send(message) ?? false; }

export function joinWithCode(code) { return (playerLink ?? joinClient()).joinWithCode(code); }
export function joinWithLink(hash) { return (playerLink ?? joinClient()).joinWithLink(hash); }
export function retryPlayerConnection() { playerLink?.retry(); }
export function getPlayerNetStats() { return playerLink?.stats ?? null; }

if (import.meta.hot) import.meta.hot.dispose(() => { gmLink?.close(); playerLink?.close(); });
