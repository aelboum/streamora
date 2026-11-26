// DEV BUILDS ONLY — Stage 9 TV run (approved 2026-11-25). Not referenced by release builds.
//   S1 Live TV: open with the cache released (= the old path), then reopen 3 times: time to ready,
//      cached or not, provider requests (XHR count only, URLs never logged), channel order and
//      favourites unchanged, free memory. Account switch when the TV has a second account.
//   S2 Global Search through the real screen (recent-search chips, keys): time to the first result
//      card and to the complete result for common / no-result / Arabic queries; a rapid second
//      query; the user's recent searches are restored afterwards.
//   S3 Series list update twice (write gate off, then on) while keys are pressed in bursts:
//      main-thread stalls (50 ms lag probe) while keys are active vs idle, gate statistics, memory.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import { fnv1a32 } from '../utils/bytes.ts';
import { createTranslator } from '../i18n/strings.ts';

const KEY: Record<string, number> = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 10009 };
const SEARCHING = [createTranslator('en')('search.searching'), createTranslator('nl')('search.searching')];

function wait(ms: number): Promise<void> { return new Promise<void>(function (r) { setTimeout(r, ms); }); }
function until(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  return new Promise<boolean>(function (resolve) {
    function poll(): void {
      if (fn()) { resolve(true); return; }
      if (Date.now() - t0 > ms) { resolve(false); return; }
      setTimeout(poll, 10);
    }
    poll();
  });
}
function isList(x: unknown): x is string[] { return x instanceof Array; }

