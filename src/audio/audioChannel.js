// The audio package's seat on the control socket.
//
// The control WebSocket belongs to the network layer (src/net/*), and the page creates it exactly once, so the audio code cannot open
// its own. This tiny bridge is the whole contract:
//
//   page -> audio   channel.deliver(message)   every AUDIO_* message the link receives (the links' `onAudio` handler)
//                   channel.setOpen(boolean)   the control socket opened / closed (the links' `onConnection` / status handler)
//   audio -> page   channel.send(message)      AUDIO_LISTEN / ANSWER / STATS (player) or OFFER / CONTROLS / STATUS / ... (GM)
//
// `withPlayerAudio(sendPlayerMessage, handlers)` and `withGmAudio(sendGmMessage, handlers)` wrap the handler object a page already
// passes to subscribePlayer / subscribeGM, so wiring is one call each and nothing else about those handlers changes.
function makeChannel(role) {
  let sender = null;
  let open = false;
  const messageListeners = new Set();
  const openListeners = new Set();
  return {
    role,
    attach(send) { sender = typeof send === 'function' ? send : null; },
    get open() { return open; },
    send(message) { try { return !!sender?.(message); } catch { return false; } },
    deliver(message) { for (const fn of [...messageListeners]) { try { fn(message); } catch { /* one listener must not break the others */ } } },
    setOpen(value) {
      const next = value === true;
      if (next === open) return;
      open = next;
      for (const fn of [...openListeners]) { try { fn(open); } catch { /* ignore */ } }
    },
    subscribe(fn) { messageListeners.add(fn); return () => messageListeners.delete(fn); },
    onOpen(fn) { openListeners.add(fn); return () => openListeners.delete(fn); },
  };
}

export const playerChannel = makeChannel('player');
export const gmChannel = makeChannel('gm');
export const createChannel = makeChannel;

/** subscribePlayer(withPlayerAudio(sendPlayerMessage, { ...your handlers })) */
export function withPlayerAudio(send, handlers = {}) {
  playerChannel.attach(send);
  return {
    ...handlers,
    onAudio(message) { try { handlers.onAudio?.(message); } finally { playerChannel.deliver(message); } },
    onConnection(isOpen, status) { try { handlers.onConnection?.(isOpen, status); } finally { playerChannel.setOpen(isOpen === true); } },
  };
}

/** subscribeGM(withGmAudio(sendGmMessage, { ...your handlers })) */
export function withGmAudio(send, handlers = {}) {
  gmChannel.attach(send);
  return {
    ...handlers,
    onAudio(message) { try { handlers.onAudio?.(message); } finally { gmChannel.deliver(message); } },
    onStatus(status) { try { handlers.onStatus?.(status); } finally { gmChannel.setOpen(status === 'open'); } },
  };
}
