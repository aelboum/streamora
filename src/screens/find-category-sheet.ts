// "Find a category" panel (Stage 7B.1, design 23a / P3 large-catalogue "modal"): a 640-wide opaque
// side sheet over a scrim, inside the Movies/Series screen (not a router overlay), so it stays on
// screen while the filter is typed in the text entry (the router shows one overlay at a time).
// Matching is case-insensitive "contains" on the category names already in memory (the catalogue
// index); nothing is read from storage or the network.
// Keys (routed by the owning screen while open): ↑↓ move between the filter field and the matches,
// CH▲▼ page by 9, OK on the field → 'edit' (open the text entry), OK on a match → its index,
// Back → the screen closes the panel.
import { createVirtualList } from '../components/virtual-list.ts';
import { createIcon } from '../components/brand.ts';
import type { Translate } from '../i18n/strings.ts';
import type { RemoteKey } from '../navigation/keys.ts';
import { formatCount } from './format.ts';
import { h } from '../utils/dom.ts';

const ROWS = 9;

export function matchCategories(names: string[], query: string): number[] {
  const q = query.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < names.length; i++) {
    if (!q || names[i].toLowerCase().indexOf(q) >= 0) { out.push(i); }
  }
  return out;
}

export interface FindPanel {
  readonly element: HTMLElement;
  isOpen(): boolean;
  open(names: string[], counts: number[]): void;
  close(): void;
  query(): string;
  /** New filter text; focus moves to the first match (or stays on the field when none). */
  setQuery(q: string): void;
  /** 'edit' = open the text entry; a number = pick that category (index into names); null = handled. */
  key(k: RemoteKey): 'edit' | number | null;
}

interface Row { name: HTMLElement; count: HTMLElement }

export function createFindPanel(doc: Document, t: Translate): FindPanel {
  let names: string[] = [];
  let counts: number[] = [];
  let matches: number[] = [];
  let q = '';
  let pos = -1; // -1 = the filter field
  let open = false;
  const sub = h(doc, 'div', { className: 'ss-sheet__sub' });
  const queryEl = h(doc, 'div', { className: 'ss-find__query' });
  const matchesEl = h(doc, 'div', { className: 'ss-find__matches' });
  const field = h(doc, 'div', { className: 'ss-find__field' }, [createIcon(doc, 'filter', '#A9B2C3', 'ss-find__icon'), queryEl, matchesEl]);
  const none = h(doc, 'div', { className: 'ss-find__none' });
  const list = createVirtualList<Row>(doc, {
    rows: ROWS, className: 'ss-find__list',
    createRow: function () {
      const name = h(doc, 'div', { className: 'ss-find__name' });
      const count = h(doc, 'div', { className: 'ss-find__count' });
      return { root: h(doc, 'div', { className: 'ss-find__row' }, [name, count]), parts: { name: name, count: count } };
    },
    bind: function (r, i) {
      r.name.textContent = names[matches[i]];
      r.count.textContent = formatCount(counts[matches[i]]);
    }
  });
  const element = h(doc, 'div', { className: 'ss-find is-hidden' }, [
    h(doc, 'div', { className: 'ss-find__scrim' }),
    h(doc, 'div', { className: 'ss-sheet' }, [h(doc, 'div', { className: 'ss-sheet__title', text: t('vod.find') }), sub, field, none, list.element])
  ]);

  function focusAt(next: number): void {
    if (pos >= 0) { list.setFocused(pos, false); }
    pos = next;
    if (pos >= 0) { list.setFocused(pos, true); }
    field.className = 'ss-find__field' + (pos < 0 ? ' is-focused' : '');
  }

  function render(): void {
    matches = matchCategories(names, q);
    queryEl.textContent = q;
    matchesEl.textContent = q ? '· ' + t('vod.findMatches', { n: formatCount(matches.length) }) : '';
    none.textContent = matches.length ? '' : t('vod.findNone', { q: q });
    pos = -1;
    list.reset();
    list.setCount(matches.length);
    focusAt(q && matches.length ? 0 : -1);
  }

  return {
    element: element,
    isOpen: function () { return open; },
    open: function (n, c) {
      names = n;
      counts = c;
      q = '';
      open = true;
      sub.textContent = t('vod.findSub', { n: formatCount(n.length) });
      element.className = 'ss-find';
      render();
    },
    close: function () {
      open = false;
      element.className = 'ss-find is-hidden';
      list.setCount(0);
    },
    query: function () { return q; },
    setQuery: function (v) {
      q = v;
      if (open) { render(); }
    },
    key: function (k) {
      if (k === 'down' && pos < matches.length - 1) {
        focusAt(pos + 1);
      } else if (k === 'up' && pos >= 0) {
        focusAt(pos - 1);
      } else if ((k === 'chDown' || k === 'chUp') && matches.length) {
        focusAt(Math.max(0, Math.min(matches.length - 1, pos + (k === 'chDown' ? ROWS : -ROWS))));
      } else if (k === 'ok') {
        return pos < 0 ? 'edit' : matches[pos];
      }
      return null;
    }
  };
}
