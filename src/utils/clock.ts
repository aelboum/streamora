// Time source and timers, injectable so tests are deterministic.

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Next animation frame (falls back to a 16 ms timer). */
  frame(fn: () => void): void;
}

export function systemClock(win: { requestAnimationFrame?: (cb: () => void) => number }): Clock {
  return {
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimeout: function (h) { clearTimeout(h as number); },
    frame: function (fn) {
      if (win.requestAnimationFrame) { win.requestAnimationFrame(function () { fn(); }); }
      else { setTimeout(fn, 16); }
    }
  };
}

/** Calls fn once, `ms` after the last call. */
export function debounce(clock: Clock, ms: number, fn: () => void): { trigger(): void; cancel(): void } {
  let handle: unknown = null;
  return {
    trigger: function () {
      if (handle !== null) { clock.clearTimeout(handle); }
      handle = clock.setTimeout(function () { handle = null; fn(); }, ms);
    },
    cancel: function () {
      if (handle !== null) { clock.clearTimeout(handle); handle = null; }
    }
  };
}
