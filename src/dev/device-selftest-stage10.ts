// DEV BUILDS ONLY — Stage 10 (approved 2026-11-25). Not referenced by release builds.
//   K  Key log: every raw keydown the TV delivers (code, mapped app key) is logged, so physical
//      presses during your checks are recorded (codes only).
//   L  Scripted Live TV controls check (injected keys — NOT physical verification): play a channel,
//      open the channel list over the video (playback state before/after, no new load), 300 fast
//      moves, 30 open/close cycles, a typed channel number, previous channel; free memory sampled
//      throughout and the run stops below 155 MB. Afterwards the player is left running for you.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import { mapKeyCode } from '../navigation/keys.ts';

const KEY: Record<string, number> = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 10009, chDown: 428, blue: 406 };
const STOP_BELOW_MB = 155;

function wait(ms: number): Promise<void> { return new Promise<void>(function (r) { setTimeout(r, ms); }); }
function until(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  return new Promise<boolean>(function (resolve) {
    function poll(): void {
      if (fn()) { resolve(true); return; }
      if (Date.now() - t0 > ms) { resolve(false); return; }
      setTimeout(poll, 20);
    }
    poll();
  });
}

export function runStage10KeyLog(platform: Platform, log: Logger, app?: DevApp): Promise<void> {
  const L = log.child('selftest10');
  const doc = app ? (app.root.ownerDocument as Document) : document;
  let n = 0;
  doc.addEventListener('keydown', function (e: KeyboardEvent) {
    n++;
    const m = mapKeyCode(e.keyCode, false);
    L.info('10 key', { n: n, code: e.keyCode, mapped: m ? m.key + (m.digit !== undefined ? m.digit : '') : '-', top: app ? app.started.router.stack().slice(-1)[0] : '' });
  }, true);
  L.info('10 keylog ready', { memMB: platform.memory().availableMB });
  return Promise.resolve();
}