export function runStage9SelfTest(platform: Platform, log: Logger, app?: DevApp): Promise<void> {
  const L = log.child('selftest9');
  if (!app) { L.warn('9 skipped (no app)'); return Promise.resolve(); }
  const ctx = app.ctx;
  const svc = ctx.playlists;
  const vod = ctx.vod;
  if (!svc || !vod) { L.warn('9 skipped (no playlists/vod)'); return Promise.resolve(); }
  const playlists = svc;
  const vodS = vod;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  const gate = app.started.writeGate;
  const root = app.root;
  const pid = playlists.activeId() || '';
  function mem(): number { return platform.memory().availableMB; }
  function errors(since: number): LogEntry[] { return log.entries().filter(function (e) { return e.t >= since && e.level === 'error'; }); }
  function key(k: string): void {
    const ev = { keyCode: KEY[k], preventDefault: function () { /* */ } };
    kr.keyDown(ev);
    kr.keyUp(ev);
  }
  function byClass(cls: string): HTMLElement[] {
    const els = (root as HTMLElement).getElementsByClassName(cls);
    const out: HTMLElement[] = [];
    for (let i = 0; i < els.length; i++) { out.push(els[i] as HTMLElement); }
    return out;
  }
  function searching(): boolean {
    const m = byClass('ss-srch__message')[0];
    return !!m && SEARCHING.indexOf(m.textContent || '') >= 0;
  }
  function rowLabels(): string {
    return byClass('ss-srch__row').map(function (r) { const l = r.getElementsByClassName('ss-srch__label')[0]; return l ? l.textContent || '' : ''; }).join(' | ');
  }

  // Provider requests: XHR opens to anything but the LAN dev sink (counts only, no URLs).
  let xhrCount = 0;
  const XP = (window as unknown as { XMLHttpRequest: { prototype: { open: (...a: unknown[]) => void } } }).XMLHttpRequest.prototype;
  const origOpen = XP.open;
  XP.open = function (this: unknown) {
    const u = String(arguments[1] || '');
    if (u.indexOf('192.168.1.180') < 0) { xhrCount++; }
    return origOpen.apply(this, arguments as unknown as unknown[]);
  };

  // Main-thread lag probe: a 50 ms timer; a late firing is a stall of that length.
  const stalls: Array<{ at: number; ms: number }> = [];
  let probeLast = Date.now();
  const probe = setInterval(function () {
    const n = Date.now();
    const late = n - probeLast - 50;
    if (late > 100) { stalls.push({ at: n, ms: late }); }
    probeLast = n;
  }, 50);

  // ---------------------------------------------------------------- S1 Live TV
  function liveOpen(n: number, cold: boolean): Promise<void> {
    if (cold) { playlists.releaseLiveCache('stage9 cold open'); }
    router.resetTo('home');
    return wait(1500).then(function () {
      const since = Date.now();
      const x0 = xhrCount;
      const m0 = mem();
      router.push('live-tv', { playlistId: pid });
      return until(function () { return log.entries().some(function (e) { return e.t >= since && e.msg === 'live tv ready'; }); }, 20000).then(function (ok) {
        const ready = log.entries().filter(function (e) { return e.t >= since && e.msg === 'live tv ready'; })[0];
        const d = ready ? ((ready as unknown as { data: Record<string, unknown> }).data || {}) : {};
        const toReady = ready ? ready.t - since : -1;
        return wait(3000).then(function () {
          const x1 = xhrCount - x0;
          return playlists.loadLive(pid).then(function (l) {
            const order = l.status === 'ok' ? fnv1a32(l.catalogue.channels.map(function (c) { return c.id; }).join(',')) : '';
            const favIds = ctx.lists.favourites(pid);
            let favResolved = 0;
            if (l.status === 'ok') {
              const set: Record<string, boolean> = {};
              for (let i = 0; i < l.catalogue.channels.length; i++) { set['k' + l.catalogue.channels[i].id] = true; }
              for (let i = 0; i < favIds.length; i++) { if (set['k' + favIds[i]]) { favResolved++; } }
            }
            const c = playlists.liveCacheInfo();
            L.info('9 S1 live open', {
              n: n, cold: cold, ready: ok, toReadyMs: toReady, loadMs: d.loadMs, renderMs: d.renderMs, cached: d.cached, channels: d.channels,
              categories: d.categories, providerRequestsIn3s: x1, orderHash: order, favourites: favIds.length, favResolved: favResolved,
              memBeforeMB: m0, memAfterMB: mem(), cacheChars: c.chars, cacheHits: c.hits, cacheMisses: c.misses, errors: errors(since).length
            });
          });
        });
      });
    });
  }
  function s1(): Promise<void> {
    let c: Promise<void> = liveOpen(0, true);
    for (let i = 1; i <= 3; i++) { const n = i; c = c.then(function () { return liveOpen(n, false); }); }
    return c.then(function (): Promise<void> | undefined {
      const list = playlists.list();
      if (list.length < 2) { L.info('9 S1 account switch', { skipped: true, accounts: list.length }); return undefined; }
      let other = '';
      for (let i = 0; i < list.length; i++) { if (list[i].id !== pid) { other = list[i].id; } }
      playlists.setActive(other);
      const afterSwitch = playlists.liveCacheInfo();
      playlists.setActive(pid);
      L.info('9 S1 account switch', { skipped: false, accounts: list.length, cacheAfterSwitch: afterSwitch.playlistId, released: afterSwitch.lastRelease });
      return liveOpen(9, false);
    }).then(function () {
      router.resetTo('home');
      // Memory with the cache held, outside Live TV.
      return wait(5000).then(function () { L.info('9 S1 outside live', { memMB: mem(), cached: playlists.liveCacheInfo().playlistId ? 'yes' : 'no' }); });
    });
  }

  // ---------------------------------------------------------------- S2 Search
  const QUERIES: Array<[string, string]> = [['love', 'common'], ['night', 'common2'], ['zqxvjw', 'none'], ['حب', 'arabic']];
  function searchOne(q: string, label: string): Promise<void> {
    ctx.kv.set('search.recent', [q]);
    router.resetTo('home');
    return wait(1200).then(function () {
      router.push('search');
      return wait(400);
    }).then(function () {
      const since = Date.now();
      key('down'); // query box → recent chips
      const t0 = Date.now();
      key('ok'); // the chip runs the search
      let first = -1;
      let done = -1;
      return until(function () {
        const n = Date.now() - t0;
        if (first < 0 && byClass('ss-srch__card').length > 0) { first = n; }
        if (done < 0 && !searching()) { done = n; }
        return done >= 0;
      }, 20000).then(function () {
        const msg = byClass('ss-srch__message')[0];
        let maxStall = 0;
        for (let i = 0; i < stalls.length; i++) { if (stalls[i].at >= t0 && stalls[i].ms > maxStall) { maxStall = stalls[i].ms; } }
        L.info('9 S2 search', { label: label, queryLen: q.length, firstCardMs: first, completeMs: done, rows: rowLabels(), message: msg ? (msg.textContent || '').slice(0, 80) : '', maxStallMs: maxStall, memMB: mem(), errors: errors(since).length });
      });
    });
  }
  function rapid(): Promise<void> {
    // Two queries about 200 ms apart: the screen must end on the second one.
    ctx.kv.set('search.recent', ['night', 'love']);
    router.resetTo('home');
    return wait(1200).then(function () { router.push('search'); return wait(400); }).then(function () {
      const since = Date.now();
      key('down');
      key('ok'); // "night" (the recent list stays night, love)
      return wait(200).then(function () {
        key('right'); key('ok'); // "love", while "night" is still being scanned
        return wait(300).then(function () { return until(function () { return !searching(); }, 20000); });
      }).then(function () {
        return wait(4000); // late results of the first query would have arrived by now
      }).then(function () {
        const titles = byClass('ss-srch__title').slice(0, 8).map(function (x) { return (x.textContent || '').toLowerCase().indexOf('love') >= 0 ? 'love' : 'other'; });
        L.info('9 S2 rapid', { rows: rowLabels(), titlesMatchingSecondQuery: titles.join(','), recentNow: ctx.kv.get<string[]>('search.recent', isList, []).slice(0, 2).join(','), errors: errors(since).length });
      });
    });
  }
  function s2(): Promise<void> {
    const saved = ctx.kv.get<string[]>('search.recent', isList, []);
    let c: Promise<void> = Promise.resolve();
    for (let i = 0; i < QUERIES.length; i++) { const q = QUERIES[i]; c = c.then(function () { return searchOne(q[0], q[1]); }); }
    return c.then(rapid).then(function () {
      ctx.kv.set('search.recent', saved); // the user's recent searches as before
      router.resetTo('home');
    });
  }

  // ---------------------------------------------------------------- S3 update while keys are pressed
  function update(gateOn: boolean): Promise<void> {
    const files = platform.fileStore;
    if (files && files.setWriteGate) { files.setWriteGate(gateOn ? gate.wait : null); }
    router.resetTo('home');
    const since = Date.now();
    const active: number[] = [];
    let finished = false;
    let minMem = mem();
    const memT = setInterval(function () { const m = mem(); if (m >= 0 && m < minMem) { minMem = m; } }, 1000);
    // Bursts: 8 keys 300 ms apart (2.4 s of use), then 3 s without keys.
    function burst(): Promise<void> {
      if (finished) { return Promise.resolve(); }
      const seq: string[] = ['right', 'left', 'right', 'left', 'right', 'left', 'right', 'left'];
      let c: Promise<void> = Promise.resolve();
      for (let i = 0; i < seq.length; i++) {
        const k = seq[i];
        c = c.then(function (): Promise<void> | undefined { if (finished) { return undefined; } active.push(Date.now()); key(k); return wait(300); });
      }
      return c.then(function () { return finished ? undefined : wait(3000); }).then(burst);
    }
    const g0 = gate.stats();
    const job = vodS.refresh(pid, 'series');
    const keysDone = burst();
    return job.result.then(function (r) {
      finished = true;
      clearInterval(memT);
      return keysDone.then(function () {
        let activeMax = 0;
        let idleMax = 0;
        let activeN = 0;
        let idleN = 0;
        for (let i = 0; i < stalls.length; i++) {
          if (stalls[i].at < since) { continue; }
          // A stall "during use" began within 1.5 s after a key press.
          const begin = stalls[i].at - stalls[i].ms;
          let near = false;
          for (let j = 0; j < active.length; j++) { if (begin >= active[j] && begin - active[j] <= 1500) { near = true; break; } }
          if (near) { activeN++; if (stalls[i].ms > activeMax) { activeMax = stalls[i].ms; } } else { idleN++; if (stalls[i].ms > idleMax) { idleMax = stalls[i].ms; } }
        }
        const g = gate.stats();
        L.info('9 S3 update', {
          gate: gateOn, ok: r.ok, code: r.code || '', items: r.items, unchanged: r.unchanged, ms: r.ms, maxPageWriteMs: r.phases ? r.phases.maxPageWriteMs : -1,
          keys: active.length, stallsDuringUse: activeN, maxStallDuringUseMs: activeMax, stallsIdle: idleN, maxStallIdleMs: idleMax,
          gateWaited: g.waited - g0.waited, gateCapped: g.capped - g0.capped, gatePressured: g.pressured - g0.pressured, gateMaxWaitMs: g.maxWaitMs,
          minFreeMB: minMem, memMB: mem(), errors: errors(since).length
        });
        if (files && files.setWriteGate) { files.setWriteGate(gate.wait); } // the normal state
      });
    });
  }

  L.info('9 start', { memMB: mem(), accounts: playlists.list().length });
  let beats = 0;
  const hb = setInterval(function () {
    beats++;
    L.info('9 beat', { n: beats, memMB: mem(), top: router.stack().slice(-1)[0], cache: playlists.liveCacheInfo().playlistId ? 'yes' : 'no' });
    if (beats > 500) { clearInterval(hb); }
  }, 5000);
  function end(): void {
    clearInterval(hb);
    clearInterval(probe);
    XP.open = origOpen;
  }
  // Pass 2 (after the search and gate-floor fixes): S1 already measured in pass 1.
  const PASS: number = 2;
  return wait(3000).then(function () { return PASS === 1 ? s1() : undefined; }).then(s2).then(function () { return update(false); }).then(function () { return update(true); }).then(function () {
    end();
    router.resetTo('home');
    L.info('9 done', { memMB: mem(), errors: errors(0).length });
  }, function (e) {
    end();
    L.warn('9 failed', undefined, e);
  });
}
