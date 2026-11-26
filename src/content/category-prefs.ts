// Stage 14: category management — which provider categories are hidden and in which order they
// are listed, per account and per type (Live TV, Movies, Series), on this TV only.
//   KV "catprefs.<live|movie|series>.<playlistId>": { order: ids, hidden: ids } (schema 1).
// Only provider category ids are stored (Xtream category_id, M3U "g" + hash of the group name),
// never names, channels or titles, so duplicate names are told apart and renamed categories keep
// their place. The provider's catalogue is never changed: the screens only list its categories in
// another order, without the hidden ones.
// Provider changes: a new category is placed after the category that precedes it in the
// provider's list; ids the provider no longer returns are kept (a provider that fails or returns
// a short list for a while never erases the user's choices) and come back in their old place.
// An empty order = the provider's order. Restore defaults removes the key.
import type { KeyValueStore } from '../storage/kv-store.ts';
import { isPlaylistId } from '../models/content.ts';

export type CategorySection = 'live' | 'movie' | 'series';

export interface CategoryPrefs {
  /** Category ids in the user's order (empty = provider order). */
  order: string[];
  /** Hidden category ids. */
  hidden: string[];
}

/** Ids kept per list; beyond it, ids the provider no longer returns are dropped first. */
export const MAX_PREF_IDS = 3000;
const ID_MAX = 80;

export function prefsKey(section: CategorySection, playlistId: string): string {
  return 'catprefs.' + section + '.' + playlistId;
}

function isIdList(x: unknown): x is string[] {
  if (!Array.isArray(x) || x.length > MAX_PREF_IDS) { return false; }
  for (let i = 0; i < x.length; i++) {
    if (typeof x[i] !== 'string' || x[i].length > ID_MAX) { return false; }
  }
  return true;
}

export function isCategoryPrefs(x: unknown): x is CategoryPrefs {
  const p = x as CategoryPrefs;
  return !!p && typeof p === 'object' && isIdList(p.order) && isIdList(p.hidden);
}

export function emptyPrefs(): CategoryPrefs { return { order: [], hidden: [] }; }

export function isDefaultPrefs(p: CategoryPrefs): boolean { return p.order.length === 0 && p.hidden.length === 0; }

export interface CategoryPrefsStore {
  get(playlistId: string, section: CategorySection): CategoryPrefs;
  /** False when not stored (storage failed); the caller says so. Default prefs remove the key. */
  set(playlistId: string, section: CategorySection, p: CategoryPrefs): boolean;
  reset(playlistId: string, section: CategorySection): void;
  /** Account removed: all three types. */
  clear(playlistId: string): void;
}

export function createCategoryPrefsStore(kv: KeyValueStore): CategoryPrefsStore {
  return {
    get: function (pid, section) {
      if (!isPlaylistId(pid)) { return emptyPrefs(); }
      const p = kv.get<CategoryPrefs>(prefsKey(section, pid), isCategoryPrefs, emptyPrefs());
      return { order: p.order.slice(), hidden: p.hidden.slice() };
    },
    set: function (pid, section, p) {
      if (!isPlaylistId(pid)) { return false; }
      if (isDefaultPrefs(p)) { kv.remove(prefsKey(section, pid)); return true; }
      return kv.set(prefsKey(section, pid), { order: p.order, hidden: p.hidden });
    },
    reset: function (pid, section) {
      if (isPlaylistId(pid)) { kv.remove(prefsKey(section, pid)); }
    },
    clear: function (pid) {
      if (!isPlaylistId(pid)) { return; }
      kv.remove(prefsKey('live', pid));
      kv.remove(prefsKey('movie', pid));
      kv.remove(prefsKey('series', pid));
    }
  };
}

interface HasId { id: string }

/**
 * The saved order with the provider's new categories merged in (each after the category that
 * precedes it in the provider's list, or first when none does). Unknown saved ids stay in place.
 * No saved order = the provider's order. Duplicate ids appear once.
 */
export function mergeOrder(provider: HasId[], saved: string[]): string[] {
  const out: string[] = [];
  const seen: Record<string, boolean> = {};
  if (!saved.length) {
    for (let i = 0; i < provider.length; i++) {
      const k = 'k' + provider[i].id;
      if (!seen[k]) { seen[k] = true; out.push(provider[i].id); }
    }
    return out;
  }
  for (let i = 0; i < saved.length; i++) {
    const k = 'k' + saved[i];
    if (!seen[k]) { seen[k] = true; out.push(saved[i]); }
  }
  let prev = ''; // last provider id already placed
  let placed = false;
  for (let j = 0; j < provider.length; j++) {
    const id = provider[j].id;
    const k = 'k' + id;
    if (!seen[k]) {
      seen[k] = true;
      const at = placed ? out.indexOf(prev) + 1 : 0;
      out.splice(at, 0, id);
    }
    prev = id;
    placed = true;
  }
  return out;
}

/**
 * Indexes into `provider` in the order to list them, hidden ones left out (or kept with
 * `withHidden`). The default prefs return the provider's order without any copying of categories.
 */
