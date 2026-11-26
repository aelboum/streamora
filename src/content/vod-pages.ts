// Index-only, paged movie/series catalogues (Stage 6.1; ARCHITECTURE.md rev 3 §7 "keep only an
// index on disk"). Replaces the Stage 6 single-file list, which reached 12.6 M characters for a
// real provider (108,521 movies): 11.8 s to open, a 3.3 s UI freeze while parsing, and the whole
// list in memory.
//
// On disk (CatalogueStore, ASCII-escaped and checksummed like every catalogue file):
//   section file  cat.<pl>.movie.json   the INDEX (small): categories with their position ranges,
//                                       the shared image-URL prefixes, page counts, generation id
//   item pages    cat.<pl>.movie.<gen>-i<k>.json   1,000 rows each:
//                 [id, name, imgPfx, imgRest, year, rating10, ext, genre, flags]
//   name pages    cat.<pl>.movie.<gen>-n<k>.json   10,000 lower-cased names joined by "\n" (search)
// Positions are global (0 … total-1, the browse order). A category is a list of position runs
// [start, length, start, length, …]; with per-category downloads every category is one run.
// A new generation is written next to the old one and becomes current only when its index is
// saved, so an interrupted or failed update leaves the previous catalogue intact.
//
// In memory (VodView): the index, at most MAX_ITEM_PAGES item pages (LRU) and, while a search
// runs, one name page at a time. Memory therefore does not grow with the catalogue.
import type { CatalogueStore, VodPageSection } from '../storage/catalogue-store.ts';
import type { Category, VodItem } from '../models/content.ts';
import { fnv1a32 } from '../utils/bytes.ts';

export const VOD_INDEX_VERSION = 2;
export const PAGE_ITEMS = 1000;
export const NAME_PAGE = 10000;
const MAX_PREFIXES = 5000;
const MAX_CATEGORIES = 10000;
const MAX_ITEM_PAGES = 8;
const MAX_HOT_ITEMS = 400;
export const VOD_UNCATEGORISED = '_';

type Row = [string, string, number, string, number, number, string, string, number];

export interface VodIndexPayload {
  v: number;
  s: VodPageSection;
  /** Generation of the page files this index belongs to. */
  g: string;
  /** Number of items (positions). */
  t: number;
  /** Item pages and name pages. */
  ip: number;
  np: number;
  /** [categoryId, name, adult(0|1), runs] */
  c: [string, string, number, number[]][];
  /** Shared image-URL prefixes. */
  p: string[];
  /** Content hash (incremental updates: an identical list is not rewritten). */
  h: string;
}

interface ItemPage { v: number; r: Row[] }
interface NamePage { v: number; n: string }

function isArr(x: unknown): x is unknown[] {
  return Object.prototype.toString.call(x) === '[object Array]';
}

export function isVodIndex(x: unknown): x is VodIndexPayload {
  const p = x as VodIndexPayload;
  return !!p && typeof p === 'object' && p.v === VOD_INDEX_VERSION && (p.s === 'movie' || p.s === 'series') &&
    typeof p.g === 'string' && typeof p.t === 'number' && typeof p.ip === 'number' && typeof p.np === 'number' &&
    isArr(p.c) && isArr(p.p) && typeof p.h === 'string';
}
function isItemPage(x: unknown): x is ItemPage {
  const p = x as ItemPage;
  return !!p && typeof p === 'object' && p.v === VOD_INDEX_VERSION && isArr(p.r);
}
function isNamePage(x: unknown): x is NamePage {
  const p = x as NamePage;
  return !!p && typeof p === 'object' && p.v === VOD_INDEX_VERSION && typeof p.n === 'string';
}

// ------------------------------------------------------------------ writer (refresh)

export interface VodInput {
  id: string;
  name: string;
  image: string;
  year: number | null;
  rating: number | null;
  ext: string;
  genre: string;
  adult: boolean;
}

export interface VodPageWriter {
  /** Registers a category; returns its index (-1 when the cap is reached). Repeated ids return the same index. */
  addCategory(id: string, name: string, adult: boolean): number;
  /** Appends an item to category `cat` (index from addCategory). false for a repeated id. */
  addItem(cat: number, x: VodInput): boolean;
  count(): number;
  /** Writes the remaining pages; resolves the index to commit (not yet saved), or rejects on a write failure. */
  finish(): Promise<VodIndexPayload>;
  /** Set when a page write failed (the update must fail). */
  failed(): boolean;
  /** Longest single page write (ms, diagnostics). */
  maxWriteMs(): number;
  /** Longest synchronous page encoding (ms, diagnostics). */
  maxEncodeMs(): number;
}

