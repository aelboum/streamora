// DEV BUILDS ONLY (called from device-selftest.ts). Stage 6 measurements on the real TV with
// INJECTED remote key events (not the physical remote), against the user's own Xtream playlist
// (the active one). Logs counts and timings only: no titles, URLs or credentials.
//   1. movies: download + store (ms, items, categories), browse screen ready, key handling,
//      category switch, search, details fetch, playback start (then stop after 8 s);
//   2. series: the same, plus get_series_info (seasons/episodes) and one episode's start;
//   3. Live TV regression: one channel starts after VOD on the shared engine.
// Writes only the playlist's movie/series catalogue sections (what the feature itself does).
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { VodService } from '../services/vod-service.ts';
import { createVodIndex } from '../content/vod-index.ts';

const KEY = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 10009 };

function wait(ms: number): Promise<void> {
  return new Promise<void>(function (resolve) { setTimeout(resolve, ms); });
}

function until(fn: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  return new Promise<number>(function (resolve) {
    function poll(): void {
      if (fn() || Date.now() - t0 > timeoutMs) { resolve(Date.now() - t0); return; }
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

export function runStage6SelfTest(platform: Platform, log: Logger, app: DevApp | undefined): Promise<void> {
  const L = log.child('selftest6');
  const ctx = app ? app.ctx as unknown as { playlists: PlaylistService | null; vod: VodService | null } : null;
  if (!app || !ctx || !ctx.playlists || !ctx.vod) {
    L.warn('stage 6 self-test skipped (no app context)');
    return Promise.resolve();
  }
  const svc = ctx.playlists;
  const vod = ctx.vod;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  const root = app.root;
  const pid = svc.activeId() || '';
  if (!pid || !vod.supported(pid)) {
    L.warn('stage 6 self-test skipped (active playlist is not Xtream)');
    return Promise.resolve();
  }
  function press(code: number, times?: number): void {
    for (let i = 0; i < (times || 1); i++) {
      const ev = { keyCode: code, preventDefault: function () { /* */ } };
      kr.keyDown(ev);
      kr.keyUp(ev);
    }
  }
  function find(msg: string, since: number): LogEntry | null {
    const es = log.entries();
    for (let i = es.length - 1; i >= 0; i--) { if (es[i].t >= since && es[i].msg === msg) { return es[i]; } }
    return null;
  }
  function top(): string { return router.stack().slice(-1)[0]; }
  function postersBound(): number {
    const kids = root.childNodes;
    const layer = kids[kids.length - 1] as HTMLElement;
    const els = layer && layer.querySelectorAll ? layer.querySelectorAll('.ss-card__img[src]') : null;
    return els ? els.length : -1;
  }

  function section(s: 'movie' | 'series'): Promise<unknown> {
    const out: Record<string, unknown> = { section: s };
    const free0 = platform.memory().availableMB;
    let probe = lagProbe(platform);
    const t0 = Date.now();
    return vod.refresh(pid, s).result.then(function (r) {
      const p = probe.stop();
      out.refresh = { ok: r.ok, code: r.code || '', items: r.items, categories: r.categories, invalid: r.invalid, unchanged: r.unchanged, ms: Date.now() - t0 };
      out.refreshMaxStallMs = p.maxLagMs;
      out.refreshStallsOver100ms = p.over100;
      out.freeBeforeMB = free0;
      out.refreshMinFreeMB = p.minFreeMB;
      L.info('vod refresh measured', { section: s, refresh: out.refresh, maxStallMs: p.maxLagMs, minFreeMB: p.minFreeMB });
      if (!r.ok) { throw new Error('refresh failed: ' + r.code); }
      probe = lagProbe(platform);
      const since = Date.now();
      router.resetTo('playlists');
      router.push('vod-browse', { playlistId: pid, section: s });
      return until(function () { return find('vod browse ready', since) !== null; }, 120000).then(function (ms) {
        const ready = find('vod browse ready', since);
        out.screenReadyMs = ms;
        out.screenReady = ready ? ready.data : null;
        return wait(1500);
      });
    }).then(function () {
      out.postersBoundAfter1500ms = postersBound();
      const t1 = Date.now();
      press(KEY.right, 6);
      press(KEY.down, 10);
      out.keyMsPerPress = Math.round((Date.now() - t1) / 16 * 100) / 100;
      press(KEY.left, 7); // to the categories
      const t2 = Date.now();
      press(KEY.down); // first provider category
      return wait(400).then(function () { out.categorySwitchWallMs = Date.now() - t2; });
    }).then(function () {
      const p = probe.stop();
      out.browseMaxStallMs = p.maxLagMs;
      out.browseMinFreeMB = p.minFreeMB;
      return vod.load(pid, s);
    }).then(function (l) {
      if (l.status !== 'ok') { throw new Error('load ' + l.status); }
      const ts = Date.now();
      const idx = createVodIndex(l.catalogue);
      const first = l.catalogue.items[0];
      const q = first ? first.name.substring(0, Math.min(4, first.name.length)) : 'a';
      const hits = idx.search(q, 2000);
      out.indexAndSearchMs = Date.now() - ts;
      out.searchHits = hits.length;
      const td = Date.now();
      if (s === 'movie') {
        return vod.movieDetails(pid, first).then(function (d) {
          out.detailsMs = Date.now() - td;
          out.details = d ? { plot: !!d.plot, genre: !!d.genre, duration: !!d.durationSec, year: !!d.year, rating: d.rating !== null, poster: !!d.poster } : null;
        });
      }
      return vod.seriesDetails(pid, first).then(function (d) {
        out.detailsMs = Date.now() - td;
        let eps = 0;
        if (d) { for (let i = 0; i < d.seasons.length; i++) { eps += d.seasons[i].episodes.length; } }
        out.details = d ? { seasons: d.seasons.length, episodes: eps, invalid: d.invalid, plot: !!d.details.plot } : null;
      });
    }).then(function () {
      // Through the UI: "All", first title → details → Play (movie) / first episode (series).
      press(KEY.up);
      return wait(400);
    }).then(function () {
      press(KEY.right);
      const since = Date.now();
      press(KEY.ok);
      return until(function () { return top() === 'vod-details'; }, 5000).then(function () {
        return wait(s === 'movie' ? 1500 : 6000);
      }).then(function () {
        if (s === 'series') { press(KEY.right); }
        const tp = Date.now();
        press(KEY.ok);
        return until(function () { return find('vod: playing', tp) !== null || find('vod: playback failed', tp) !== null; }, 40000).then(function () {
          const ok = find('vod: playing', tp);
          const bad = find('vod: playback failed', tp);
          out.playback = ok ? { ok: true, startupMs: (ok.data as { startupMs: number }).startupMs } : (bad ? { ok: false, code: (bad.data as { code: string }).code } : { ok: false, code: 'no-outcome' });
          out.playerScreen = top();
          return wait(8000);
        });
      }).then(function () {
        out.noFailureFor8s = !find('vod: playback failed', since + 1) || !(out.playback as { ok: boolean }).ok;
        out.freeWhilePlayingMB = platform.memory().availableMB;
        press(KEY.back);
        return wait(1500);
      });
    }).then(function () {
      out.afterBack = top();
      router.resetTo('playlists');
      return out;
    });
  }

  function liveRegression(): Promise<unknown> {
    const since = Date.now();
    router.resetTo('playlists');
    router.push('live-tv', { playlistId: pid });
    return until(function () { return find('live tv ready', since) !== null; }, 60000).then(function () {
      press(KEY.right);
      const tp = Date.now();
      press(KEY.ok);
      return until(function () { return find('live: playing', tp) !== null || find('live: channel failed', tp) !== null; }, 30000).then(function () {
        const ok = find('live: playing', tp);
        const r = { live: ok ? 'playing after VOD, startupMs=' + (ok.data as { startupMs: number }).startupMs : 'FAILED' };
        press(KEY.back);
        return wait(1500).then(function () { router.resetTo('playlists'); return r; });
      });
    });
  }

  function step(name: string, p: () => Promise<unknown>): Promise<void> {
    const t0 = Date.now();
    return p().then(function (detail) {
      L.info('selftest PASS ' + name, { ms: Date.now() - t0, detail: detail });
    }, function (e) {
      router.resetTo('playlists');
      L.warn('selftest FAIL ' + name, { ms: Date.now() - t0 }, e);
    });
  }

  return step('movies (real Xtream provider)', function () { return section('movie'); })
    .then(function () { return step('series (real Xtream provider)', function () { return section('series'); }); })
    .then(function () { return step('Live TV after VOD (shared engine)', liveRegression); })
    .then(function () { L.info('stage 6 self-test done', { memory: platform.memory() }); });
}
