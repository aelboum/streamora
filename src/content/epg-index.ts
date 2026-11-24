// Compact EPG index: the programmes kept for one playlist, keyed by XMLTV channel id (lower case),
// plus a name alias table for channels mapped by display name. Pure; stored as catalogue section
// 'epg' and loaded into memory for the active playlist only.
//
// Stored form (version 1):
//   { "v":1, "builtAt":<ms>, "from":<ms>, "to":<ms>,
//     "ch": { "<xmltv id>": [[startMin, durationMin, title, desc], …] },   sorted by start
//     "alias": { "<normalised display name>": "<xmltv id>" } }
// Times are whole minutes since the epoch (UTC) to keep the file small.
//
// Channel mapping, in order: tvg-id / epg_channel_id exact (case-insensitive) → display-name
// match on the normalised channel name. Unmapped channels have no EPG ("missing EPG").
import type { Channel, Programme } from '../models/content.ts';

export const EPG_FORMAT_VERSION = 1;

export type EpgRow = [number, number, string, string];

export interface EpgPayload {
  v: number;
  builtAt: number;
  from: number;
  to: number;
  ch: Record<string, EpgRow[]>;
  alias: Record<string, string>;
}

export function isEpgPayload(x: unknown): x is EpgPayload {
  const p = x as EpgPayload;
  return !!p && typeof p === 'object' && p.v === EPG_FORMAT_VERSION && typeof p.builtAt === 'number' &&
    typeof p.from === 'number' && typeof p.to === 'number' && !!p.ch && typeof p.ch === 'object' && !!p.alias && typeof p.alias === 'object';
}

/** Name normalisation for display-name matching: lower case, accents kept, punctuation, quality tags and spaces removed. */
export function normaliseName(s: string): string {
  return s.toLowerCase()
    .replace(/\b(uhd|fhd|hd|sd|4k|hevc|h265|\+1)\b/g, '')
    .replace(/[^0-9a-zÀ-ɏͰ-ϿЀ-ӿ]+/g, '');
}

export function epgKeyFor(p: EpgPayload, channel: Channel): string | null {
  if (channel.epgKey) {
    const k = channel.epgKey.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(p.ch, k)) {
      return k;
    }
  }
  const n = normaliseName(channel.name);
  if (n && Object.prototype.hasOwnProperty.call(p.alias, n) && Object.prototype.hasOwnProperty.call(p.ch, p.alias[n])) {
    return p.alias[n];
  }
  return null;
}

function toProgramme(r: EpgRow): Programme {
  const pr: Programme = { start: r[0] * 60000, end: (r[0] + r[1]) * 60000, title: r[2] };
  if (r[3]) { pr.desc = r[3]; }
  return pr;
}

/** Index of the last row starting at or before t (binary search), or -1. */
function rowAt(rows: EpgRow[], tMin: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= tMin) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

export interface NowNext {
  now: Programme | null;
  next: Programme | null;
}

export function nowNext(rows: EpgRow[] | undefined, t: number): NowNext {
  if (!rows || rows.length === 0) {
    return { now: null, next: null };
  }
  const tMin = t / 60000;
  const i = rowAt(rows, tMin);
  let now: Programme | null = null;
  let nextIdx = i + 1;
  if (i >= 0 && rows[i][0] + rows[i][1] > tMin) {
    now = toProgramme(rows[i]);
  } else if (i < 0) {
    nextIdx = 0;
  }
  const next = nextIdx < rows.length ? toProgramme(rows[nextIdx]) : null;
  return { now: now, next: next };
}

export function programmesBetween(rows: EpgRow[] | undefined, from: number, to: number, max: number): Programme[] {
  const out: Programme[] = [];
  if (!rows) {
    return out;
  }
  let i = Math.max(0, rowAt(rows, from / 60000));
  for (; i < rows.length && out.length < max; i++) {
    const r = rows[i];
    if ((r[0] + r[1]) * 60000 <= from) {
      continue;
    }
    if (r[0] * 60000 >= to) {
      break;
    }
    out.push(toProgramme(r));
  }
  return out;
}

