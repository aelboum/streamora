// Favourites and recently watched channels, per playlist (ARCHITECTURE.md rev 3 §2:
// FavouritesService, HistoryService; §7: KeyValueStore). Only channel ids are stored.
//   KV "fav.<playlistId>"    channel ids in the order they were added (max 1,000)
//   KV "recent.<playlistId>" most recent first (max 30)
import type { KeyValueStore } from '../storage/kv-store.ts';
import { isPlaylistId } from '../models/content.ts';

export const MAX_FAVOURITES = 1000;
export const MAX_RECENT = 30;

export interface UserLists {
  favourites(playlistId: string): string[];
  isFavourite(playlistId: string, channelId: string): boolean;
  /** Returns the new state (true = now a favourite); false when the list is full. */
  toggleFavourite(playlistId: string, channelId: string): boolean;
  recent(playlistId: string): string[];
  markWatched(playlistId: string, channelId: string): void;
  clear(playlistId: string): void;
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function isIdList(x: unknown): x is string[] {
  if (Object.prototype.toString.call(x) !== '[object Array]') {
    return false;
  }
  const a = x as unknown[];
  for (let i = 0; i < a.length; i++) {
    if (typeof a[i] !== 'string' || !ID_RE.test(a[i] as string)) {
      return false;
    }
  }
  return true;
}

export function createUserLists(kv: KeyValueStore): UserLists {
  function read(name: string): string[] {
    return kv.get<string[]>(name, isIdList, []);
  }
  function key(kind: string, pid: string): string | null {
    return isPlaylistId(pid) ? kind + '.' + pid : null;
  }
  return {
    favourites: function (pid) {
      const k = key('fav', pid);
      return k ? read(k) : [];
    },
    isFavourite: function (pid, cid) {
      const k = key('fav', pid);
      return !!k && read(k).indexOf(cid) >= 0;
    },
    toggleFavourite: function (pid, cid) {
      const k = key('fav', pid);
      if (!k || !ID_RE.test(cid)) {
        return false;
      }
      const list = read(k);
      const i = list.indexOf(cid);
      if (i >= 0) {
        list.splice(i, 1);
        kv.set(k, list);
        return false;
      }
      if (list.length >= MAX_FAVOURITES) {
        return false;
      }
      list.push(cid);
      kv.set(k, list);
      return true;
    },
    recent: function (pid) {
      const k = key('recent', pid);
      return k ? read(k) : [];
    },
    markWatched: function (pid, cid) {
      const k = key('recent', pid);
      if (!k || !ID_RE.test(cid)) {
        return;
      }
      const list = read(k);
      const i = list.indexOf(cid);
      if (i >= 0) {
        list.splice(i, 1);
      }
      list.unshift(cid);
      if (list.length > MAX_RECENT) {
        list.length = MAX_RECENT;
      }
      kv.set(k, list);
    },
    clear: function (pid) {
      const f = key('fav', pid);
      const r = key('recent', pid);
      if (f) { kv.remove(f); }
      if (r) { kv.remove(r); }
    }
  };
}
