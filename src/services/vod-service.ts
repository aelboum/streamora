// VodService (Stage 6, paged in Stage 6.1): movie and series catalogues of an Xtream playlist.
//
// - refresh(pid, section): the category list, then the titles CATEGORY BY CATEGORY
//   (get_vod_streams / get_series with category_id), so the TV never holds the provider's whole
//   list (Stage 6 measured 108,521 movies in one response: lowest free memory 71 MB). Titles are
//   written as they arrive into the page files of a new generation (content/vod-pages.ts); the
//   index is saved last, and only then the previous generation is deleted. A failed, empty or
//   interrupted update therefore keeps the previous catalogue. Without categories the whole list
//   is requested in one go (fallback). Incremental: an identical list keeps the stored files.
//   One update at a time; abortRefresh() stops it (playback starts).
// - load(pid, section): reads only the index and returns a VodView; item pages load on demand.
// - movieDetails / seriesDetails: get_vod_info / get_series_info on demand, cached per session.
// - resolve(pid, ref): play-time stream URL through PlaylistService (credentials never leave it).
// State per playlist (count, categories, time, hash) is kept in the KeyValueStore under
// 'vod.<playlistId>' (removed with the playlist). Nothing here logs titles, URLs or credentials.
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { CatalogueStore } from '../storage/catalogue-store.ts';
import type { PlaylistService } from './playlist-service.ts';
import type { XtreamClient, XtreamErrorCode, XtreamHandle, LiveStreamsSummary } from '../api/xtream/xtream-client.ts';
import type { XtreamCategory, XtreamSeriesInfo, XtreamVodInfo } from '../api/xtream/xtream-types.ts';
import { createVodPageWriter, createVodView, isVodIndex, VOD_UNCATEGORISED } from '../content/vod-pages.ts';
import type { VodIndexPayload, VodPageWriter, VodView } from '../content/vod-pages.ts';
import { looksAdult } from '../content/catalogue-codec.ts';
import type { Episode, MediaDetails, PlaybackSource, Season, StreamRef, VodItem } from '../models/content.ts';
import type { Logger } from '../utils/log.ts';

export type VodSection = 'movie' | 'series';

export type VodErrorCode = 'not-supported' | 'no-credentials' | 'busy' | 'network' | 'timeout' | 'http' | 'auth' |
  'invalid-response' | 'too-large' | 'redirect-blocked' | 'aborted' | 'storage' | 'empty' | 'corrupt' | 'invalid-url';

export interface SectionState {
  /** epoch ms of the last successful update. */
  at: number;
  items: number;
  categories: number;
  /** Content hash of the stored list (incremental updates). */
  hash: string;
}

export type VodLoad =
  | { status: 'ok'; view: VodView; ms: number }
  | { status: 'missing' }
  | { status: 'error'; code: VodErrorCode };

export interface VodRefreshResult {
  ok: boolean;
  code?: VodErrorCode;
  items: number;
  categories: number;
  invalid: number;
  unchanged: boolean;
  /** Category requests made (0 = single full-list request). */
  requests: number;
  /** Diagnostics: reading the previous index, removing old pages, longest page write (ms). */
  phases?: { readIndexMs: number; cleanupMs: number; maxPageWriteMs: number; maxPageEncodeMs: number };
  ms: number;
}

export interface VodJob {
  result: Promise<VodRefreshResult>;
  abort(): void;
}

export interface SeriesDetails {
  details: MediaDetails;
  seasons: Season[];
  invalid: number;
}

export interface VodServiceOptions {
  playlists: PlaylistService;
  catalogue: CatalogueStore;
  kv: KeyValueStore;
  now: () => number;
  log: Logger;
}

export interface VodService {
  /** Movies and series need an Xtream playlist (M3U VOD entries are not stored). */
  supported(pid: string): boolean;
  state(pid: string, section: VodSection): SectionState | null;
  load(pid: string, section: VodSection): Promise<VodLoad>;
  refresh(pid: string, section: VodSection, onProgress?: (items: number) => void): VodJob;
  refreshing(): string | null;
  /** Stops a running update (the previous catalogue stays). Called when playback starts. */
  abortRefresh(): void;
  movieDetails(pid: string, item: VodItem): Promise<MediaDetails | null>;
  seriesDetails(pid: string, item: VodItem): Promise<SeriesDetails | null>;
  /** Stream reference of a movie (container extension from the list or the details, else mp4). */
  movieRef(pid: string, item: VodItem): StreamRef;
  resolve(pid: string, ref: StreamRef): Promise<PlaybackSource | null>;
}

interface StoredState { movie?: SectionState; series?: SectionState }

