// DEV BUILDS ONLY — Stage 11 (approved 2026-11-25). Not referenced by release builds.
//   M  Movies: category sizes (how many fit the 5,000 sorting limit), year coverage and the time and
//      memory to sort the largest category that fits, for each order. Stored data only.
//   S  Series: 20 series spread over the list (get_series_info, as Details does): how many state
//      season/episode numbers, and which have a next episode; one is suggested for your test.
//   Key log (codes only) and a memory heartbeat stay on for the physical checks.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import { mapKeyCode } from '../navigation/keys.ts';
import { SORT_MAX, sortPositions } from '../content/vod-sort.ts';
import type { SortMode } from '../content/vod-sort.ts';
import { nextEpisode } from '../content/next-episode.ts';

function wait(ms: number): Promise<void> { return new Promise<void>(function (r) { setTimeout(r, ms); }); }

export function runStage11SelfTest(platform: Platform, log: Logger, app?: DevApp): Promise<void> {
  const L = log.child('selftest11');
  if (!app || !app.ctx.playlists || !app.ctx.vod) { L.warn('11 skipped'); return Promise.resolve(); }
  const vod = app.ctx.vod;
  const pid = app.ctx.playlists.activeId() || '';
  const router = app.started.router;
  function mem(): number { return platform.memory().availableMB; }
  const doc = app.root.ownerDocument as Document;
  let n = 0;
  doc.addEventListener('keydown', function (e: KeyboardEvent) {
    n++;
    const m = mapKeyCode(e.keyCode, false);
    L.info('11 key', { n: n, code: e.keyCode, mapped: m ? m.key : '-', top: router.stack().slice(-1)[0] });
  }, true);
  setInterval(function () { L.info('11 beat', { memMB: mem(), top: router.stack().slice(-1)[0] }); }, 5000);
  L.info('11 start', { memMB: mem(), myListMovies: app.ctx.myList.list(pid, 'movie').length, myListSeries: app.ctx.myList.list(pid, 'series').length });

  return wait(4000).then(function () { return vod.load(pid, 'movie'); }).then(function (l): Promise<void> | undefined {
    if (l.status !== 'ok') { L.warn('11 M no movies', { status: l.status }); return undefined; }
    const v = l.view;
    const sizes = v.categories.map(function (c) { return c.count; }).filter(function (x) { return x > 0; });
    let fit = 0; let over = 0; let largestFit = -1; let largestFitN = 0; let max = 0;
    for (let i = 0; i < v.categories.length; i++) {
      const c = v.categories[i].count;
      if (c <= 0) { continue; }
      if (c > max) { max = c; }
      if (c <= SORT_MAX) { fit++; if (c > largestFitN) { largestFitN = c; largestFit = i; } } else { over++; }
    }
    sizes.sort(function (a, b) { return a - b; });
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    L.info('11 M categories', { categories: sizes.length, sortable: fit, overLimit: over, largest: max, median: median, largestSortable: largestFitN, total: v.total });
    if (largestFit < 0) { return undefined; }
    const cat = v.categories[largestFit];
    const ref = v.byCategory(cat.id);
    const positions: number[] = [];
    for (let i = 0; i < ref.length; i++) { positions.push(ref.at(i)); }
    const m0 = mem();
    const t0 = Date.now();
    return v.sortKeys(positions).then(function (k) {
      const readMs = Date.now() - t0;
      let withYear = 0; let withName = 0;
      for (let i = 0; i < k.years.length; i++) { if (k.years[i] > 0) { withYear++; } if (k.names[i]) { withName++; } }
      const modes: SortMode[] = ['titleAsc', 'titleDesc', 'yearDesc', 'yearAsc'];
      const times: string[] = [];
      for (let i = 0; i < modes.length; i++) { const s = Date.now(); sortPositions(positions, k.names, k.years, modes[i]); times.push(modes[i] + ':' + (Date.now() - s)); }
      L.info('11 M sort', { items: positions.length, readKeysMs: readMs, sortMs: times.join(' '), withYear: withYear, withName: withName, memBeforeMB: m0, memAfterMB: mem(), pages: v.pagesInMemory() });
    });
  }).then(function () { return vod.load(pid, 'series'); }).then(function (l): Promise<void> | undefined {
    if (l.status !== 'ok') { L.warn('11 S no series', { status: l.status }); return undefined; }
    const v = l.view;
    const step = Math.max(1, Math.floor(v.total / 20));
    const want: number[] = [];
    for (let i = 0; i < 20 && i * step < v.total; i++) { want.push(i * step); }
    return v.ensure(want).then(function () {
      let chain: Promise<void> = Promise.resolve();
      let series = 0; let eps = 0; let exact = 0; let withNext = 0; let multiSeason = 0;
      let suggestion = '';
      for (let i = 0; i < want.length; i++) {
        const it = v.item(want[i]);
        if (!it || it.adult) { continue; }
        const item = it;
        chain = chain.then(function () {
          return vod.seriesDetails(pid, item).then(function (sd) {
            if (!sd || !sd.seasons.length) { return; }
            series++;
            let nx = 0;
            for (let s = 0; s < sd.seasons.length; s++) {
              for (let e = 0; e < sd.seasons[s].episodes.length; e++) {
                const ep = sd.seasons[s].episodes[e];
                eps++;
                if (ep.exact) { exact++; }
                const r = nextEpisode(sd.seasons, ep.id);
                if ('episode' in r) { nx++; }
              }
            }
            if (nx > 0) { withNext++; }
            if (sd.seasons.length > 1) { multiSeason++; if (!suggestion && nx > 0) { suggestion = item.name.slice(0, 60) + ' (' + sd.seasons.length + ' seasons)'; } }
            return wait(300);
          });
        });
      }
      return chain.then(function () {
        L.info('11 S series', { sampled: series, episodes: eps, statedNumbers: exact, seriesWithNext: withNext, multiSeason: multiSeason, suggestion: suggestion, memMB: mem() });
      });
    });
  }).then(function () {
    L.info('11 done', { memMB: mem() });
  }, function (e) { L.warn('11 failed', undefined, e); });
}
