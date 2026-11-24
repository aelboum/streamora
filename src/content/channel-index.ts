// In-memory lookup structures over a decoded live catalogue, built once per load (O(n)):
// channel indexes per category, id → index, and a lower-case name table for search.
// Lists are arrays of channel indexes, so category switching and search never copy channels.
import type { Category, Channel, LiveCatalogue } from '../models/content.ts';

export interface ChannelIndex {
  readonly channels: Channel[];
  readonly categories: Category[];
  all(): number[];
  byCategory(categoryId: string): number[];
  indexOfId(channelId: string): number;
  /** Resolves stored channel ids (favourites, recent) to indexes, skipping ids no longer present. */
  resolve(ids: string[]): number[];
  /** Name substring match (case-insensitive); a pure number also matches the channel number prefix. */
  search(query: string, max: number): number[];
}

export function createChannelIndex(cat: LiveCatalogue): ChannelIndex {
  const channels = cat.channels;
  const byCat: Record<string, number[]> = {};
  const byId: Record<string, number> = {};
  const all: number[] = [];
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    all.push(i);
    const k = 'k' + c.categoryId;
    let list = byCat[k];
    if (!list) {
      list = [];
      byCat[k] = list;
    }
    list.push(i);
    if (!Object.prototype.hasOwnProperty.call(byId, 'k' + c.id)) {
      byId['k' + c.id] = i;
    }
  }
  let lower: string[] | null = null; // built on the first search only

  return {
    channels: channels,
    categories: cat.categories,
    all: function () { return all; },
    byCategory: function (id) { return byCat['k' + id] || []; },
    indexOfId: function (id) {
      const v = byId['k' + id];
      return typeof v === 'number' ? v : -1;
    },
    resolve: function (ids) {
      const out: number[] = [];
      for (let i = 0; i < ids.length; i++) {
        const v = byId['k' + ids[i]];
        if (typeof v === 'number') {
          out.push(v);
        }
      }
      return out;
    },
    search: function (query, max) {
      const q = query.replace(/^\s+|\s+$/g, '').toLowerCase();
      const out: number[] = [];
      if (!q) {
        return out;
      }
      if (!lower) {
        lower = [];
        for (let i = 0; i < channels.length; i++) {
          lower.push(channels[i].name.toLowerCase());
        }
      }
      const numeric = /^\d{1,6}$/.test(q);
      for (let j = 0; j < channels.length && out.length < max; j++) {
        if (lower[j].indexOf(q) >= 0 || (numeric && String(channels[j].num).indexOf(q) === 0)) {
          out.push(j);
        }
      }
      return out;
    }
  };
}
