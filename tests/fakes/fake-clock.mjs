// Deterministic clock and timers for tests.
export function createFakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Advances time, firing due timers in order (timers scheduled while firing are honoured). */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!next || t.at < next.at)) { next = t; nextId = id; }
        }
        if (!next) break;
        timers.delete(nextId);
        now = next.at;
        next.fn();
      }
      now = target;
    }
  };
}

/** Lets pending promise callbacks run. */
export function flush() {
  return new Promise((r) => setImmediate(r));
}
