// Stage 14: "Manage categories" side sheet inside Live TV, Movies and Series (the same 640-wide
// sheet as "Find a category"). Lists the screen's provider categories in the user's order, hidden
// ones included and marked; the special rows (Search, Favourites, All, My List …) are not listed
// and never move.
// Keys (routed by the owning screen while open):
//   ↑↓ move the focus (the first row is "Restore defaults"), CH▲▼ page by 9,
//   OK on a category = hide / show, ► = pick it up; while picked up ↑↓ (CH▲▼) move it and
//   OK, ◄ or Back put it down; OK on "Restore defaults" = 'restore' (the screen asks first);
//   Back = 'close'.
// Each hide/show and each put-down returns 'changed'; the screen saves at once and reports with
// note(). Only ids and row positions are held (category-prefs.ts editor); released on close.
import { createVirtualList } from '../components/virtual-list.ts';
import type { Translate } from '../i18n/strings.ts';
import type { RemoteKey } from '../navigation/keys.ts';
import { createCategoryEditor } from '../content/category-prefs.ts';
import type { CategoryEditor, CategoryPrefs } from '../content/category-prefs.ts';
import { formatCount } from './format.ts';
import { h } from '../utils/dom.ts';

const ROWS = 9;

export interface ManagerInput {
  /** "Live TV" / "Movies" / "Series". */
  section: string;
  /** All provider categories (index space of names/counts). */
  provider: Array<{ id: string }>;
  names: string[];
  counts: number[];
  /** Provider indexes the screen lists (categories with content). */
  listed: number[];
  prefs: CategoryPrefs;
}

export type ManagerResult = 'changed' | 'restore' | 'close' | null;

export interface CategoryManager {
  readonly element: HTMLElement;
  isOpen(): boolean;
  open(o: ManagerInput): void;
  /** Restore defaults confirmed: show the new (default) prefs. */
  reload(prefs: CategoryPrefs): void;
  close(): void;
  prefs(): CategoryPrefs;
  /** "Saved" / "Not saved" under the list. */
  note(text: string, warn: boolean): void;
  key(k: RemoteKey): ManagerResult;
  back(): ManagerResult;
  /** Row of the focused category (−1 = Restore defaults); tests and diagnostics. */
  focused(): number;
  moving(): boolean;
}

interface Row { root: HTMLElement; name: HTMLElement; state: HTMLElement; count: HTMLElement }

