// VodService (Stage 6): movie and series catalogues of an Xtream playlist.
//
// - refresh(pid, section): get_vod_categories + get_vod_streams (movies) or get_series_categories +
//   get_series (series), streamed and parsed in time slices into the compact VOD payload, stored as
//   catalogue section 'movie' / 'series' (CatalogueStore: checksummed, ASCII-escaped for the TV).
//   Incremental: an unchanged list is not rewritten (unless its file is missing). One refresh at a
//   time. The Live TV import is independent and unchanged.
// - load(pid, section): reads the stored list; the last loaded list per section stays in memory.
// - movieDetails / seriesDetails: get_vod_info / get_series_info on demand (plot, genre, cast,
//   duration, seasons, episodes), cached in memory for the session.
// - resolve(pid, ref): play-time stream URL through PlaylistService (credentials never leave it).
// State per playlist (count, categories, time, checksum) is kept in the KeyValueStore under
// 'vod.<playlistId>' (removed with the playlist). Nothing here logs URLs or credentials.
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { CatalogueStore } from '../storage/catalogue-store.ts';
import type { PlaylistService } from './playlist-service.ts';
import type { XtreamClient, XtreamErrorCode } from '../api/xtream/xtream-client.ts';
import type { XtreamSeriesInfo, XtreamVodInfo } from '../api/xtream/xtream-types.ts';
import { createVodBuilder, decodeVod, isVodPayload } from '../content/vod-codec.ts';
import { looksAdult } from '../content/catalogue-codec.ts';
import type { Episode, MediaDetails, PlaybackSource, Season, StreamRef, VodCatalogue, VodItem } from '../models/content.ts';
import type { Logger } from '../utils/log.ts';

export type VodSection = 'movie' | 'series';

export type VodErrorCode = 'not-supported' | 'no-credentials' | 'busy' | 'network' | 'timeout' | 'http' | 'auth' |
  'invalid-response' | 'too-large' | 'redirect-blocked' | 'aborted' | 'storage' | 'empty' | 'corrupt' | 'invalid-url';

export interface SectionState {
  /** epoch ms of the last successful update. */
  at: number;
  items: number;
  categories: number;
  /** CatalogueStore checksum of the stored list (incremental updates). */
  hash: string;
}

export type VodLoad =
  | { status: 'ok'; catalogue: VodCatalogue; ms: number; skipped: number }
  | { status: 'missing' }
  | { status: 'error'; code: VodErrorCode };

