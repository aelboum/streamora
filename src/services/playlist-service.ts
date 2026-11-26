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
// import as interrupted and removes temp files and the files of playlists the user removed.
//
// DI-1 (data integrity): an unreadable playlist list is never treated as an empty one.
//   - The list is read with kv.read(); missing, unreadable, corrupt, malformed, unsupported and
//     partially invalid lists are told apart. Only a verified-missing list on a device with no
//     backup and no catalogue files of earlier playlists counts as a first start.
//   - Anything else puts the service in a protected state: writes to the list (add, update,
//     remove, removeAll, setActive, status updates) are refused with 'storage-protected', start-up
//     cleanup is skipped, and the stored value is quarantined (kv-store.ts), never deleted.
//   - Valid entries of a partially invalid list stay visible and playable (read-only).
//   - Backup: ss-playlists.bak.json in the FileStore (a different medium than localStorage),
//     rewritten after every successful, validated save (verified by count and hash before use).
//     ss-playlists.bak.keep.json preserves a backup once before a recovery decision replaces it.
//   - Tombstones: KV "playlists.removed" lists playlists the user removed; only their catalogue
//     files are deleted by cleanup. Files whose owner is unknown are kept.
//   - Recovery is a user decision: restoreBackup() or continueWithoutRestore(), both only when the
//     unreadable value is preserved in quarantine; recheckStorage() re-reads (e.g. after a read error).
import type { KeyValueStore, KvProblem } from '../storage/kv-store.ts';
import type { FileStore } from '../app/platform/platform.ts';
import type { DiagLog } from '../storage/diag-log.ts';
import type { AccountInfoStore } from './account-info.ts';
import { ACCOUNT_KEY_PREFIX } from './account-info.ts';
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
import { isPlaylistDef, isPlaylistId, isPlaylistList } from '../models/content.ts';
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
/** DI-1: ids of playlists the user removed (their leftover catalogue files may be deleted). */
const KV_REMOVED = 'playlists.removed';
const MAX_TOMBSTONES = 50;
/** DI-1: last-known-good copy of the playlist list (FileStore). */
export const BACKUP_FILE = 'ss-playlists.bak.json';
/** DI-1: one preserved backup, written once before a recovery decision replaces the backup. */
export const BACKUP_KEEP_FILE = 'ss-playlists.bak.keep.json';

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

export type InputError = 'invalid-name' | 'invalid-url' | 'invalid-credentials' | 'limit' | 'not-found' | 'storage' | 'storage-protected';

/** DI-1: why the playlist list is protected. */
export type StorageProblem = KvProblem | 'partial' | 'missing-with-backup' | 'missing-with-data' | 'unverified' | 'no-local-storage';

export type PlaylistStorageState =
  | { status: 'ok' }
  /** The list key is missing; backup and catalogue files are being checked (first start or loss?). */
  | { status: 'checking' }
  | {
    status: 'protected';
    problem: StorageProblem;
    /** The unreadable stored value is preserved (quarantined, or nothing was stored). */
    preserved: boolean;
    canRestore: boolean;
    canContinue: boolean;
    /** Entries in a verified backup; -1 when there is none. */
    backupEntries: number;
    validEntries: number;
    invalidEntries: number;
  };

/**
 * DI-1.1: read-only storage report for the diagnostics screen. Every field is measured now from
 * the stored data (fresh reads, no writes); null / 'unknown' when it cannot be verified.
 */
export interface StorageReport {
  state: 'healthy' | 'protected' | 'unavailable' | 'unknown';
  /** Protection reason (codes of StorageProblem), when protected or unavailable. */
  problem: StorageProblem | null;
  /** Entries of the stored list that pass validation; null when the list cannot be read. */
  listEntries: number | null;
  backup: 'missing' | 'valid' | 'invalid' | 'unreadable' | 'unknown';
  /** Entries of the verified backup; null unless backup === 'valid'. */
  backupEntries: number | null;
  /** Count + checksum + validation of the backup: 'ok' only for a verified backup. */
  integrity: 'ok' | 'failed' | 'unknown';
}

