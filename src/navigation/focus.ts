// Focus manager: an explicit zone graph (ARCHITECTURE.md rev 2 §2D, kept in rev 3).
// - Exactly one focused item at a time; rendering is delegated (CSS class, no DOM focus()).
// - Each zone remembers its last index; entering a zone restores it (clamped).
// - Leaving a zone through an edge enters the neighbour zone; empty neighbours are skipped.
// - When the focused zone shrinks or empties, focus falls back (same zone clamped, then the
//   zone's fallback, then the first non-empty zone), so focus is never lost while anything is focusable.

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface FocusZone {
  id: string;
  kind: 'row' | 'column' | 'grid';
  /** Grid only. */
  columns?: number;
  size(): number;
  neighbours: { up?: string; down?: string; left?: string; right?: string };
  /** Zone to fall back to when this one becomes empty. */
  fallback?: string;
  onSelect?(index: number): void;
  onFocus?(index: number): void;
}

export interface FocusRenderer {
  (zoneId: string, index: number, focused: boolean): void;
}

export interface FocusPosition { zone: string; index: number }

export interface FocusManager {
  register(zone: FocusZone): void;
  unregister(id: string): void;
  focus(zoneId: string, index?: number): boolean;
  move(dir: Direction): boolean;
  select(): boolean;
  current(): FocusPosition | null;
  /** Call after a zone's size changed. Re-validates focus and applies fallbacks. */
  refresh(zoneId: string): void;
  memory(zoneId: string): number;
  /** Sets the remembered index of a zone without focusing it (e.g. a list that was replaced). */
  remember(zoneId: string, index: number): void;
}

export function createFocusManager(render: FocusRenderer): FocusManager {
  const zones: Record<string, FocusZone> = {};
  const order: string[] = [];
  const mem: Record<string, number> = {};
  let cur: FocusPosition | null = null;

  function size(id: string): number {
    const z = zones[id];
    if (!z) {
      return 0;
    }
    const n = z.size();
    return n > 0 ? Math.floor(n) : 0;
  }

  function setFocus(zoneId: string, index: number): void {
    if (cur && cur.zone === zoneId && cur.index === index) {
      return;
    }
    if (cur && zones[cur.zone]) {
      render(cur.zone, cur.index, false);
    }
    cur = { zone: zoneId, index: index };
    mem[zoneId] = index;
    render(zoneId, index, true);
    const z = zones[zoneId];
    if (z.onFocus) {
      z.onFocus(index);
    }
  }

  function clamp(i: number, n: number): number {
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  }

  function firstNonEmpty(except?: string): string | null {
    for (let i = 0; i < order.length; i++) {
      if (order[i] !== except && size(order[i]) > 0) {
        return order[i];
      }
    }
    return null;
  }

  function enter(zoneId: string, index?: number): boolean {
    const n = size(zoneId);
    if (n === 0) {
      return false;
    }
    const want = index !== undefined ? index : (mem[zoneId] || 0);
    setFocus(zoneId, clamp(want, n));
    return true;
  }

  function fallbackFrom(zoneId: string): void {
    const z = zones[zoneId];
    if (z && z.fallback && enter(z.fallback)) {
      return;
    }
    const other = firstNonEmpty(zoneId);
    if (other && enter(other)) {
      return;
    }
    if (cur) {
      cur = null;
    }
  }

  return {
    register: function (zone) {
      if (!zones[zone.id]) {
        order.push(zone.id);
      }
      zones[zone.id] = zone;
      if (mem[zone.id] === undefined) {
        mem[zone.id] = 0;
      }
    },
    unregister: function (id) {
      delete zones[id];
      const i = order.indexOf(id);
      if (i >= 0) {
        order.splice(i, 1);
      }
      if (cur && cur.zone === id) {
        cur = null;
        const other = firstNonEmpty();
        if (other) {
          enter(other);
        }
      }
    },
    focus: function (zoneId, index) { return zones[zoneId] ? enter(zoneId, index) : false; },
    move: function (dir) {
      if (!cur) {
        const first = firstNonEmpty();
        return first ? enter(first) : false;
      }
      const z = zones[cur.zone];
      const n = size(cur.zone);
      const i = cur.index;
      let next = -1;
      if (z.kind === 'row') {
        if (dir === 'left') { next = i - 1; } else if (dir === 'right') { next = i + 1; }
      } else if (z.kind === 'column') {
        if (dir === 'up') { next = i - 1; } else if (dir === 'down') { next = i + 1; }
      } else {
        const cols = Math.max(1, z.columns || 1);
        const col = i % cols;
        if (dir === 'left' && col > 0) { next = i - 1; }
        if (dir === 'right' && col < cols - 1 && i + 1 < n) { next = i + 1; }
        if (dir === 'up' && i - cols >= 0) { next = i - cols; }
        if (dir === 'down') {
          if (i + cols < n) {
            next = i + cols;
          } else if (Math.floor(i / cols) < Math.floor((n - 1) / cols)) {
            next = n - 1; // partial last row: go to its last item
          }
        }
      }
      if (next >= 0 && next < n) {
        setFocus(cur.zone, next);
        return true;
      }
      const target = z.neighbours[dir];
      return target ? enter(target) : false;
    },
    select: function () {
      if (!cur) {
        return false;
      }
      const z = zones[cur.zone];
      if (z && z.onSelect) {
        z.onSelect(cur.index);
        return true;
      }
      return false;
    },
    current: function () { return cur ? { zone: cur.zone, index: cur.index } : null; },
    refresh: function (zoneId) {
      if (!cur || cur.zone !== zoneId) {
        return;
      }
      const n = size(zoneId);
      if (n === 0) {
        fallbackFrom(zoneId);
        return;
      }
      if (cur.index >= n) {
        const z = zoneId;
        const idx = n - 1;
        cur = null; // force re-render of the clamped item
        setFocus(z, idx);
      }
    },
    memory: function (zoneId) { return mem[zoneId] || 0; },
    remember: function (zoneId, index) {
      if (zones[zoneId]) {
        mem[zoneId] = Math.max(0, Math.floor(index));
      }
    }
  };
}
