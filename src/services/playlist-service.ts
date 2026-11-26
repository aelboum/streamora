// PlaylistService (ARCHITECTURE.md rev 3 §2 Services): playlist definitions, credentials,
// import/refresh into the catalogue store, cached loading, switching, and play-time stream
// resolution. No DOM; runs under node --test.
//
// Storage (Stage 3 interfaces, rev 3 §7):
//   KV "playlists"        PlaylistDef[]  (no secrets)
//   KV "playlists.active" active playlist id
//   KV "import.journal"   {id, startedAt} while an import runs (interrupted-import detection)
//   SecretStore           ss_pl_<id>: Xtream username/password, or the full M3U URL
//   CatalogueStore        cat.<id>.live.json (compact payload), cat.<id>.meta.json (CatalogueMeta)
//
// Import protocol (crash-safe):
//   1. journal written; the old catalogue stays in place and usable;
//   2. download + parse completely (compact rows in memory); nothing is written before it succeeds;
//   3. live section saved (atomic replace; skipped when its checksum is unchanged);
//   4. meta saved with the live checksum (atomic replace);
//   5. definition status updated, journal cleared.
// A crash between 3 and 4 leaves a live file whose checksum differs from meta.liveHash; loadLive
// reports 'inconsistent' and the caller re-imports. recover() at start-up marks a journalled
// import as interrupted and removes temp files and orphaned catalogue files.
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { CatalogueStore } from '../storage/catalogue-store.ts';
import type { SecretStore, PlaylistSecret } from '../storage/secret-store.ts';
import type { HttpClient } from '../api/http-client.ts';
import type { RetryPolicy, RetryTimers } from '../api/retry.ts';
import { checkUrl } from '../api/url.ts';
import { buildXtreamStreamUrl, buildXtreamXmltvUrl, createXtreamClient, normalizeXtreamServer, validCredentials } from '../api/xtream/xtream-client.ts';
import type { XtreamClient } from '../api/xtream/xtream-client.ts';
import type { Logger } from '../utils/log.ts';
import type {
  CatalogueMeta, Channel, EpgSource, ImportCounts, ImportErrorCode, LiveCatalogue, LiveFormat, PlaybackSource, PlaylistDef, Programme, SourceStatus, StreamRef
} from '../models/content.ts';
import { isPlaylistId, isPlaylistList } from '../models/content.ts';
import { importM3u } from '../content/m3u-source.ts';
import { importXtream } from '../content/xtream-source.ts';
import type { ImportHandle, ImportProgress, ImportResult, SourceImport } from '../content/import-types.ts';
import { decodeLive, isLivePayload } from '../content/catalogue-codec.ts';
import { credentialsFromUrl, resolveTemplate } from '../content/credential-template.ts';
import type { PlaylistCredentials } from '../content/credential-template.ts';
import { cleanText } from '../content/text.ts';

export const MAX_PLAYLISTS = 20;
const KV_LIST = 'playlists';
const KV_ACTIVE = 'playlists.active';
const KV_JOURNAL = 'import.journal';

export interface PlaylistInput {
  name: string;
  kind: 'm3u' | 'xtream';
  /** m3u: full playlist URL (may contain credentials). */
  url?: string;
  /** xtream: server address, username, password. */
  server?: string;
  username?: string;
  password?: string;
  epgUrl?: string;
  liveFormat?: LiveFormat;
}

export interface PlaylistChanges {
  name?: string;
  epgUrl?: string | null;
  liveFormat?: LiveFormat;
  /** Replace the credentials (and, for M3U, the URL). */
  url?: string;
  server?: string;
  username?: string;
  password?: string;
}

export type InputError = 'invalid-name' | 'invalid-url' | 'invalid-credentials' | 'limit' | 'not-found' | 'storage';

export type SaveDefResult =
  | { ok: true; playlist: PlaylistDef }
  | { ok: false; code: InputError; message: string };

export type RefreshResult =
  /** ms = total; fetchMs = download + parse; storeMs = encode + checksum + file writes. */
  | { ok: true; counts: ImportCounts; categories: number; unchanged: boolean; overBudget: boolean; warnings: string[]; ms: number; fetchMs: number; storeMs: number }
  | { ok: false; code: ImportErrorCode; message: string };

export interface RefreshJob {
  result: Promise<RefreshResult>;
  abort(): void;
}

export type LiveLoad =
  /** cached: Stage 9, served from the in-memory live cache (no channel-file read). */
  | { status: 'ok'; catalogue: LiveCatalogue; meta: CatalogueMeta; ms: number; cached?: boolean }
  | { status: 'missing' }
  | { status: 'inconsistent' | 'corrupt'; reason: string }
  | { status: 'error'; message: string };

export interface RecoveryReport {
  interrupted: string | null;
  removedFiles: number;
}