export interface StorageActionResult {
  ok: boolean;
  code: 'restored' | 'continued' | 'not-protected' | 'not-preserved' | 'no-backup' | 'backup-keep-failed' | 'write-failed';
  entries?: number;
}

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
  /** DI-1: true when start-up cleanup did not run because the playlist list is not verified. */
  cleanupSkipped?: boolean;
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
  /** DI-1: file store for the playlist-list backup (absent = no backup). */
  files?: FileStore | null;
  /** DI-1: persistent diagnostics log. */
  diag?: DiagLog | null;
  /** DI-1: false when localStorage is unavailable (memory fallback): the list is then protected. */
  storagePersistent?: boolean;
  /** S2: Xtream account metadata (expiry, status), stored apart from the playlist list. */
  accounts?: AccountInfoStore | null;
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
  /** Removes the definition, its credentials and its catalogue files. Rejects while storage is protected. */
  remove(id: string): Promise<void>;
  /** DI-1: whether the playlist list is verified, being checked, or protected. */
  storageState(): PlaylistStorageState;
  /** DI-1: the state once a missing list has been classified (first start or loss). */
  whenChecked(): Promise<PlaylistStorageState>;
  /** DI-1.1: read-only report (diagnostics). Never writes, quarantines, cleans up or changes state. */
  storageReport(): Promise<StorageReport>;
  /** DI-1: reads the list again (for example after a read error) and re-checks. */
  recheckStorage(): Promise<PlaylistStorageState>;
  /** DI-1: user decision: rebuild the list from the verified backup (the unreadable value stays quarantined). */
  restoreBackup(): Promise<StorageActionResult>;
  /** DI-1: user decision: carry on with the valid entries (or none); quarantine, backup and files are kept. */
  continueWithoutRestore(): Promise<StorageActionResult>;
  activeId(): string | null;
  /** CP1: false where no secure store exists; logins are then kept for this session only. */
  credentialsPersistent(): boolean;
  /** CP1: true when the playlist's login is available now (false after a restart in session-only mode). */
  hasCredentials(id: string): Promise<boolean>;
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
  /** Aborts a running import and deletes every playlist, its credentials and its files (unauthenticated PIN reset). Rejects while storage is protected. */
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

function isArrayValue(x: unknown): x is unknown[] {
  return Object.prototype.toString.call(x) === '[object Array]';
}

function isIdList(x: unknown): x is string[] {
  if (!isArrayValue(x)) { return false; }
  for (let i = 0; i < x.length; i++) { if (!isPlaylistId(x[i])) { return false; } }
  return true;
}

/** DI-1: small checksum of the backup content (detects truncation and damage; not a security measure). */
function textHash(t: string): string {
  let h = 5381;
  for (let i = 0; i < t.length; i++) { h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; }
  return h.toString(36) + '.' + t.length.toString(36);
}

function backupText(list: PlaylistDef[]): string {
  return JSON.stringify({ v: 1, count: list.length, hash: textHash(JSON.stringify(list)), list: list });
}

