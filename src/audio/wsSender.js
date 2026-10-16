// The GM page's fallback encoder (design 5.2, 5.4): the AudioWorklet of pcm-processor.js cuts the captured sound into numbered
// 4096-frame ADPCM packets (RFA3) and they are sent over /__realm/audio. It exists only while at least one listener is on the
// fallback path, so a table that is all WebRTC pays nothing for it.
import { createAudioSocket } from './audioSocket.js';

export function createWsSender({ context, tap, workletUrl, socketOptions = {}, releaseDelayMs = 5000, setTimeoutImpl = (...a) => globalThis.setTimeout(...a), clearTimeoutImpl = (...a) => globalThis.clearTimeout(...a) }) {
  let node = null;
  let socket = null;
  let loading = null;
  let releaseTimer = null;
  let wanted = false;
  const counters = { sent: 0, dropped: 0 };
  let next = { seq: 0, samples: 0 }; // where a rebuilt encoder must pick up, read from the last packet that went out

  async function build() {
    if (node) return;
    loading ??= (async () => {
      await context.audioWorklet.addModule(workletUrl);
      if (node || !wanted) return;
      const created = new AudioWorkletNode(context, 'realm-forge-pcm', { channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2], processorOptions: next });
      created.port.onmessage = event => {
        const view = new DataView(event.data);
        next = { seq: (view.getUint32(4) + 1) >>> 0, samples: (view.getUint32(8) + view.getUint16(18)) >>> 0 };
        if (socket?.send(event.data)) counters.sent++; else counters.dropped++;
      };
      tap.connect(created);
      created.connect(context.destination); // silent: the worklet writes no output, but a connected node is the one that gets pulled
      node = created;
    })().finally(() => { loading = null; });
    await loading;
  }

  function teardown() {
    if (node) { try { tap.disconnect(node); node.disconnect(); node.port.onmessage = null; } catch { /* ignore */ } node = null; }
    socket?.close();
    socket = null;
  }

  return {
    /** Call with the number of listeners that are on the fallback path. */
    async setListeners(count) {
      if (count > 0) {
        clearTimeoutImpl(releaseTimer); releaseTimer = null;
        wanted = true;
        if (!socket) { socket = createAudioSocket({ role: 'gm', ...socketOptions }); socket.start(); }
        try { await build(); } catch { /* the page keeps WebRTC; the fallback is unavailable */ }
      } else if (wanted && !releaseTimer) {
        releaseTimer = setTimeoutImpl(() => { releaseTimer = null; wanted = false; teardown(); }, releaseDelayMs);
      }
    },
    get active() { return !!node; },
    stats: () => ({ ...counters, socketOpen: socket?.open ?? false }),
    dispose() { wanted = false; clearTimeoutImpl(releaseTimer); teardown(); },
  };
}