export function createVodPageWriter(store: CatalogueStore, pid: string, section: VodPageSection, gen: string, now?: () => number): VodPageWriter {
  const clock = now || function () { return Date.now(); };
  let maxWrite = 0;
  let maxEncode = 0;
  const cats: [string, string, number, number[]][] = [];
  const catIndex: Record<string, number> = {};
  const prefixes: string[] = [];
  const prefixIndex: Record<string, number> = {};
  const seen: Record<string, boolean> = {};
  const checksums: string[] = [];
  let rows: Row[] = [];
  let names: string[] = [];
  let total = 0;
  let itemPages = 0;
  let namePages = 0;
  let lastCat = -1;
  let writeError = false;
  let chain: Promise<void> = Promise.resolve();

  function prefixOf(url: string): [number, string] {
    const slash = url.lastIndexOf('/');
    if (slash < 8) {
      return [-1, url];
    }
    const pfx = url.substring(0, slash + 1);
    const k = 'k' + pfx;
    if (Object.prototype.hasOwnProperty.call(prefixIndex, k)) {
      return [prefixIndex[k], url.substring(slash + 1)];
    }
    if (prefixes.length >= MAX_PREFIXES) {
      return [-1, url];
    }
    prefixes.push(pfx);
    prefixIndex[k] = prefixes.length - 1;
    return [prefixes.length - 1, url.substring(slash + 1)];
  }

  function queue(kind: 'i' | 'n', n: number, data: unknown): void {
    chain = chain.then(function () {
      if (writeError) {
        return;
      }
      const t0 = clock();
      const pending = store.savePage(pid, section, gen, kind, n, data);
      const enc = clock() - t0; // synchronous part: JSON, ASCII escaping, checksum
      if (enc > maxEncode) { maxEncode = enc; }
      return pending.then(function (r) {
        const ms = clock() - t0;
        if (ms > maxWrite) { maxWrite = ms; }
        if (r.ok) {
          checksums.push(kind + n + ':' + r.checksum);
        } else {
          writeError = true;
        }
      }, function () { writeError = true; });
    });
  }

  function flushItems(): void {
    if (rows.length) {
      queue('i', itemPages++, { v: VOD_INDEX_VERSION, r: rows });
      rows = [];
    }
  }
  function flushNames(): void {
    if (names.length) {
      queue('n', namePages++, { v: VOD_INDEX_VERSION, n: names.join('\n') });
      names = [];
    }
  }

  return {
    addCategory: function (id, name, adult) {
      const k = 'k' + id;
      if (Object.prototype.hasOwnProperty.call(catIndex, k)) {
        return catIndex[k];
      }
      if (cats.length >= MAX_CATEGORIES) {
        return -1;
      }
      cats.push([id, name, adult ? 1 : 0, []]);
      catIndex[k] = cats.length - 1;
      return cats.length - 1;
    },
    addItem: function (cat, x) {
      const k = 'k' + x.id;
      if (seen[k] || cat < 0 || cat >= cats.length) {
        return false;
      }
      seen[k] = true;
      const runs = cats[cat][3];
      if (cat === lastCat && runs.length && runs[runs.length - 2] + runs[runs.length - 1] === total) {
        runs[runs.length - 1]++;
      } else {
        runs.push(total, 1);
      }
      lastCat = cat;
      let ip = -1;
      let ir = '';
      if (x.image) {
        const pr = prefixOf(x.image);
        ip = pr[0];
        ir = pr[1];
      }
      const rating = x.rating !== null && x.rating >= 0 && x.rating <= 10 ? Math.round(x.rating * 10) : -1;
      rows.push([x.id, x.name, ip, ir, x.year !== null && x.year > 0 ? x.year : 0, rating, x.ext, x.genre, (x.adult || cats[cat][2] === 1) ? 1 : 0]);
      names.push(x.name.toLowerCase().replace(/\n/g, ' '));
      total++;
      if (rows.length >= PAGE_ITEMS) { flushItems(); }
      if (names.length >= NAME_PAGE) { flushNames(); }
      return true;
    },
    count: function () { return total; },
    failed: function () { return writeError; },
    maxWriteMs: function () { return maxWrite; },
    maxEncodeMs: function () { return maxEncode; },
    finish: function () {
      flushItems();
      flushNames();
      return chain.then(function (): VodIndexPayload {
        if (writeError) {
          throw new Error('page write failed');
        }
        const h = fnv1a32(checksums.join(',') + '|' + JSON.stringify(cats) + '|' + prefixes.join('\n'));
        return { v: VOD_INDEX_VERSION, s: section, g: gen, t: total, ip: itemPages, np: namePages, c: cats, p: prefixes, h: h };
      });
    }
  };
}

