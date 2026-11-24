// DEV BUILDS ONLY (called from device-selftest.ts). Stage 5 measurements on the real TV with
// INJECTED remote key events (not the physical remote), through the real key router and screens.
//   A. Playback with the real AVPlay on SYNTHETIC LAN streams from the dev sink (ffmpeg test
//      pattern, H.264/AAC and H.264/MP2 MPEG-TS): start-up time, stability, channel switching,
//      a 404 channel, a refused connection, recovery, cleanup. Not a real provider.
//   B. Live TV with 1,000 / 10,000 / 50,000 channels: import, screen ready, guide refresh, key
//      handling, category switch, search (through the system-keyboard dialog's Done path),
//      event-loop stalls, free memory, guide cache load.
// Test playlists are added through the app's PlaylistService and removed afterwards; other
// playlists, favourites and history are not touched.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';

const KEY = { down: 40, up: 38, ok: 13, back: 10009, chUp: 427 };

function step(log: Logger, name: string, p: Promise<unknown>): Promise<void> {
  const t0 = Date.now();
  return p.then(function (detail) {
    log.info('selftest PASS ' + name, { ms: Date.now() - t0, detail: detail });
  }, function (e) {
    log.warn('selftest FAIL ' + name, { ms: Date.now() - t0 }, e);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise<void>(function (resolve) { setTimeout(resolve, ms); });
}

function until(fn: () => boolean, timeoutMs: number, what: string): Promise<number> {
  const t0 = Date.now();
  return new Promise<number>(function (resolve, reject) {
    function poll(): void {
      if (fn()) { resolve(Date.now() - t0); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error('timeout: ' + what)); return; }
      setTimeout(poll, 20);
    }
    poll();
  });
}

interface Probe { stop(): { maxLagMs: number; over100: number; minFreeMB: number } }

function lagProbe(platform: Platform): Probe {
  let maxLag = 0;
  let over = 0;
  let n = 0;
  let last = Date.now();
  let minFree = platform.memory().availableMB;
  const h = setInterval(function () {
    const now = Date.now();
    const lag = now - last - 50;
    last = now;
    if (lag > maxLag) { maxLag = lag; }
    if (lag > 100) { over++; }
    if (++n % 10 === 0) {
      const m = platform.memory().availableMB;
      if (m >= 0 && m < minFree) { minFree = m; }
    }
  }, 50);
  return { stop: function () { clearInterval(h); return { maxLagMs: maxLag, over100: over, minFreeMB: minFree }; } };
}

export function runStage5SelfTest(platform: Platform, log: Logger, sinkUrl: string, app?: DevApp, scaleOnly?: boolean): Promise<void> {
  const L = log.child('selftest5');
  if (!app || !app.ctx.playlists || !app.ctx.epg) {
    L.warn('stage 5 self-test skipped (no app context)');
    return Promise.resolve();
  }
  const root = app.root;
  const svc = app.ctx.playlists;
  const epg = app.ctx.epg;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  const origin = sinkUrl.replace(/\/ingest$/, '');
  const doc = root.ownerDocument as Document;

  function press(code: number, times?: number): void {
    for (let i = 0; i < (times || 1); i++) {
      const ev = { keyCode: code, preventDefault: function () { /* */ } };
      kr.keyDown(ev);
      kr.keyUp(ev);
    }
  }
  function visible(): HTMLElement | null {
    const kids = root.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      const el = kids[i] as HTMLElement;
      if (el.style && el.style.display !== 'none') { return el; }
    }
    return null;
  }
  function text(): string {
    const v = visible();
    return v ? v.textContent || '' : '';
  }
  function q(sel: string): HTMLElement | null {
    const v = visible();
    return v ? v.querySelector(sel) as HTMLElement | null : null;
  }
  function firstRow(): string {
    const r = q('.ss-ch:not([style*="none"]) .ss-ch__name');
    return r ? r.textContent || '' : '';
  }
  let mark = 0;
  function find(msg: string): LogEntry | null {
    const es = log.entries();
    for (let i = 0; i < es.length; i++) { if (es[i].t >= mark && es[i].msg === msg) { return es[i]; } }
    return null;
  }
  function addAndImport(url: string, name: string): Promise<{ id: string; importMs: number }> {
    const t0 = Date.now();
    return svc.add({ name: name, kind: 'm3u', url: url }).then(function (a) {
      if (!a.ok) { throw new Error('add failed: ' + a.code); }
      svc.markCleartextNoticeSeen(a.playlist.id);
      return svc.refresh(a.playlist.id).result.then(function (r) {
        if (!r.ok) { throw new Error('import failed: ' + r.code); }
        return { id: a.playlist.id, importMs: Date.now() - t0 };
      });
    });
  }
  function openLive(id: string): Promise<number> {
    mark = Date.now();
    router.resetTo('playlists');
    const t0 = Date.now();
    router.push('live-tv', { playlistId: id });
    return until(function () { return find('live tv ready') !== null; }, 60000, 'live tv ready').then(function () { return Date.now() - t0; });
  }
  function untilPlayingOrFailed(timeoutMs: number, what: string): Promise<number> {
    return until(function () { return find('live: playing') !== null || find('live: channel failed') !== null; }, timeoutMs, what);
  }

  // ---------------------------------------------------------------- A. playback
  function playback(): Promise<unknown> {
    const out: Record<string, unknown> = {};
    let id = '';
    return addAndImport(origin + '/fixture/live.m3u', 'selftest live').then(function (r) {
      id = r.id;
      return openLive(id);
    }).then(function () {
      return until(function () { return !epg.status().refreshing && epg.status().state !== 'loading'; }, 60000, 'guide');
    }).then(function () {
      out.guideChannels = epg.status().channels;
      out.listShowsCurrentProgramme = /Programme \d+ on channel 0/.test(text());
      mark = Date.now();
      press(KEY.ok); // Watch channel 1
      return untilPlayingOrFailed(30000, 'first channel');
    }).then(function (ms) {
      const e = find('live: playing');
      out.ch1 = e ? 'playing; startupMs=' + (e.data as { startupMs: number }).startupMs + '; OK to picture ' + ms + ' ms' : 'FAILED ' + JSON.stringify(find('live: channel failed'));
      mark = Date.now();
      return wait(8000);
    }).then(function () {
      let drops = 0;
      const es = log.entries();
      for (let i = 0; i < es.length; i++) {
        if (es[i].t >= mark && /dropped|failed/.test(es[i].msg)) { drops++; }
      }
      out.stableFor8s = drops === 0;
      const st = q('.ss-player__status');
      out.statusTextAfter8s = st ? st.textContent : '';
      mark = Date.now();
      press(KEY.chUp); // channel 2 (H.264/MP2)
      return untilPlayingOrFailed(30000, 'zap');
    }).then(function (ms) {
      const e = find('live: playing');
      out.zapToCh2 = e ? 'playing; startupMs=' + (e.data as { startupMs: number }).startupMs + '; CH+ to picture ' + ms + ' ms (incl. 400 ms debounce)' : 'FAILED';
      mark = Date.now();
      press(KEY.chUp); // 404
      return until(function () { return find('live: channel failed') !== null; }, 40000, '404');
    }).then(function (ms) {
      const e = find('live: channel failed');
      out.ch3_404 = 'error ' + (e && e.data ? (e.data as { code: string }).code : '?') + ' after ' + ms + ' ms; hint on screen: ' + /Press OK to try again/.test(text());
      mark = Date.now();
      press(KEY.chUp); // refused
      return until(function () { return find('live: channel failed') !== null; }, 40000, 'refused');
    }).then(function (ms) {
      const e = find('live: channel failed');
      out.ch4_refused = 'error ' + (e && e.data ? (e.data as { code: string }).code : '?') + ' after ' + ms + ' ms';
      mark = Date.now();
      press(KEY.chUp); // wraps to channel 1
      return untilPlayingOrFailed(30000, 'recover');
    }).then(function (ms) {
      out.recoveryToCh1 = find('live: playing') ? 'playing after ' + ms + ' ms' : 'FAILED';
      press(KEY.back);
      return wait(1500);
    }).then(function () {
      out.afterBack = router.stack().slice(-1)[0];
      out.pageStillTransparent = doc.body.className.indexOf('ss-playing') >= 0;
      out.freeMB = platform.memory().availableMB;
      router.resetTo('playlists');
      return svc.remove(id);
    }).then(function () { return out; }, function (e) {
      router.resetTo('playlists');
      return (id ? svc.remove(id) : Promise.resolve()).then(function () { throw e; });
    });
  }

  // ---------------------------------------------------------------- B. scale
  function scale(n: number): Promise<unknown> {
    const out: Record<string, unknown> = { channels: n };
    let id = '';
    let probe: Probe | null = null;
    return addAndImport(origin + '/fixture/channels.m3u?n=' + n, 'selftest ' + n).then(function (r) {
      id = r.id;
      out.importMs = r.importMs;
      out.freeBeforeMB = platform.memory().availableMB;
      probe = lagProbe(platform);
      return openLive(id);
    }).then(function (ms) {
      out.screenReadyMs = ms;
      const ready = find('live tv ready');
      const data = ready && ready.data ? ready.data as { loadMs: number; renderMs: number } : { loadMs: -1, renderMs: -1 };
      out.catalogueLoadMs = data.loadMs;
      out.indexAndRenderMs = data.renderMs;
      return until(function () { return epg.status().state === 'ready' && !epg.status().refreshing; }, 180000, 'guide');
    }).then(function (ms) {
      out.guideRefreshMs = ms;
      out.guideProgrammes = epg.status().programmes;
      const p = (probe as Probe).stop();
      out.openAndGuideMaxStallMs = p.maxLagMs;
      out.openAndGuideStallsOver100ms = p.over100;
      out.openAndGuideFreeMinMB = p.minFreeMB;
      probe = lagProbe(platform);
      const t0 = Date.now();
      press(KEY.down, 40);
      out.keyHandlingMsPerPress = Math.round((Date.now() - t0) / 40 * 100) / 100;
      return wait(300);
    }).then(function () {
      press(KEY.back); // categories ("All channels")
      const before = firstRow();
      const t0 = Date.now();
      press(KEY.down); // first real category
      return until(function () { return firstRow() !== before && firstRow() !== ''; }, 5000, 'category switch').then(function () {
        out.categorySwitchMs = Date.now() - t0 - 150; // minus the 150 ms debounce
      });
    }).then(function () {
      press(KEY.up, 4); // Search
      press(KEY.ok);
      return wait(800);
    }).then(function (): Promise<unknown> | undefined {
      const input = q('.ss-ime__input') as HTMLInputElement | null;
      out.searchDialog = input ? 'system keyboard dialog' : String(router.overlay());
      if (!input) {
        press(KEY.back);
        return undefined;
      }
      input.value = '999';
      const ev = doc.createEvent('Event');
      ev.initEvent('keydown', true, true);
      (ev as unknown as { keyCode: number }).keyCode = 65376; // IME "Done"
      const before = firstRow();
      const t0 = Date.now();
      input.dispatchEvent(ev);
      // '999' matches names containing 999 and channel number 999 (which is 'Channel 998').
      return until(function () { return router.overlay() === null && firstRow() !== before && /99[89]/.test(firstRow()); }, 5000, 'search').then(function () {
        out.searchMs = Date.now() - t0;
        out.firstResult = firstRow();
      });
    }).then(function () {
      const p = (probe as Probe).stop();
      out.interactionMaxStallMs = p.maxLagMs;
      out.interactionFreeMinMB = p.minFreeMB;
      press(KEY.back);
      press(KEY.back);
      return wait(300);
    }).then(function () {
      router.resetTo('playlists');
      const t0 = Date.now();
      return epg.load(id).then(function (s) {
        out.guideCacheLoadMs = Date.now() - t0;
        out.guideCacheProgrammes = s.programmes;
        out.freeAfterMB = platform.memory().availableMB;
        return svc.remove(id);
      });
    }).then(function () { return out; }, function (e) {
      if (probe) { probe.stop(); }
      router.resetTo('playlists');
      return (id ? svc.remove(id) : Promise.resolve()).then(function () { throw e; });
    });
  }

  // Leftovers of an interrupted earlier self-test run (only playlists this suite creates).
  function cleanup(): Promise<number> {
    const old = svc.list().filter(function (d) { return d.name.indexOf('selftest ') === 0; });
    let chain: Promise<void> = Promise.resolve();
    for (let i = 0; i < old.length; i++) {
      const pid = old[i].id;
      chain = chain.then(function () { return svc.remove(pid); });
    }
    return chain.then(function () { return old.length; });
  }

  return cleanup().then(function (n) { if (n) { L.info('removed leftover self-test playlists', { count: n }); } })
    .then(function () { return scaleOnly ? undefined : step(L, 'playback on synthetic LAN streams (real AVPlay)', playback()); })
    .then(function () { return step(L, 'live TV with 1,000 channels', scale(1000)); })
    .then(function () { return step(L, 'live TV with 10,000 channels', scale(10000)); })
    .then(function () { return step(L, 'live TV with 50,000 channels', scale(50000)); })
    .then(function () { L.info('stage 5 self-test done', { memory: platform.memory() }); });
}
