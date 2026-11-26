// Stage 11: My List — movies and series the user saved, per account, on this TV only.
//   KV "mylist.movie.<playlistId>" / "mylist.series.<playlistId>": newest first, max MAX_MY_LIST each.
// An entry stores the provider id plus the few fields a card and Details need (name, poster URL,
// year, rating, container extension, genre, category, adult flag): no catalogue pages, no plots.
// Ids are only compared within one account and one section, so the same provider id in another
// account or section never matches. Nothing is removed automatically: a title that left the
// provider's catalogue stays until the user removes it (Details says when it can't be loaded).
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { VodItem } from '../models/content.ts';
import { isPlaylistId } from '../models/content.ts';

export const MAX_MY_LIST = 500;
export type MyListSection = 'movie' | 'series';

export interface MyListEntry { item: VodItem; at: number }

export interface MyList {
  list(playlistId: string, section: MyListSection): MyListEntry[];
  has(playlistId: string, section: MyListSection, id: string): boolean;
  /** 'added' | 'removed', 'full' (MAX_MY_LIST reached) or 'error' (not saved: storage failed). */
  toggle(playlistId: string, section: MyListSection, item: VodItem): 'added' | 'removed' | 'full' | 'error';
  remove(playlistId: string, section: MyListSection, id: string): boolean;
  clear(playlistId: string): void;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

function str(v: unknown, max: number): string { return typeof v === 'string' ? v.slice(0, max) : ''; }

/** Keeps only the fields a card and Details use (small entries; unknown fields dropped). */
export function compactItem(it: VodItem): VodItem {
  const out: VodItem = { id: it.id, name: str(it.name, 200), categoryId: str(it.categoryId, 80), adult: it.adult === true };
  if (it.poster && /^https?:\/\//.test(it.poster)) { out.poster = it.poster.slice(0, 500); }
  if (typeof it.year === 'number' && it.year > 0) { out.year = it.year; }
  if (typeof it.rating === 'number' && it.rating >= 0) { out.rating = it.rating; }
  if (it.ext) { out.ext = str(it.ext, 8); }
  if (it.genre) { out.genre = str(it.genre, 100); }
  return out;
}

function isEntry(x: unknown): x is MyListEntry {
  const e = x as MyListEntry;
  return !!e && typeof e === 'object' && typeof e.at === 'number' && !!e.item && typeof e.item === 'object' &&
    typeof e.item.id === 'string' && ID_RE.test(e.item.id) && typeof e.item.name === 'string' && typeof e.item.categoryId === 'string' &&
    typeof e.item.adult === 'boolean';
}

function isEntryList(x: unknown): x is MyListEntry[] {
  if (Object.prototype.toString.call(x) !== '[object Array]') { return false; }
  const a = x as unknown[];
  for (let i = 0; i < a.length; i++) { if (!isEntry(a[i])) { return false; } }
  return true;
}

export function myListKey(section: MyListSection, playlistId: string): string { return 'mylist.' + section + '.' + playlistId; }

export function createMyList(kv: KeyValueStore, now: () => number): MyList {
  function key(pid: string, section: MyListSection): string | null {
    return isPlaylistId(pid) && (section === 'movie' || section === 'series') ? myListKey(section, pid) : null;
  }
  function read(k: string): MyListEntry[] {
    // A damaged stored value reads as empty here but is not overwritten until the user changes the list.
    return kv.get<MyListEntry[]>(k, isEntryList, []);
  }
  return {
    list: function (pid, section) {
      const k = key(pid, section);
      return k ? read(k) : [];
    },
    has: function (pid, section, id) {
      const k = key(pid, section);
      if (!k) { return false; }
      const l = read(k);
      for (let i = 0; i < l.length; i++) { if (l[i].item.id === id) { return true; } }
      return false;
    },
    toggle: function (pid, section, item) {
      const k = key(pid, section);
      if (!k || !item || !ID_RE.test(item.id)) { return 'error'; }
      const l = read(k);
      for (let i = 0; i < l.length; i++) {
        if (l[i].item.id === item.id) {
          l.splice(i, 1);
          return kv.set(k, l) ? 'removed' : 'error';
        }
      }
      if (l.length >= MAX_MY_LIST) { return 'full'; }
      l.unshift({ item: compactItem(item), at: now() });
      return kv.set(k, l) ? 'added' : 'error';
    },
    remove: function (pid, section, id) {
      const k = key(pid, section);
      if (!k) { return false; }
      const l = read(k);
      for (let i = 0; i < l.length; i++) {
        if (l[i].item.id === id) { l.splice(i, 1); return kv.set(k, l); }
      }
      return false;
    },
    clear: function (pid) {
      if (!isPlaylistId(pid)) { return; }
      kv.remove(myListKey('movie', pid));
      kv.remove(myListKey('series', pid));
    }
  };
}
