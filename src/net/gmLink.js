// The GM window's side of the table (logic moved out of broadcast.js; design 4.10).
//
//   GM -> server    SCENE            the whole scene, images as short URLs (coalesced by a short throttle)
//   server -> GM    PLAYER_TOKEN_MOVE / PLAYER_END_TURN / MAP_PING / PLAYER_ROSTER / REQUEST_FULL_STATE
//   server -> GM    JOIN_REQUEST, TABLE   (new: who wants in, and the table's mode / code)
//   GM -> server    TABLE_CMD        (new: kick, admit, deny, lock, unlock, rotate, mode, rename)
//
// The GM socket offers only the 'rf3' sub-protocol; the server recognises the GM by loopback + Host + Origin + the rf-gm
// cookie (Appendix A.6), so there is no /hello and no device key here.
import { canPlayerMoveToken } from '../ownership.js';
import { createAssetPublisher } from '../assetPublisher.js';
import { LIMITS, TABLE_OPS } from './protocol.js';
import { createConnection, createSystemClock } from './connection.js';

/** The parts of the GM's state that make up the shared scene. Pan, zoom, selection and open panels are not here. */
export const SCENE_KEYS = [
  'mapImageSrc', 'mapWidth', 'mapHeight', 'showGrid', 'gridSize', 'gridColor', 'gridOpacity', 'feetPerCell',
  'snapToGrid', 'playerCanMoveTokens', 'showFog', 'fogCells', 'fogColor', 'fogOpacity', 'areaEffects', 'markers',
  'playerViewRect', 'tokens', 'combat', 'handoutSrc', 'handoutName',
];

/** Copy the scene out of GM state, swapping every image for its shared URL. */
export async function buildScene(state, assets) {
  const scene = {};
  for (const key of SCENE_KEYS) if (state[key] !== undefined) scene[key] = state[key];
  const [mapImageSrc, handoutSrc] = await Promise.all([
    assets.resolve(state.mapImageSrc, 'map'),
    assets.resolve(state.handoutSrc, 'handout'),
  ]);
  scene.mapImageSrc = mapImageSrc;
  scene.handoutSrc = handoutSrc;
  scene.tokens = await Promise.all((state.tokens ?? []).map(async token => {
    // The uncropped source is only for the GM's own re-cropping.
    const { portraitSource: _source, ...rest } = token;
    // Hidden tokens never leave the GM's computer, not even their artwork.
    if (token.visibleToPlayers === false) return { ...rest, imageSrc: null, portraitSrc: null };
    const [imageSrc, portraitSrc] = await Promise.all([
      assets.resolve(token.imageSrc, 'token'),
      assets.resolve(token.portraitSrc && token.portraitSrc !== token.imageSrc ? token.portraitSrc : null, 'token'),
    ]);
    return { ...rest, imageSrc, portraitSrc };
  }));
  return scene;
}

const TABLE_FIELDS = ['device', 'mode', 'name', 'required'];

/**
 * Handlers (set with `setHandlers`, all optional):
 *   onTokenMove(id, x, y)  onRoster(players)  onPing({ id, name, x, y })  onEndTurn({ playerId, tokenId, name })
 *   onStatus(status)  onLatency(ms)                                  as before
 *   onJoinRequest(request)  onTable(table)  onAudio(message)  onNetStats(stats)  onAssetError(message)   new
 *
 * Options: `createTransport` (a createConnection look-alike), `transportOptions` (passed to it: url, WebSocketClass, clock,
 * fetchImpl, ...), `assets`, `throttleMs`, `clock`.
 */
