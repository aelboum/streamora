// Time-sliced processing of streamed text (ARCHITECTURE.md rev 3 §6.2: parsing in ≤ 16 ms
// slices so the UI stays responsive during large imports).
//
// Text pushed from XHR progress events is queued and consumed in pieces of `pieceChars`
// characters; after `budgetMs` of work the slicer yields to the event loop (setTimer 0), so key
// presses and rendering run between slices. Without timers it consumes synchronously (tests and
// callers that don't need slicing). Pieces cut text at arbitrary points: consumers must accept
// chunk boundaries anywhere (the M3U parser and the JSON array reader do).
export interface SliceTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
}

export interface SliceOptions {
  /** Default 8,192 characters (≈ 5 ms of parsing on the TV). */
  pieceChars?: number;
  /** Default 16 ms. */
  budgetMs?: number;
}

export interface Slicer {
  push(text: string): void;
  /** Resolves when everything pushed so far has been consumed (or consumption stopped). */
  drained(): Promise<void>;
  cancel(): void;
  /** Characters waiting to be consumed. */
  backlog(): number;
  stopped(): boolean;
}

/** `consume` returns false to stop (the rest of the queue is dropped). */
export function createSlicer(consume: (piece: string) => boolean, timers?: SliceTimers, options?: SliceOptions): Slicer {
  const pieceChars = (options && options.pieceChars) || 8192;
  const budgetMs = (options && options.budgetMs) || 16;
  const queue: string[] = [];
  let head = 0;       // offset into queue[0]
  let waiting = 0;    // characters queued
  let scheduled: unknown = null;
  let stop = false;
  let waiters: Array<() => void> = [];

  function settleWaiters(): void {
    if (waiting === 0 || stop) {
      const w = waiters;
      waiters = [];
      for (let i = 0; i < w.length; i++) {
        w[i]();
      }
    }
  }

  function halt(): void {
    stop = true;
    queue.length = 0;
    head = 0;
    waiting = 0;
    if (scheduled !== null && timers) {
      timers.clearTimer(scheduled);
      scheduled = null;
    }
  }

  function step(): boolean {
    const first = queue[0];
    const piece = head === 0 && first.length <= pieceChars ? first : first.substring(head, head + pieceChars);
    head += piece.length;
    waiting -= piece.length;
    if (head >= first.length) {
      queue.shift();
      head = 0;
    }
    if (!consume(piece)) {
      halt();
      return false;
    }
    return true;
  }

  function run(): void {
    scheduled = null;
    if (stop || !timers) {
      return;
    }
    const t0 = timers.now();
    while (queue.length > 0 && !stop) {
      if (!step()) {
        break;
      }
      if (timers.now() - t0 >= budgetMs) {
        break;
      }
    }
    if (queue.length > 0 && !stop) {
      scheduled = timers.setTimer(run, 0);
    }
    settleWaiters();
  }

  return {
    push: function (text) {
      if (stop || text.length === 0) {
        return;
      }
      queue.push(text);
      waiting += text.length;
      if (!timers) {
        while (queue.length > 0 && !stop && step()) { /* consume synchronously */ }
        return;
      }
      if (scheduled === null) {
        scheduled = timers.setTimer(run, 0);
      }
    },
    drained: function () {
      if (waiting === 0 || stop) {
        return Promise.resolve();
      }
      return new Promise<void>(function (resolve) { waiters.push(resolve); });
    },
    cancel: function () {
      halt();
      settleWaiters();
    },
    backlog: function () { return waiting; },
    stopped: function () { return stop; }
  };
}
