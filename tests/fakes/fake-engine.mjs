// Scriptable PlaybackEngine double: tests decide when a load resolves, fails or shows a picture.
export function createFakeEngine() {
  const listeners = [];
  const calls = [];
  let pending = null;
  const all = []; // every load ever made: { resolve, reject, url }, including abandoned ones
  let st = 'idle';
  const engine = {
    load(src, opts) {
      calls.push({ op: 'load', url: src.url, bufferSec: opts.bufferSec });
      st = 'opening';
      return new Promise((resolve, reject) => { pending = { resolve, reject, url: src.url }; all.push(pending); });
    },
    pause() { calls.push({ op: 'pause' }); st = 'paused'; },
    resume() { calls.push({ op: 'resume' }); st = 'playing'; },
    stop() { calls.push({ op: 'stop' }); st = 'idle'; pending = null; },
    state: () => st,
    setRect() {},
    suspend() { calls.push({ op: 'suspend' }); },
    restore() { calls.push({ op: 'restore' }); },
    on(cb) { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); },
    destroy() { calls.push({ op: 'destroy' }); }
  };
  return {
    engine,
    calls,
    loads: () => calls.filter((c) => c.op === 'load'),
    /** prepare succeeded (play called) */
    prepared() { if (pending) { pending.resolve(); } },
    failPrepare(code) { if (pending) { const p = pending; pending = null; p.reject(code); } },
    emit(e) { listeners.slice().forEach((l) => l(e)); },
    picture() { st = 'playing'; this.emit({ type: 'playing' }); },
    pendingUrl: () => (pending ? pending.url : null),
    /** Settles load number i (0-based) even after it was abandoned: a late callback of an old channel. */
    resolveLoad(i) { all[i].resolve(); },
    rejectLoad(i, code) { all[i].reject(code); }
  };
}