export interface PlaylistServiceOptions {
  kv: KeyValueStore;
  catalogue: CatalogueStore;
  secrets: SecretStore;
  http: HttpClient;
  now: () => number;
  log: Logger;
  timers: RetryTimers;
  retry: RetryPolicy;
  limits: {
    requestTimeoutMs: number;
    maxResponseChars: number;
    maxPlaylistChars: number;
    idleTimeoutMs: number;
    totalTimeoutMs: number;
  };
  /**
   * Stage 9: in-memory cache of the active playlist's decoded live catalogue, so reopening Live TV
   * (or Search) does not re-read and re-decode the channel file. Absent = no cache (old behaviour).
   */
  liveCache?: LiveCacheOptions;
}

export interface LiveCacheOptions {
  /** Largest channel file (characters) whose decoded form may be kept. */
  maxChars: number;
  /** Free device memory (MB) below which the cache is released; 0 = no memory check. */
  minFreeMB: number;
  /** Free device memory in MB, −1 when unknown (unknown never releases on its own). */
  memoryMB: () => number;
  /** How often the memory is checked while something is cached (ms). */
  checkMs: number;
}

/** Stage 9: what the live cache holds and why it last let go (diagnostics and tests). */
export interface LiveCacheInfo {
  playlistId: string | null;
  chars: number;
  hits: number;
  misses: number;
  lastRelease: string;
}

export interface PlaylistService {
  list(): PlaylistDef[];
  get(id: string): PlaylistDef | null;
  add(input: PlaylistInput): Promise<SaveDefResult>;
  update(id: string, changes: PlaylistChanges): Promise<SaveDefResult>;
  /** Removes the definition, its credentials and its catalogue files. */
  remove(id: string): Promise<void>;
  activeId(): string | null;
  /** Switches the active playlist. False for an unknown id. */
  setActive(id: string): boolean;
  /** Downloads and stores the catalogue. One import at a time ('busy' otherwise). */
  refresh(id: string, onProgress?: (p: ImportProgress) => void): RefreshJob;
  importing(): string | null;
  loadLive(id: string): Promise<LiveLoad>;
  /** Stage 9: live cache state (diagnostics). */
  liveCacheInfo(): LiveCacheInfo;
  /** Stage 9: releases the cached live catalogue (also done automatically; see LiveCacheOptions). */
  releaseLiveCache(reason: string): void;
  /** True for an http:// playlist whose cleartext notice has not been shown yet. */
  needsCleartextNotice(id: string): boolean;
  markCleartextNoticeSeen(id: string): void;
  /** Play-time stream URL. Contains credentials: hand it to the player only; never store or log it. */
  resolvePlayback(id: string, channel: Channel): Promise<PlaybackSource | null>;
  /** EPG references with credentials substituted (for the Stage 5 EPG engine). Never log the result. */
  resolveEpgSources(id: string): Promise<EpgSource[]>;
  recover(): Promise<RecoveryReport>;
  /** Stored catalogue metadata (small file; no channel list). */
  meta(id: string): Promise<CatalogueMeta | null>;
  /** Aborts a running import and deletes every playlist, its credentials and its files (unauthenticated PIN reset). */
  removeAll(): Promise<void>;
  /** Xtream short EPG for one channel (Xtream references only; credentials stay inside the service). */
  shortEpg(id: string, channel: Channel, limit: number): Promise<Programme[] | null>;
  /**
   * Stage 6: an Xtream API client for an Xtream playlist (null otherwise or without credentials),
   * for the movie/series service. The client holds the credentials internally; callers never see them.
   */
  xtreamClient(id: string): Promise<XtreamClient | null>;
  /** Play-time URL for any stream reference (movies, episodes). Same rules as resolvePlayback. */
  resolveStream(id: string, ref: StreamRef): Promise<PlaybackSource | null>;
}

export function isCatalogueMeta(x: unknown): x is CatalogueMeta {
  const m = x as CatalogueMeta;
  return !!m && typeof m === 'object' && m.v === 1 && typeof m.importId === 'string' && typeof m.importedAt === 'number' &&
    (m.kind === 'm3u' || m.kind === 'xtream') && !!m.counts && typeof m.counts.live === 'number' &&
    typeof m.liveHash === 'string' && Object.prototype.toString.call(m.epg) === '[object Array]' &&
    Object.prototype.toString.call(m.warnings) === '[object Array]';
}

interface Journal { id: string; startedAt: number }

function isJournalOrNull(x: unknown): x is Journal | null {
  const j = x as Journal;
  return x === null || (!!j && typeof j === 'object' && isPlaylistId(j.id) && typeof j.startedAt === 'number');
}

function isActive(x: unknown): x is string | null {
  return x === null || isPlaylistId(x);
}

function streamType(ext: string): PlaybackSource['type'] {
  const e = ext.toLowerCase();
  return e === 'ts' ? 'ts' : e === 'm3u8' ? 'hls' : e === 'mp4' ? 'mp4' : e === 'mkv' ? 'mkv' : 'other';
}