/** Verified backup list, or null (unreadable, truncated, invalid). */
function parseBackup(text: string): PlaylistDef[] | null {
  try {
    const o = JSON.parse(text);
    if (!o || o.v !== 1 || !isPlaylistList(o.list) || o.count !== o.list.length || o.hash !== textHash(JSON.stringify(o.list))) {
      return null;
    }
    return o.list;
  } catch (e) {
    return null;
  }
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

  // ---------------------------------------------------------------- DI-1: fail-safe list storage
  const backupFiles = o.files || null;
  const diag = o.diag || null;
  const persistentKv = o.storagePersistent !== false;
  type State = { status: 'ok' } | { status: 'checking' } | { status: 'protected'; problem: StorageProblem; preserved: boolean; valid: number; invalid: number };
  let st: State = { status: 'checking' };
  /** The last list read successfully (shown while protected: never an invented empty list). */
  let lastGood: PlaylistDef[] = [];
  let checked: Promise<void> | null = null;
  let backup: PlaylistDef[] | null = null;
  let backupStored: string | null = null;
  let backupChain: Promise<void> = Promise.resolve();

  type Inspect =
    | { kind: 'ok'; list: PlaylistDef[] }
    | { kind: 'missing' }
    | { kind: 'partial'; list: PlaylistDef[]; invalid: number; raw: string }
    | { kind: KvProblem; raw: string | null };

  function record(e: string, d?: Record<string, unknown>): void {
    if (diag) { diag.record(e, d); }
  }

  /** Reads the stored list without changing anything; valid entries are separated from invalid ones. */
  function inspect(): Inspect {
    const r = o.kv.read<unknown[]>(KV_LIST, isArrayValue);
    if (r.status === 'missing') { return { kind: 'missing' }; }
    if (r.status !== 'ok') { return { kind: r.status, raw: r.raw }; }
    const valid: PlaylistDef[] = [];
    const seen: Record<string, boolean> = {};
    let invalid = 0;
    for (let i = 0; i < r.value.length; i++) {
      const x = r.value[i];
      if (isPlaylistDef(x) && !seen['k' + x.id]) {
        seen['k' + x.id] = true;
        valid.push(x);
      } else {
        invalid++;
      }
    }
    if (!invalid) { return { kind: 'ok', list: valid }; }
    return { kind: 'partial', list: valid, invalid: invalid, raw: JSON.stringify({ v: 1, d: r.value }) };
  }

  function protect(problem: StorageProblem, preserved: boolean, valid: number, invalid: number): void {
    st = { status: 'protected', problem: problem, preserved: preserved, valid: valid, invalid: invalid };
    log.warn('playlists: storage protected; existing data kept', { problem: problem, preserved: preserved, valid: valid, invalid: invalid });
    record('pl-protected', { reason: problem, kept: preserved, valid: valid, invalid: invalid });
  }

  /** Enters the protected state for an inspection that is not a clean list. */
  function degrade(r: Inspect): void {
    if (r.kind === 'ok') { return; }
    if (r.kind === 'missing') {
      protect(backup && backup.length ? 'missing-with-backup' : 'missing-with-data', true, 0, 0);
    } else if (r.kind === 'partial') {
      lastGood = r.list;
      protect('partial', o.kv.quarantine(KV_LIST, r.raw, 'invalid'), r.list.length, r.invalid);
    } else {
      protect(r.kind, r.raw !== null && o.kv.quarantine(KV_LIST, r.raw, r.kind), lastGood.length, 0);
    }
  }

  /** Classifies the stored list (start-up and recheck). Synchronous: the list key is in localStorage. */
  function evaluate(): void {
    checked = null;
    if (!persistentKv) {
      lastGood = [];
      protect('no-local-storage', true, 0, 0);
      return;
    }
    const r = inspect();
    if (r.kind === 'ok') {
      lastGood = r.list;
      st = { status: 'ok' };
    } else if (r.kind === 'missing') {
      lastGood = [];
      st = { status: 'checking' };
    } else {
      if (r.kind !== 'partial') { lastGood = []; }
      degrade(r);
    }
  }

  function loadBackup(): Promise<void> {
    if (!backupFiles) { backup = null; return Promise.resolve(); }
    return backupFiles.read(BACKUP_FILE).then(function (text) {
      if (text === null) { backup = null; return; }
      const list = parseBackup(text);
      if (!list) {
        backup = null;
        log.warn('playlists: backup failed verification; kept as it is');
        record('backup-invalid', { chars: text.length });
        return;
      }
      backup = list;
      backupStored = text;
    }, function () {
      backup = null;
      record('backup-unreadable');
    });
  }

  /** Writes the backup after a successful, validated save (or a verified read); never from a protected state. */
  function writeBackup(list: PlaylistDef[]): void {
    if (!backupFiles || st.status !== 'ok') { return; }
    if (!isPlaylistList(list)) { record('backup-skipped', { why: 'invalid' }); return; }
    const text = backupText(list);
    if (text === backupStored) { return; }
    backupStored = text;
    const copy = list.slice();
    const fs = backupFiles;
    backupChain = backupChain.then(function () {
      return fs.write(BACKUP_FILE, text).then(function () {
        backup = copy;
        record('backup-written', { entries: copy.length });
      }, function () {
        backupStored = null;
        log.warn('playlists: backup could not be written');
        record('backup-failed', { entries: copy.length });
      });
    });
  }

  /** Preserves the current backup once (never overwritten) before a recovery decision replaces it. */
  function keepBackup(): Promise<boolean> {
    if (!backupFiles || !backup || !backupStored) { return Promise.resolve(true); }
    const fs = backupFiles;
    const text = backupStored;
    return fs.read(BACKUP_KEEP_FILE).then(function (have): boolean | Promise<boolean> {
      if (have !== null) { return true; }
      return fs.write(BACKUP_KEEP_FILE, text).then(function () { return true; }, function () { return false; });
    }, function () { return false; });
  }

  function tombstones(): string[] {
    return o.kv.get<string[]>(KV_REMOVED, isIdList, []);
  }

  function addTombstones(ids: string[]): void {
    const t = tombstones();
    for (let i = 0; i < ids.length; i++) {
      if (isPlaylistId(ids[i]) && t.indexOf(ids[i]) < 0) { t.push(ids[i]); }
    }
    o.kv.set(KV_REMOVED, t.length > MAX_TOMBSTONES ? t.slice(t.length - MAX_TOMBSTONES) : t);
  }

  /**
   * Resolves once a missing list has been classified: first start (ok), or protected because a
   * backup or catalogue files of earlier playlists exist. Also loads the backup.
   */
  function ensureChecked(): Promise<void> {
    if (checked) { return checked; }
    checked = loadBackup().then(function (): void | Promise<void> {
      if (st.status === 'ok') { writeBackup(lastGood); return; }
      if (st.status !== 'checking') { return; }
      if (backup && backup.length) {
        protect('missing-with-backup', true, 0, 0);
        return;
      }
      return o.catalogue.ownerIds().then(function (owners) {
        if (st.status !== 'checking') { return; }
        const gone = tombstones();
        let unexplained = 0;
        for (let i = 0; i < owners.length; i++) {
          if (gone.indexOf(owners[i]) < 0) { unexplained++; }
        }
        if (unexplained) {
          protect('missing-with-data', true, 0, 0);
          record('pl-orphan-data', { count: unexplained });
        } else {
          st = { status: 'ok' };
        }
      }, function () {
        if (st.status === 'checking') { protect('unverified', true, 0, 0); }
      });
    });
    return checked;
  }

  function refuse(op: string): void {
    const reason = st.status === 'protected' ? st.problem : st.status;
    log.warn('playlists: write refused, storage protected', { op: op, reason: reason });
    record('pl-write-refused', { op: op, reason: reason });
  }

  /**
   * The current list for a write: only in the verified state, and only after a fresh, clean read.
   * A list that became unreadable (or vanished) while the app ran switches to the protected state.
   */
  function freshList(op: string): PlaylistDef[] | null {
    if (st.status !== 'ok') { refuse(op); return null; }
    const r = inspect();
    if (r.kind === 'ok') { lastGood = r.list; return r.list; }
    if (r.kind === 'missing' && !lastGood.length) { return []; }
    degrade(r);
    refuse(op);
    return null;
  }

  /** Saves the list (after a fresh guard read), then refreshes the backup. False = nothing saved. */
  function saveList(list: PlaylistDef[], op: string): boolean {
    if (!freshList(op)) { return false; }
    if (!o.kv.set(KV_LIST, list)) {
      record('pl-write-failed', { op: op });
      return false;
    }
    lastGood = list.slice();
    writeBackup(lastGood);
    return true;
  }

  function protectedError(): SaveDefResult {
    return { ok: false, code: 'storage-protected', message: 'playlist storage is protected; existing data was kept' };
  }

  function canResolve(): boolean {
    return st.status === 'protected' && st.preserved && st.problem !== 'read-error' && st.problem !== 'no-local-storage';
  }

  function stateCopy(): PlaylistStorageState {
    if (st.status !== 'protected') { return { status: st.status }; }
    const restore = canResolve() && !!backup && backup.length > 0;
    return {
      status: 'protected', problem: st.problem, preserved: st.preserved, canRestore: restore, canContinue: canResolve(),
      backupEntries: backup ? backup.length : -1, validEntries: st.valid, invalidEntries: st.invalid
    };
  }

  /** The list for display and lookups: never an invented empty list while protected. */
  function readList(): PlaylistDef[] {
    if (st.status === 'ok') {
      const r = inspect();
      if (r.kind === 'ok') { lastGood = r.list; return r.list; }
      if (r.kind === 'missing' && !lastGood.length) { return []; }
      degrade(r);
    }
    return lastGood.slice();
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
    const list = freshList('patch');
    if (!list) { return; }
    const i = find(list, id);
    if (i >= 0) {
      fn(list[i]);
      saveList(list, 'patch');
    }
  }

  evaluate();

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
        liveFormat: def.liveFormat, now: o.now, onProgress: onProgress,
        // S2: saved right after the login, so a later failure never loses it (separate KV key).
        onAccount: function (a) { if (o.accounts) { o.accounts.save(def.id, a); } }
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
      // DI-1: never add to a list that could not be read (that would overwrite the real one).
      return ensureChecked().then(function (): SaveDefResult | Promise<SaveDefResult> {
      const list = freshList('add');
      if (!list) {
        return protectedError();
      }
      if (list.length >= MAX_PLAYLISTS) {
        return { ok: false, code: 'limit', message: 'at most ' + MAX_PLAYLISTS + ' playlists' };
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
        if (!saveList(list, 'add')) {
          const fail = st.status === 'ok' ? storageError : protectedError;
          return o.secrets.remove(id).then(fail, fail);
        }
        if (!o.kv.get<string | null>(KV_ACTIVE, isActive, null)) {
          o.kv.set(KV_ACTIVE, id);
        }
        log.info('playlist added', { id: id, kind: def.kind, cleartext: def.server.indexOf('http:') === 0 });
        return { ok: true, playlist: def };
      }, function (): SaveDefResult {
        return { ok: false, code: 'storage', message: 'credentials could not be stored securely' };
      });
      });
    },

    update: function (id, ch) {
      return ensureChecked().then(function (): SaveDefResult | Promise<SaveDefResult> {
      const list = freshList('update');
      if (!list) {
        return protectedError();
      }
      const i = find(list, id);
      if (i < 0) {
        return { ok: false, code: 'not-found', message: 'unknown playlist' };
      }
      const def = list[i];
      if (ch.name !== undefined) {
        const n = cleanText(ch.name, 64);
        if (!n) {
          return { ok: false, code: 'invalid-name', message: 'a name is required' };
        }
        def.name = n;
      }
      if (ch.epgUrl !== undefined) {
        const e = validEpg(ch.epgUrl);
        if (e === false) {
          return { ok: false, code: 'invalid-url', message: 'EPG address is not a valid http(s) URL' };
        }
        if (e) { def.epgUrl = e; } else { delete def.epgUrl; }
      }
      if (ch.liveFormat !== undefined) {
        def.liveFormat = ch.liveFormat === 'm3u8' ? 'm3u8' : 'ts';
      }
      const sourceChanged = ch.url !== undefined || ch.server !== undefined || ch.username !== undefined || ch.password !== undefined;
      if (!sourceChanged) {
        return saveList(list, 'update') ? { ok: true, playlist: def } : (st.status === 'ok' ? storageError() : protectedError());
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
          if (!saveList(list, 'update')) {
            return st.status === 'ok' ? storageError() : protectedError();
          }
          log.info('playlist source updated', { id: id });
          return { ok: true, playlist: def };
        });
      }).then(null, function (): SaveDefResult {
        return { ok: false, code: 'storage', message: 'credentials could not be stored securely' };
      });
      });
    },

    remove: function (id) {
      return ensureChecked().then(function (): void | Promise<void> {
      // DI-1: a removal needs a verified list; nothing is deleted while storage is protected.
      const list = freshList('remove');
      if (!list) {
        throw new Error('playlist storage is protected');
      }
      if (cached && cached.id === id) { releaseCache('removed'); }
      const i = find(list, id);
      if (isPlaylistId(id)) { addTombstones([id]); } // before any deletion: leftovers are then known garbage
      if (i >= 0) {
        list.splice(i, 1);
        if (!saveList(list, 'remove')) {
          throw new Error('the playlist list could not be saved');
        }
      }
      if (o.kv.get<string | null>(KV_ACTIVE, isActive, null) === id) {
        if (list.length) { o.kv.set(KV_ACTIVE, list[0].id); } else { o.kv.remove(KV_ACTIVE); }
      }
      if (!isPlaylistId(id)) {
        return;
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
      o.kv.remove(ACCOUNT_KEY_PREFIX + id); // S2 (approved exception): expiry of an explicitly removed playlist
      return o.secrets.remove(id).then(null, function () { /* already gone */ }).then(function () {
        return o.catalogue.removePlaylist(id);
      }).then(function () {
        log.info('playlist removed', { id: id });
        record('pl-removed', { id: id });
      });
      });
    },

    storageState: stateCopy,

    whenChecked: function () { return ensureChecked().then(stateCopy); },

    storageReport: function () {
      // Read-only by construction: inspect() is kv.read() (no writes) and the backup is only read.
      // The service state is reported as it is; nothing here calls degrade(), protect(),
      // quarantine, saveList, writeBackup, ensureChecked or cleanup.
      let state: StorageReport['state'] = 'unknown';
      let problem: StorageProblem | null = null;
      if (st.status === 'ok') {
        state = 'healthy';
      } else if (st.status === 'protected') {
        problem = st.problem;
        state = st.problem === 'read-error' || st.problem === 'no-local-storage' ? 'unavailable' : 'protected';
      }
      let listEntries: number | null = null;
      if (persistentKv) {
        const r = inspect();
        if (r.kind === 'ok' || r.kind === 'partial') {
          listEntries = r.list.length;
        } else if (r.kind === 'missing' && st.status === 'ok') {
          listEntries = 0; // verified first start: no list yet
        }
      }
      const base: StorageReport = { state: state, problem: problem, listEntries: listEntries, backup: 'unknown', backupEntries: null, integrity: 'unknown' };
      if (!backupFiles) {
        return Promise.resolve(base);
      }
      return backupFiles.read(BACKUP_FILE).then(function (text): StorageReport {
        if (text === null) {
          base.backup = 'missing';
          return base;
        }
        const list = parseBackup(text);
        if (!list) {
          base.backup = 'invalid';
          base.integrity = 'failed';
          return base;
        }
        base.backup = 'valid';
        base.backupEntries = list.length;
        base.integrity = 'ok';
        return base;
      }, function (): StorageReport {
        base.backup = 'unreadable';
        return base;
      });
    },

    recheckStorage: function () {
      evaluate();
      return ensureChecked().then(function () {
        record('pl-recheck', { state: st.status });
        return stateCopy();
      });
    },

    restoreBackup: function () {
      return ensureChecked().then(function (): StorageActionResult | Promise<StorageActionResult> {
        if (st.status !== 'protected') { return { ok: false, code: 'not-protected' }; }
        if (!canResolve()) { return { ok: false, code: 'not-preserved' }; }
        const from = backup;
        if (!from || !from.length) { return { ok: false, code: 'no-backup' }; }
        return keepBackup().then(function (): StorageActionResult {
          // Union: the backup, plus valid entries of a partial list that the backup does not have.
          const merged = from.slice();
          for (let i = 0; i < lastGood.length && merged.length < MAX_PLAYLISTS; i++) {
            if (find(merged, lastGood[i].id) < 0) { merged.push(lastGood[i]); }
          }
          if (!o.kv.set(KV_LIST, merged)) {
            record('pl-write-failed', { op: 'restore' });
            return { ok: false, code: 'write-failed' };
          }
          st = { status: 'ok' };
          lastGood = merged.slice();
          const a = readActive();
          if (!a || find(merged, a) < 0) { o.kv.set(KV_ACTIVE, merged[0].id); }
          writeBackup(merged);
          log.warn('playlists: list restored from the backup', { entries: merged.length });
          record('pl-restored', { entries: merged.length });
          return { ok: true, code: 'restored', entries: merged.length };
        });
      });
    },

    continueWithoutRestore: function () {
      return ensureChecked().then(function (): StorageActionResult | Promise<StorageActionResult> {
        if (st.status !== 'protected') { return { ok: false, code: 'not-protected' }; }
        if (!canResolve()) { return { ok: false, code: 'not-preserved' }; }
        const keep = st.problem === 'partial' ? lastGood.slice() : [];
        return keepBackup().then(function (kept): StorageActionResult {
          if (!kept) { return { ok: false, code: 'backup-keep-failed' }; }
          if (!o.kv.set(KV_LIST, keep)) {
            record('pl-write-failed', { op: 'continue' });
            return { ok: false, code: 'write-failed' };
          }
          st = { status: 'ok' };
          lastGood = keep.slice();
          writeBackup(keep);
          log.warn('playlists: continued without restoring; quarantine, backup and files kept', { entries: keep.length });
          record('pl-continued', { entries: keep.length });
          return { ok: true, code: 'continued', entries: keep.length };
        });
      });
    },

    credentialsPersistent: function () { return o.secrets.persistent; },
    hasCredentials: function (id) {
      const def = getDef(id);
      if (!def) { return Promise.resolve(false); }
      return o.secrets.get(id).then(function (s) { return !!s && (def.kind === 'xtream') === (s.kind === 'xtream'); }, function () { return false; });
    },
    activeId: function () {
      const a = o.kv.get<string | null>(KV_ACTIVE, isActive, null);
      return a && find(readList(), a) >= 0 ? a : null;
    },

    setActive: function (id) {
      const list = freshList('set-active');
      const ok = !!list && find(list, id) >= 0 && o.kv.set(KV_ACTIVE, id);
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
        return ensureChecked();
      }).then(function () {
        releaseCache('remove-all');
        // DI-1: the wipe needs a verified list; while storage is protected it is refused (the PIN
        // service then keeps the PIN and retries on the next start, see pin.ts wipe()).
        const list = freshList('remove-all');
        if (!list) {
          return Promise.reject(new Error('playlist storage is protected'));
        }
        const ids: string[] = [];
        for (let i = 0; i < list.length; i++) { ids.push(list[i].id); }
        addTombstones(ids);
        // An explicit empty list (not a missing key): a later start knows nothing was lost.
        if (!saveList([], 'remove-all')) {
          return Promise.reject(new Error('the playlist list could not be saved'));
        }
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
          o.kv.remove(ACCOUNT_KEY_PREFIX + id); // S2 (approved exception): explicit wipe only
          chain = chain.then(function () {
            return o.secrets.remove(id).then(null, function () { /* already gone */ }).then(function () {
              return o.catalogue.removePlaylist(id);
            }).then(function () { return undefined; });
          });
        }
        return chain.then(function () {
          o.kv.remove(KV_ACTIVE);
          o.kv.remove(KV_JOURNAL);
          // A user-confirmed wipe (unauthenticated PIN reset): every catalogue file goes, also files
          // of earlier playlists whose owner is unknown.
          return o.catalogue.ownerIds().then(function (owners) { return o.catalogue.cleanup(owners, owners); });
        }).then(function () {
          if (backupFiles) { return backupFiles.remove(BACKUP_KEEP_FILE).then(null, function () { /* keep going */ }); }
          return undefined;
        }).then(function () {
          log.warn('all playlists removed', { count: list.length });
          record('pl-removed-all', { count: list.length });
        });
      });
    },

    recover: function () {
      return ensureChecked().then(function (): RecoveryReport | Promise<RecoveryReport> {
        // DI-1: no cleanup (and no journal handling) unless the list was read and verified.
        if (st.status !== 'ok') {
          const reason = st.status === 'protected' ? st.problem : st.status;
          log.warn('playlists: start-up cleanup skipped; storage not verified', { reason: reason });
          record('cleanup-skipped', { reason: reason });
          return { interrupted: null, removedFiles: 0, cleanupSkipped: true };
        }
        const j = o.kv.get<Journal | null>(KV_JOURNAL, isJournalOrNull, null);
        let interrupted: string | null = null;
        if (j && busy === null) {
          interrupted = j.id;
          patch(j.id, function (d) {
            d.lastStatus = { ok: false, at: o.now(), code: 'interrupted', message: 'the last import did not finish' };
          });
          o.kv.remove(KV_JOURNAL);
          log.warn('interrupted import detected', { id: j.id });
        }
        const list = freshList('recover');
        if (!list) {
          record('cleanup-skipped', { reason: 'changed' });
          return { interrupted: interrupted, removedFiles: 0, cleanupSkipped: true };
        }
        const ids: string[] = [];
        for (let i = 0; i < list.length; i++) {
          ids.push(list[i].id);
        }
        const t = tombstones();
        const gone: string[] = [];
        for (let i = 0; i < t.length; i++) {
          if (ids.indexOf(t[i]) < 0) { gone.push(t[i]); }
        }
        return o.catalogue.cleanup(gone, ids).then(function (r) {
          if (r.removed > 0) { releaseCache('recovery'); }
          if (r.removed || r.kept) { record('cleanup', { removed: r.removed, kept: r.kept }); }
          return { interrupted: interrupted, removedFiles: r.removed };
        });
      });
    }
  };
}