export function createGMLink({
  createTransport = createConnection, assets, throttleMs = 40, transportOptions = {}, clock = transportOptions.clock ?? createSystemClock(),
} = {}) {
  let handlers = {};
  let latest = null;     // newest state the app has produced
  let published = null;  // the state most recently turned into a scene
  let timer = null;
  let running = false;
  let again = false;
  let closed = false;
  let table = null;
  const sharedAssets = assets ?? createAssetPublisher({
    fetchImpl: transportOptions.fetchImpl ? (...args) => transportOptions.fetchImpl(...args) : undefined,
    base: transportOptions.url ? new URL(transportOptions.url).origin : '',
    onError: error => handlers.onAssetError?.(error.userMessage ?? error.message, error),
  });

  const transport = createTransport({
    ...transportOptions,
    clock,
    role: 'gm',
    onStatus: status => handlers.onStatus?.(status),
    onLatency: rtt => { handlers.onLatency?.(rtt); handlers.onNetStats?.(transport.stats); },
    onOpen() {
      // A restarted server has lost its images; confirm them again with the next scene.
      sharedAssets.forgetUploads();
      schedule(0);
    },
    onMessage(message) {
      if (message.type === 'REQUEST_FULL_STATE') schedule(0);
      else if (message.type === 'PLAYER_ROSTER') handlers.onRoster?.(message.players);
      else if (message.type === 'MAP_PING') handlers.onPing?.(message);
      else if (message.type === 'TOKEN_LIVE') handlers.onTokenLive?.(message);
      else if (message.type === 'PLAYER_END_TURN') handlers.onEndTurn?.(message);
      else if (message.type === 'JOIN_REQUEST') handlers.onJoinRequest?.(message);
      else if (message.type === 'TABLE') { table = message; handlers.onTable?.(message); }
      else if (message.type === 'AUDIO_LISTENER' || message.type === 'AUDIO_ANSWER' || message.type === 'AUDIO_STATS') handlers.onAudio?.(message);
      else if (message.type === 'PLAYER_TOKEN_MOVE') {
        const token = latest?.tokens.find(t => t.id === message.id);
        if (!canPlayerMoveToken(latest, token, message.playerId) || !Number.isFinite(message.x) || !Number.isFinite(message.y)) {
          schedule(0); // Put the player's screen back the way the GM has it.
          return;
        }
        handlers.onTokenMove?.(message.id, message.x, message.y);
      }
    },
  });

  function schedule(delay = throttleMs) {
    if (timer || closed) return;
    timer = clock.setTimeout(flush, delay);
  }

  async function flush() {
    timer = null;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const snapshot = latest;
        if (!snapshot || !transport.open) break; // Sent when the connection opens.
        const scene = await buildScene(snapshot, sharedAssets);
        if (!transport.open || closed) break;
        const text = JSON.stringify({ type: 'SCENE', scene });
        const cap = transport.limits?.maxScene ?? LIMITS.gmMaxPayload;
        if (text.length > cap) {
          // The server would close the socket (1009). Say so instead, and do not retry the same scene in a loop.
          published = snapshot;
          handlers.onAssetError?.('This scene is too large to share with the players. Use a smaller map or fewer images.');
          break;
        }
        if (transport.sendRaw(text)) published = snapshot;
      } while (again);
    } catch (error) {
      console.warn('Could not publish the scene:', error);
    } finally { running = false; }
  }

  const link = {
    /** Call on every state change. Cheap: only a change to the shared scene sends anything. */
    broadcastState(state) {
      latest = state;
      if (published && SCENE_KEYS.every(key => state[key] === published[key])) return;
      schedule();
    },
    setHandlers(next) { handlers = next ?? {}; },
    /** TABLE_CMD: `op` is one of kick admit deny lock unlock rotate mode rename; `fields` may carry device, mode, name. */
    tableCommand(op, fields = {}) {
      if (!TABLE_OPS.has(op)) return false;
      const message = { type: 'TABLE_CMD', op };
      for (const key of TABLE_FIELDS) if (fields[key] !== undefined) message[key] = fields[key];
      if (message.device !== undefined && typeof message.device !== 'string') return false;
      return transport.send(message);
    },
    /** Pass-through for the audio package (AUDIO_OFFER, AUDIO_CONTROLS, ...): the server validates the type. */
    send(message) { return transport.send(message); },
    nudge() { transport.nudge?.(); },
    get table() { return table; },
    get stats() { return transport.stats; },
    get open() { return !!transport.open; },
    close() { closed = true; clock.clearTimeout(timer); timer = null; transport.close(); },
  };
  return link;
}

