// In-memory index over one movie or series catalogue (Stage 6): items per category, all items,
// and name search. Built once per loaded catalogue; lists are arrays of item indexes, so switching
// category never copies items. The lower-cased names for search are built on the first search.
import type { VodCatalogue } from '../models/content.ts';

export interface VodIndex {
  readonly catalogue: VodCatalogue;
  all(): number[];
  byCategory(categoryId: string): number[];
  /** Items whose name contains every word of `query` (case-insensitive), best matches first, at most `max`. */
  search(query: string, max: number): number[];
}

export function createVodIndex(cat: VodCatalogue): VodIndex {
  const byCat: Record<string, number[]> = {};
  const all: number[] = [];
  for (let i = 0; i < cat.items.length; i++) {
    all.push(i);
    const k = 'k' + cat.items[i].categoryId;
    (byCat[k] || (byCat[k] = [])).push(i);
  }
  let lower: string[] | null = null;

  return {
    catalogue: cat,
    all: function () { return all; },
    byCategory: function (id) { return byCat['k' + id] || []; },
    search: function (query, max) {
      const words = query.toLowerCase().replace(/^\s+|\s+$/g, '').split(/\s+/);
      if (!words[0]) {
        return [];
      }
      if (!lower) {
        lower = [];
        for (let i = 0; i < cat.items.length; i++) {
          lower.push(cat.items[i].name.toLowerCase());
        }
      }
      const starts: number[] = [];
      const contains: number[] = [];
      for (let j = 0; j < lower.length && starts.length < max; j++) {
        const n = lower[j];
        let ok = true;
        for (let w = 0; w < words.length; w++) {
          if (n.indexOf(words[w]) < 0) { ok = false; break; }
        }
        if (ok) {
          if (n.indexOf(words[0]) === 0) { starts.push(j); } else if (contains.length < max) { contains.push(j); }
        }
      }
      return starts.concat(contains).slice(0, max);
    }
  };
}