export function runStage10SelfTest(platform: Platform, log: Logger, app?: DevApp): Promise<void> {
  const L = log.child('selftest10');
  if (!app || !app.ctx.playlists || !app.ctx.engine) { L.warn('10 skipped'); return Promise.resolve(); }
  const playlists = app.ctx.playlists;
  const eng = app.ctx.engine;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  const root = app.root;
  const pid = playlists.activeId() || '';
  let stopped = false;
  let minMem = 9999;
  function mem(): number { const m = platform.memory().availableMB; if (m >= 0 && m < minMem) { minMem = m; } return m; }
  function errors(since: number): number { return log.entries().filter(function (e: LogEntry) { return e.t >= since && e.level === 'error'; }).length; }
  function key(k: string): void {
    if (stopped) { return; }
    const ev = { keyCode: KEY[k] || k.charCodeAt(0), preventDefault: function () { /* */ } };
    kr.keyDown(ev);
    kr.keyUp(ev);
  }
  function digitKey(d: number): void { const ev = { keyCode: 48 + d, preventDefault: function () { /* */ } }; kr.keyDown(ev); kr.keyUp(ev); }
  function first(cls: string): HTMLElement | null { const els = (root as HTMLElement).getElementsByClassName(cls); return els.length ? els[0] as HTMLElement : null; }
  function text(cls: string): string { const e = first(cls); return e ? e.textContent || '' : ''; }
  function listOpen(): boolean { const e = first('ss-chlist'); return !!e && e.className.indexOf('is-hidden') < 0; }
  // Stream opens, counted by wrapping the engine's load (no URL is read or logged).
  const loadTimes: number[] = [];
  const origLoad = eng.load;
  eng.load = function (src, opts) { loadTimes.push(Date.now()); return origLoad.call(eng, src, opts); };
  function opens(since: number): number { let n = 0; for (let i = 0; i < loadTimes.length; i++) { if (loadTimes[i] >= since) { n++; } } return n; }
  function guard(label: string): boolean {
    const m = mem();
    if (m >= 0 && m < STOP_BELOW_MB) { stopped = true; L.warn('10 stopped: memory near the floor', { at: label, memMB: m }); }
    return stopped;
  }
  // Main-thread lag probe.
  let maxStall = 0;
  let probeLast = Date.now();
  const probe = setInterval(function () { const t = Date.now(); const late = t - probeLast - 50; if (late > maxStall) { maxStall = late; } probeLast = t; }, 50);
  const hb = setInterval(function () { L.info('10 beat', { memMB: mem(), top: router.stack().slice(-1)[0], engine: eng.state(), list: listOpen() }); }, 5000);

  L.info('10 start', { memMB: mem() });
  const t0 = Date.now();
  router.resetTo('home');
  router.push('live-tv', { playlistId: pid });
  return until(function () { return log.entries().some(function (e) { return e.t >= t0 && e.msg === 'live tv ready'; }); }, 20000).then(function () {
    return wait(1500);
  }).then(function () {
    key('ok'); // plays the focused channel
    return until(function () { return eng.state() === 'playing'; }, 20000);
  }).then(function (ok) {
    return wait(6000).then(function () { L.info('10 L playing', { ok: ok, banner: text('ss-banner__name').slice(0, 40), engine: eng.state(), memMB: mem() }); });
  }).then(function (): Promise<void> | undefined {
    if (guard('playing')) { return undefined; }
    // Open the list over the video.
    const since = Date.now();
    const s0 = eng.state();
    key('ok');
    const openMs = Date.now() - since;
    return wait(3000).then(function () {
      L.info('10 L list open', { open: listOpen(), openMs: openMs, engineBefore: s0, engineAfter: eng.state(), newOpens: opens(since), title: text('ss-chlist__title'), rows: (root as HTMLElement).getElementsByClassName('ss-chlist__row').length, memMB: mem() });
    });
  }).then(function (): Promise<void> | undefined {
    if (guard('list open')) { return undefined; }
    // 300 fast moves (every 100 ms), lag probe.
    const since = Date.now();
    maxStall = 0;
    let c: Promise<void> = Promise.resolve();
    for (let i = 0; i < 300; i++) { const k = i % 50 === 49 ? 'chDown' : 'down'; c = c.then(function () { key(k); return wait(100); }); }
    return c.then(function () {
      L.info('10 L fast moves', { title: text('ss-chlist__title'), maxStallMs: maxStall, engine: eng.state(), newOpens: opens(since), memMB: mem(), errors: errors(since) });
      key('back');
    });
  }).then(function (): Promise<void> | undefined {
    if (guard('fast moves')) { return undefined; }
    // 30 open/close cycles.
    const since = Date.now();
    const m0 = mem();
    const samples: number[] = [];
    let c: Promise<void> = Promise.resolve();
    for (let i = 0; i < 30; i++) {
      c = c.then(function () { key('ok'); return wait(400); }).then(function () { key('back'); return wait(400); }).then(function () { if (i % 5 === 4) { samples.push(mem()); } });
    }
    return c.then(function () {
      L.info('10 L open-close', { cycles: 30, memStartMB: m0, memSamplesMB: samples.join(','), memEndMB: mem(), rows: (root as HTMLElement).getElementsByClassName('ss-chlist__row').length, engine: eng.state(), newOpens: opens(since), errors: errors(since) });
    });
  }).then(function (): Promise<void> | undefined {
    if (guard('open-close')) { return undefined; }
    // A typed number: the channel 5 positions further in the same list.
    return playlists.loadLive(pid).then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      const before = text('ss-banner__name');
      let target = '';
      let num = 0;
      for (let i = 0; i < l.catalogue.channels.length && !num; i++) {
        const c = l.catalogue.channels[i];
        if (c.num > 0 && c.num < 100000 && c.name !== before && i > 5 && !c.adult) { num = c.num; target = c.name; }
      }
      const since = Date.now();
      const ds = String(num);
      for (let i = 0; i < ds.length; i++) { digitKey(+ds.charAt(i)); }
      const typed = text('ss-numentry');
      return until(function () { return eng.state() === 'playing' && opens(since) > 0; }, 15000).then(function (ok) {
        return wait(2500).then(function () {
          L.info('10 L number', { digits: ds.length, typedShown: typed.length > 0, tuned: ok, bannerMatches: text('ss-banner__name') === target, engine: eng.state(), memMB: mem() });
          // Previous channel (Blue) back to the first channel.
          const s2 = Date.now();
          key('blue');
          return until(function () { return eng.state() === 'playing' && opens(s2) > 0; }, 15000).then(function (ok2) {
            return wait(2500).then(function () {
              L.info('10 L previous', { tuned: ok2, backToFirst: text('ss-banner__name') === before, engine: eng.state(), memMB: mem() });
            });
          });
        });
      });
    });
  }).then(function () {
    clearInterval(probe);
    L.info('10 L done', { stopped: stopped, minMemMB: minMem, memMB: mem(), errors: errors(t0), top: router.stack().slice(-1)[0] });
    // The heartbeat keeps running for the physical checks.
    setTimeout(function () { clearInterval(hb); }, 30 * 60 * 1000);
  }, function (e) {
    clearInterval(probe);
    clearInterval(hb);
    L.warn('10 failed', undefined, e);
  });
}
