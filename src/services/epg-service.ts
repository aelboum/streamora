// EpgService (ARCHITECTURE.md rev 3 §2 Services, §7 "EPG window"; Stage 5).
//
// - load(id): reads the cached EPG index of a playlist (catalogue section 'epg') into memory.
//   Only one playlist's EPG is in memory at a time.
// - refresh(id, channels): downloads every XMLTV source of the playlist (PlaylistService.
//   resolveEpgSources: user EPG URL, M3U header url-tvg, Xtream xmltv.php), parses it incrementally
//   in time slices, keeps only programmes of mapped channels inside the window
//   [now − pastHours, now + futureHours], and stores the compact index. The previous index stays
//   in use until the new one is saved.
// - nowNext / programmes: synchronous lookups from memory.
// - shortEpg: Xtream get_short_epg for one channel when the XMLTV index has nothing for it.
// Missing EPG is a normal state ('none'): screens show "No guide information".
// Credentialed EPG URLs are requested with credentialOrigin = their own origin (the provider that
// wrote them) and are never logged.
import type { HttpClient } from '../api/http-client.ts';
import { carriesCredentials } from '../api/http-client.ts';
import { originOf } from '../api/url.ts';
import type { CatalogueStore } from '../storage/catalogue-store.ts';
import type { PlaylistService } from './playlist-service.ts';
import type { Channel, Programme } from '../models/content.ts';
import type { Logger } from '../utils/log.ts';
import { createXmltvParser } from '../content/xmltv-parser.ts';
import { createByteTextDecoder, gzipByName, startsLikeGzip } from '../content/gzip.ts';
import type { GzipErrorCode } from '../content/gzip.ts';
import { createSlicer } from '../content/slicer.ts';
import type { SliceTimers } from '../content/slicer.ts';
import { createEpgBuilder, epgKeyFor, isEpgPayload, nowNext, programmesBetween } from '../content/epg-index.ts';
import type { EpgBuilder, EpgPayload, EpgRow, NowNext } from '../content/epg-index.ts';

export type EpgState = 'none' | 'loading' | 'ready';

export type EpgErrorCode = 'no-source' | 'not-xmltv' | 'network' | 'timeout' | 'http' | 'too-large' | 'redirect-blocked' |
  'aborted' | 'storage' | 'invalid-url' | 'bad-gzip' | 'gzip-unsupported';

export interface EpgStatus {
  state: EpgState;
  playlistId: string;
  builtAt: number;
  channels: number;
  programmes: number;
  refreshing: boolean;
  /** Last refresh error code, if any. */
  error?: EpgErrorCode;
  /** True for Xtream playlists: per-channel short EPG is available as a fallback. */
  shortEpg: boolean;
}

export interface EpgRefreshResult {
  ok: boolean;
  code?: EpgErrorCode;
  sources: number;
  channels: number;
  programmes: number;
  ms: number;
}

export interface EpgJob {
  result: Promise<EpgRefreshResult>;
  abort(): void;
}

export interface EpgServiceOptions {
  playlists: PlaylistService;
  catalogue: CatalogueStore;
  http: HttpClient;
  now: () => number;
  timers: SliceTimers;
  log: Logger;
  limits: {
    maxChars: number;
    idleTimeoutMs: number;
    totalTimeoutMs: number;
    pastHours: number;
    futureHours: number;
    maxPerChannel: number;
    maxTotal: number;
    /** An index older than this is stale (refresh suggested). */
    staleMs: number;
    /** Offset (minutes) for XMLTV times without an explicit offset. */
    defaultOffsetMin: number;
    /** Largest compressed (.gz) download in bytes. */
    maxGzipBytes: number;
  };
}

export interface EpgService {
  load(playlistId: string): Promise<EpgStatus>;
  status(): EpgStatus;
  isStale(): boolean;
  refresh(playlistId: string, channels: Channel[], onProgress?: (chars: number, programmes: number) => void): EpgJob;
  nowNext(channel: Channel): NowNext;
  programmes(channel: Channel, from: number, to: number, max: number): Programme[];
  /** Xtream short EPG for a channel without XMLTV data; cached per channel for 15 minutes. */
  shortEpg(channel: Channel): Promise<Programme[] | null>;
}

