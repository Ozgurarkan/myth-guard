// TCP impairment proxy: delay, jitter, stalls and a TCP-loss model between a client and a server.
//
// STRICT FIFO. A TCP stream cannot reorder bytes, so every chunk is delivered no earlier than the chunk before it
// (one queue and one pump timer per direction). The first version of this proxy gave every chunk its own timer, which
// reordered chunks and made the old audio path look as if it popped after every stall (design 2, 5.6). That was a
// bug in the proxy, not in the product. test/harness.test.js proves the order on every run: do not "simplify" this.
//
// Loss model (server -> client direction): each 1460-byte segment is lost with probability `loss`; recovery costs one
// RTO (300 ms, the Windows minimum), doubled again for every further loss of the retransmission. A stall blocks
// everything behind it (head-of-line blocking), which is the point.
import { createServer, connect } from 'node:net';

/**
 * createTcpImpair({ listenPort, targetPort, targetHost, host, random, now })
 *   -> { state, stats, listen(), close(), stall(ms), port }
 * state is live: change it while connections are open.
 *   baseMs, jitterMs   delay added to server->client chunks: baseMs + random*jitterMs
 *   loss, rto          per-segment loss probability and the retransmission timeout
 *   upBaseMs, upJitterMs   the same for client->server chunks (no loss model in that direction)
 *   stallUntil         everything server->client is held until this time (set by stall(ms))
 */
export function createTcpImpair({ listenPort = 0, targetPort, targetHost = '127.0.0.1', host = '127.0.0.1', random = Math.random, now = Date.now } = {}) {
  if (!targetPort) throw new Error('createTcpImpair needs targetPort');
  const state = { baseMs: 0, jitterMs: 0, loss: 0, rto: 300, stallUntil: 0, stalledMs: 0, lossEvents: 0, upBaseMs: 0, upJitterMs: 0 };
  const stats = { connections: 0, bytesDown: 0, bytesUp: 0, chunksDown: 0, chunksUp: 0 };
  const open = new Set();

  /** One FIFO direction: `deliver(chunk)` is called in arrival order, never earlier than the chunk's due time. */
  const pipe = deliver => {
    const queue = [];
    let timer = null;
    let last = 0;
    const pump = () => {
      timer = null;
      const t = now();
      while (queue.length && queue[0].at <= t) deliver(queue.shift().chunk);
      if (queue.length) timer = setTimeout(pump, Math.max(0, queue[0].at - now()));
    };
    return {
      push(chunk, at) {
        at = Math.max(at, last); // the FIFO rule
        last = at;
        queue.push({ at, chunk });
        if (!timer) timer = setTimeout(pump, Math.max(0, at - now()));
      },
      clear() { clearTimeout(timer); timer = null; queue.length = 0; },
    };
  };

  const server = createServer(client => {
    const upstream = connect(targetPort, targetHost);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    stats.connections += 1;
    const pair = { client, upstream };
    open.add(pair);

    const down = pipe(chunk => { if (!client.destroyed) client.write(chunk); });
    const up = pipe(chunk => { if (!upstream.destroyed) upstream.write(chunk); });

    client.on('data', chunk => {
      stats.bytesUp += chunk.length; stats.chunksUp += 1;
      up.push(chunk, now() + state.upBaseMs + random() * state.upJitterMs);
    });
    upstream.on('data', chunk => {
      stats.bytesDown += chunk.length; stats.chunksDown += 1;
      const t = now();
      let at = t + state.baseMs + random() * state.jitterMs;
      if (state.loss) {
        const segments = Math.ceil(chunk.length / 1460);
        for (let i = 0; i < segments; i += 1) {
          if (random() >= state.loss) continue;
          let rto = state.rto;
          state.lossEvents += 1;
          while (random() < state.loss) rto *= 2;
          state.stallUntil = Math.max(state.stallUntil, t + rto);
          state.stalledMs += rto;
          break; // one recovery per chunk is enough to model the stall
        }
      }
      down.push(chunk, Math.max(at, state.stallUntil));
    });
    const end = () => { down.clear(); up.clear(); client.destroy(); upstream.destroy(); open.delete(pair); };
    client.on('close', end); upstream.on('close', end); client.on('error', end); upstream.on('error', end);
  });

  return {
    state,
    stats,
    get port() { return server.address()?.port ?? listenPort; },
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, host, () => { server.off('error', reject); resolve(); }); }),
    close: () => new Promise(resolve => {
      for (const { client, upstream } of open) { client.destroy(); upstream.destroy(); }
      server.close(() => resolve());
    }),
    /** Hold everything server -> client for `ms` (then release it as a burst, in order). */
    stall(ms) { state.stallUntil = Math.max(state.stallUntil, now() + ms); },
  };
}