function extOf(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(path);
  return m ? m[1] : '';
}

function trim(s: unknown): string {
  return typeof s === 'string' ? s.replace(/^\s+|\s+$/g, '') : '';
}

export function createPlaylistService(o: PlaylistServiceOptions): PlaylistService {
  const log = o.log;
  let busy: string | null = null;
  let job: RefreshJob | null = null;
  // Imports parse in ≤ 16 ms slices between events (rev 3 §6.2), so the UI stays responsive.
  const slice = { setTimer: o.timers.setTimer, clearTimer: o.timers.clearTimer, now: o.now };
  let seq = 0;

  // ---------------------------------------------------------------- Stage 9: live cache
  // One playlist's decoded live catalogue, kept after the screen that loaded it is gone. It is
  // only ever returned after the small meta file confirms that the stored channel file still has
  // the checksum the cached copy was decoded from, so a refresh, a recovery or an interrupted
  // import can never serve stale channels. Released on account switch/removal, after a refresh
  // that changed the list, and when free memory falls below the floor (checked periodically).
  interface LiveCacheEntry { id: string; hash: string; chars: number; catalogue: LiveCatalogue }
  const lc = o.liveCache || null;
  let cached: LiveCacheEntry | null = null;
  let cacheTimer: unknown = null;
  let cacheGen = 0; // bumps on every release: a load that started before it does not refill the cache
  const cacheStats: LiveCacheInfo = { playlistId: null, chars: 0, hits: 0, misses: 0, lastRelease: '' };
  const inflight: Record<string, Promise<LiveLoad>> = {};

  function memoryLow(): boolean {
    if (!lc || lc.minFreeMB <= 0) { return false; }
    const mb = lc.memoryMB();
    return mb >= 0 && mb < lc.minFreeMB;
  }

  function stopCacheTimer(): void {
    if (cacheTimer !== null) { o.timers.clearTimer(cacheTimer); cacheTimer = null; }
  }

  function releaseCache(reason: string): void {
    cacheGen++;
    stopCacheTimer();
    if (cached) {
      log.info('live cache released', { id: cached.id, reason: reason, chars: cached.chars });
      cacheStats.lastRelease = reason;
    }
    cached = null;
    cacheStats.playlistId = null;
    cacheStats.chars = 0;
  }

  function watchMemory(): void {
    stopCacheTimer();
    if (!lc || lc.minFreeMB <= 0 || !cached) { return; }
    cacheTimer = o.timers.setTimer(function () {
      cacheTimer = null;
      if (!cached) { return; }
      if (memoryLow()) { releaseCache('low-memory'); return; }
      watchMemory();
    }, lc.checkMs);
  }

  function keepInCache(id: string, hash: string, chars: number, catalogue: LiveCatalogue): void {
    if (!lc) { return; }
    if (chars > lc.maxChars) { log.info('live cache skipped', { id: id, reason: 'too-large', chars: chars }); return; }
    if (memoryLow()) { log.info('live cache skipped', { id: id, reason: 'low-memory', chars: chars }); return; }
    if (cached && cached.id !== id) { releaseCache('other-playlist'); }
    cached = { id: id, hash: hash, chars: chars, catalogue: catalogue };
    cacheStats.playlistId = id;
    cacheStats.chars = chars;
    watchMemory();
  }

  function loadLiveFromFiles(id: string): Promise<LiveLoad> {
    const t0 = o.now();
    const gen0 = cacheGen;
    return o.catalogue.load<CatalogueMeta>(id, 'meta', isCatalogueMeta).then(function (m): LiveLoad | Promise<LiveLoad> {
      if (m.status === 'error') {
        return { status: 'error', message: m.message };
      }
      // Stage 9: a cached copy whose checksum the stored metadata still names is the same data.
      if (cached && cached.id === id && m.status === 'ok' && m.data.liveHash === cached.hash) {
        if (memoryLow()) {
          releaseCache('low-memory');
        } else {
          cacheStats.hits++;
          return { status: 'ok', catalogue: cached.catalogue, meta: m.data, ms: o.now() - t0, cached: true };
        }
      } else if (cached && cached.id === id) {
        releaseCache(m.status === 'ok' ? 'changed' : 'metadata-missing');
      }
      if (lc) { cacheStats.misses++; }
      return o.catalogue.load(id, 'live', isLivePayload).then(function (l): LiveLoad {
        if (l.status === 'missing' && m.status === 'missing') {
          return { status: 'missing' };
        }
        if (l.status === 'error') {
          return { status: 'error', message: l.message };
        }
        if (l.status === 'corrupt') {
          return { status: 'corrupt', reason: l.reason };
        }
        if (m.status !== 'ok' || l.status !== 'ok') {
          return { status: 'inconsistent', reason: m.status !== 'ok' ? 'catalogue metadata missing' : 'channel list missing' };
        }
        if (l.checksum !== m.data.liveHash) {
          return { status: 'inconsistent', reason: 'channel list belongs to an interrupted import' };
        }
        const cat = decodeLive(l.data);
        if (!cat) {
          return { status: 'corrupt', reason: 'malformed channel rows' };
        }
        // Only the active playlist is kept, and only when nothing was invalidated meanwhile.
        if (gen0 === cacheGen && readActive() === id) { keepInCache(id, l.checksum, l.chars, cat); }
        return { status: 'ok', catalogue: cat, meta: m.data, ms: o.now() - t0 };
      });
    });
  }

  function readActive(): string | null {
    return o.kv.get<string | null>(KV_ACTIVE, isActive, null);
  }

  function readList(): PlaylistDef[] {
    return o.kv.get<PlaylistDef[]>(KV_LIST, isPlaylistList, []);
  }

  function find(list: PlaylistDef[], id: string): number {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return i;
      }
    }
    return -1;
  }

  function getDef(id: string): PlaylistDef | null {
    const list = readList();
    const i = find(list, id);
    return i >= 0 ? list[i] : null;
  }

  function patch(id: string, fn: (d: PlaylistDef) => void): void {
    const list = readList();
    const i = find(list, id);
    if (i >= 0) {
      fn(list[i]);
      o.kv.set(KV_LIST, list);
    }
  }

  function storageError(): SaveDefResult {
    return { ok: false, code: 'storage', message: 'the playlist could not be saved' };
  }

  /** Validates the source fields; returns the origin and the secret, or an input error. */
  function validateSource(kind: 'm3u' | 'xtream', i: { url?: string; server?: string; username?: string; password?: string }):
    { ok: true; server: string; secret: PlaylistSecret } | { ok: false; code: InputError; message: string } {
    if (kind === 'm3u') {
      const c = checkUrl(trim(i.url), { kind: 'userSource' });
      if (!c.ok) {
        return { ok: false, code: 'invalid-url', message: 'playlist address: ' + c.reason };
      }
      return { ok: true, server: c.origin, secret: { kind: 'm3u', url: c.href } };
    }
    const s = normalizeXtreamServer(i.server || '');
    if (!s.ok) {
      return { ok: false, code: 'invalid-url', message: 'server address: ' + s.reason };
    }
    const cred = { username: i.username || '', password: i.password || '' };
    if (!validCredentials(cred)) {
      return { ok: false, code: 'invalid-credentials', message: 'username and password are required' };
    }
    return { ok: true, server: s.origin, secret: { kind: 'xtream', username: cred.username, password: cred.password } };
  }

  /** null = none given; false = invalid. */
  function validEpg(u: string | undefined | null): string | null | false {
    const t = trim(u);
    if (!t) {
      return null;
    }
    const c = checkUrl(t, { kind: 'userSource' });
    return c.ok ? c.href : false;
  }

  function newId(): string {
    seq = (seq + 1) % 1296;
    return ('p' + o.now().toString(36) + (seq < 36 ? '0' : '') + seq.toString(36)).substring(0, 32);
  }

  function credentialsFor(def: PlaylistDef, secret: PlaylistSecret): PlaylistCredentials | null {
    if (secret.kind === 'xtream') {
      return { username: secret.username, password: secret.password };
    }
    return def.kind === 'm3u' ? credentialsFromUrl(secret.url) : null;
  }

  function loadMeta(id: string): Promise<CatalogueMeta | null> {
    return o.catalogue.load<CatalogueMeta>(id, 'meta', isCatalogueMeta).then(function (r) {
      return r.status === 'ok' ? r.data : null;
    });
  }

  function startImport(def: PlaylistDef, secret: PlaylistSecret, onProgress?: (p: ImportProgress) => void): ImportHandle {
    if (secret.kind === 'xtream') {
      return importXtream({
        client: createXtreamClient({
          http: o.http, server: def.server, credentials: { username: secret.username, password: secret.password },
          limits: {
            requestTimeoutMs: o.limits.requestTimeoutMs, maxResponseChars: o.limits.maxResponseChars,
            maxListChars: o.limits.maxPlaylistChars, idleTimeoutMs: o.limits.idleTimeoutMs, totalTimeoutMs: o.limits.totalTimeoutMs
          },
          retry: o.retry, timers: o.timers, slice: slice
        }),
        liveFormat: def.liveFormat, now: o.now, onProgress: onProgress
      });
    }
    return importM3u({
      http: o.http, url: secret.url, name: def.name, maxChars: o.limits.maxPlaylistChars,
      idleTimeoutMs: o.limits.idleTimeoutMs, totalTimeoutMs: o.limits.totalTimeoutMs, onProgress: onProgress, timers: slice
    });
  }

  /** Steps 3 and 4 of the import protocol. */
  function store(id: string, def: PlaylistDef, data: SourceImport, t0: number, onProgress?: (p: ImportProgress) => void): Promise<RefreshResult> {
    const tFetched = o.now();
    if (onProgress) {
      onProgress({ chars: 0, channels: data.counts.live, phase: 'store' });
    }
    // Yield once so the UI can show the saving state before the (synchronous) encoding starts.
    const pause = new Promise<void>(function (resolve) { o.timers.setTimer(resolve, 30); });
    return pause.then(function () { return loadMeta(id); }).then(function (prev) {
      return o.catalogue.save(id, 'live', data.payload, prev ? { unlessChecksum: prev.liveHash } : undefined);
    }).then(function (saved): RefreshResult | Promise<RefreshResult> {
      if (!saved.ok) {
        return { ok: false, code: saved.reason === 'too-large' ? 'too-large' : 'storage', message: saved.message };
      }
      const at = o.now();
      const meta: CatalogueMeta = {
        v: 1, importId: at.toString(36), importedAt: at, kind: def.kind, counts: data.counts,
        categories: data.categories, epg: data.epg, liveHash: saved.checksum, warnings: data.warnings.slice(0, 20)
      };
      return o.catalogue.save(id, 'meta', meta).then(function (m): RefreshResult {
        if (!m.ok) {
          return { ok: false, code: 'storage', message: m.message };
        }
        return {
          ok: true, counts: data.counts, categories: data.categories, unchanged: saved.unchanged,
          overBudget: saved.overBudget, warnings: data.warnings, ms: o.now() - t0,
          fetchMs: tFetched - t0, storeMs: o.now() - tFetched
        };
      });
    });
  }

  return {
    list: readList,
    get: getDef,

    add: function (input) {
      const name = cleanText(input ? input.name : '', 64);
      if (!name) {
        return Promise.resolve<SaveDefResult>({ ok: false, code: 'invalid-name', message: 'a name is required' });
      }
      const list = readList();
      if (list.length >= MAX_PLAYLISTS) {
        return Promise.resolve<SaveDefResult>({ ok: false, code: 'limit', message: 'at most ' + MAX_PLAYLISTS + ' playlists' });
      }
      if (input.kind !== 'm3u' && input.kind !== 'xtream') {
        return Promise.resolve<SaveDefResult>({ ok: false, code: 'invalid-url', message: 'unknown playlist type' });
      }
      const src = validateSource(input.kind, input);
      if (!src.ok) {
        return Promise.resolve<SaveDefResult>(src);
      }
      const epg = validEpg(input.epgUrl);
      if (epg === false) {
        return Promise.resolve<SaveDefResult>({ ok: false, code: 'invalid-url', message: 'EPG address is not a valid http(s) URL' });
      }
      let id = newId();
      while (find(list, id) >= 0) {
        id = newId();
      }
      const def: PlaylistDef = {
        id: id, name: name, kind: input.kind, server: src.server,
        liveFormat: input.liveFormat === 'm3u8' ? 'm3u8' : 'ts', addedAt: o.now()
      };
      if (epg) {
        def.epgUrl = epg;
      }
      // Secret first: a definition without its credentials would be unusable.
      return o.secrets.put(id, src.secret).then(function (): SaveDefResult | Promise<SaveDefResult> {
        list.push(def);
        if (!o.kv.set(KV_LIST, list)) {
          return o.secrets.remove(id).then(storageError, storageError);
        }
        if (!o.kv.get<string | null>(KV_ACTIVE, isActive, null)) {
          o.kv.set(KV_ACTIVE, id);
        }
        log.info('playlist added', { id: id, kind: def.kind, cleartext: def.server.indexOf('http:') === 0 });
        return { ok: true, playlist: def };
      }, function (): SaveDefResult {
        return { ok: false, code: 'storage', message: 'credentials could not be stored securely' };
      });
    },

    update: function (id, ch) {
      const list = readList();
      const i = find(list, id);
      if (i < 0) {
        return Promise.resolve<SaveDefResult>({ ok: false, code: 'not-found', message: 'unknown playlist' });
      }
      const def = list[i];
      if (ch.name !== undefined) {
        const n = cleanText(ch.name, 64);
        if (!n) {
          return Promise.resolve<SaveDefResult>({ ok: false, code: 'invalid-name', message: 'a name is required' });
        }
        def.name = n;
      }
      if (ch.epgUrl !== undefined) {
        const e = validEpg(ch.epgUrl);
        if (e === false) {
          return Promise.resolve<SaveDefResult>({ ok: false, code: 'invalid-url', message: 'EPG address is not a valid http(s) URL' });
        }
        if (e) { def.epgUrl = e; } else { delete def.epgUrl; }
      }
      if (ch.liveFormat !== undefined) {
        def.liveFormat = ch.liveFormat === 'm3u8' ? 'm3u8' : 'ts';
      }
      const sourceChanged = ch.url !== undefined || ch.server !== undefined || ch.username !== undefined || ch.password !== undefined;
      if (!sourceChanged) {
        return Promise.resolve<SaveDefResult>(o.kv.set(KV_LIST, list) ? { ok: true, playlist: def } : storageError());
      }
      return o.secrets.get(id).then(function (old): SaveDefResult | Promise<SaveDefResult> {
        const src = validateSource(def.kind, {
          url: ch.url !== undefined ? ch.url : (old && old.kind === 'm3u' ? old.url : undefined),
          server: ch.server !== undefined ? ch.server : def.server,
          username: ch.username !== undefined ? ch.username : (old && old.kind === 'xtream' ? old.username : undefined),
          password: ch.password !== undefined ? ch.password : (old && old.kind === 'xtream' ? old.password : undefined)
        });
        if (!src.ok) {
          return src;
        }
        return o.secrets.put(id, src.secret).then(function (): SaveDefResult {
          if (src.server !== def.server) {
            delete def.cleartextNoticeSeen;
          }
          def.server = src.server;
          if (!o.kv.set(KV_LIST, list)) {
            return storageError();
          }
          log.info('playlist source updated', { id: id });
          return { ok: true, playlist: def };
        });
      }).then(null, function (): SaveDefResult {
        return { ok: false, code: 'storage', message: 'credentials could not be stored securely' };
      });
    },

    remove: function (id) {
      if (cached && cached.id === id) { releaseCache('removed'); }
      const list = readList();
      const i = find(list, id);
      if (i >= 0) {
        list.splice(i, 1);
        o.kv.set(KV_LIST, list);
      }
      if (o.kv.get<string | null>(KV_ACTIVE, isActive, null) === id) {
        if (list.length) { o.kv.set(KV_ACTIVE, list[0].id); } else { o.kv.remove(KV_ACTIVE); }
      }
      if (!isPlaylistId(id)) {
        return Promise.resolve();
      }
      // Favourites and recently watched (keys of services/user-lists.ts) belong to the playlist.
      o.kv.remove('fav.' + id);
      o.kv.remove('recent.' + id);
      o.kv.remove('vod.' + id); // movie/series catalogue state (services/vod-service.ts)
      o.kv.remove('mylist.movie.' + id); // Stage 11: My List of this account (services/my-list.ts)
      o.kv.remove('mylist.series.' + id);
      o.kv.remove('catprefs.live.' + id); // Stage 14: category order / hidden (content/category-prefs.ts)
      o.kv.remove('catprefs.movie.' + id);
      o.kv.remove('catprefs.series.' + id);
      return o.secrets.remove(id).then(null, function () { /* already gone */ }).then(function () {
        return o.catalogue.removePlaylist(id);
      }).then(function () {
        log.info('playlist removed', { id: id });
      });
    },

    activeId: function () {
      const a = o.kv.get<string | null>(KV_ACTIVE, isActive, null);
      return a && find(readList(), a) >= 0 ? a : null;
    },

    setActive: function (id) {
      const ok = find(readList(), id) >= 0 && o.kv.set(KV_ACTIVE, id);
      // Stage 9: another account's channels never survive a switch.
      if (ok && cached && cached.id !== id) { releaseCache('account-switch'); }
      return ok;
    },

    importing: function () { return busy; },

    refresh: function (id, onProgress) {
      if (busy) {
        return { result: Promise.resolve<RefreshResult>({ ok: false, code: 'busy', message: 'another import is running' }), abort: function () { /* nothing */ } };
      }
      const def = getDef(id);
      if (!def) {
        return { result: Promise.resolve<RefreshResult>({ ok: false, code: 'invalid-url', message: 'unknown playlist' }), abort: function () { /* nothing */ } };
      }
      busy = id;
      const t0 = o.now();
      o.kv.set(KV_JOURNAL, { id: id, startedAt: t0 });
      let handle: ImportHandle | null = null;
      let aborted = false;
      let account: SourceImport['account'];

      const result = o.secrets.get(id).then(function (secret): ImportResult | Promise<ImportResult> {
        if (!secret || (def.kind === 'xtream') !== (secret.kind === 'xtream')) {
          return { ok: false, code: 'no-credentials', message: 'credentials are missing; edit the playlist' };
        }
        if (aborted) {
          return { ok: false, code: 'aborted', message: 'aborted' };
        }
        handle = startImport(def, secret, onProgress);
        return handle.result;
      }, function (): ImportResult {
        return { ok: false, code: 'no-credentials', message: 'credentials could not be read' };
      }).then(function (r): RefreshResult | Promise<RefreshResult> {
        if (!r.ok) {
          return r;
        }
        account = r.data.account;
        return store(id, def, r.data, t0, onProgress);
      }).then(null, function (e): RefreshResult {
        log.error('import crashed', { id: id }, e);
        return { ok: false, code: 'storage', message: 'unexpected error' };
      }).then(function (res: RefreshResult): RefreshResult {
        busy = null;
        o.kv.remove(KV_JOURNAL);
        const status: SourceStatus = res.ok ? { ok: true, at: o.now() } : { ok: false, at: o.now(), code: res.code, message: res.message };
        if (account) {
          if (account.expiresAt !== null) { status.expiresAt = account.expiresAt; }
          if (account.maxConnections !== null) { status.maxConnections = account.maxConnections; }
          if (account.trial) { status.trial = true; }
        }
        patch(id, function (d) {
          d.lastStatus = status;
          if (res.ok) { d.lastLoadedAt = status.at; }
        });
        // Stage 9: a refresh that rewrote the list frees the old copy at once (the checksum check
        // would reject it anyway). An unchanged or failed refresh keeps it: the files still match.
        if (res.ok && !res.unchanged && cached && cached.id === id) { releaseCache('refreshed'); }
        if (res.ok) {
          log.info('import done', { id: id, live: res.counts.live, categories: res.categories, unchanged: res.unchanged, ms: res.ms, fetchMs: res.fetchMs, storeMs: res.storeMs });
        } else {
          log.warn('import failed', { id: id, code: res.code });
        }
        return res;
      });

      const j: RefreshJob = {
        result: result,
        abort: function () {
          aborted = true;
          if (handle) {
            handle.abort();
          }
        }
      };
      job = j;
      result.then(function () { if (job === j) { job = null; } });
      return j;
    },

    loadLive: function (id) {
      if (!isPlaylistId(id)) {
        return Promise.resolve<LiveLoad>({ status: 'error', message: 'invalid playlist id' });
      }
      // Stage 9: concurrent loads of the same playlist (Live TV and Search) share one file read.
      const k = 'k' + id;
      if (Object.prototype.hasOwnProperty.call(inflight, k)) { return inflight[k]; }
      const p = loadLiveFromFiles(id);
      inflight[k] = p;
      function done(): void { delete inflight[k]; }
      p.then(done, done);
      return p;
    },

    liveCacheInfo: function () {
      return { playlistId: cacheStats.playlistId, chars: cacheStats.chars, hits: cacheStats.hits, misses: cacheStats.misses, lastRelease: cacheStats.lastRelease };
    },

    releaseLiveCache: function (reason) { releaseCache(reason); },

    needsCleartextNotice: function (id) {
      const d = getDef(id);
      return !!d && d.server.indexOf('http:') === 0 && !d.cleartextNoticeSeen;
    },

    markCleartextNoticeSeen: function (id) {
      patch(id, function (d) { d.cleartextNoticeSeen = true; });
    },

    resolvePlayback: function (id, channel) {
      const def = getDef(id);
      if (!def) {
        return Promise.resolve(null);
      }
      return o.secrets.get(id).then(function (secret): PlaybackSource | null {
        if (!secret) {
          return null;
        }
        const ref = channel.streamRef;
        const cred = credentialsFor(def, secret);
        let url: string | null = null;
        let ext = '';
        if (ref.kind === 'xtream') {
          if (!cred) {
            return null;
          }
          ext = ref.ext || (ref.type === 'live' ? def.liveFormat : 'mp4');
          try {
            url = buildXtreamStreamUrl(def.server, cred, ref.type, ref.id, ext);
          } catch (e) {
            return null;
          }
        } else if (ref.cred) {
          url = cred ? resolveTemplate(ref.url, cred) : null;
          ext = url ? extOf(url) : '';
        } else {
          const c = checkUrl(ref.url, { kind: 'userSource' });
          url = c.ok ? c.href : null;
          ext = url ? extOf(url) : '';
        }
        if (!url) {
          return null;
        }
        const src: PlaybackSource = { url: url, type: streamType(ext), live: ref.kind === 'url' || ref.type === 'live' };
        if (channel.userAgent) { src.userAgent = channel.userAgent; }
        if (channel.referrer) { src.referrer = channel.referrer; }
        return src;
      }, function () { return null; });
    },

    resolveEpgSources: function (id) {
      const def = getDef(id);
      if (!def) {
        return Promise.resolve<EpgSource[]>([]);
      }
      if (def.epgUrl) {
        return Promise.resolve<EpgSource[]>([{ kind: 'xmltv', url: def.epgUrl }]);
      }
      return Promise.all([loadMeta(id), o.secrets.get(id).then(null, function () { return null; })]).then(function (r) {
        const meta = r[0];
        const secret = r[1];
        const out: EpgSource[] = [];
        if (!meta) {
          return out;
        }
        const cred = secret ? credentialsFor(def, secret) : null;
        for (let i = 0; i < meta.epg.length; i++) {
          const e = meta.epg[i];
          if (e.kind === 'xtream') {
            // Short EPG via the API, and the panel's XMLTV export for the full guide.
            out.push(e);
            if (cred) { out.push({ kind: 'xmltv', url: buildXtreamXmltvUrl(def.server, cred) }); }
          } else if (!e.cred) {
            out.push({ kind: 'xmltv', url: e.url });
          } else if (cred) {
            const u = resolveTemplate(e.url, cred);
            if (u) { out.push({ kind: 'xmltv', url: u }); }
          }
        }
        return out;
      });
    },

    shortEpg: function (id, channel, limit) {
      const def = getDef(id);
      const ref = channel.streamRef;
      if (!def || ref.kind !== 'xtream') {
        return Promise.resolve(null);
      }
      return o.secrets.get(id).then(function (secret): Promise<Programme[] | null> | null {
        const cred = secret ? credentialsFor(def, secret) : null;
        if (!cred) {
          return null;
        }
        const client = createXtreamClient({
          http: o.http, server: def.server, credentials: cred,
          limits: {
            requestTimeoutMs: o.limits.requestTimeoutMs, maxResponseChars: o.limits.maxResponseChars,
            maxListChars: o.limits.maxPlaylistChars, idleTimeoutMs: o.limits.idleTimeoutMs, totalTimeoutMs: o.limits.totalTimeoutMs
          },
          retry: { attempts: 1, delaysMs: [] }, timers: o.timers
        });
        return client.shortEpg(ref.id, limit).result.then(function (r): Programme[] | null {
          if (!r.ok) {
            return null;
          }
          const out: Programme[] = [];
          for (let i = 0; i < r.data.length; i++) {
            const e = r.data[i];
            const pr: Programme = { start: e.start, end: e.end, title: e.title };
            if (e.desc) { pr.desc = e.desc; }
            out.push(pr);
          }
          return out;
        });
      }, function () { return null; });
    },

    meta: function (id) {
      return isPlaylistId(id) ? loadMeta(id) : Promise.resolve(null);
    },

    xtreamClient: function (id) {
      const def = getDef(id);
      if (!def || def.kind !== 'xtream') {
        return Promise.resolve(null);
      }
      return o.secrets.get(id).then(function (secret): XtreamClient | null {
        const cred = secret ? credentialsFor(def, secret) : null;
        if (!cred) {
          return null;
        }
        return createXtreamClient({
          http: o.http, server: def.server, credentials: cred,
          limits: {
            requestTimeoutMs: o.limits.requestTimeoutMs, maxResponseChars: o.limits.maxResponseChars,
            maxListChars: o.limits.maxPlaylistChars, idleTimeoutMs: o.limits.idleTimeoutMs, totalTimeoutMs: o.limits.totalTimeoutMs
          },
          retry: o.retry, timers: o.timers, slice: slice
        });
      }, function () { return null; });
    },

    resolveStream: function (id, ref) {
      // Same resolution as a channel; movies and episodes carry no user agent or referrer.
      return this.resolvePlayback(id, { id: '', num: 0, name: '', categoryId: '', adult: false, streamRef: ref });
    },

    removeAll: function () {
      const running = job;
      if (running) {
        running.abort();
      }
      const wait: Promise<unknown> = running ? running.result : Promise.resolve();
      releaseCache('remove-all');
      return wait.then(function () {
        releaseCache('remove-all');
        const list = readList();
        let chain: Promise<void> = Promise.resolve();
        for (let i = 0; i < list.length; i++) {
          const id = list[i].id;
          o.kv.remove('fav.' + id);
          o.kv.remove('recent.' + id);
          o.kv.remove('vod.' + id);
          o.kv.remove('mylist.movie.' + id);
          o.kv.remove('mylist.series.' + id);
          o.kv.remove('catprefs.live.' + id); // Stage 14: category order / hidden (content/category-prefs.ts)
          o.kv.remove('catprefs.movie.' + id);
          o.kv.remove('catprefs.series.' + id);
          chain = chain.then(function () {
            return o.secrets.remove(id).then(null, function () { /* already gone */ }).then(function () {
              return o.catalogue.removePlaylist(id);
            }).then(function () { return undefined; });
          });
        }
        return chain.then(function () {
          o.kv.remove(KV_LIST);
          o.kv.remove(KV_ACTIVE);
          o.kv.remove(KV_JOURNAL);
          return o.catalogue.cleanup([]);
        }).then(function () {
          log.warn('all playlists removed', { count: list.length });
        });
      });
    },

    recover: function () {
      const j = o.kv.get<Journal | null>(KV_JOURNAL, isJournalOrNull, null);
      let interrupted: string | null = null;
      if (j && busy === null) {
        interrupted = j.id;
        o.kv.remove(KV_JOURNAL);
        patch(j.id, function (d) {
          d.lastStatus = { ok: false, at: o.now(), code: 'interrupted', message: 'the last import did not finish' };
        });
        log.warn('interrupted import detected', { id: j.id });
      }
      const ids: string[] = [];
      const list = readList();
      for (let i = 0; i < list.length; i++) {
        ids.push(list[i].id);
      }
      return o.catalogue.cleanup(ids).then(function (r) {
        if (r.removed > 0) { releaseCache('recovery'); }
        return { interrupted: interrupted, removedFiles: r.removed };
      });
    }
  };
}