const SHORT_TTL = 15 * 60000;
/** Compressed-download cap when the caller sets none (config epg.maxGzipMB default). */
const DEFAULT_MAX_GZIP = 30000000;

type FetchResult = { ok: boolean; code?: EpgErrorCode };

export function createEpgService(o: EpgServiceOptions): EpgService {
  let index: EpgPayload | null = null;
  let status: EpgStatus = { state: 'none', playlistId: '', builtAt: 0, channels: 0, programmes: 0, refreshing: false, shortEpg: false };
  let shortCache: Record<string, { at: number; list: Programme[] | null }> = {};
  let running: EpgJob | null = null;

  function setIndex(playlistId: string, p: EpgPayload | null, isXtream: boolean): void {
    index = p;
    let c = 0;
    let n = 0;
    if (p) {
      for (const k in p.ch) {
        if (Object.prototype.hasOwnProperty.call(p.ch, k)) {
          c++;
          n += p.ch[k].length;
        }
      }
    }
    status = {
      state: p ? 'ready' : 'none', playlistId: playlistId, builtAt: p ? p.builtAt : 0,
      channels: c, programmes: n, refreshing: status.playlistId === playlistId ? status.refreshing : false, shortEpg: isXtream
    };
  }

  function rowsFor(channel: Channel): EpgRow[] | undefined {
    if (!index) {
      return undefined;
    }
    const k = epgKeyFor(index, channel);
    return k === null ? undefined : index.ch[k];
  }

  /**
   * Downloads and parses one XMLTV URL into the builder (Stage 5.1: plain or gzip).
   * Compression detection, most reliable first:
   *   1. a .gz/.gzip URL path → binary download from the start;
   *   2. a text download whose Content-Type says gzip, or whose first byte is 0x1f (the gzip magic;
   *      never the start of XML) → aborted at once and restarted as a binary download;
   *   3. in binary mode the decoder checks the magic bytes itself: data without them (a .gz URL
   *      served uncompressed, or decoded by the browser because of Content-Encoding) is read as
   *      plain UTF-8.
   * Binary pieces go through the streaming gzip decoder inside the time-sliced consumer, so
   * decompression and parsing share the 16 ms slices and the decompressed guide is never held
   * as a whole. Limits: compressed bytes ≤ maxGzipBytes, decompressed bytes ≤ maxChars.
   */
  function fetchOne(url: string, builder: EpgBuilder, onProgress: ((c: number, p: number) => void) | undefined,
    register: (abort: () => void) => void, binary: boolean): Promise<FetchResult> {
    let parsed = 0;
    let kept = 0;
    let lastReport = 0;
    let notXml = false;
    let restartBinary = false;
    let gzError: GzipErrorCode | null = null;
    let first = true;
    const decoder = binary ? createByteTextDecoder({ maxOutputBytes: o.limits.maxChars }) : null;
    const parser = createXmltvParser(function (c) {
      builder.addChannel(c.id, c.names);
    }, function (p) {
      if (builder.addProgramme(p.channel, p.start, p.stop, p.title || p.subTitle, p.desc)) {
        kept++;
      }
    }, { defaultOffsetMin: o.limits.defaultOffsetMin });
    function feed(text: string): boolean {
      if (!text) {
        return true;
      }
      parsed += text.length;
      if (!parser.push(text)) {
        notXml = true;
        h.abort();
        return false;
      }
      if (onProgress && parsed - lastReport > 524288) {
        lastReport = parsed;
        onProgress(parsed, kept);
      }
      return true;
    }
    const slicer = createSlicer(function (piece) {
      if (decoder) {
        const text = decoder.push(piece);
        if (decoder.error()) {
          gzError = decoder.error();
          h.abort();
          return false;
        }
        return feed(text);
      }
      if (first) {
        first = false;
        if (startsLikeGzip(piece)) {
          restartBinary = true;
          h.abort();
          return false;
        }
      }
      return feed(piece);
    }, o.timers, decoder ? { pieceChars: 2048 } : undefined);
    const h = o.http.stream({
      url: url, policy: { kind: 'userSource' }, credentialOrigin: carriesCredentials(url) ? originOf(url) : undefined,
      maxChars: binary ? (o.limits.maxGzipBytes > 0 ? o.limits.maxGzipBytes : DEFAULT_MAX_GZIP) : o.limits.maxChars, idleTimeoutMs: o.limits.idleTimeoutMs, totalTimeoutMs: o.limits.totalTimeoutMs,
      binary: binary,
      onHeaders: binary ? undefined : function (contentType) {
        if (/gzip/i.test(contentType)) {
          restartBinary = true;
          h.abort();
        }
      },
      onChunk: function (t) { slicer.push(t); }
    });
    register(function () { slicer.cancel(); h.abort(); });
    return h.result.then(function (r): FetchResult | Promise<FetchResult> {
      if (restartBinary) {
        slicer.cancel();
        return fetchOne(url, builder, onProgress, register, true);
      }
      if (gzError) {
        return { ok: false, code: gzError === 'too-large' ? 'too-large' : 'bad-gzip' };
      }
      if (notXml) {
        return { ok: false, code: 'not-xmltv' };
      }
      if (!r.ok) {
        slicer.cancel();
        const k = r.error.kind;
        if (binary && k === 'parse') {
          return { ok: false, code: 'gzip-unsupported' };
        }
        const code: EpgErrorCode = k === 'timeout' || k === 'http' || k === 'too-large' || k === 'redirect-blocked' || k === 'aborted' || k === 'invalid-url'
          ? k : 'network';
        return { ok: false, code: code };
      }
      return slicer.drained().then(function (): FetchResult | Promise<FetchResult> {
        if (restartBinary) {
          // The whole (small) body arrived before the first slice saw the gzip magic.
          return fetchOne(url, builder, onProgress, register, true);
        }
        if (gzError) {
          return { ok: false, code: gzError === 'too-large' ? 'too-large' : 'bad-gzip' };
        }
        if (notXml) {
          return { ok: false, code: 'not-xmltv' };
        }
        if (decoder) {
          const tail = decoder.end();
          const e = decoder.error();
          if (e) {
            return { ok: false, code: e === 'too-large' ? 'too-large' : 'bad-gzip' };
          }
          if (!feed(tail)) {
            return { ok: false, code: 'not-xmltv' };
          }
        }
        const sum = parser.end();
        return sum.verdict === 'xmltv' ? { ok: true } : { ok: false, code: 'not-xmltv' };
      });
    });
  }

  return {
    load: function (playlistId) {
      const def = o.playlists.get(playlistId);
      const isXtream = !!def && def.kind === 'xtream';
      shortCache = {};
      index = null;
      status = { state: 'loading', playlistId: playlistId, builtAt: 0, channels: 0, programmes: 0, refreshing: false, shortEpg: isXtream };
      return o.catalogue.load<EpgPayload>(playlistId, 'epg', isEpgPayload).then(function (r) {
        if (status.playlistId === playlistId) {
          setIndex(playlistId, r.status === 'ok' ? r.data : null, isXtream);
        }
        return status;
      }, function () {
        setIndex(playlistId, null, isXtream);
        return status;
      });
    },

    status: function () { return status; },

    isStale: function () {
      // Stale when missing, older than staleMs, or the stored window ends within 2 hours.
      return !index || o.now() - index.builtAt > o.limits.staleMs || o.now() + 2 * 3600000 > index.to;
    },

    refresh: function (playlistId, channels, onProgress) {
      if (running) {
        running.abort();
      }
      const t0 = o.now();
      let aborted = false;
      let current: (() => void) | null = null;
      if (status.playlistId === playlistId) {
        status.refreshing = true;
      }
      const builder = createEpgBuilder(channels, t0 - o.limits.pastHours * 3600000, t0 + o.limits.futureHours * 3600000,
        o.limits.maxPerChannel, o.limits.maxTotal);
      const def = o.playlists.get(playlistId);
      function done(r: Partial<EpgRefreshResult> & { ok: boolean }, sources: number): EpgRefreshResult {
        return { ok: r.ok, code: r.code, sources: sources, channels: r.channels || 0, programmes: r.programmes || 0, ms: o.now() - t0 };
      }
      const result = o.playlists.resolveEpgSources(playlistId).then(function (sources): Promise<EpgRefreshResult> | EpgRefreshResult {
        const urls: string[] = [];
        for (let i = 0; i < sources.length; i++) {
          const s = sources[i];
          if (s.kind === 'xmltv' && urls.indexOf(s.url) < 0) {
            urls.push(s.url);
          }
        }
        if (urls.length === 0) {
          return done({ ok: false, code: 'no-source' }, 0);
        }
        let chain: Promise<FetchResult[]> = Promise.resolve([]);
        for (let j = 0; j < urls.length; j++) {
          const u = urls[j];
          chain = chain.then(function (acc) {
            if (aborted) {
              return acc.concat([{ ok: false, code: 'aborted' }]);
            }
            return fetchOne(u, builder, onProgress, function (a) { current = a; }, gzipByName(u)).then(function (r) {
              builder.nextSource();
              return acc.concat([r]);
            });
          });
        }
        return chain.then(function (results): Promise<EpgRefreshResult> | EpgRefreshResult {
          if (aborted) {
            return done({ ok: false, code: 'aborted' }, urls.length);
          }
          let anyOk = false;
          let firstCode: EpgErrorCode | undefined;
          for (let k = 0; k < results.length; k++) {
            if (results[k].ok) { anyOk = true; } else if (!firstCode) { firstCode = results[k].code; }
          }
          if (!anyOk) {
            return done({ ok: false, code: firstCode || 'network' }, urls.length);
          }
          const built = builder.finish(o.now());
          return o.catalogue.save(playlistId, 'epg', built.payload).then(function (saved): EpgRefreshResult {
            if (!saved.ok) {
              return done({ ok: false, code: 'storage' }, urls.length);
            }
            if (status.playlistId === playlistId) {
              setIndex(playlistId, built.payload, !!def && def.kind === 'xtream');
              shortCache = {};
            }
            return done({ ok: true, channels: built.channels, programmes: built.programmes }, urls.length);
          });
        });
      }).then(function (r) {
        if (running === job) {
          running = null;
        }
        if (status.playlistId === playlistId) {
          status.refreshing = false;
          if (r.ok) { delete status.error; } else { status.error = r.code; }
        }
        o.log.info('epg refresh', { playlist: playlistId, ok: r.ok, code: r.code, sources: r.sources, channels: r.channels, programmes: r.programmes, ms: r.ms });
        return r;
      });
      const job: EpgJob = {
        result: result,
        abort: function () {
          aborted = true;
          if (current) {
            current();
          }
        }
      };
      running = job;
      return job;
    },

    nowNext: function (channel) {
      return nowNext(rowsFor(channel), o.now());
    },

    programmes: function (channel, from, to, max) {
      return programmesBetween(rowsFor(channel), from, to, max);
    },

    shortEpg: function (channel) {
      if (!status.shortEpg || !status.playlistId) {
        return Promise.resolve(null);
      }
      const k = 'k' + channel.id;
      const c = shortCache[k];
      if (c && o.now() - c.at < SHORT_TTL) {
        return Promise.resolve(c.list);
      }
      const pid = status.playlistId;
      return o.playlists.shortEpg(pid, channel, 4).then(function (list) {
        if (status.playlistId === pid) {
          shortCache[k] = { at: o.now(), list: list };
        }
        return list;
      });
    }
  };
}
