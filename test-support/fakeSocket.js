// Fake sockets for unit tests (no network).
//
//  createFakeSocket()          the server-side `ws` object the hub/session code receives:
//                              send / close / terminate / ping, readyState, bufferedAmount, 'message' 'close' 'error' 'pong' events.
//  createFakeWebSocketClass()  a browser-style WebSocket class for the client connection code (new WebSocketClass(url, protocols),
//                              onopen/onmessage/onclose/onerror + addEventListener), with a test handle on every instance.
//  createSocketPair()          a client/server pair joined by a (virtual) wire with optional latency driven by a fake clock.
//
// Test handles are on `.test`: they make the "other side" do things (deliver a frame, close, fill the send buffer).
import { EventEmitter } from 'node:events';

export const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

const sizeOf = data => (typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? data?.length ?? 0);
const isPlainObject = value => value !== null && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer);

/** `ws`-compatible server-side socket. */
export function createFakeSocket({ remoteAddress = '127.0.0.1', headers = {}, readyState = OPEN } = {}) {
  const socket = new EventEmitter();
  Object.assign(socket, {
    readyState,
    bufferedAmount: 0,
    protocol: '',
    CONNECTING, OPEN, CLOSING, CLOSED,
    _socket: { remoteAddress, remotePort: 50000, setNoDelay() {}, pause() {}, resume() {} },
    upgradeReq: { headers, socket: { remoteAddress } },
    sent: [],        // everything sent: { data, binary, bytes }
    pings: 0,
    closed: null,    // { code, reason } once close() was called
    terminated: false,
    holdSends: false,
    send(data, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      if (socket.readyState !== OPEN) {
        const error = new Error('WebSocket is not open: readyState ' + socket.readyState);
        if (callback) { callback(error); return; }
        throw error;
      }
      const bytes = sizeOf(data);
      socket.sent.push({ data, binary: typeof data !== 'string', bytes, options });
      if (socket.holdSends) socket.bufferedAmount += bytes; // a frozen client: nothing leaves, the buffer grows
      callback?.();
    },
    ping() { socket.pings += 1; },
    pong() {},
    close(code = 1005, reason = '') {
      if (socket.readyState === CLOSED || socket.readyState === CLOSING) return;
      socket.closed = { code, reason: String(reason) };
      socket.readyState = CLOSING;
      // A real close handshake completes asynchronously: here on the next microtask (or call test.finishClose()).
      queueMicrotask(() => socket.test.finishClose());
    },
    terminate() {
      socket.terminated = true;
      socket.closed ??= { code: 1006, reason: '' };
      socket.test.finishClose();
    },
    framesOfType(type) { return socket.frames.filter(frame => frame?.type === type); },
  });
  /** All text frames sent so far, parsed as JSON. */
  Object.defineProperty(socket, 'frames', {
    get: () => socket.sent.filter(entry => !entry.binary).map(entry => { try { return JSON.parse(entry.data); } catch { return entry.data; } }),
  });
  socket.test = {
    /** The client sent a frame. Objects are stringified; strings are text; Buffers/typed arrays are binary. */
    receive(data) {
      const binary = typeof data !== 'string' && !isPlainObject(data);
      const payload = binary ? Buffer.from(data) : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      socket.emit('message', payload, binary);
    },
    pong() { socket.emit('pong'); },
    error(error = new Error('socket error')) { socket.emit('error', error); },
    /** Simulate a client that stopped reading: sent bytes pile up in bufferedAmount. */
    freeze() { socket.holdSends = true; },
    thaw() { socket.holdSends = false; socket.bufferedAmount = 0; },
    setBuffered(bytes) { socket.bufferedAmount = bytes; },
    finishClose() {
      if (socket.readyState === CLOSED) return;
      socket.readyState = CLOSED;
      const { code, reason } = socket.closed ?? { code: 1005, reason: '' };
      socket.emit('close', code, Buffer.from(reason));
    },
    /** The remote end dropped the connection without a close frame. */
    drop() { socket.closed = { code: 1006, reason: '' }; socket.test.finishClose(); },
  };
  return socket;
}

