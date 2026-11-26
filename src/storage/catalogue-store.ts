// Large-data catalogue storage: one file per playlist and section on the FileStore
// (tizen.filesystem on the TV). ARCHITECTURE.md rev 3 §7.
//
// File name: cat.<playlistId>.<section>.json
// File format (two parts separated by the first "\n"):
//   line 1: header JSON {"f":"ss-cat","v":1,"p":<playlistId>,"s":<section>,"t":<savedAt ms>,"n":<payload chars>,"c":<fnv1a32 of payload>}
//   rest:   payload JSON
// The header lets a torn or truncated write be detected (length + checksum) without trusting the
// payload. Corrupt or outdated files are removed and reported, so the caller re-downloads.
// Budget: TV file throughput is about 1.5 MB/s [M, probe 2]; sections above the budget are
// stored but flagged, and above the hard limit they are refused.
import type { FileStore } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';
import { fnv1a32 } from '../utils/bytes.ts';

export const CATALOGUE_FORMAT = 'ss-cat';
export const CATALOGUE_VERSION = 1;
export type CatalogueSection = 'meta' | 'live' | 'movie' | 'series' | 'epg';
const SECTIONS: CatalogueSection[] = ['meta', 'live', 'movie', 'series', 'epg'];
const PLAYLIST_ID_RE = /^[a-z0-9]{1,32}$/;
// Section files cat.<pl>.<section>.json and (Stage 6.1) page files cat.<pl>.<section>.<gen>-<i|n><n>.json.
const FILE_RE = /^cat\.([a-z0-9]{1,32})\.(meta|live|movie|series|epg)(?:\.([a-z0-9]{1,16})-([in])([0-9]{1,5}))?\.json(\.tmp)?$/;
const GEN_RE = /^[a-z0-9]{1,16}$/;

/** Sections stored in pages (Stage 6.1, index-only movie/series catalogues). */
export type VodPageSection = 'movie' | 'series';

export interface CatalogueLimits {
  /** Soft budget per section (characters). Default 5,000,000 (about 3 s to read on the TV). */
  budgetChars: number;
  /** Hard limit per section (characters). Default 20,000,000. */
  maxChars: number;
}

export type SaveResult =
  /** `checksum`: header checksum of the payload. `unchanged`: not rewritten because it equals `unlessChecksum`. */
  | { ok: true; chars: number; ms: number; overBudget: boolean; checksum: string; unchanged: boolean }
  | { ok: false; reason: 'too-large' | 'serialise' | 'io'; message: string };

export type LoadResult<T> =
  | { status: 'ok'; data: T; savedAt: number; chars: number; ms: number; checksum: string }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: string }
  | { status: 'error'; message: string };

export interface SaveOptions {
  /** Incremental update: when the new payload's checksum equals this value, the file is not rewritten. */
  unlessChecksum?: string;
}

export interface CatalogueStore {
  save(playlistId: string, section: CatalogueSection, data: unknown, options?: SaveOptions): Promise<SaveResult>;
  load<T>(playlistId: string, section: CatalogueSection, validate: (x: unknown) => x is T): Promise<LoadResult<T>>;
  /** Stage 6.1: one page of a paged section ('i' items, 'n' search names) of generation `gen`. */
  savePage(playlistId: string, section: VodPageSection, gen: string, kind: 'i' | 'n', n: number, data: unknown): Promise<SaveResult>;
  loadPage<T>(playlistId: string, section: VodPageSection, gen: string, kind: 'i' | 'n', n: number, validate: (x: unknown) => x is T): Promise<LoadResult<T>>;
  /** Removes the section's page files of every generation except `keepGen` (null: all). */
  removePages(playlistId: string, section: VodPageSection, keepGen: string | null): Promise<number>;
  /** Deletes every section of one playlist (and its page files). Resolves the number of files removed. */
  removePlaylist(playlistId: string): Promise<number>;
  /** Removes files of unknown playlists, leftover temp files and unrecognised catalogue files. */
  cleanup(knownPlaylistIds: string[]): Promise<{ removed: number }>;
}

export function catalogueFileName(playlistId: string, section: CatalogueSection): string {
  if (!PLAYLIST_ID_RE.test(playlistId)) {
    throw new Error('invalid playlist id');
  }
  if (SECTIONS.indexOf(section) < 0) {
    throw new Error('invalid section');
  }
  return 'cat.' + playlistId + '.' + section + '.json';
}

export function pageFileName(playlistId: string, section: VodPageSection, gen: string, kind: 'i' | 'n', n: number): string {
  if (!PLAYLIST_ID_RE.test(playlistId) || (section !== 'movie' && section !== 'series') || !GEN_RE.test(gen) ||
      (kind !== 'i' && kind !== 'n') || !(n >= 0 && n < 100000 && Math.floor(n) === n)) {
    throw new Error('invalid page');
  }
  return 'cat.' + playlistId + '.' + section + '.' + gen + '-' + kind + n + '.json';
}

interface Header { f: string; v: number; p: string; s: string; t: number; n: number; c: string }