export function createCategoryManager(doc: Document, t: Translate): CategoryManager {
  let input: ManagerInput | null = null;
  let ed: CategoryEditor | null = null;
  let pos = -1; // -1 = "Restore defaults"
  let carrying = false;
  let isOpenNow = false;
  const sub = h(doc, 'div', { className: 'ss-sheet__sub' });
  const restore = h(doc, 'div', { className: 'ss-catman__restore', text: t('cat.restore') });
  const noteEl = h(doc, 'div', { className: 'ss-catman__note' });
  const hint = h(doc, 'div', { className: 'ss-catman__hint' });
  const list = createVirtualList<Row>(doc, {
    rows: ROWS, className: 'ss-catman__list',
    createRow: function () {
      const name = h(doc, 'div', { className: 'ss-catman__name' });
      const state = h(doc, 'div', { className: 'ss-catman__state' });
      const count = h(doc, 'div', { className: 'ss-catman__count' });
      const root = h(doc, 'div', { className: 'ss-catman__row' }, [name, state, count]);
      return { root: root, parts: { root: root, name: name, state: state, count: count } };
    },
    bind: function (r, i, focused) {
      if (!ed || !input) { return; }
      const row = ed.row(i);
      if (row.hidden) { r.root.className += ' is-off'; }
      if (focused && carrying) { r.root.className += ' is-moving'; }
      r.name.textContent = (focused && carrying ? '⇅  ' : '') + input.names[row.index];
      r.state.textContent = row.hidden ? t('cat.hidden') : '';
      r.count.textContent = formatCount(input.counts[row.index]);
    }
  });
  const element = h(doc, 'div', { className: 'ss-find ss-catman is-hidden' }, [
    h(doc, 'div', { className: 'ss-find__scrim' }),
    h(doc, 'div', { className: 'ss-sheet' }, [h(doc, 'div', { className: 'ss-sheet__title', text: t('cat.title') }), sub, restore, list.element, noteEl, hint])
  ]);

  function renderSub(): void {
    if (!ed || !input) { return; }
    sub.textContent = t('cat.sub', { section: input.section, n: formatCount(ed.size()), h: formatCount(ed.hiddenCount()) });
  }
  function renderHint(): void {
    hint.textContent = carrying ? t('cat.hintMoving') : pos < 0 ? t('cat.hintRestore') : t('cat.hint');
  }
  function focusAt(next: number): void {
    if (pos >= 0) { list.setFocused(pos, false); }
    pos = next;
    if (pos >= 0) { list.setFocused(pos, true); }
    restore.className = 'ss-catman__restore' + (pos < 0 ? ' is-focused' : '');
    renderHint();
  }
  function start(p: CategoryPrefs, at: number): void {
    if (!input) { return; }
    ed = createCategoryEditor(input.provider, input.listed, p);
    carrying = false;
    pos = -1;
    list.reset();
    list.setCount(ed.size());
    renderSub();
    // After Restore defaults the focus stays on the button (at = −1), so a second OK changes nothing.
    focusAt(ed.size() && at >= 0 ? Math.min(at, ed.size() - 1) : -1);
  }
  function drop(): ManagerResult {
    carrying = false;
    list.refresh();
    renderHint();
    return 'changed';
  }

  return {
    element: element,
    isOpen: function () { return isOpenNow; },
    open: function (o) {
      input = o;
      isOpenNow = true;
      noteEl.textContent = '';
      element.className = 'ss-find ss-catman';
      start(o.prefs, 0);
    },
    reload: function (p) {
      start(p, pos);
    },
    close: function () {
      isOpenNow = false;
      carrying = false;
      element.className = 'ss-find ss-catman is-hidden';
      list.setCount(0);
      ed = null; // releases the working copy and the screen's name/count arrays
      input = null;
    },
    prefs: function () { return ed ? ed.prefs() : { order: [], hidden: [] }; },
    note: function (text, warn) {
      noteEl.textContent = text;
      noteEl.className = 'ss-catman__note' + (warn ? ' is-warn' : '');
    },
    key: function (k) {
      if (!ed) { return null; }
      const n = ed.size();
      if (carrying) {
        if ((k === 'up' || k === 'down' || k === 'chUp' || k === 'chDown') && pos >= 0) {
          const steps = k === 'chUp' || k === 'chDown' ? ROWS : 1;
          const dir = k === 'up' || k === 'chUp' ? -1 : 1;
          let at = pos;
          for (let s = 0; s < steps; s++) { at = ed.move(at, dir); }
          if (at !== pos) { list.setFocused(pos, false); pos = at; list.setFocused(pos, true); }
          list.refresh();
          return null;
        }
        if (k === 'ok' || k === 'left') { return drop(); }
        return null;
      }
      if (k === 'down' && pos < n - 1) {
        focusAt(pos + 1);
      } else if (k === 'up' && pos >= 0) {
        focusAt(pos - 1);
      } else if ((k === 'chDown' || k === 'chUp') && n) {
        focusAt(Math.max(0, Math.min(n - 1, pos + (k === 'chDown' ? ROWS : -ROWS))));
      } else if (k === 'ok') {
        if (pos < 0) { return ed.isDefault() ? null : 'restore'; }
        ed.toggle(pos);
        list.refresh();
        renderSub();
        return 'changed';
      } else if (k === 'right' && pos >= 0) {
        carrying = true;
        list.refresh();
        renderHint();
      }
      return null;
    },
    back: function () {
      if (carrying) { return drop(); }
      return 'close';
    },
    focused: function () { return pos; },
    moving: function () { return carrying; }
  };
}