export interface VodRefreshResult {
  ok: boolean;
  code?: VodErrorCode;
  items: number;
  categories: number;
  invalid: number;
  unchanged: boolean;
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

export function createVodService(o: VodServiceOptions): VodService {
  let busy: string | null = null;
  const loaded: Record<string, { pid: string; catalogue: VodCatalogue; skipped: number }> = {};
  const movieCache: Record<string, MediaDetails | null> = {};
  const seriesCache: Record<string, SeriesDetails | null> = {};
  const exts: Record<string, string> = {};

  function key(pid: string): string { return 'vod.' + pid; }
  function stored(pid: string): StoredState { return o.kv.get<StoredState>(key(pid), isStored, {}); }

  function client(pid: string): Promise<XtreamClient | null> {
    return o.playlists.xtreamClient(pid);
  }

  return {
    supported: function (pid) {
      const def = o.playlists.get(pid);
      return !!def && def.kind === 'xtream';
    },

    state: function (pid, section) {
      const s = stored(pid)[section];
      return s || null;
    },

    refreshing: function () { return busy; },

    load: function (pid, section) {
      const t0 = o.now();
      const mem = loaded[section];
      if (mem && mem.pid === pid) {
        return Promise.resolve<VodLoad>({ status: 'ok', catalogue: mem.catalogue, ms: 0, skipped: mem.skipped });
      }
      return o.catalogue.load(pid, section, isVodPayload).then(function (r): VodLoad {
        if (r.status === 'missing') {
          return { status: 'missing' };
        }
        if (r.status === 'error') {
          return { status: 'error', code: 'storage' };
        }
        if (r.status === 'corrupt') {
          o.log.warn('vod: stored list unusable', { playlist: pid, section: section, reason: r.reason });
          return { status: 'missing' }; // discarded by the store; an update downloads it again
        }
        const d = decodeVod(r.data);
        if (!d || r.data.s !== section) {
          return { status: 'error', code: 'corrupt' };
        }
        loaded[section] = { pid: pid, catalogue: d.catalogue, skipped: d.skipped };
        o.log.info('vod: list loaded', { playlist: pid, section: section, items: d.catalogue.items.length, skipped: d.skipped, ms: o.now() - t0 });
        return { status: 'ok', catalogue: d.catalogue, ms: o.now() - t0, skipped: d.skipped };
      }, function (): VodLoad {
        return { status: 'error', code: 'storage' };
      });
    },

    refresh: function (pid, section, onProgress) {
      const t0 = o.now();
      function done(r: Partial<VodRefreshResult> & { ok: boolean }): VodRefreshResult {
        return { ok: r.ok, code: r.code, items: r.items || 0, categories: r.categories || 0, invalid: r.invalid || 0, unchanged: !!r.unchanged, ms: o.now() - t0 };
      }
      if (busy) {
        return { result: Promise.resolve(done({ ok: false, code: 'busy' })), abort: function () { /* nothing */ } };
      }
      if (!this.supported(pid)) {
        return { result: Promise.resolve(done({ ok: false, code: 'not-supported' })), abort: function () { /* nothing */ } };
      }
      busy = pid + ':' + section;
      let aborted = false;
      let current: { abort(): void } | null = null;
      const builder = createVodBuilder(section);
      let lastReport = 0;
      const result = client(pid).then(function (c): Promise<VodRefreshResult> | VodRefreshResult {
        if (!c) {
          return done({ ok: false, code: 'no-credentials' });
        }
        const cats = section === 'movie' ? c.vodCategories() : c.seriesCategories();
        current = cats;
        return cats.result.then(function (cr): Promise<VodRefreshResult> | VodRefreshResult {
          if (!cr.ok) {
            return done({ ok: false, code: fromXtream(cr.code) });
          }
          for (let i = 0; i < cr.data.length; i++) {
            builder.addCategory(cr.data[i].id, cr.data[i].name, looksAdult(cr.data[i].name));
          }
          if (aborted) {
            return done({ ok: false, code: 'aborted' });
          }
          function progress(): void {
            const n = builder.count();
            if (onProgress && n - lastReport >= 1000) {
              lastReport = n;
              onProgress(n);
            }
          }
          const list = section === 'movie'
            ? c.vodStreams(function (s) {
              builder.addItem({ id: s.streamId, name: s.name, categoryId: s.categoryId, image: s.icon, year: s.year, rating: s.rating, added: s.added, ext: s.ext, genre: '', adult: s.adult });
              progress();
            })
            : c.seriesList(function (s) {
              builder.addItem({ id: s.seriesId, name: s.name, categoryId: s.categoryId, image: s.cover, year: s.year, rating: s.rating, added: s.updated, ext: '', genre: s.genre, adult: false });
              progress();
            });
          current = list;
          return list.result.then(function (lr): Promise<VodRefreshResult> | VodRefreshResult {
            if (!lr.ok) {
              return done({ ok: false, code: fromXtream(lr.code) });
            }
            const built = builder.finish();
            if (built.items === 0) {
              return done({ ok: false, code: 'empty', invalid: lr.data.invalid });
            }
            const prev = stored(pid)[section];
            return o.catalogue.save(pid, section, built.payload, prev ? { unlessChecksum: prev.hash } : undefined).then(function (saved): VodRefreshResult {
              if (!saved.ok) {
                return done({ ok: false, code: saved.reason === 'too-large' ? 'too-large' : 'storage' });
              }
              const st = stored(pid);
              st[section] = { at: o.now(), items: built.items, categories: built.categories, hash: saved.checksum };
              o.kv.set(key(pid), st);
              delete loaded[section]; // reload from the new file
              return done({ ok: true, items: built.items, categories: built.categories, invalid: lr.data.invalid, unchanged: saved.unchanged });
            });
          });
        });
      }).then(null, function (e): VodRefreshResult {
        o.log.error('vod: refresh crashed', { playlist: pid, section: section }, e);
        return done({ ok: false, code: 'storage' });
      }).then(function (r) {
        busy = null;
        o.log.info('vod: refresh', { playlist: pid, section: section, ok: r.ok, code: r.code, items: r.items, categories: r.categories, invalid: r.invalid, unchanged: r.unchanged, ms: r.ms });
        return r;
      });
      return {
        result: result,
        abort: function () {
          aborted = true;
          if (current) { current.abort(); }
        }
      };
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
                id: e.id, season: e.season, episode: e.episode, title: e.title, plot: e.plot, durationSec: e.durationSec, image: e.image,
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
}
