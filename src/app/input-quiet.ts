// Stage 9: "is the user pressing keys right now?" for work that blocks the UI thread.
// On the TV each tizen.filesystem FileStream.write() is a synchronous native call that can block for
// 0.5–0.8 s regardless of its size (Stage 6.1), so it cannot be made shorter. The file store asks
// this gate before such a call: it goes ahead once no key was pressed for `quietMs`, or after waiting
// `maxWaitMs` (so an update always finishes and its pending pages cannot pile up in memory for long),
// or at once when free memory is low (holding data back would then be the bigger risk).
export interface InputQuietOptions {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  quietMs: number;
  maxWaitMs: number;
  /** True when waiting would be unsafe (for example low free memory). Optional. */
  pressure?: () => boolean;
}

export interface InputQuiet {
  /** Call on every key press. */
  note(): void;
  /** Resolves when a blocking call may run now. */
  wait(): Promise<void>;
  /** Diagnostics: calls that waited, longest wait (ms), calls released by maxWaitMs / pressure. */
  stats(): { waited: number; maxWaitMs: number; capped: number; pressured: number };
}

export function createInputQuiet(o: InputQuietOptions): InputQuiet {
  let last = -Infinity;
  const st = { waited: 0, maxWaitMs: 0, capped: 0, pressured: 0 };
  return {
    note: function () { last = o.now(); },
    wait: function () {
      const t0 = o.now();
      if (t0 - last >= o.quietMs) { return Promise.resolve(); }
      st.waited++;
      return new Promise<void>(function (resolve) {
        function check(): void {
          const t = o.now();
          const waited = t - t0;
          let go = false;
          if (t - last >= o.quietMs) {
            go = true;
          } else if (o.pressure && o.pressure()) {
            st.pressured++;
            go = true;
          } else if (waited >= o.maxWaitMs) {
            st.capped++;
            go = true;
          }
          if (go) {
            if (waited > st.maxWaitMs) { st.maxWaitMs = waited; }
            resolve();
            return;
          }
          // Next look: when the quiet period would end, never later than the cap, at least 50 ms.
          const untilQuiet = last + o.quietMs - t;
          const untilCap = o.maxWaitMs - waited;
          o.setTimer(check, Math.max(50, Math.min(untilQuiet, untilCap, 500)));
        }
        check();
      });
    },
    stats: function () { return { waited: st.waited, maxWaitMs: st.maxWaitMs, capped: st.capped, pressured: st.pressured }; }
  };
}