// ------------------------------------------------------------------ view (browse, search)

/** A browse list: `length` items, `at(i)` gives the global position of the i-th. */
export interface ListRef {
  length: number;
  at(i: number): number;
}

export interface SearchJob {
  /** Positions, prefix matches first, at most `max`. */
  result: Promise<number[]>;
  cancel(): void;
}

export interface VodView {
  readonly section: VodPageSection;
  readonly total: number;
  readonly categories: Category[];
  all(): ListRef;
  byCategory(id: string): ListRef;
  /** The item at a global position when it is in memory, else null (call ensure). */
  item(pos: number): VodItem | null;
  /** Loads the pages holding these positions and keeps the items (recently requested ones stay
   *  even when their page leaves the page cache). Resolves when done. */
  ensure(positions: number[]): Promise<void>;
  /** True when the position's page could not be read (missing or damaged file). */
  failed(pos: number): boolean;
  /** Incremental search over the name pages; `onProgress` receives the results found so far. */
  search(query: string, max: number, onProgress?: (sofar: number[]) => void): SearchJob;
  /**
   * Stage 11: title and year of each position (for sorting one category), read page by page in
   * page order; '' / 0 where a page or row could not be read. Keeps no extra pages.
   */
  sortKeys(positions: number[]): Promise<{ names: string[]; years: number[] }>;
  /** Item pages currently held (diagnostics). */
  pagesInMemory(): number;
  /** Longest page read and longest synchronous row decode (ms, diagnostics). */
  timings(): { maxReadMs: number; maxDecodeMs: number };
}

function listOf(runs: number[]): ListRef {
  const starts: number[] = [];
  const offsets: number[] = [];
  let n = 0;
  for (let i = 0; i + 1 < runs.length; i += 2) {
    starts.push(runs[i]);
    offsets.push(n);
    n += runs[i + 1];
  }
  return {
    length: n,
    at: function (i) {
      let lo = 0;
      let hi = offsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= i) { lo = mid; } else { hi = mid - 1; }
      }
      return starts[lo] + (i - offsets[lo]);
    }
  };
}

