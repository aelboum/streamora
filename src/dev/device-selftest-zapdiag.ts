// DEV BUILDS ONLY — zapping diagnostics (approved 2026-11-25: "yes install the diagnostic build").
// Not referenced by release builds. Changes no app behaviour; only records, with timestamps:
//   - every key press (code, mapped key, screen) — the start of each zap;
//   - every stream open (engine.load) and every engine event (buffering %, playing, error, ended);
//   - the app's own live-player messages (playing + startup time, stall reopen, reconnect, failure)
//     and AVPlay's debug traces, by setting the log level to debug;
//   - free memory every 5 s.
// No URLs, credentials or stream addresses: the engine wrapper logs only the stream type.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import { mapKeyCode } from '../navigation/keys.ts';

export function runZapDiagnostics(platform: Platform, log: Logger, app?: DevApp): Promise<void> {
  const L = log.child('zapdiag');
  if (!app || !app.ctx.engine) { L.warn('zapdiag skipped'); return Promise.resolve(); }
  log.setLevel('debug');
  const eng = app.ctx.engine;
  const router = app.started.router;
  const t0 = Date.now();
  let loads = 0;
  let lastLoadAt = 0;
  let lastStep = -1;
  function top(): string { return router.stack().slice(-1)[0] || ''; }

  const doc = app.root.ownerDocument as Document;
  let keys = 0;
  doc.addEventListener('keydown', function (e: KeyboardEvent) {
    keys++;
    const m = mapKeyCode(e.keyCode, false);
    L.info('zap key', { n: keys, code: e.keyCode, key: m ? m.key + (m.digit !== undefined ? m.digit : '') : '-', top: top(), s: Math.round((Date.now() - t0) / 100) / 10 });
  }, true);

  const origLoad = eng.load;
  eng.load = function (src, opts) {
    loads++;
    lastLoadAt = Date.now();
    L.info('zap load', { n: loads, type: src.type, live: !!src.live, bufferSec: opts.bufferSec, top: top(), s: Math.round((lastLoadAt - t0) / 100) / 10 });
    const p = origLoad.call(eng, src, opts);
    const n = loads;
    const at = lastLoadAt;
    p.then(function () { L.info('zap prepared', { n: n, ms: Date.now() - at }); }, function (c) { L.warn('zap prepare failed', { n: n, ms: Date.now() - at, code: String(c) }); });
    return p;
  };
  const origStop = eng.stop;
  eng.stop = function () { L.info('zap stop', { n: loads, msSinceLoad: lastLoadAt ? Date.now() - lastLoadAt : -1, top: top() }); return origStop.call(eng); };

  eng.on(function (e) {
    const since = lastLoadAt ? Date.now() - lastLoadAt : -1;
    // Only buffering start, each 25 % step and done: AVPlay reports every percent (1,300+ events flooded the log ring).
    if (e.type === 'buffering') {
      const step = Math.floor(e.percent / 25);
      if (e.percent === 0 || e.percent >= 100 || step !== lastStep) { L.info('zap buffering', { n: loads, pct: e.percent, msSinceLoad: since }); }
      lastStep = e.percent >= 100 ? -1 : step;
    }
    if (e.type === 'playing' || e.type === 'ended' || e.type === 'seek-failed') { L.info('zap ' + e.type, { n: loads, msSinceLoad: since }); }
    if (e.type === 'error') { L.warn('zap error', { n: loads, code: e.code, msSinceLoad: since }); }
  });

  setInterval(function () { L.info('zap beat', { memMB: platform.memory().availableMB, top: top(), engine: eng.state(), loads: loads }); }, 5000);
  L.info('zapdiag ready', { memMB: platform.memory().availableMB });
  return Promise.resolve();
}