const NON_ASCII_RE = /[\u0080-￿]/g;
const NON_ASCII_TEST = /[\u0080-￿]/;

/**
 * Makes JSON text pure ASCII: every character above U+007F (including both halves of surrogate
 * pairs and lone surrogates) becomes its \uXXXX escape. JSON.parse restores the same string.
 * In JSON text produced by JSON.stringify such characters only occur inside strings.
 */
export function escapeNonAscii(json: string): string {
  if (!NON_ASCII_TEST.test(json)) {
    return json;
  }
  return json.replace(NON_ASCII_RE, function (c) {
    const h = c.charCodeAt(0).toString(16);
    return '\\u' + (h.length === 2 ? '00' + h : h.length === 3 ? '0' + h : h);
  });
}

function isHeader(x: unknown): x is Header {
  const h = x as Header;
  return !!h && typeof h === 'object' && typeof h.f === 'string' && typeof h.v === 'number' && typeof h.p === 'string' &&
    typeof h.s === 'string' && typeof h.t === 'number' && typeof h.n === 'number' && typeof h.c === 'string';
}

export function createCatalogueStore(files: FileStore, limits: CatalogueLimits, now: () => number, log?: Logger): CatalogueStore {
  function discard(name: string, reason: string): Promise<LoadResult<never>> {
    if (log) { log.warn('catalogue: discarding file', { file: name, reason: reason }); }
    return files.remove(name).then(
      function () { return { status: 'corrupt' as const, reason: reason }; },
      function () { return { status: 'corrupt' as const, reason: reason }; }
    );
  }

  function saveAs(name: string, playlistId: string, section: string, data: unknown, options?: SaveOptions): Promise<SaveResult> {
      const t0 = now();
      let payload: string;
      try {
        payload = JSON.stringify(data);
      } catch (e) {
        return Promise.resolve<SaveResult>({ ok: false, reason: 'serialise', message: 'data is not serialisable' });
      }
      if (typeof payload !== 'string') {
        return Promise.resolve<SaveResult>({ ok: false, reason: 'serialise', message: 'data is not serialisable' });
      }
      // Files are written as pure ASCII. Measured on the TV (Stage 5.2): Tizen 3.0's FileStream
      // miscounts multi-byte UTF-8 characters (it mixes up bytes and characters), so text with
      // non-ASCII characters is shifted and extended on write/read and emoji are destroyed; the
      // checksum then fails and the section is discarded. \uXXXX escapes avoid it, and
      // JSON.parse restores the same text.
      payload = escapeNonAscii(payload);
      if (payload.length > limits.maxChars) {
        if (log) { log.warn('catalogue: section over hard limit, not saved', { playlist: playlistId, section: section, chars: payload.length }); }
        return Promise.resolve<SaveResult>({ ok: false, reason: 'too-large', message: 'section exceeds ' + limits.maxChars + ' characters' });
      }
      const checksum = fnv1a32(payload);
      const overBudget = payload.length > limits.budgetChars;
      const header: Header = { f: CATALOGUE_FORMAT, v: CATALOGUE_VERSION, p: playlistId, s: section, t: now(), n: payload.length, c: checksum };
      const text = JSON.stringify(header) + '\n' + payload;
      if (options && options.unlessChecksum === checksum) {
        // Unchanged content is skipped only while the file is still there: a file discarded as
        // corrupt (or deleted) must be written again, or "Update" could never repair it.
        return files.list().then(function (names): SaveResult | Promise<SaveResult> {
          if (names.indexOf(name) >= 0) {
            return { ok: true, chars: payload.length, ms: now() - t0, overBudget: overBudget, checksum: checksum, unchanged: true };
          }
          if (log) { log.warn('catalogue: unchanged section missing on disk, rewriting', { playlist: playlistId, section: section }); }
          return write();
        }, function () { return write(); });
      }
      return write();

      function write(): Promise<SaveResult> {
        return files.write(name, text).then(function (): SaveResult {
          if (overBudget && log) {
            log.warn('catalogue: section over budget', { playlist: playlistId, section: section, chars: payload.length, budget: limits.budgetChars });
          }
          return { ok: true, chars: text.length, ms: now() - t0, overBudget: overBudget, checksum: checksum, unchanged: false };
        }, function (e): SaveResult {
          if (log) { log.error('catalogue: write failed', { playlist: playlistId, section: section }, e); }
          return { ok: false, reason: 'io', message: e instanceof Error ? e.message : 'write failed' };
        });
      }
  }

  function loadAs<T>(name: string, playlistId: string, section: string, validate: (x: unknown) => x is T): Promise<LoadResult<T>> {
      const t0 = now();
      return files.read(name).then(function (text): LoadResult<T> | Promise<LoadResult<T>> {
        if (text === null) {
          return { status: 'missing' };
        }
        const nl = text.indexOf('\n');
        if (nl < 0) {
          return discard(name, 'no header');
        }
        let header: unknown;
        try {
          header = JSON.parse(text.substring(0, nl));
        } catch (e) {
          return discard(name, 'unreadable header');
        }
        if (!isHeader(header) || header.f !== CATALOGUE_FORMAT) {
          return discard(name, 'not a catalogue file');
        }
        if (header.v !== CATALOGUE_VERSION) {
          return discard(name, 'format version ' + header.v);
        }
        if (header.p !== playlistId || header.s !== section) {
          return discard(name, 'header does not match file name');
        }
        const payload = text.substring(nl + 1);
        if (payload.length !== header.n) {
          return discard(name, 'length mismatch (truncated write?)');
        }
        if (fnv1a32(payload) !== header.c) {
          return discard(name, 'checksum mismatch');
        }
        let data: unknown;
        try {
          data = JSON.parse(payload);
        } catch (e) {
          return discard(name, 'unreadable payload');
        }
        if (!validate(data)) {
          return discard(name, 'payload failed validation');
        }
        return { status: 'ok', data: data, savedAt: header.t, chars: text.length, ms: now() - t0, checksum: header.c };
      }, function (e): LoadResult<T> {
        if (log) { log.error('catalogue: read failed', { playlist: playlistId, section: section }, e); }
        return { status: 'error', message: e instanceof Error ? e.message : 'read failed' };
      });
  }

  /** Page files of one section (every generation, or all except exceptGen). */
  function pageFiles(playlistId: string, section: VodPageSection, exceptGen: string | null): Promise<string[]> {
    return files.list().then(function (names) {
      const out: string[] = [];
      for (let i = 0; i < names.length; i++) {
        const m = FILE_RE.exec(names[i]);
        if (m && m[1] === playlistId && m[2] === section && m[3] && m[3] !== exceptGen) {
          out.push(names[i]);
        }
      }
      return out;
    });
  }

  function removeAll(list: string[]): Promise<number> {
    let chain: Promise<void> = Promise.resolve();
    let removed = 0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      chain = chain.then(function () { return files.remove(n).then(function () { removed++; }, function () { /* keep going */ }); });
    }
    return chain.then(function () { return removed; });
  }

  return {
    save: function (playlistId, section, data, options) {
      let name: string;
      try { name = catalogueFileName(playlistId, section); } catch (e) { return Promise.reject(e); }
      return saveAs(name, playlistId, section, data, options);
    },

    load: function <T>(playlistId: string, section: CatalogueSection, validate: (x: unknown) => x is T): Promise<LoadResult<T>> {
      let name: string;
      try { name = catalogueFileName(playlistId, section); } catch (e) { return Promise.reject(e); }
      return loadAs(name, playlistId, section, validate);
    },

    savePage: function (playlistId, section, gen, kind, n, data) {
      let name: string;
      try { name = pageFileName(playlistId, section, gen, kind, n); } catch (e) { return Promise.reject(e); }
      return saveAs(name, playlistId, section + '.' + gen + '-' + kind + n, data);
    },

    loadPage: function <T>(playlistId: string, section: VodPageSection, gen: string, kind: 'i' | 'n', n: number, validate: (x: unknown) => x is T): Promise<LoadResult<T>> {
      let name: string;
      try { name = pageFileName(playlistId, section, gen, kind, n); } catch (e) { return Promise.reject(e); }
      return loadAs(name, playlistId, section + '.' + gen + '-' + kind + n, validate);
    },

    removePages: function (playlistId, section, keepGen) {
      if (!PLAYLIST_ID_RE.test(playlistId)) {
        return Promise.reject(new Error('invalid playlist id'));
      }
      return pageFiles(playlistId, section, keepGen).then(removeAll);
    },

    removePlaylist: function (playlistId) {
      if (!PLAYLIST_ID_RE.test(playlistId)) {
        return Promise.reject(new Error('invalid playlist id'));
      }
      let removed = 0;
      let chain: Promise<void> = Promise.resolve();
      for (let i = 0; i < SECTIONS.length; i++) {
        const name = catalogueFileName(playlistId, SECTIONS[i]);
        chain = chain.then(function () {
          return files.read(name).then(function (t) {
            if (t !== null) {
              removed++;
            }
            return files.remove(name);
          });
        });
      }
      return chain.then(function () {
        return Promise.all([pageFiles(playlistId, 'movie', null), pageFiles(playlistId, 'series', null)]);
      }).then(function (lists) {
        return removeAll(lists[0].concat(lists[1]));
      }).then(function (pages) { return removed + pages; });
    },

    cleanup: function (known) {
      return files.list().then(function (names) {
        const doomed: string[] = [];
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          if (n.indexOf('cat.') !== 0) {
            continue; // not ours
          }
          const m = FILE_RE.exec(n);
          if (!m || m[6] || known.indexOf(m[1]) < 0) {
            doomed.push(n);
          }
        }
        let chain: Promise<void> = Promise.resolve();
        let removed = 0;
        for (let j = 0; j < doomed.length; j++) {
          const target = doomed[j];
          chain = chain.then(function () {
            return files.remove(target).then(function () { removed++; }, function () { /* keep going */ });
          });
        }
        return chain.then(function () {
          if (removed && log) { log.info('catalogue: cleanup removed files', { removed: removed }); }
          return { removed: removed };
        });
      });
    }
  };
}
