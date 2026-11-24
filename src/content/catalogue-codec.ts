// Compact on-disk form of a live catalogue (catalogue section 'live') and the builder that
// sources fill while an import streams in.
//
// TV file throughput is about 1.5 MB/s [M], so the stored form is small: channels are arrays
// (no repeated keys), categories are referenced by index, and URL prefixes (everything up to the
// last '/') are shared through a table. Rows are built directly during parsing, so an import
// never holds a second, object-per-channel copy of the playlist.
//
// Payload (version 1):
//   { "v":1,
//     "c": [[categoryId, name, adult(0|1)], …],
//     "p": [urlPrefix, …],
//     "u": [userAgentOrReferrer, …],
//     "r": [[id, num, name, catIdx, logoPfx, logoRest, epgKey, sk, sp, sr, flags, catchupDays, uaIdx, refIdx], …] }
//   sk 0 = Xtream stream (sp = type 'live'|'movie'|'series' + ':' + ext or '', sr = stream id)
//   sk 1 = URL (sp = prefix index or -1, sr = rest of the URL)
//   flags: 1 adult, 2 credential placeholders in the URL, 4 radio
//   logoPfx / uaIdx / refIdx = -1 when absent; catchupDays 0 when absent.
import type { Category, Channel, LiveCatalogue, Section, StreamRef } from '../models/content.ts';
import { fnv1a32 } from '../utils/bytes.ts';

export const LIVE_FORMAT_VERSION = 1;
const MAX_PREFIXES = 5000;
const MAX_STRINGS = 200;
const MAX_CATEGORIES = 10000;

type Row = [string, number, string, number, number, string, string, number, string, string, number, number, number, number];

export interface LivePayload {
  v: number;
  c: [string, string, number][];
  p: string[];
  u: string[];
  r: Row[];
}

export interface ChannelInput {
  /** Provider id (Xtream stream_id); M3U channels get a hash of their stream reference. */
  providerId?: string;
  num: number | null;
  name: string;
  categoryId: string;
  logo: string;
  epgKey: string;
  ref: StreamRef;
  adult: boolean;
  radio: boolean;
  catchupDays: number | null;
  userAgent: string;
  referrer: string;
}

export interface LiveBuilder {
  /** Registers a category; repeated ids are ignored. Returns false when the category cap is reached. */
  addCategory(id: string, name: string, adult: boolean): boolean;
  hasCategory(id: string): boolean;
  /** Adds a channel. Returns false for a duplicate stream reference. */
  addChannel(c: ChannelInput): boolean;
  channelCount(): number;
  finish(): { payload: LivePayload; categories: number; channels: number };
}

const ADULT_RE = /(^|[^a-z0-9])(xxx|adults?|18\+|porn|erotic|for adults)([^a-z0-9]|$)/i;

export function looksAdult(name: string): boolean {
  return ADULT_RE.test(name);
}

export const UNCATEGORISED = '_';

function refKey(ref: StreamRef): string {
  return ref.kind === 'xtream' ? 'x' + ref.type + ':' + ref.id : 'u' + ref.url;
}