export function createVodView(store: CatalogueStore, pid: string, idx: VodIndexPayload, onPageError?: (page: number) => void): VodView {
  let maxRead = 0;
  let maxDecode = 0;
  const section = idx.s;
  const categories: Category[] = [];
  // Run starts → category, for VodItem.categoryId (sorted by start).
  const runStart: number[] = [];
  const runEnd: number[] = [];
  const runCat: number[] = [];
  const lists: Record<string, ListRef> = {};
  for (let i = 0; i < idx.c.length; i++) {
    const c = idx.c[i];
    const runs = isArr(c[3]) ? c[3] : [];
    let count = 0;
    for (let j = 0; j + 1 < runs.length; j += 2) {
      count += runs[j + 1];
      runStart.push(runs[j]);
      runEnd.push(runs[j] + runs[j + 1]);
      runCat.push(i);
    }
    categories.push({ id: String(c[0]), name: String(c[1]), section: section, count: count, adult: c[2] === 1 });
    lists['k' + c[0]] = listOf(runs);
  }
  const order: number[] = [];
  for (let k = 0; k < runStart.length; k++) { order.push(k); }
  order.sort(function (a, b) { return runStart[a] - runStart[b]; });
  const sStart: number[] = [];
  const sEnd: number[] = [];
  const sCat: number[] = [];
  for (let k = 0; k < order.length; k++) { sStart.push(runStart[order[k]]); sEnd.push(runEnd[order[k]]); sCat.push(runCat[order[k]]); }

  function categoryAt(pos: number): string {
    let lo = 0;
    let hi = sStart.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sStart[mid] <= pos) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found >= 0 && pos < sEnd[found] ? categories[sCat[found]].id : VOD_UNCATEGORISED;
  }

  const pages: Record<string, VodItem[]> = {};
  const pageOrder: number[] = []; // LRU: most recently used last
  const loading: Record<string, Promise<void>> = {};
  const badPages: Record<string, boolean> = {};
  // Recently requested items by position (search hits may sit on many different pages).
  const hot: Record<string, VodItem> = {};
  const hotOrder: number[] = [];

  function keepHot(pos: number, it: VodItem): void {
    const k = 'h' + pos;
    if (!Object.prototype.hasOwnProperty.call(hot, k)) {
      hotOrder.push(pos);
      while (hotOrder.length > MAX_HOT_ITEMS) {
        delete hot['h' + hotOrder.shift()];
      }
    }
    hot[k] = it;
  }

  function touch(n: number): void {
    const i = pageOrder.indexOf(n);
    if (i >= 0) { pageOrder.splice(i, 1); }
    pageOrder.push(n);
    while (pageOrder.length > MAX_ITEM_PAGES) {
      const old = pageOrder.shift() as number;
      delete pages['p' + old];
    }
  }

  function decodeRow(r: unknown, pos: number): VodItem | null {
    if (!isArr(r) || r.length !== 9 || typeof r[0] !== 'string' || typeof r[1] !== 'string' || typeof r[2] !== 'number' ||
        r[2] >= idx.p.length || typeof r[3] !== 'string' || typeof r[4] !== 'number' || typeof r[5] !== 'number' ||
        typeof r[6] !== 'string' || typeof r[7] !== 'string' || typeof r[8] !== 'number') {
      return null;
    }
    const it: VodItem = { id: r[0], name: r[1], categoryId: categoryAt(pos), adult: (r[8] & 1) === 1 };
    if (r[3]) { it.poster = (r[2] >= 0 ? idx.p[r[2]] : '') + r[3]; }
    if (r[4] > 0) { it.year = r[4]; }
    if (r[5] >= 0) { it.rating = r[5] / 10; }
    if (r[6]) { it.ext = r[6]; }
    if (r[7]) { it.genre = r[7]; }
    return it;
  }

  function loadPage(n: number): Promise<void> {
    const key = 'p' + n;
    if (pages[key]) {
      touch(n);
      return Promise.resolve();
    }
    if (Object.prototype.hasOwnProperty.call(loading, key)) {
      return loading[key];
    }
    const tr = Date.now();
    const p = store.loadPage(pid, section, idx.g, 'i', n, isItemPage).then(function (r) {
      delete loading[key];
      const td = Date.now();
      if (td - tr > maxRead) { maxRead = td - tr; }
      const items: VodItem[] = [];
      if (r.status === 'ok') {
        for (let i = 0; i < r.data.r.length; i++) {
          items.push(decodeRow(r.data.r[i], n * PAGE_ITEMS + i) as VodItem);
        }
        if (Date.now() - td > maxDecode) { maxDecode = Date.now() - td; }
        pages[key] = items;
        touch(n);
      } else {
        badPages[key] = true; // not retried on every bind; a new update rewrites the pages
        if (onPageError) { onPageError(n); }
      }
    }, function () {
      delete loading[key];
      badPages[key] = true;
      if (onPageError) { onPageError(n); }
    });
    loading[key] = p;
    return p;
  }

  const allList: ListRef = { length: idx.t, at: function (i) { return i; } };
  const emptyList: ListRef = { length: 0, at: function (i) { return i; } };

  return {
    section: section,
    total: idx.t,
    categories: categories,
    all: function () { return allList; },
    byCategory: function (id) { return lists['k' + id] || emptyList; },
    item: function (pos) {
      if (pos < 0 || pos >= idx.t) {
        return null;
      }
      const pg = pages['p' + Math.floor(pos / PAGE_ITEMS)];
      const it = pg ? pg[pos % PAGE_ITEMS] : null;
      if (it) {
        return it;
      }
      return Object.prototype.hasOwnProperty.call(hot, 'h' + pos) ? hot['h' + pos] : null;
    },
    failed: function (pos) {
      // An unreadable page, or a malformed row in a loaded page (skipped, never requested again).
      const k = 'p' + Math.floor(pos / PAGE_ITEMS);
      return badPages[k] === true || (!!pages[k] && !pages[k][pos % PAGE_ITEMS] && !Object.prototype.hasOwnProperty.call(hot, 'h' + pos));
    },
    ensure: function (positions) {
      // Group by page, in page order; each page is read once and its requested items kept.
      const byPage: Record<string, number[]> = {};
      const order: number[] = [];
      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (pos < 0 || pos >= idx.t) { continue; }
        const n = Math.floor(pos / PAGE_ITEMS);
        if (badPages['p' + n]) { continue; }
        if (!byPage['p' + n]) { byPage['p' + n] = []; order.push(n); }
        byPage['p' + n].push(pos);
      }
      order.sort(function (a, b) { return a - b; });
      let chain: Promise<void> = Promise.resolve();
      for (let k = 0; k < order.length; k++) {
        const pn = order[k];
        chain = chain.then(function () {
          return loadPage(pn).then(function () {
            const pg = pages['p' + pn];
            const want = byPage['p' + pn];
            if (!pg) { return; }
            for (let j = 0; j < want.length; j++) {
              const it = pg[want[j] % PAGE_ITEMS];
              if (it) { keepHot(want[j], it); }
            }
          });
        });
      }
      return chain;
    },
    search: function (query, max, onProgress) {
      const words = query.toLowerCase().replace(/^\s+|\s+$/g, '').split(/\s+/);
      let cancelled = false;
      const starts: number[] = [];
      const contains: number[] = [];
      function scan(k: number): Promise<number[]> {
        if (cancelled || k >= idx.np || starts.length >= max) {
          return Promise.resolve(starts.concat(contains).slice(0, max));
        }
        return store.loadPage(pid, section, idx.g, 'n', k, isNamePage).then(function (r) {
          if (cancelled) {
            return starts.concat(contains).slice(0, max);
          }
          // One name page at a time: the previous page is released before the next is read.
          const list = r.status === 'ok' ? r.data.n.split('\n') : [];
          const base = k * NAME_PAGE;
          for (let j = 0; j < list.length && starts.length < max; j++) {
            const n = list[j];
            let ok = true;
            for (let w = 0; w < words.length; w++) {
              if (n.indexOf(words[w]) < 0) { ok = false; break; }
            }
            if (ok) {
              if (n.indexOf(words[0]) === 0) { starts.push(base + j); } else if (contains.length < max) { contains.push(base + j); }
            }
          }
          if (onProgress) {
            onProgress(starts.concat(contains).slice(0, max));
          }
          return scan(k + 1);
        });
      }
      const result = words[0] ? scan(0) : Promise.resolve([]);
      return { result: result, cancel: function () { cancelled = true; } };
    },
    sortKeys: function (positions) {
      const names: string[] = [];
      const years: number[] = [];
      const byPage: Record<string, number[]> = {};
      const order: number[] = [];
      for (let i = 0; i < positions.length; i++) {
        names.push('');
        years.push(0);
        const pos = positions[i];
        if (pos < 0 || pos >= idx.t) { continue; }
        const n = Math.floor(pos / PAGE_ITEMS);
        if (!byPage['p' + n]) { byPage['p' + n] = []; order.push(n); }
        byPage['p' + n].push(i);
      }
      order.sort(function (a, b) { return a - b; });
      let chain: Promise<void> = Promise.resolve();
      for (let k = 0; k < order.length; k++) {
        const pn = order[k];
        chain = chain.then(function () {
          return loadPage(pn).then(function () {
            const pg = pages['p' + pn];
            if (!pg) { return; }
            const want = byPage['p' + pn];
            for (let j = 0; j < want.length; j++) {
              const it = pg[positions[want[j]] % PAGE_ITEMS];
              if (it) { names[want[j]] = it.name; years[want[j]] = it.year || 0; }
            }
          });
        });
      }
      return chain.then(function () { return { names: names, years: years }; });
    },
    pagesInMemory: function () { return pageOrder.length; },
    timings: function () { return { maxReadMs: maxRead, maxDecodeMs: maxDecode }; }
  };
}
