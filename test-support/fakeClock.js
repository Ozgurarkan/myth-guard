// A clock that only moves when a test says so. Same surface as the injected `clock` of the server and client
// modules (design 4.8): now(), setTimeout, clearTimeout, setInterval, clearInterval. Timers fire in time order, and
// timers set for the same instant fire in the order they were created.

export function createFakeClock({ start = 0 } = {}) {
  let time = start;
  let seq = 0;
  const timers = new Map(); // id -> { id, at, seq, fn, every }

  const add = (fn, ms, every) => {
    if (typeof fn !== 'function') throw new TypeError('timer callback must be a function');
    const delay = Math.max(0, Number(ms) || 0);
    const id = ++seq;
    timers.set(id, { id, at: time + delay, seq: id, fn, every });
    // A handle that behaves like a Node timer for the calls the code under test makes.
    return {
      id,
      ref() { return this; },
      unref() { return this; },
      hasRef: () => true,
      refresh() { const timer = timers.get(id); if (timer) timer.at = time + delay; return this; },
      [Symbol.toPrimitive]: () => id,
    };
  };
  const idOf = handle => (handle && typeof handle === 'object' ? handle.id : handle);
  const next = limit => {
    let best = null;
    for (const timer of timers.values()) {
      if (timer.at > limit) continue;
      if (!best || timer.at < best.at || (timer.at === best.at && timer.seq < best.seq)) best = timer;
    }
    return best;
  };

  const clock = {
    now: () => time,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: handle => { timers.delete(idOf(handle)); },
    setInterval: (fn, ms) => add(fn, Math.max(1, Number(ms) || 1), Math.max(1, Number(ms) || 1)),
    clearInterval: handle => { timers.delete(idOf(handle)); },
    /** Number of timers that are still waiting. */
    get pending() { return timers.size; },
    /** Milliseconds until the next timer, or null. */
    nextIn() {
      let at = Infinity;
      for (const timer of timers.values()) at = Math.min(at, timer.at);
      return at === Infinity ? null : at - time;
    },
    /** Move time forward by `ms`, firing every timer on the way (timers created by timers included). */
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError('advance(ms) needs ms >= 0');
      const target = time + ms;
      for (let timer = next(target); timer; timer = next(target)) {
        time = Math.max(time, timer.at);
        if (timer.every) { timer.at = time + timer.every; timer.seq = ++seq; } else timers.delete(timer.id);
        timer.fn();
      }
      time = target;
      return time;
    },
    /** Fire only the timers that are due right now. */
    flush() { return clock.advance(0); },
    /** Jump to the next timer and fire it; returns false when none is left. */
    tick() {
      const ms = clock.nextIn();
      if (ms === null) return false;
      clock.advance(ms);
      return true;
    },
    /** Set the wall time without firing anything (for code that compares timestamps). */
    set(value) { time = value; },
  };
  return clock;
}