/** Collects programmes during a parse; finish() sorts, de-duplicates and returns the payload. */
export interface EpgBuilder {
  /** Declares an XMLTV channel; returns true when it maps to a playlist channel. */
  addChannel(id: string, names: string[]): boolean;
  addProgramme(channelId: string, start: number, stop: number, title: string, desc: string): boolean;
  /** Ids already filled by an earlier source are skipped by later sources. */
  nextSource(): void;
  finish(builtAt: number): { payload: EpgPayload; channels: number; programmes: number };
}

export function createEpgBuilder(channels: Channel[], from: number, to: number, maxPerChannel: number, maxTotal: number): EpgBuilder {
  const wantedIds: Record<string, boolean> = {};
  const wantedNames: Record<string, boolean> = {};
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    if (c.epgKey) {
      wantedIds['k' + c.epgKey.toLowerCase()] = true;
    }
    const n = normaliseName(c.name);
    if (n) {
      wantedNames['k' + n] = true;
    }
  }
  const keep: Record<string, boolean> = {};
  const fromEarlier: Record<string, boolean> = {};
  const ch: Record<string, EpgRow[]> = {};
  const alias: Record<string, string> = {};
  let total = 0;
  const fromMin = Math.floor(from / 60000);
  const toMin = Math.ceil(to / 60000);

  function wanted(idLower: string): boolean {
    return wantedIds['k' + idLower] === true || keep['k' + idLower] === true;
  }

  return {
    addChannel: function (id, names) {
      const k = id.toLowerCase();
      let hit = wantedIds['k' + k] === true;
      for (let i = 0; i < names.length; i++) {
        const n = normaliseName(names[i]);
        if (n && wantedNames['k' + n]) {
          hit = true;
          if (!Object.prototype.hasOwnProperty.call(alias, n)) {
            alias[n] = k;
          }
        }
      }
      if (hit) {
        keep['k' + k] = true;
      }
      return hit;
    },
    addProgramme: function (channelId, start, stop, title, desc) {
      const k = channelId.toLowerCase();
      if (!wanted(k) || fromEarlier['k' + k] || total >= maxTotal) {
        return false;
      }
      const s = Math.floor(start / 60000);
      const e = Math.ceil(stop / 60000);
      if (e <= fromMin || s >= toMin) {
        return false;
      }
      if (k === '__proto__') {
        return false; // never a valid key on a plain object
      }
      let rows = Object.prototype.hasOwnProperty.call(ch, k) ? ch[k] : undefined;
      if (!rows) {
        rows = [];
        ch[k] = rows;
      }
      if (rows.length >= maxPerChannel) {
        return false;
      }
      rows.push([s, Math.max(1, e - s), title, desc]);
      total++;
      return true;
    },
    nextSource: function () {
      for (const k in ch) {
        if (Object.prototype.hasOwnProperty.call(ch, k)) {
          fromEarlier['k' + k] = true;
        }
      }
    },
    finish: function (builtAt) {
      let n = 0;
      let count = 0;
      for (const k in ch) {
        if (!Object.prototype.hasOwnProperty.call(ch, k)) {
          continue;
        }
        const rows = ch[k].sort(function (a, b) { return a[0] - b[0]; });
        const dedup: EpgRow[] = [];
        for (let i = 0; i < rows.length; i++) {
          if (dedup.length && dedup[dedup.length - 1][0] === rows[i][0]) {
            continue; // same start twice (duplicate listing)
          }
          dedup.push(rows[i]);
        }
        ch[k] = dedup;
        n++;
        count += dedup.length;
      }
      return { payload: { v: EPG_FORMAT_VERSION, builtAt: builtAt, from: from, to: to, ch: ch, alias: alias }, channels: n, programmes: count };
    }
  };
}