/**
 * Browser-style WebSocket class factory. Every instance is recorded in `Class.instances`;
 * `instance.test.open()` completes the connection, `.serverSend(obj|string|ArrayBuffer)`, `.serverClose(code, reason)`, `.fail()`.
 * Set `autoOpen: true` to open each socket on the next microtask. `Class.log` lists { url, protocols } of every constructor call.
 */
export function createFakeWebSocketClass({ autoOpen = false, clock = null } = {}) {
  const instances = [];
  const log = [];
  class FakeWebSocket {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;
    static instances = instances;
    static log = log;
    constructor(url, protocols = []) {
      this.url = String(url);
      this.protocols = Array.isArray(protocols) ? protocols : [protocols].filter(Boolean);
      this.protocol = '';
      this.readyState = CONNECTING;
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.sent = [];
      this.closeInfo = null;
      this.listeners = new Map();
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.test = {
        open: (protocol = this.protocols[0] ?? '') => {
          if (this.readyState !== CONNECTING) return;
          this.readyState = OPEN;
          this.protocol = protocol;
          this.#fire('open', { type: 'open' });
        },
        serverSend: data => {
          if (this.readyState !== OPEN) return;
          const payload = typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : JSON.stringify(data);
          this.#fire('message', { type: 'message', data: payload });
        },
        serverClose: (code = 1006, reason = '') => {
          if (this.readyState === CLOSED) return;
          this.readyState = CLOSED;
          this.closeInfo = { code, reason };
          this.#fire('close', { type: 'close', code, reason, wasClean: code !== 1006 });
        },
        fail: () => { this.#fire('error', { type: 'error' }); this.test.serverClose(1006, ''); },
      };
      Object.defineProperty(this.test, 'sentJson', { get: () => this.sent.flatMap(item => { try { return typeof item === 'string' ? [JSON.parse(item)] : []; } catch { return []; } }) });
      instances.push(this);
      log.push({ url: this.url, protocols: this.protocols, at: clock?.now?.() ?? Date.now() });
      if (autoOpen) queueMicrotask(() => this.test.open());
    }
    #fire(type, event) {
      event.target = this;
      this[`on${type}`]?.(event);
      for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    send(data) {
      if (this.readyState !== OPEN) throw new Error('InvalidStateError: WebSocket is not open');
      this.sent.push(data);
    }
    close(code = 1005, reason = '') {
      if (this.readyState === CLOSED || this.readyState === CLOSING) return;
      this.readyState = CLOSING;
      this.closeInfo = { code, reason };
      queueMicrotask(() => {
        if (this.readyState !== CLOSING) return;
        this.readyState = CLOSED;
        this.#fire('close', { type: 'close', code, reason, wasClean: true });
      });
    }
  }
  return FakeWebSocket;
}

/**
 * A connected pair. `pair.server` is a createFakeSocket() whose messages come from `pair.client` (a FakeWebSocket instance), and
 * whatever the server sends reaches the client. With a fake `clock` and `latencyMs`, frames are delivered after that delay (order kept).
 */
export function createSocketPair({ clock = null, latencyMs = 0, remoteAddress = '127.0.0.1', url = 'ws://localhost/__realm/ws?role=player' } = {}) {
  const Client = createFakeWebSocketClass();
  const client = new Client(url, ['rf3']);
  const server = createFakeSocket({ remoteAddress });
  const deliver = fn => { if (clock && latencyMs > 0) clock.setTimeout(fn, latencyMs); else fn(); };
  const serverSend = server.send.bind(server);
  server.send = (data, options, callback) => {
    serverSend(data, options, callback);
    deliver(() => client.test.serverSend(data));
  };
  const clientSend = client.send.bind(client);
  client.send = data => {
    clientSend(data);
    deliver(() => server.test.receive(data));
  };
  const serverClose = server.close.bind(server);
  server.close = (code, reason) => {
    serverClose(code, reason);
    deliver(() => client.test.serverClose(code, reason));
  };
  client.test.open();
  return { client, server };
}