function isSection(x: unknown): x is SectionState {
  const s = x as SectionState;
  return !!s && typeof s === 'object' && typeof s.at === 'number' && typeof s.items === 'number' &&
    typeof s.categories === 'number' && typeof s.hash === 'string';
}
function isStored(x: unknown): x is StoredState {
  const s = x as StoredState;
  return !!s && typeof s === 'object' && (s.movie === undefined || isSection(s.movie)) && (s.series === undefined || isSection(s.series));
}

function fromXtream(c: XtreamErrorCode): VodErrorCode {
  return c === 'invalid-url' || c === 'network' || c === 'timeout' || c === 'http' || c === 'auth' || c === 'invalid-response' ||
    c === 'too-large' || c === 'redirect-blocked' || c === 'aborted' ? c : 'network';
}

function details(i: XtreamVodInfo | XtreamSeriesInfo['info']): MediaDetails {
  return {
    name: i.name, plot: i.plot, genre: i.genre, director: i.director, cast: i.cast, year: i.year, rating: i.rating,
    durationSec: i.durationSec, poster: i.poster, backdrop: i.backdrop
  };
}

let genSeq = 0;

export function createVodService(o: VodServiceOptions): VodService {
  let busy: string | null = null;
  let running: VodJob | null = null;
  const views: Record<string, { pid: string; view: VodView; gen: string }> = {};
  const movieCache: Record<string, MediaDetails | null> = {};
  const seriesCache: Record<string, SeriesDetails | null> = {};
  const exts: Record<string, string> = {};

  function key(pid: string): string { return 'vod.' + pid; }
  function stored(pid: string): StoredState { return o.kv.get<StoredState>(key(pid), isStored, {}); }

  function client(pid: string): Promise<XtreamClient | null> {
    return o.playlists.xtreamClient(pid);
  }

  function readIndex(pid: string, section: VodSection): Promise<VodIndexPayload | null> {
    return o.catalogue.load(pid, section, isVodIndex).then(function (r) {
      if (r.status === 'ok' && r.data.s === section) {
        return r.data;
      }
      if (r.status === 'corrupt') {
        o.log.warn('vod: stored index unusable', { playlist: pid, section: section, reason: r.reason });
      }
      return null; // missing, unusable, or a Stage 6 single-file list (re-downloaded on open)
    }, function () { return null; });
  }

  function pagesPresent(pid: string, section: VodSection, idx: VodIndexPayload): Promise<boolean> {
    // Cheap check before reusing an unchanged generation: is its last item page there?
    if (idx.ip === 0) {
      return Promise.resolve(true);
    }
    return o.catalogue.loadPage(pid, section, idx.g, 'i', idx.ip - 1, function (x): x is unknown { return !!x; }).then(function (r) {
      return r.status === 'ok';
    }, function () { return false; });
  }

  const service: VodService = {
    supported: function (pid) {
      const def = o.playlists.get(pid);
      return !!def && def.kind === 'xtream';
    },

    state: function (pid, section) {
      const s = stored(pid)[section];
      return s || null;
    },

    refreshing: function () { return busy; },

    abortRefresh: function () {
      if (running) {
        running.abort();
      }
    },

    load: function (pid, section) {
      const t0 = o.now();
      const mem = views[section];
      if (mem && mem.pid === pid) {
        return Promise.resolve<VodLoad>({ status: 'ok', view: mem.view, ms: 0 });
      }
      return readIndex(pid, section).then(function (idx): VodLoad {
        if (!idx) {
          return { status: 'missing' };
        }
        const view = createVodView(o.catalogue, pid, idx, function (page) {
          o.log.warn('vod: page unavailable', { playlist: pid, section: section, page: page });
        });
        views[section] = { pid: pid, view: view, gen: idx.g };
        o.log.info('vod: index loaded', { playlist: pid, section: section, items: idx.t, categories: idx.c.length, pages: idx.ip, ms: o.now() - t0 });
        return { status: 'ok', view: view, ms: o.now() - t0 };
      });
    },

    refresh: function (pid, section, onProgress) {
      const t0 = o.now();
      let requests = 0;
      let invalid = 0;
      let readIndexMs = 0;
      let cleanupMs = 0;
      let writer: VodPageWriter | null = null;
      function done(r: Partial<VodRefreshResult> & { ok: boolean }): VodRefreshResult {
        return { ok: r.ok, code: r.code, items: r.items || 0, categories: r.categories || 0, invalid: invalid, unchanged: !!r.unchanged, requests: requests, ms: o.now() - t0,
          phases: { readIndexMs: readIndexMs, cleanupMs: cleanupMs, maxPageWriteMs: writer ? writer.maxWriteMs() : 0, maxPageEncodeMs: writer ? writer.maxEncodeMs() : 0 } };
      }
      if (busy) {
        return { result: Promise.resolve(done({ ok: false, code: 'busy' })), abort: function () { /* nothing */ } };
      }
      if (!service.supported(pid)) {
        return { result: Promise.resolve(done({ ok: false, code: 'not-supported' })), abort: function () { /* nothing */ } };
      }
      busy = pid + ':' + section;
      let aborted = false;
      let current: { abort(): void } | null = null;
      const gen = o.now().toString(36) + (genSeq++ % 36).toString(36);
      let prev: VodIndexPayload | null = null;
      let lastReport = 0;

      function list(c: XtreamClient, w: VodPageWriter, cat: number, categoryId: string | undefined): XtreamHandle<LiveStreamsSummary> {
        function progress(): void {
          const n = w.count();
          if (onProgress && n - lastReport >= 1000) {
            lastReport = n;
            onProgress(n);
          }
        }
        if (section === 'movie') {
          return c.vodStreams(function (s) {
            const ci = cat >= 0 ? cat : w.addCategory(s.categoryId || VOD_UNCATEGORISED, '', false);
            w.addItem(ci, { id: s.streamId, name: s.name, image: s.icon, year: s.year, rating: s.rating, ext: s.ext, genre: '', adult: s.adult });
            progress();
          }, categoryId);
        }
        return c.seriesList(function (s) {
          const ci = cat >= 0 ? cat : w.addCategory(s.categoryId || VOD_UNCATEGORISED, '', false);
          w.addItem(ci, { id: s.seriesId, name: s.name, image: s.cover, year: s.year, rating: s.rating, ext: '', genre: s.genre, adult: false });
          progress();
        }, categoryId);
      }

      function fetchAll(c: XtreamClient, w: VodPageWriter, cats: XtreamCategory[]): Promise<VodErrorCode | null> {
        if (cats.length === 0) {
          // Fallback: no categories listed; the whole list in one response.
          const h = list(c, w, -1, undefined);
          current = h;
          return h.result.then(function (r) {
            if (!r.ok) { return fromXtream(r.code); }
            invalid += r.data.invalid;
            return null;
          });
        }
        let chain: Promise<VodErrorCode | null> = Promise.resolve(null);
        for (let i = 0; i < cats.length; i++) {
          const ci = w.addCategory(cats[i].id, cats[i].name, looksAdult(cats[i].name));
          const id = cats[i].id;
          chain = chain.then(function (err): Promise<VodErrorCode | null> | VodErrorCode | null {
            if (err) { return err; }
            if (aborted) { return 'aborted'; }
            if (w.failed()) { return 'storage'; }
            requests++;
            const h = list(c, w, ci, id);
            current = h;
            return h.result.then(function (r) {
              if (!r.ok) { return fromXtream(r.code); }
              invalid += r.data.invalid;
              return null;
            });
          });
        }
        return chain;
      }

      const tIdx = o.now();
      const result = readIndex(pid, section).then(function (old) {
        prev = old;
        readIndexMs = o.now() - tIdx;
        const tc = o.now();
        // Pages of an earlier interrupted update (not the current generation) are removed first.
        return o.catalogue.removePages(pid, section, old ? old.g : null).then(function (n) { cleanupMs += o.now() - tc; return n; }, function () { return 0; });
      }).then(function () {
        return client(pid);
      }).then(function (c): Promise<VodRefreshResult> | VodRefreshResult {
        if (!c) {
          return done({ ok: false, code: 'no-credentials' });
        }
        const cats = section === 'movie' ? c.vodCategories() : c.seriesCategories();
        current = cats;
        return cats.result.then(function (cr): Promise<VodRefreshResult> | VodRefreshResult {
          if (!cr.ok) {
            return done({ ok: false, code: fromXtream(cr.code) });
          }
          if (aborted) {
            return done({ ok: false, code: 'aborted' });
          }
          const w = createVodPageWriter(o.catalogue, pid, section, gen, o.now);
          writer = w;
          return fetchAll(c, w, cr.data).then(function (err): Promise<VodRefreshResult> | VodRefreshResult {
            if (err) {
              return done({ ok: false, code: err });
            }
            if (w.count() === 0) {
              return done({ ok: false, code: 'empty' });
            }
            return w.finish().then(function (idx): Promise<VodRefreshResult> {
              const old = prev;
              const keepOld = old && old.h === idx.h ? pagesPresent(pid, section, old) : Promise.resolve(false);
              return keepOld.then(function (same): Promise<VodRefreshResult> {
                if (same && old) {
                  // Identical list: keep the stored generation, drop the new pages.
                  return o.catalogue.removePages(pid, section, old.g).then(function () {
                    return done({ ok: true, items: old.t, categories: old.c.length, unchanged: true });
                  });
                }
                return o.catalogue.save(pid, section, idx).then(function (saved): Promise<VodRefreshResult> | VodRefreshResult {
                  if (!saved.ok) {
                    return done({ ok: false, code: saved.reason === 'too-large' ? 'too-large' : 'storage' });
                  }
                  const st = stored(pid);
                  st[section] = { at: o.now(), items: idx.t, categories: idx.c.length, hash: idx.h };
                  o.kv.set(key(pid), st);
                  delete views[section];
                  // Committed: the previous generation is no longer referenced.
                  const tc = o.now();
                  return o.catalogue.removePages(pid, section, gen).then(function () {
                    cleanupMs += o.now() - tc;
                    return done({ ok: true, items: idx.t, categories: idx.c.length, unchanged: false });
                  });
                });
              });
            }, function (): VodRefreshResult {
              return done({ ok: false, code: 'storage' });
            });
          });
        });
      }).then(null, function (e): VodRefreshResult {
        o.log.error('vod: refresh crashed', { playlist: pid, section: section }, e);
        return done({ ok: false, code: 'storage' });
      }).then(function (r): Promise<VodRefreshResult> | VodRefreshResult {
        if (r.ok || !writer) {
          return r;
        }
        // Failed: remove this generation's pages; the previous catalogue stays untouched.
        const keep = prev ? (prev as VodIndexPayload).g : null;
        return o.catalogue.removePages(pid, section, keep).then(function () { return r; }, function () { return r; });
      }).then(function (r) {
        busy = null;
        running = null;
        o.log.info('vod: refresh', { playlist: pid, section: section, ok: r.ok, code: r.code, items: r.items, categories: r.categories, invalid: r.invalid, unchanged: r.unchanged, requests: r.requests, ms: r.ms, phases: r.phases });
        return r;
      });
      const job: VodJob = {
        result: result,
        abort: function () {
          aborted = true;
          if (current) { current.abort(); }
        }
      };
      running = job;
      return job;
    },

    movieDetails: function (pid, item) {
      const k = pid + ':' + item.id;
      if (Object.prototype.hasOwnProperty.call(movieCache, k)) {
        return Promise.resolve(movieCache[k]);
      }
      return client(pid).then(function (c): Promise<MediaDetails | null> | null {
        if (!c) {
          return null;
        }
        return c.vodInfo(item.id).result.then(function (r): MediaDetails | null {
          const d = r.ok ? details(r.data) : null;
          if (r.ok && r.data.ext) { exts[k] = r.data.ext; }
          if (r.ok || r.code === 'invalid-response') {
            movieCache[k] = d; // a definitive answer; network failures are retried next time
          }
          return d;
        });
      });
    },

    seriesDetails: function (pid, item) {
      const k = pid + ':' + item.id;
      if (Object.prototype.hasOwnProperty.call(seriesCache, k)) {
        return Promise.resolve(seriesCache[k]);
      }
      return client(pid).then(function (c): Promise<SeriesDetails | null> | null {
        if (!c) {
          return null;
        }
        return c.seriesInfo(item.id, item.name).result.then(function (r): SeriesDetails | null {
          if (!r.ok) {
            if (r.code === 'invalid-response') { seriesCache[k] = null; }
            return null;
          }
          const seasons: Season[] = [];
          for (let i = 0; i < r.data.seasons.length; i++) {
            const s = r.data.seasons[i];
            const eps: Episode[] = [];
            for (let j = 0; j < s.episodes.length; j++) {
              const e = s.episodes[j];
              eps.push({
                id: e.id, season: e.season, episode: e.episode, exact: e.exact, title: e.title, plot: e.plot, durationSec: e.durationSec, image: e.image,
                streamRef: { kind: 'xtream', type: 'series', id: e.id, ext: e.ext || 'mp4' }
              });
            }
            seasons.push({ number: s.number, name: s.name, cover: s.cover, episodes: eps });
          }
          const out: SeriesDetails = { details: details(r.data.info), seasons: seasons, invalid: r.data.invalid };
          seriesCache[k] = out;
          return out;
        });
      });
    },

    movieRef: function (pid, item) {
      const ext = item.ext || exts[pid + ':' + item.id] || 'mp4';
      return { kind: 'xtream', type: 'movie', id: item.id, ext: ext };
    },

    resolve: function (pid, ref) {
      return o.playlists.resolveStream(pid, ref);
    }
  };
  return service;
}