export function createLiveBuilder(): LiveBuilder {
  const cats: [string, string, number][] = [];
  const catIndex: Record<string, number> = {};
  const prefixes: string[] = [];
  const prefixIndex: Record<string, number> = {};
  const strings: string[] = [];
  const stringIndex: Record<string, number> = {};
  const rows: Row[] = [];
  const seenRef: Record<string, boolean> = {};
  const seenId: Record<string, boolean> = {};
  let autoNum = 0;

  function category(id: string): number {
    const k = 'k' + id;
    if (Object.prototype.hasOwnProperty.call(catIndex, k)) {
      return catIndex[k];
    }
    if (id !== UNCATEGORISED) {
      // A channel in a category the provider did not list: file it under "uncategorised".
      return category(UNCATEGORISED);
    }
    cats.push([UNCATEGORISED, '', 0]);
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

  function stringRef(s: string): number {
    if (!s) {
      return -1;
    }
    const k = 'k' + s;
    if (Object.prototype.hasOwnProperty.call(stringIndex, k)) {
      return stringIndex[k];
    }
    if (strings.length >= MAX_STRINGS) {
      return -1;
    }
    strings.push(s);
    stringIndex[k] = strings.length - 1;
    return strings.length - 1;
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
    hasCategory: function (id) {
      return Object.prototype.hasOwnProperty.call(catIndex, 'k' + id);
    },
    addChannel: function (c) {
      const key = refKey(c.ref);
      if (seenRef[key]) {
        return false;
      }
      seenRef[key] = true;
      let id = c.providerId || ('m' + fnv1a32(key));
      for (let n = 2; seenId['k' + id]; n++) {
        id = (c.providerId || ('m' + fnv1a32(key))) + '-' + n;
      }
      seenId['k' + id] = true;
      autoNum++;
      const catIdx = category(c.categoryId || UNCATEGORISED);
      let logoP = -1;
      let logoR = '';
      if (c.logo) {
        const lp = prefixOf(c.logo);
        logoP = lp[0];
        logoR = lp[1];
      }
      let sk: number;
      let sp: string;
      let sr: string;
      let flags = (c.adult || cats[catIdx][2] === 1 ? 1 : 0) | (c.radio ? 4 : 0);
      if (c.ref.kind === 'xtream') {
        sk = 0;
        sp = c.ref.type + ':' + (c.ref.ext || '');
        sr = c.ref.id;
      } else {
        sk = 1;
        const up = prefixOf(c.ref.url);
        sp = String(up[0]);
        sr = up[1];
        if (c.ref.cred) {
          flags |= 2;
        }
      }
      rows.push([id, c.num !== null && c.num > 0 ? c.num : autoNum, c.name, catIdx, logoP, logoR, c.epgKey, sk, sp, sr,
        flags, c.catchupDays && c.catchupDays > 0 ? c.catchupDays : 0, stringRef(c.userAgent), stringRef(c.referrer)]);
      return true;
    },
    channelCount: function () { return rows.length; },
    finish: function () {
      return { payload: { v: LIVE_FORMAT_VERSION, c: cats, p: prefixes, u: strings, r: rows }, categories: cats.length, channels: rows.length };
    }
  };
}

function isArr(x: unknown): x is unknown[] {
  return Object.prototype.toString.call(x) === '[object Array]';
}

/** Shallow shape check used by CatalogueStore.load; decodeLive does the per-row checks. */
export function isLivePayload(x: unknown): x is LivePayload {
  const p = x as LivePayload;
  return !!p && typeof p === 'object' && p.v === LIVE_FORMAT_VERSION && isArr(p.c) && isArr(p.p) && isArr(p.u) && isArr(p.r);
}

const SECTIONS: Record<string, Section> = { live: 'live', movie: 'movie', series: 'series' };

/** Expands the stored payload into model objects. null when any row is malformed (file treated as corrupt). */
export function decodeLive(p: LivePayload): LiveCatalogue | null {
  const categories: Category[] = [];
  const counts: number[] = [];
  for (let i = 0; i < p.c.length; i++) {
    const c = p.c[i];
    if (!isArr(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string') {
      return null;
    }
    categories.push({ id: c[0], name: c[1], section: 'live', count: 0, adult: c[2] === 1 });
    counts.push(0);
  }
  const channels: Channel[] = [];
  for (let j = 0; j < p.r.length; j++) {
    const r = p.r[j];
    if (!isArr(r) || r.length !== 14 || typeof r[0] !== 'string' || typeof r[1] !== 'number' || typeof r[2] !== 'string' ||
        typeof r[3] !== 'number' || !(r[3] >= 0 && r[3] < categories.length) || typeof r[4] !== 'number' || typeof r[5] !== 'string' ||
        typeof r[6] !== 'string' || (r[7] !== 0 && r[7] !== 1) || typeof r[8] !== 'string' || typeof r[9] !== 'string' ||
        typeof r[10] !== 'number' || typeof r[11] !== 'number' || typeof r[12] !== 'number' || typeof r[13] !== 'number') {
      return null;
    }
    let ref: StreamRef;
    if (r[7] === 0) {
      const colon = r[8].indexOf(':');
      const type = SECTIONS[colon > 0 ? r[8].substring(0, colon) : ''];
      if (!type) {
        return null;
      }
      const ext = r[8].substring(colon + 1);
      ref = ext ? { kind: 'xtream', type: type, id: r[9], ext: ext } : { kind: 'xtream', type: type, id: r[9] };
    } else {
      const pi = parseInt(r[8], 10);
      if (pi >= p.p.length || (pi < 0 && pi !== -1) || isNaN(pi)) {
        return null;
      }
      const url = (pi >= 0 ? p.p[pi] : '') + r[9];
      ref = (r[10] & 2) ? { kind: 'url', url: url, cred: true } : { kind: 'url', url: url };
    }
    if (r[4] >= p.p.length || r[12] >= p.u.length || r[13] >= p.u.length) {
      return null;
    }
    const ch: Channel = { id: r[0], num: r[1], name: r[2], categoryId: categories[r[3]].id, adult: (r[10] & 1) === 1, streamRef: ref };
    if (r[5]) { ch.logo = (r[4] >= 0 ? p.p[r[4]] : '') + r[5]; }
    if (r[6]) { ch.epgKey = r[6]; }
    if (r[11] > 0) { ch.catchupDays = r[11]; }
    if (r[12] >= 0) { ch.userAgent = p.u[r[12]]; }
    if (r[13] >= 0) { ch.referrer = p.u[r[13]]; }
    counts[r[3]]++;
    channels.push(ch);
  }
  for (let k = 0; k < categories.length; k++) {
    categories[k].count = counts[k];
  }
  return { categories: categories, channels: channels };
}
