// THE swap point between the fake hub and the real hub for test/gmLink, playerLink and facade tests.
//
// Every integration-style test gets its table from `startTable(t)`. Which hub answers is decided HERE and nowhere else:
//
//   node --test test/gmLink.test.js ...                  the in-process fake hub (test-support/wp4-fakeHub.js)
//   WP4_HUB=real node --test test/gmLink.test.js ...      the real server/net/realm.js over loopback (wp4-realHub.js)
//
// (The one-line change, if an environment variable is not wanted: in startTable() replace `fromEnvironment` by
// `startRealHub`.) Both give the same raw shape, documented in wp4-realHub.js:
//   { fake, url, WebSocketClass, fetchImpl, invite(), setMode, admit, deny, kick, rotate, closeAll(code, role) }
//
// On top of that raw shape this file adds what the tests observe, identically for both hubs, from the CLIENT side of the wire:
//   table.sockets          one entry per WebSocket a link created: { role, protocols, device, opened, closeCode, sent[], received[] }
//   table.requests         every fetch to /__realm/: { path, method, body, status }
//   table.framesTo(device) every frame the hub sent to that device (parsed)         table.sentBy(role, type) every frame a client sent
//   table.outage(true)     the Wi-Fi is down: player sockets and /hello fail before they exist (until outage(false))
// Assertions that look inside the fake hub itself are guarded by `table.fake`.
import { createFakeHub } from './wp4-fakeHub.js';

const CONNECTING = 0, OPEN = 1, CLOSED = 3;

export async function startTable(t, options = {}) {
  const raw = await (process.env.WP4_HUB === 'real' ? fromEnvironment(t, options) : startFake(t, options));
  return decorate(raw);
}

async function fromEnvironment(t, options) {
  const { startRealHub } = await import('./wp4-realHub.js');
  return startRealHub(t, options);
}

function startFake(t, options) {
  const hub = createFakeHub(options);
  t.after(() => hub.close());
  return {
    fake: true,
    hub,
    url: hub.url,
    WebSocketClass: hub.WebSocketClass,
    fetchImpl: hub.fetchImpl,
    invite: () => ({ ...hub.invite }),
    setMode: mode => hub.setMode(mode),
    admit: device => hub.admit(device),
    deny: device => hub.deny(device),
    kick: device => hub.kick(device),
    rotate: () => hub.rotate(),
    closeAll: (code, role) => hub.closeAll(code, role),
  };
}

function decorate(raw) {
  const state = { outage: false }; // false, true (every player) or a device id
  const sockets = [];
  const requests = [];
  const Raw = raw.WebSocketClass;

  /** A browser-style WebSocket that forwards to the hub's class and keeps a client-side record of the wire. */
  class Recorded {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(address, protocols = []) {
      const list = Array.isArray(protocols) ? protocols : [protocols];
      const role = new URL(address).searchParams.get('role');
      const auth = list.find(item => typeof item === 'string' && item.startsWith('auth.'));
      const info = { role, protocols: [...list], device: auth ? auth.split('.')[1] : null, opened: false, closeCode: null, sent: [], received: [] };
      sockets.push(info);
      this.info = info;
      info.socket = this;
      this.url = String(address);
      this.protocol = '';
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._state = CONNECTING;
      if (role === 'player' && state.outage && (state.outage === true || state.outage === info.device)) {
        setTimeout(() => { this._state = CLOSED; this.onerror?.({ type: 'error' }); this.onclose?.({ code: 1006, reason: '', wasClean: false }); }, 0);
        return;
      }
      const inner = this.inner = new Raw(address, list);
      inner.onopen = event => { info.opened = true; this.protocol = inner.protocol; this.onopen?.(event); };
      inner.onmessage = event => {
        if (typeof event.data === 'string') { try { info.received.push(JSON.parse(event.data)); } catch { /* not JSON */ } }
        this.onmessage?.(event);
      };
      inner.onerror = event => this.onerror?.(event);
      inner.onclose = event => { info.closeCode = event.code; this._state = CLOSED; this.onclose?.(event); };
    }
    get readyState() { return this.inner ? this.inner.readyState : this._state; }
    get bufferedAmount() { return this.inner?.bufferedAmount ?? 0; }
    send(data) {
      try { this.info.sent.push(JSON.parse(data)); } catch { /* binary or not JSON */ }
      return this.inner.send(data);
    }
    close(code, reason) { if (this.inner) this.inner.close(code, reason); else this._state = CLOSED; }
    terminate() { if (this.inner) (this.inner.terminate ? this.inner.terminate() : this.inner.close()); else this._state = CLOSED; }
  }

  const fetchImpl = async (input, init = {}) => {
    const address = String(input?.url ?? input);
    if (address.startsWith('data:') || address.startsWith('blob:')) return raw.fetchImpl(input, init);
    const path = new URL(address, raw.url).pathname;
    if (state.outage && path === '/__realm/hello') throw new TypeError('Failed to fetch');
    const entry = { path, method: (init.method ?? 'GET').toUpperCase(), body: null, status: null };
    if (typeof init.body === 'string') { try { entry.body = JSON.parse(init.body); } catch { entry.body = init.body; } }
    requests.push(entry);
    const response = await raw.fetchImpl(input, init);
    entry.status = response.status;
    return response;
  };

  const frames = (device) => sockets.filter(item => item.device === device).flatMap(item => item.received);

  return {
    ...raw,
    WebSocketClass: Recorded,
    fetchImpl,
    sockets,
    requests,
    /** true: every player is cut off; a device id: only that phone; false: back. Existing sockets are not touched (use dropDevice). */
    outage: (on = true) => { state.outage = on; },
    /** Kill one phone's socket from its own side, as a dying Wi-Fi would. */
    dropDevice: device => { for (const item of sockets) if (item.device === device && item.socket.readyState === OPEN) item.socket.terminate(); },
    framesTo: device => frames(device),
    /** Frames of `type` that clients of `role` sent to the hub, oldest first. */
    sentBy: (role, type) => sockets.filter(item => item.role === role).flatMap(item => item.sent).filter(message => !type || message.type === type),
    /** How many sockets of this role have been created (reconnect attempts included). */
    socketCount: role => sockets.filter(item => item.role === role).length,
    /** Frames of `type` that the hub sent to a GM socket (REQUEST_FULL_STATE, TABLE, ...). */
    framesToGm: type => sockets.filter(item => item.role === 'gm').flatMap(item => item.received).filter(message => !type || message.type === type),
  };
}

/** The options every link takes to talk to a table (url, sockets, fetch) plus fast timings for tests. */
export const transportFor = (table, extra = {}) => ({
  url: table.url, WebSocketClass: table.WebSocketClass, fetchImpl: table.fetchImpl, reconnectDelay: 20, maxReconnectDelay: 120, ...extra,
});

/** Poll until `predicate()` is true (real timers; the same helper the old sync tests used). */
export async function until(predicate, label = 'a change', { timeout = 3000, step = 5 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, step));
  }
}

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
