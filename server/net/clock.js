// Time source for the network layer. Everything that needs "now" or a timer takes a clock,
// so tests can drive nonce expiry, bans and code freshness without waiting.

/** The real clock. Timers are unref'd so they never keep the process alive on their own. */
export function createClock() {
  const unref = handle => { handle?.unref?.(); return handle; };
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout: handle => clearTimeout(handle),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval: handle => clearInterval(handle),
  };
}

/**
 * A clock that only moves when the test says so. `advance(ms)` runs every timer that falls due, in order,
 * with `now()` set to the moment each one was due.
 */
export function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  let sequence = 0;
  const timers = new Map(); // id -> { id, at, fn, every }
  const add = (fn, ms, every) => {
    const id = ++sequence;
    timers.set(id, { id, at: current + Math.max(0, Number(ms) || 0), fn, every });
    return id;
  };
  const next = limit => {
    let best = null;
    for (const timer of timers.values()) {
      if (timer.at <= limit && (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id))) best = timer;
    }
    return best;
  };
  return {
    now: () => current,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: id => { timers.delete(id); },
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: id => { timers.delete(id); },
    advance(ms) {
      const target = current + ms;
      for (let timer = next(target); timer; timer = next(target)) {
        current = Math.max(current, timer.at);
        if (timer.every) timer.at += timer.every; else timers.delete(timer.id);
        timer.fn();
      }
      current = target;
    },
    get pending() { return timers.size; },
  };
}
