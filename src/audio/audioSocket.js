// The fallback audio WebSocket (/__realm/audio), authenticated exactly like the control socket (design 4.3, A.5, A.6).
//
//   player: POST /__realm/hello {device} -> nonce; sub-protocols ['rf3', 'auth.<device>.<nonce>.<proof>'], proof = wsProof(dk, device, nonce, 'player')
//   GM:     sub-protocol ['rf3'] only; the browser's rf-gm cookie and the loopback address authenticate it (A.6)
//
// `connect()` returns a small controller that reconnects with backoff (0.5 s x 2^n up to 6 s, +-30 % jitter) until closed, and
// stops for good on the close codes that mean "do not come back".
import { PATHS, SUBPROTOCOL, CLOSE, authProtocol } from '../net/protocol.js';
import { wsProof } from '../net/hmac.js';
import { playerServerUrl } from '../net/playerServer.js';

const FINAL = new Set([CLOSE.KICKED, CLOSE.TOO_OLD, CLOSE.REPLACED]);

export function createAudioSocket({
  role, identity, location = globalThis.location, fetchImpl = (...a) => globalThis.fetch(...a), WebSocketClass = globalThis.WebSocket,
  url: serverUrl,
  setTimeoutImpl = (...a) => globalThis.setTimeout(...a), clearTimeoutImpl = (...a) => globalThis.clearTimeout(...a),
  onOpen, onMessage, onClose, onFinal, random = Math.random,
} = {}) {
  let socket = null;
  let closed = false;
  let attempts = 0;
  let timer = null;
  let opening = false;

  // In the installed player, `location` is the Capacitor WebView rather than the
  // game host. Browser players deliberately keep the previous relative requests.
  const remoteUrl = serverUrl || playerServerUrl();
  const url = () => {
    const base = remoteUrl || `${location.protocol}//${location.host}`;
    const target = new URL(PATHS.audioWs, base);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    target.searchParams.set('role', role);
    return target.href;
  };
  const endpoint = path => remoteUrl ? new URL(path, remoteUrl).href : path;

  async function protocols() {
    if (role === 'gm') return [SUBPROTOCOL];
    const { device, dk } = await identity();
    if (!device || !dk) throw new Error('not a member of this table');
    const response = await fetchImpl(endpoint(PATHS.hello), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device }) });
    if (!response.ok) throw new Error(`hello ${response.status}`);
    const { nonce } = await response.json();
    return [SUBPROTOCOL, authProtocol(device, nonce, wsProof(dk, device, nonce, 'player'))];
  }

  function schedule() {
    if (closed || timer) return;
    const base = Math.min(6000, 500 * 2 ** Math.min(attempts, 4));
    const delay = base * (0.7 + 0.6 * random());
    attempts++;
    timer = setTimeoutImpl(() => { timer = null; void open(); }, delay);
  }

  async function open() {
    if (closed || opening || socket) return;
    opening = true;
    try {
      const list = await protocols();
      if (closed) return;
      const ws = new WebSocketClass(url(), list);
      ws.binaryType = 'arraybuffer';
      socket = ws;
      ws.onopen = () => { attempts = 0; onOpen?.(ws); };
      ws.onmessage = event => onMessage?.(event.data);
      ws.onerror = () => {};
      ws.onclose = event => {
        if (socket === ws) socket = null;
        onClose?.(event.code);
        if (FINAL.has(event.code)) { closed = true; onFinal?.(event.code); return; }
        schedule();
      };
    } catch {
      schedule();
    } finally {
      opening = false;
    }
  }

  return {
    start() { closed = false; void open(); },
    /** Send one binary frame. Returns false when the socket is not ready or already holds too much unsent data. */
    send(data, maxBuffered = 64 * 1024) {
      const ws = socket;
      if (!ws || ws.readyState !== 1 || ws.bufferedAmount > maxBuffered) return false;
      try { ws.send(data); return true; } catch { return false; }
    },
    get open() { return !!socket && socket.readyState === 1; },
    close() {
      closed = true;
      clearTimeoutImpl(timer);
      timer = null;
      const ws = socket;
      socket = null;
      try { ws?.close(1000); } catch { /* ignore */ }
    },
  };
}