export function arrange(provider: HasId[], p: CategoryPrefs, withHidden?: boolean): number[] {
  const out: number[] = [];
  const hidden: Record<string, boolean> = {};
  if (!withHidden) {
    for (let h = 0; h < p.hidden.length; h++) { hidden['k' + p.hidden[h]] = true; }
  }
  if (!p.order.length) {
    for (let i = 0; i < provider.length; i++) {
      if (!hidden['k' + provider[i].id]) { out.push(i); }
    }
    return out;
  }
  const at: Record<string, number[]> = {};
  for (let i = 0; i < provider.length; i++) {
    const k = 'k' + provider[i].id;
    (at[k] || (at[k] = [])).push(i);
  }
  const order = mergeOrder(provider, p.order);
  for (let j = 0; j < order.length; j++) {
    const k = 'k' + order[j];
    const list = at[k];
    if (!list || hidden[k]) { continue; }
    for (let n = 0; n < list.length; n++) { out.push(list[n]); }
  }
  return out;
}

/** Keeps the lists within MAX_PREF_IDS by dropping ids the provider no longer returns first. */
function cap(ids: string[], known: Record<string, boolean>): string[] {
  if (ids.length <= MAX_PREF_IDS) { return ids; }
  const out: string[] = [];
  let extra = ids.length - MAX_PREF_IDS;
  for (let i = 0; i < ids.length; i++) {
    if (extra > 0 && !known['k' + ids[i]]) { extra--; continue; }
    out.push(ids[i]);
  }
  return out.length > MAX_PREF_IDS ? out.slice(0, MAX_PREF_IDS) : out;
}

export interface EditorRow { index: number; hidden: boolean }

/**
 * The manager's working copy for one account and type. Rows are the provider categories the
 * screen lists (`listed`: indexes into `provider`, e.g. those with titles) in the user's order,
 * hidden ones included. Only ids and positions are held; the categories stay where they are.
 */
export interface CategoryEditor {
  size(): number;
  row(i: number): EditorRow;
  hiddenCount(): number;
  toggle(i: number): void;
  /** Moves row i one place up (-1) or down (+1); returns its new row. */
  move(i: number, delta: number): number;
  prefs(): CategoryPrefs;
  isDefault(): boolean;
}

export function createCategoryEditor(provider: HasId[], listed: number[], saved: CategoryPrefs): CategoryEditor {
  const known: Record<string, boolean> = {};
  const listedAt: Record<string, number> = {};
  for (let i = 0; i < listed.length; i++) {
    const k = 'k' + provider[listed[i]].id;
    if (!Object.prototype.hasOwnProperty.call(listedAt, k)) { listedAt[k] = listed[i]; }
  }
  for (let j = 0; j < provider.length; j++) { known['k' + provider[j].id] = true; }
  const order = mergeOrder(provider, saved.order);
  const def = mergeOrder(provider, []);
  const hidden: Record<string, boolean> = {};
  const hiddenIds: string[] = [];
  for (let h = 0; h < saved.hidden.length; h++) {
    const k = 'k' + saved.hidden[h];
    if (!hidden[k]) { hidden[k] = true; hiddenIds.push(saved.hidden[h]); }
  }
  // view[r] = position in `order` of row r (listed categories only).
  const view: number[] = [];
  for (let o = 0; o < order.length; o++) {
    if (Object.prototype.hasOwnProperty.call(listedAt, 'k' + order[o])) { view.push(o); }
  }
  /** The known categories are in the provider's order (unknown saved ids aside). */
  function orderIsDefault(): boolean {
    let a = 0;
    for (let o = 0; o < order.length; o++) {
      if (!known['k' + order[o]]) { continue; }
      if (order[o] !== def[a]) { return false; }
      a++;
    }
    return true;
  }
  return {
    size: function () { return view.length; },
    row: function (i) {
      const k = 'k' + order[view[i]];
      return { index: listedAt[k], hidden: !!hidden[k] };
    },
    hiddenCount: function () {
      let n = 0;
      for (let i = 0; i < view.length; i++) { if (hidden['k' + order[view[i]]]) { n++; } }
      return n;
    },
    toggle: function (i) {
      const id = order[view[i]];
      const k = 'k' + id;
      if (hidden[k]) {
        delete hidden[k];
        hiddenIds.splice(hiddenIds.indexOf(id), 1);
      } else {
        hidden[k] = true;
        hiddenIds.push(id);
      }
    },
    move: function (i, delta) {
      const j = i + delta;
      if (j < 0 || j >= view.length) { return i; }
      const a = view[i];
      const b = view[j];
      const tmp = order[a];
      order[a] = order[b];
      order[b] = tmp;
      return j;
    },
    prefs: function () {
      // A saved order whose known part matches the provider again is kept only for the unknown
      // ids in it (their old places); without any, the provider's order needs no stored order.
      let unknown = false;
      for (let o = 0; o < order.length; o++) { if (!known['k' + order[o]]) { unknown = true; break; } }
      const keep = !orderIsDefault() || (unknown && saved.order.length > 0);
      return { order: keep ? cap(order.slice(), known) : [], hidden: cap(hiddenIds.slice(), known) };
    },
    isDefault: function () { return hiddenIds.length === 0 && orderIsDefault(); }
  };
}
