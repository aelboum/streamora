// Scriptable PlaybackEngine double: tests decide when a load resolves, fails or shows a picture.
export function createFakeEngine() {
  const listeners = [];
  const calls = [];
  let pending = null;
  const all = []; // every load ever made: { resolve, reject, url }, including abandoned ones
  let st = 'idle';
  let trackList = [];
  let startMs = 0;
  const rects = []; // every setRect call [x, y, w, h] (kept apart from `calls`)
  const engine = {
    load(src, opts) {
      calls.push({ op: 'load', url: src.url, bufferSec: opts.bufferSec });
      startMs = opts.startMs || 0;
      // A new source has its own tracks (the AVPlay engine clears its list on load as well).
      trackList = [];
      st = 'opening';
      return new Promise((resolve, reject) => { pending = { resolve, reject, url: src.url }; all.push(pending); });
    },
    pause() { calls.push({ op: 'pause' }); st = 'paused'; },
    resume() { calls.push({ op: 'resume' }); st = 'playing'; },
    stop() { calls.push({ op: 'stop' }); st = 'idle'; pending = null; },
    state: () => st,
    setRect(x, y, w, h) { rects.push([x, y, w, h]); },
    seek(ms) { calls.push({ op: 'seek', ms }); },
    tracks: () => trackList.map((t) => ({ ...t })),
    selectTrack(kind, id) {
      calls.push({ op: 'track', kind, id });
      trackList = trackList.map((t) => (t.kind === kind ? { ...t, selected: t.id === id } : t));
      listeners.slice().forEach((l) => l({ type: 'tracks' }));
    },
    suspend() { calls.push({ op: 'suspend' }); },
    restore() { calls.push({ op: 'restore' }); },
    on(cb) { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); },
    destroy() { calls.push({ op: 'destroy' }); }
  };
  return {
    engine,
    calls,
    rects,
    loads: () => calls.filter((c) => c.op === 'load'),
    /** prepare succeeded (play called) */
    prepared() { if (pending) { pending.resolve(); } },
    failPrepare(code) { if (pending) { const p = pending; pending = null; p.reject(code); } },
    emit(e) { listeners.slice().forEach((l) => l(e)); },
    /** First picture; a start position given to load() is recorded as a seek (as the engines apply it). */
    picture() { st = 'playing'; if (startMs) { calls.push({ op: 'seek', ms: startMs }); startMs = 0; } this.emit({ type: 'playing' }); },
    /** The engine could not seek (AVPlay on the user's provider). */
    failSeek() { this.emit({ type: 'seek-failed' }); },
    /** Sets the audio/subtitle tracks and announces them ({kind, id, language, label, selected}). */
    setTracks(list) { trackList = list.map((t) => ({ label: '', selected: false, ...t })); this.emit({ type: 'tracks' }); },
    pendingUrl: () => (pending ? pending.url : null),
    /** Settles load number i (0-based) even after it was abandoned: a late callback of an old channel. */
    resolveLoad(i) { all[i].resolve(); },
    rejectLoad(i, code) { all[i].reject(code); }
  };
}
