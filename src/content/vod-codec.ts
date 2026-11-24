// Compact on-disk form of a movie or series list (catalogue sections 'movie' and 'series',
// Stage 6) and the builder that the Xtream import fills while the list streams in.
// Same ideas as catalogue-codec.ts (live): rows are arrays, categories are referenced by index,
// image URL prefixes (everything up to the last '/') are shared through a table, and rows are
// built during parsing so no object-per-item copy of the provider response is kept.
//
// Payload (version 1):
//   { "v":1, "s":"movie"|"series",
//     "c": [[categoryId, name, adult(0|1)], …],
//     "p": [imageUrlPrefix, …],
//     "r": [[id, name, catIdx, imgPfx, imgRest, year, rating10, added, ext, genre, flags], …] }
//   year 0 / rating10 -1 / added 0 when unknown; rating10 = rating × 10 (integer 0–100);
//   imgPfx -1 when there is no shared prefix (imgRest is then the whole URL, or '' for none);
//   flags: 1 adult. Text is stored as-is (CatalogueStore escapes non-ASCII for the TV).
import type { Category, VodCatalogue, VodItem } from '../models/content.ts';

export const VOD_FORMAT_VERSION = 1;
const MAX_PREFIXES = 5000;
const MAX_CATEGORIES = 10000;
export const VOD_UNCATEGORISED = '_';

type Row = [string, string, number, number, string, number, number, number, string, string, number];

export interface VodPayload {
  v: number;
  s: 'movie' | 'series';
  c: [string, string, number][];
  p: string[];
  r: Row[];
}

export interface VodInput {
  id: string;
  name: string;
  categoryId: string;
  image: string;
  year: number | null;
  rating: number | null;
  added: number | null;
  ext: string;
  genre: string;
  adult: boolean;
}

export interface VodBuilder {
  addCategory(id: string, name: string, adult: boolean): boolean;
  /** false for a repeated id (the first entry wins). */
  addItem(x: VodInput): boolean;
  count(): number;
  finish(): { payload: VodPayload; categories: number; items: number };
}

export function createVodBuilder(section: 'movie' | 'series'): VodBuilder {
  const cats: [string, string, number][] = [];
  const catIndex: Record<string, number> = {};
  const prefixes: string[] = [];
  const prefixIndex: Record<string, number> = {};
  const rows: Row[] = [];
  const seen: Record<string, boolean> = {};

  function category(id: string): number {
    const k = 'k' + id;
    if (Object.prototype.hasOwnProperty.call(catIndex, k)) {
      return catIndex[k];
    }
    if (id !== VOD_UNCATEGORISED) {
      return category(VOD_UNCATEGORISED); // a category the provider did not list
    }
    cats.push([VOD_UNCATEGORISED, '', 0]);
    catIndex[k] = cats.length - 1;
    return cats.length - 1;
  }

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

  return {
    addCategory: function (id, name, adult) {
      const k = 'k' + id;
      if (Object.prototype.hasOwnProperty.call(catIndex, k)) {
        return true;
      }
      if (cats.length >= MAX_CATEGORIES) {
        return false;
      }
      cats.push([id, name, adult ? 1 : 0]);
      catIndex[k] = cats.length - 1;
      return true;
    },
    addItem: function (x) {
      const k = 'k' + x.id;
      if (seen[k]) {
        return false;
      }
      seen[k] = true;
      const ci = category(x.categoryId || VOD_UNCATEGORISED);
      let ip = -1;
      let ir = '';
      if (x.image) {
        const pr = prefixOf(x.image);
        ip = pr[0];
        ir = pr[1];
      }
      const rating = x.rating !== null && x.rating >= 0 && x.rating <= 10 ? Math.round(x.rating * 10) : -1;
      rows.push([x.id, x.name, ci, ip, ir, x.year !== null && x.year > 0 ? x.year : 0, rating,
        x.added !== null && x.added > 0 ? x.added : 0, x.ext, x.genre, (x.adult || cats[ci][2] === 1) ? 1 : 0]);
      return true;
    },
    count: function () { return rows.length; },
    finish: function () {
      return { payload: { v: VOD_FORMAT_VERSION, s: section, c: cats, p: prefixes, r: rows }, categories: cats.length, items: rows.length };
    }
  };
}

function isArr(x: unknown): x is unknown[] {
  return Object.prototype.toString.call(x) === '[object Array]';
}

/** Shallow shape check for CatalogueStore.load; decodeVod checks every row. */
export function isVodPayload(x: unknown): x is VodPayload {
  const p = x as VodPayload;
  return !!p && typeof p === 'object' && p.v === VOD_FORMAT_VERSION && (p.s === 'movie' || p.s === 'series') &&
    isArr(p.c) && isArr(p.p) && isArr(p.r);
}

/**
 * Expands the stored payload. Malformed rows are skipped and counted (one bad row must not hide
 * the whole catalogue); null only when the categories themselves are unusable.
 */
export function decodeVod(p: VodPayload): { catalogue: VodCatalogue; skipped: number } | null {
  const section = p.s;
  const categories: Category[] = [];
  for (let i = 0; i < p.c.length; i++) {
    const c = p.c[i];
    if (!isArr(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string') {
      return null;
    }
    categories.push({ id: c[0], name: c[1], section: section, count: 0, adult: c[2] === 1 });
  }
  const items: VodItem[] = [];
  let skipped = 0;
  for (let j = 0; j < p.r.length; j++) {
    const r = p.r[j];
    if (!isArr(r) || r.length !== 11 || typeof r[0] !== 'string' || typeof r[1] !== 'string' || typeof r[2] !== 'number' ||
        !(r[2] >= 0 && r[2] < categories.length) || typeof r[3] !== 'number' || r[3] >= p.p.length || typeof r[4] !== 'string' ||
        typeof r[5] !== 'number' || typeof r[6] !== 'number' || typeof r[7] !== 'number' || typeof r[8] !== 'string' ||
        typeof r[9] !== 'string' || typeof r[10] !== 'number') {
      skipped++;
      continue;
    }
    const it: VodItem = { id: r[0], name: r[1], categoryId: categories[r[2]].id, adult: (r[10] & 1) === 1 };
    if (r[4]) { it.poster = (r[3] >= 0 ? p.p[r[3]] : '') + r[4]; }
    if (r[5] > 0) { it.year = r[5]; }
    if (r[6] >= 0) { it.rating = r[6] / 10; }
    if (r[7] > 0) { it.added = r[7]; }
    if (r[8]) { it.ext = r[8]; }
    if (r[9]) { it.genre = r[9]; }
    categories[r[2]].count++;
    items.push(it);
  }
  return { catalogue: { section: section, categories: categories, items: items }, skipped: skipped };
}
