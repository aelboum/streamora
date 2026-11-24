// Virtualised vertical list (ARCHITECTURE.md rev 3 §9: "virtualised lists with node pooling").
// A fixed pool of row nodes shows a window of the items; moving the focus rebinds the pool instead
// of creating nodes, so 50,000 channels cost the same DOM as 11. Only the rows whose item or focus
// changed are rebound. No business logic: `bind` receives the item index and focus state.
import { h } from '../utils/dom.ts';

export interface VirtualListOptions<R> {
  rows: number;
  className: string;
  createRow(): { root: HTMLElement; parts: R };
  bind(parts: R, index: number, focused: boolean): void;
}

export interface VirtualList {
  readonly element: HTMLElement;
  setCount(n: number): void;
  count(): number;
  /** Moves the visual focus (scrolling the window as needed). */
  setFocused(index: number, focused: boolean): void;
  /** Rebinds every visible row (data changed, e.g. EPG or favourites). */
  refresh(): void;
  /** Back to the top with no focused row (the list was replaced while another column has focus). */
  reset(): void;
  /** First visible item. */
  top(): number;
  /** Number of row binds performed (performance diagnostics). */
  binds(): number;
}

export function createVirtualList<R>(doc: Document, o: VirtualListOptions<R>): VirtualList {
  const element = h(doc, 'div', { className: 'ss-vlist ' + o.className });
  const pool: Array<{ root: HTMLElement; parts: R; index: number; focused: boolean; base: string }> = [];
  let n = 0;
  let top = 0;
  let focus = -1;
  let bindCount = 0;
  for (let i = 0; i < o.rows; i++) {
    const r = o.createRow();
    r.root.style.display = 'none';
    element.appendChild(r.root);
    pool.push({ root: r.root, parts: r.parts, index: -1, focused: false, base: r.root.className });
  }

  function render(force: boolean): void {
    for (let i = 0; i < pool.length; i++) {
      const slot = pool[i];
      const idx = top + i;
      if (idx >= n) {
        if (slot.index !== -1) {
          slot.root.style.display = 'none';
          slot.index = -1;
        }
        continue;
      }
      const f = idx === focus;
      if (force || slot.index !== idx || slot.focused !== f) {
        if (slot.index === -1) {
          slot.root.style.display = '';
        }
        slot.index = idx;
        slot.focused = f;
        slot.root.className = slot.base + (f ? ' is-focused' : '');
        o.bind(slot.parts, idx, f);
        bindCount++;
      }
    }
  }

  function scrollTo(i: number): void {
    const margin = o.rows > 4 ? 1 : 0;
    if (i < top + margin) {
      top = Math.max(0, i - margin);
    } else if (i > top + o.rows - 1 - margin) {
      top = Math.min(Math.max(0, n - o.rows), i - o.rows + 1 + margin);
    }
  }

  return {
    element: element,
    setCount: function (count) {
      n = Math.max(0, count);
      if (focus >= n) {
        focus = n - 1;
      }
      top = Math.max(0, Math.min(top, n - o.rows));
      if (focus >= 0) {
        scrollTo(focus);
      }
      render(true);
    },
    count: function () { return n; },
    setFocused: function (index, focused) {
      if (focused) {
        focus = index;
        scrollTo(index);
      } else if (focus === index) {
        focus = -1;
      }
      render(false);
    },
    refresh: function () { render(true); },
    reset: function () {
      top = 0;
      focus = -1;
    },
    top: function () { return top; },
    binds: function () { return bindCount; }
  };
}
