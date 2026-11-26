// Stage 11: movie sorting inside one category (your decision: categories of up to SORT_MAX
// titles; "All movies" and larger categories keep the provider order). Pure functions.
//   provider   the provider's order (default; the stored order, never changed)
//   titleAsc / titleDesc   by title, ignoring case; titles that are empty go last in both
//   yearDesc / yearAsc     by the stored year; titles without a year go last in both (never invented)
// Equal values keep the provider order (stable: the position index breaks ties), so the result is
// the same on every TV regardless of the engine's sort algorithm.
export type SortMode = 'provider' | 'titleAsc' | 'titleDesc' | 'yearDesc' | 'yearAsc';
export const SORT_MODES: SortMode[] = ['provider', 'titleAsc', 'titleDesc', 'yearDesc', 'yearAsc'];
export const SORT_MAX = 5000;

export function nextSortMode(m: SortMode): SortMode {
  const i = SORT_MODES.indexOf(m);
  return SORT_MODES[(i + 1) % SORT_MODES.length];
}

/**
 * `positions` in provider order; `names[i]` / `years[i]` belong to `positions[i]` ('' / 0 unknown).
 * Returns a new array (the input is not changed).
 */
export function sortPositions(positions: number[], names: string[], years: number[], mode: SortMode): number[] {
  const n = positions.length;
  const order: number[] = [];
  for (let i = 0; i < n; i++) { order.push(i); }
  if (mode === 'provider') { return positions.slice(0); }
  const keys: string[] = [];
  if (mode === 'titleAsc' || mode === 'titleDesc') {
    for (let i = 0; i < n; i++) { keys.push((names[i] || '').toLowerCase()); }
  }
  const dir = mode === 'titleDesc' || mode === 'yearDesc' ? -1 : 1;
  order.sort(function (a, b) {
    let c = 0;
    if (mode === 'titleAsc' || mode === 'titleDesc') {
      const ka = keys[a];
      const kb = keys[b];
      if (!ka !== !kb) { return ka ? -1 : 1; } // empty titles last
      c = ka < kb ? -1 : ka > kb ? 1 : 0;
    } else {
      const ya = years[a] > 0 ? years[a] : 0;
      const yb = years[b] > 0 ? years[b] : 0;
      if (!ya !== !yb) { return ya ? -1 : 1; } // unknown years last
      c = ya - yb;
    }
    if (c !== 0) { return c * dir; }
    return a - b; // stable: provider order for equal values
  });
  const out: number[] = [];
  for (let i = 0; i < n; i++) { out.push(positions[order[i]]); }
  return out;
}
