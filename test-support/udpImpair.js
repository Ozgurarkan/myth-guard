// UDP impairment relay for WebRTC media: loss, Gilbert-Elliott burst loss, delay, jitter (reordering allowed, as on a
// real network) and blackouts with or without queueing.
//
// Two faces. The player is told that the GM lives at `playerFacingPort`; the GM is told that the player lives at
// `gmFacingPort`. A datagram that arrives on one face leaves from the other, so each browser always sees exactly one
// stable remote address (ICE needs that). Set `relay.gmPort` / `relay.playerPort` to the real UDP ports of the two
// browsers before media flows.
import dgram from 'node:dgram';

/**
 * createUdpRelay({ random, now, bindHost }) -> relay
 *   relay.ready()               binds both faces, resolves with the relay (sets playerFacingPort / gmFacingPort)
 *   relay.impair                { loss, burst: { p, q } | null, delay, jitter, blackoutUntil, hold }  (live)
 *   relay.blackout(ms, hold)    drop (hold=false) or queue and release as a burst (hold=true) everything for `ms`
 *   relay.stats                 { in, dropped, delivered }
 */
export function createUdpRelay({ random = Math.random, now = Date.now, bindHost = '127.0.0.1' } = {}) {
  const toPlayer = dgram.createSocket('udp4'); // the face the player talks to
  const toGm = dgram.createSocket('udp4');     // the face the GM talks to
  const relay = {
    gmPort: 0, playerPort: 0, playerFacingPort: 0, gmFacingPort: 0,
    impair: { loss: 0, burst: null, delay: 0, jitter: 0, blackoutUntil: 0, hold: false },
    stats: { in: 0, dropped: 0, delivered: 0 },
  };
  const timers = new Set();
  let closed = false;
  let geBad = false;

  /** null = drop; { wait } = deliver after `wait` ms. */
  const decide = () => {
    const t = now();
    const i = relay.impair;
    if (t < i.blackoutUntil) return i.hold ? { wait: i.blackoutUntil - t + 1 } : null;
    if (i.burst) {
      geBad = geBad ? random() >= i.burst.q : random() < i.burst.p;
      if (geBad) return null;
    } else if (i.loss && random() < i.loss) return null;
    return { wait: i.delay + random() * i.jitter };
  };
  const pass = (message, out, portKey) => {
    if (closed) return;
    relay.stats.in += 1;
    const decision = decide();
    if (!decision) { relay.stats.dropped += 1; return; }
    const go = () => {
      relay.stats.delivered += 1;
      try { out.send(message, relay[portKey], bindHost); } catch { /* closed meanwhile */ }
    };
    if (decision.wait > 0) {
      const timer = setTimeout(() => { timers.delete(timer); go(); }, decision.wait);
      timers.add(timer);
    } else go();
  };
  toPlayer.on('message', message => pass(message, toGm, 'gmPort'));         // from the player, out of the GM-facing socket
  toGm.on('message', message => pass(message, toPlayer, 'playerPort'));     // from the GM, out of the player-facing socket
  toPlayer.on('error', () => {});
  toGm.on('error', () => {});

  relay.ready = async () => {
    await Promise.all([
      new Promise(resolve => toPlayer.bind(0, bindHost, resolve)),
      new Promise(resolve => toGm.bind(0, bindHost, resolve)),
    ]);
    // A burst of datagrams must not be lost in the relay's own socket buffer: that would be loss nobody asked for.
    for (const socket of [toPlayer, toGm]) {
      try { socket.setRecvBufferSize(4 * 1024 * 1024); } catch { /* keep the default */ }
    }
    relay.playerFacingPort = toPlayer.address().port;
    relay.gmFacingPort = toGm.address().port;
    return relay;
  };
  relay.blackout = (ms, hold = false) => { relay.impair.blackoutUntil = now() + ms; relay.impair.hold = hold; };
  relay.close = () => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    try { toPlayer.close(); } catch { /* already closed */ }
    try { toGm.close(); } catch { /* already closed */ }
  };
  return relay;
}
