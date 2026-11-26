// Viewing progress and watched marks (Stage 7B.2: resume, Continue watching, episode marks).
//   KV "progress.<playlistId>"  unfinished titles, newest first (max 50)
//   KV "watched.<playlistId>"   keys of titles watched to the end (max 3,000)
// A key is "m:<streamId>" for a movie or "e:<episodeId>" for an episode. Entries store only what
// the screens need to show a card and restart playback (title, poster URL, stream reference and
// the movie/series item for Details); stream URLs with credentials are never stored here, because
// StreamRef for Xtream holds ids only.
// Rules: a position under 30 s is not worth resuming; 95 % or more counts as watched (the entry
// moves to the watched list).
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { StreamRef, VodItem } from '../models/content.ts';
import { isPlaylistId } from '../models/content.ts';

export const MAX_PROGRESS = 50;
export const MAX_WATCHED = 3000;
export const MIN_RESUME_MS = 30000;
export const WATCHED_RATIO = 0.95;

export interface ProgressEntry {
  key: string;
  section: 'movie' | 'series';
  title: string;
  /** Second line: "S1 E3 · Title" for episodes, empty for movies. */
  sub: string;
  poster: string;
  ref: StreamRef;
  /** The movie or series, to open Details. */
  item: VodItem;
  pos: number;
  dur: number;
  /** epoch ms */
  at: number;
}

export interface ProgressStore {
  list(playlistId: string): ProgressEntry[];
  get(playlistId: string, key: string): ProgressEntry | null;
  /** Saves the position; finished titles are removed and marked watched. Returns the stored entry. */
  save(playlistId: string, e: ProgressEntry): ProgressEntry | null;
  remove(playlistId: string, key: string): void;
  isWatched(playlistId: string, key: string): boolean;
  clear(playlistId: string): void;
}

const KEY_RE = /^[me]:[A-Za-z0-9_.-]{1,80}$/;

function isEntry(x: unknown): x is ProgressEntry {
  const e = x as ProgressEntry;
  return !!e && typeof e === 'object' && typeof e.key === 'string' && KEY_RE.test(e.key) &&
    (e.section === 'movie' || e.section === 'series') && typeof e.title === 'string' && typeof e.sub === 'string' &&
    typeof e.poster === 'string' && !!e.ref && typeof e.ref === 'object' && !!e.item && typeof e.item === 'object' &&
    typeof e.pos === 'number' && typeof e.dur === 'number' && typeof e.at === 'number';
}

function isEntryList(x: unknown): x is ProgressEntry[] {
  if (Object.prototype.toString.call(x) !== '[object Array]') { return false; }
  const a = x as unknown[];
  for (let i = 0; i < a.length; i++) { if (!isEntry(a[i])) { return false; } }
  return true;
}

function isKeyList(x: unknown): x is string[] {
  if (Object.prototype.toString.call(x) !== '[object Array]') { return false; }
  const a = x as unknown[];
  for (let i = 0; i < a.length; i++) { if (typeof a[i] !== 'string' || !KEY_RE.test(a[i] as string)) { return false; } }
  return true;
}

export function progressKey(section: 'movie' | 'series', id: string): string {
  return (section === 'movie' ? 'm:' : 'e:') + id;
}

export function createProgressStore(kv: KeyValueStore, now: () => number): ProgressStore {
  function pk(pid: string): string | null { return isPlaylistId(pid) ? 'progress.' + pid : null; }
  function wk(pid: string): string | null { return isPlaylistId(pid) ? 'watched.' + pid : null; }
  function read(pid: string): ProgressEntry[] { const k = pk(pid); return k ? kv.get<ProgressEntry[]>(k, isEntryList, []) : []; }
  function watched(pid: string): string[] { const k = wk(pid); return k ? kv.get<string[]>(k, isKeyList, []) : []; }

  function without(list: ProgressEntry[], key: string): ProgressEntry[] {
    const out: ProgressEntry[] = [];
    for (let i = 0; i < list.length; i++) { if (list[i].key !== key) { out.push(list[i]); } }
    return out;
  }

  return {
    list: function (pid) { return read(pid); },
    get: function (pid, key) {
      const l = read(pid);
      for (let i = 0; i < l.length; i++) { if (l[i].key === key) { return l[i]; } }
      return null;
    },
    save: function (pid, e) {
      const k = pk(pid);
      if (!k || !KEY_RE.test(e.key)) { return null; }
      const list = without(read(pid), e.key);
      const done = e.dur > 0 && e.pos >= e.dur * WATCHED_RATIO;
      if (done) {
        kv.set(k, list);
        const w = watched(pid);
        if (w.indexOf(e.key) < 0) {
          w.unshift(e.key);
          kv.set(wk(pid) as string, w.slice(0, MAX_WATCHED));
        }
        return null;
      }
      if (e.pos < MIN_RESUME_MS) {
        kv.set(k, list); // too early to resume: forget an older position
        return null;
      }
      const entry: ProgressEntry = {
        key: e.key, section: e.section, title: e.title, sub: e.sub, poster: e.poster, ref: e.ref, item: e.item,
        pos: Math.floor(e.pos), dur: Math.floor(e.dur), at: now()
      };
      list.unshift(entry);
      kv.set(k, list.slice(0, MAX_PROGRESS));
      return entry;
    },
    remove: function (pid, key) {
      const k = pk(pid);
      if (k) { kv.set(k, without(read(pid), key)); }
    },
    isWatched: function (pid, key) { return watched(pid).indexOf(key) >= 0; },
    clear: function (pid) {
      const k = pk(pid);
      const w = wk(pid);
      if (k) { kv.remove(k); }
      if (w) { kv.remove(w); }
    }
  };
}
