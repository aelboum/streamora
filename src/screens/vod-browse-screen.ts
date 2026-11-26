// Movies / Series browse screen (Stage 6; paged data in Stage 6.1; Stage 7B.1 design 06/23–25):
// rail | categories | poster grid.
//   Left:  Search, Find a category, Update list, All movies/series, then the provider's
//          categories (with counts): 10 visible rows, "Category n of N" counter, CH▲▼ pages 10,
//          Yellow (or OK on "Find a category") opens the filter sheet (find-category-sheet.ts).
//   Right: virtualised poster grid, 5 columns × 2 visible rows + a peek row; a fixed pool of 3 row
//          nodes is rebound while scrolling, so 100,000 titles cost the same DOM as 15 cards.
//          Cards keep one size in three states: poster, title plate (name known, no/failed
//          poster), blank (page not read yet). Posters load only for bound cards.
//   A list update shows a non-focusable chip next to the title; a failed update keeps the stored
//   list and shows a 3 s toast.
// Data: only the catalogue index is read when the screen opens (VodView). The titles of the
// visible rows, plus one screen above and below, are read page by page in the background; until
// a page arrives its cards show an empty placeholder and focus/navigation keep working.
// Search scans the stored name pages incrementally; results appear while it runs.
// Remote: ↑↓←→ move, OK opens (category → grid, title → details), CH+/CH− page the grid,
// Back steps from the grid to the categories, then leaves the screen.
// The first open of a playlist without a stored list downloads it (progress in the header).
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createVirtualList } from '../components/virtual-list.ts';
import type { VirtualList } from '../components/virtual-list.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { VodJob, VodSection, VodService } from '../services/vod-service.ts';
import type { ListRef, SearchJob, VodView } from '../content/vod-pages.ts';
import type { VodItem } from '../models/content.ts';
import type { Translate } from '../i18n/strings.ts';
import type { KeyboardParams } from './keyboard-overlay.ts';
import type { Logger } from '../utils/log.ts';
import { formatCount, formatDateTime } from './format.ts';
import { createFindPanel } from './find-category-sheet.ts';
import { createRail } from '../components/rail.ts';
import { createIcon, setIcon } from '../components/brand.ts';
import { h } from '../utils/dom.ts';
import type { Parental } from '../services/parental.ts';
import { isLocked, withParental } from './parental-gate.ts';
import type { MyList } from '../services/my-list.ts';
import { SORT_MAX, nextSortMode, sortPositions } from '../content/vod-sort.ts';
import type { SortMode } from '../content/vod-sort.ts';
import { arrange, emptyPrefs } from '../content/category-prefs.ts';
import type { CategoryPrefs, CategoryPrefsStore } from '../content/category-prefs.ts';
import { createCategoryManager } from './category-manager.ts';
import type { ManagerResult } from './category-manager.ts';
import type { ConfirmParams } from './confirm-dialog.ts';

export interface VodBrowseDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  vod: VodService;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  openText: (nav: Router, p: KeyboardParams) => void;
  log: Logger;
  /** Stage 7B.2: adult categories and titles need the PIN while locked. */
  parental?: Parental | null;
  /** Stage 11: My List (absent = no My List category). */
  myList?: MyList | null;
  /** Stage 11: free memory (MB, −1 unknown) and the floor below which no sort is started. */
  memoryMB?: () => number;
  minFreeMB?: number;
  /** Stage 14: hidden / reordered categories (absent = provider order, no "Manage categories").
   *  The manager does not open below minFreeMB either. */
  catPrefs?: CategoryPrefsStore | null;
}

export interface VodBrowseParams {
  playlistId: string;
  section: VodSection;
}

export interface VodDetailsParams {
  playlistId: string;
  section: VodSection;
  item: VodItem;
}

type CatKind = 'search' | 'find' | 'update' | 'all' | 'mylist' | 'manage' | 'sort' | 'cat';
interface CatItem { kind: CatKind; id: string; name: string; count: number; adult?: boolean }
interface CatRow { root: HTMLElement; icon: HTMLElement; name: HTMLElement; count: HTMLElement }
interface Card { root: HTMLElement; img: HTMLElement; ph: HTMLElement; title: HTMLElement; src: string }
interface GridRow { cards: Card[] }

export const GRID_COLUMNS = 5;
const GRID_ROWS = 3; // 2 fully visible + 1 peek row (design 06: row pitch 420, third row peeks)
const GRID_VISIBLE = 2;
const CATEGORY_ROWS = 10;
const CATEGORY_PAGE = 10;
const ALL_POS = 3; // Search, Find, Update, All
const SEARCH_MAX = 2000;
const EMPTY: ListRef = { length: 0, at: function (i) { return i; } };

function arrayList(a: number[]): ListRef {
  return { length: a.length, at: function (i) { return a[i]; } };
}

export function createVodBrowseScreen(d: VodBrowseDeps, p: VodBrowseParams, nav: Router): Screen & { perf(): Record<string, number> } {
  const t = d.t;
  const pid = p.playlistId;
  const movies = p.section === 'movie';
  let view: VodView | null = null;
  let cats: CatItem[] = [];
  let catPos = ALL_POS; // "All"
  /** Stage 14: this account's category order and hidden categories for this section. */
  let prefs: CategoryPrefs = d.catPrefs ? d.catPrefs.get(p.playlistId, p.section) : emptyPrefs();
  let toastTimer: unknown = null;
  const rail = createRail(d.doc, t, movies ? 'movies' : 'series', nav, d.playlists);
  let list: ListRef = EMPTY;
  let listGen = 0; // bumps when the list is replaced (late page loads for an old list are ignored)
  let query = '';
  let results: number[] = [];
  let searchJob: SearchJob | null = null;
  let alive = true;
  let job: VodJob | null = null;
  let catTimer: unknown = null;
  let ensureTimer: unknown = null;
  let ensuring = false;
  let ensureAgain = false;
  let focusCol = -1;
  let tOpen = 0;
  // Stage 11: My List shown (its saved items, not catalogue positions) and the movie sort order.
  let myItems: VodItem[] | null = null;
  let sortMode: SortMode = 'provider';
  let sorted: { catId: string; mode: SortMode; positions: number[] } | null = null;
  let sortGen = 0;
  const perf: Record<string, number> = {};

  const status = h(d.doc, 'div', { className: 'ss-live__status' });
  const message = h(d.doc, 'div', { className: 'ss-vod__message' });
  const chipText = h(d.doc, 'div', { className: 'ss-chip__text' });
  const chip = h(d.doc, 'div', { className: 'ss-chip is-hidden' }, [createIcon(d.doc, 'sync', '#4FA8FF', 'ss-chip__icon'), chipText]);
  const counter = h(d.doc, 'div', { className: 'ss-vod__catpos' });
  const toastTitle = h(d.doc, 'div', { className: 'ss-toast__title' });
  const toastBody = h(d.doc, 'div', { className: 'ss-toast__body' });
  const toast = h(d.doc, 'div', { className: 'ss-toast is-hidden' }, [createIcon(d.doc, 'warning', '#F0B357', 'ss-toast__icon'), h(d.doc, 'div', { className: 'ss-toast__text' }, [toastTitle, toastBody])]);

  const catList: VirtualList = createVirtualList<CatRow>(d.doc, {
    rows: CATEGORY_ROWS, className: 'ss-live__cats',
    createRow: function () {
      const icon = createIcon(d.doc, 'search', '#4FA8FF', 'ss-cat__icon');
      const name = h(d.doc, 'div', { className: 'ss-cat__name' });
      const count = h(d.doc, 'div', { className: 'ss-cat__count' });
      const root = h(d.doc, 'div', { className: 'ss-cat' }, [icon, name, count]);
      return { root: root, parts: { root: root, icon: icon, name: name, count: count } };
    },
    bind: function (r, i, focused) {
      const c = cats[i];
      if (i === catPos && !focused) { r.root.className += ' is-selected'; }
      const ic = c.kind === 'search' ? 'search' : c.kind === 'find' ? 'filter' : c.kind === 'update' ? 'sync' : c.kind === 'mylist' ? 'star' : c.kind === 'manage' ? 'list' : '';
      r.icon.style.display = ic ? '' : 'none';
      if (ic) { setIcon(r.icon, ic); }
      r.name.textContent = c.kind === 'search' && query ? t('vod.searchFor', { q: query }) : c.kind === 'sort' ? t('vod.sortBy', { m: t('vod.sort.' + sortMode) }) : c.name;
      r.count.textContent = c.kind === 'update' || c.kind === 'find' || c.kind === 'manage' || c.kind === 'sort' || (c.kind === 'search' && !query) ? '' : formatCount(c.count);
    }
  });

  function catCount(): number {
    let n = 0;
    for (let i = 0; i < cats.length; i++) { if (cats[i].kind === 'cat') { n++; } }
    return n;
  }

  // "Category n of N" under the column, for the focused (or shown) provider category.
  function renderCounter(pos: number): void {
    const n = catCount();
    const first = cats.length - n;
    counter.textContent = n && pos >= first ? t('vod.catPos', { i: formatCount(pos - first + 1), n: formatCount(n) }) + '   ' + t('vod.chPage') : n ? t('vod.chPage') : '';
  }

  function showToast(title: string, body: string): void {
    toastTitle.textContent = title;
    toastBody.textContent = body;
    toast.className = 'ss-toast';
    if (toastTimer !== null) { d.clearTimer(toastTimer); }
    toastTimer = d.setTimer(function () { toastTimer = null; toast.className = 'ss-toast is-hidden'; }, 3000);
  }

  function itemAt(pos: number): VodItem | null {
    if (myItems) { return pos >= 0 && pos < myItems.length ? myItems[pos] : null; }
    return view && pos >= 0 && pos < list.length ? view.item(list.at(pos)) : null;
  }

  function savedItems(): VodItem[] {
    const out: VodItem[] = [];
    const l = d.myList ? d.myList.list(pid, p.section) : [];
    for (let i = 0; i < l.length; i++) { out.push(l[i].item); }
    return out;
  }

  // Titles of the rows on screen plus one screen above and below, read in the background.
  function scheduleEnsure(): void {
    if (ensureTimer !== null || !view) {
      return;
    }
    ensureTimer = d.setTimer(runEnsure, 0);
  }
  function runEnsure(): void {
    ensureTimer = null;
    if (!alive || !view || myItems) {
      return; // My List items are stored with the list, nothing to read
    }
    if (ensuring) {
      ensureAgain = true;
      return;
    }
    const v = view;
    const top = grid.top();
    const from = Math.max(0, (top - GRID_ROWS) * GRID_COLUMNS);
    const to = Math.min(list.length, (top + 2 * GRID_ROWS) * GRID_COLUMNS);
    const want: number[] = [];
    for (let i = from; i < to; i++) {
      const g = list.at(i);
      if (!v.item(g) && !v.failed(g)) {
        want.push(g);
      }
    }
    if (!want.length) {
      return;
    }
    const gen = listGen;
    ensuring = true;
    const t0 = d.now();
    v.ensure(want).then(function () {
      ensuring = false;
      if (!alive || v !== view) {
        return;
      }
      perf.lastEnsureMs = d.now() - t0;
      if (perf.firstItemsMs === undefined && tOpen) {
        perf.firstItemsMs = d.now() - tOpen;
        d.log.info('vod browse titles shown', { section: p.section, ms: perf.firstItemsMs, pages: v.pagesInMemory() });
      }
      if (gen === listGen) {
        grid.refresh();
      }
      if (ensureAgain || gen !== listGen) {
        ensureAgain = false;
        scheduleEnsure();
      }
    });
  }

  const grid: VirtualList = createVirtualList<GridRow>(d.doc, {
    rows: GRID_ROWS, visible: GRID_VISIBLE, className: 'ss-vod__grid',
    createRow: function () {
      const cards: Card[] = [];
      const els: HTMLElement[] = [];
      for (let c = 0; c < GRID_COLUMNS; c++) {
        const img = h(d.doc, 'img', { className: 'ss-card__img', attrs: { alt: '' } });
        const ph = h(d.doc, 'div', { className: 'ss-card__ph' });
        const title = h(d.doc, 'div', { className: 'ss-card__title' });
        const root = h(d.doc, 'div', { className: 'ss-card' }, [h(d.doc, 'div', { className: 'ss-card__art' }, [ph, img]), title]);
        const card: Card = { root: root, img: img, ph: ph, title: title, src: '' };
        img.style.visibility = 'hidden'; // until a poster URL is bound
        img.addEventListener('error', function () { img.style.visibility = 'hidden'; ph.style.visibility = 'visible'; });
        img.addEventListener('load', function () { ph.style.visibility = 'hidden'; });
        cards.push(card);
        els.push(root);
      }
      return { root: h(d.doc, 'div', { className: 'ss-vod__row' }, els), parts: { cards: cards } };
    },
    bind: function (r, row, rowFocused) {
      for (let c = 0; c < GRID_COLUMNS; c++) {
        const card = r.cards[c];
        const pos = row * GRID_COLUMNS + c;
        if (!view || pos >= list.length) {
          // Stage 11 (TV): the poster and placeholder have their own visibility, which a hidden card
          // does not override; clear them too, or the previous list's posters stay on screen.
          card.root.style.visibility = 'hidden';
          card.img.style.visibility = 'hidden';
          card.img.removeAttribute('src');
          card.ph.style.visibility = 'hidden';
          card.title.textContent = '';
          card.src = '#cleared'; // the next bind repaints this card in full
          continue;
        }
        card.root.style.visibility = 'visible';
        card.root.className = 'ss-card' + (rowFocused && c === focusCol ? ' is-focused' : '');
        const it = itemAt(pos);
        if (!it) {
          // Not read yet (placeholder until its page arrives) or unreadable ("—").
          const bad = view.failed(list.at(pos));
          card.title.textContent = bad ? '—' : '';
          card.ph.textContent = bad ? '—' : '';
          card.ph.style.visibility = 'visible';
          if (card.src) {
            card.src = '';
            card.img.style.visibility = 'hidden';
            card.img.removeAttribute('src');
          }
          if (!bad) { scheduleEnsure(); }
          continue;
        }
        // Locked adult title in a mixed list: no name, no poster.
        const hide = isLocked(d.parental, it.adult);
        card.title.textContent = hide ? t('pin.lockedTitle') : it.name;
        card.ph.textContent = hide ? t('pin.lockedTitle') : it.name;
        const src = hide ? '' : it.poster || '';
        if (src !== card.src) {
          card.src = src;
          card.ph.style.visibility = 'visible';
          if (src) {
            card.img.style.visibility = 'visible';
            card.img.setAttribute('src', src);
          } else {
            card.img.style.visibility = 'hidden';
            card.img.removeAttribute('src');
          }
        }
      }
    }
  });

  function rows(): number {
    return Math.ceil(list.length / GRID_COLUMNS);
  }

  function catItems(): CatItem[] {
    if (!view) {
      return [];
    }
    const out: CatItem[] = [
      { kind: 'search', id: '', name: t('vod.search'), count: results.length },
      { kind: 'find', id: '', name: t('vod.find'), count: 0 },
      { kind: 'update', id: '', name: t('vod.update'), count: 0 },
      { kind: 'all', id: '', name: movies ? t('vod.allMovies') : t('vod.allSeries'), count: view.total }
    ];
    // Stage 11: My List after All (the sort order is a button above the grid, see sortBtn).
    if (d.myList) { out.push({ kind: 'mylist', id: '', name: t('vod.myList'), count: d.myList.list(pid, p.section).length }); }
    if (d.catPrefs) { out.push({ kind: 'manage', id: '', name: t('cat.manage'), count: 0 }); }
    const cs = view.categories;
    // Stage 14: the user's order without the hidden categories (index list; titles untouched).
    const order = arrange(cs, prefs);
    for (let j = 0; j < order.length; j++) {
      const i = order[j];
      if (cs[i].count > 0) {
        out.push({ kind: 'cat', id: cs[i].id, name: cs[i].name || t('vod.uncategorised'), count: cs[i].count, adult: cs[i].adult });
      }
    }
    return out;
  }

  /**
   * Stage 11: a provider category in the chosen order. Sorting reads the category's title pages
   * once (categories of up to SORT_MAX titles only) and keeps one sorted position list; until it
   * is ready the provider order shows. Nothing is downloaded and the stored list is not changed.
   */
  function sortedList(catId: string): ListRef {
    const base = view ? view.byCategory(catId) : EMPTY;
    if (sortMode === 'provider' || !view || base.length < 2 || base.length > SORT_MAX) { return base; }
    if (sorted && sorted.catId === catId && sorted.mode === sortMode) { return arrayList(sorted.positions); }
    // TV run: free memory fell to 129–133 MB right after repeated sorts of a 4,754-title category.
    // Below the app's 150 MB floor no sort is started; the provider order stays.
    const mb = d.memoryMB ? d.memoryMB() : -1;
    if (d.minFreeMB && mb >= 0 && mb < d.minFreeMB) {
      showToast(t('vod.sortLowMemory'), t('vod.sortLowMemoryBody'));
      return base;
    }
    sorted = null; // the previous sorted list is released before a new one is built
    const v = view;
    const mode = sortMode;
    const mine = ++sortGen;
    const positions: number[] = [];
    for (let i = 0; i < base.length; i++) { positions.push(base.at(i)); }
    const t0 = d.now();
    v.sortKeys(positions).then(function (k) {
      if (!alive || v !== view || mine !== sortGen) { return; }
      sorted = { catId: catId, mode: mode, positions: sortPositions(positions, k.names, k.years, mode) };
      perf.lastSortMs = d.now() - t0;
      d.log.info('vod sort', { items: positions.length, mode: mode, ms: perf.lastSortMs });
      const c = cats[catPos];
      if (c && c.kind === 'cat' && c.id === catId && sortMode === mode) { showCategory(catPos); }
    });
    return base;
  }

  // Stage 11: "Sort: …" above the grid (movies only); it always sorts the category on screen.
  const sortBtn = h(d.doc, 'div', { className: 'ss-vod__sortbtn' });
  function paintSort(focused: boolean): void {
    sortBtn.textContent = t('vod.sortBy', { m: t('vod.sort.' + sortMode) });
    sortBtn.className = 'ss-vod__sortbtn' + (focused ? ' is-focused' : '');
  }

  /** Stage 11: OK on the sort button: the next order, applied to the category on screen. */
  function cycleSort(): void {
    sortMode = nextSortMode(sortMode);
    paintSort(true);
    const c = cats[catPos];
    if (sortMode !== 'provider' && (!c || c.kind !== 'cat' || c.count > SORT_MAX)) {
      showToast(t('vod.sortUnavailable'), t('vod.sortUnavailableBody', { n: formatCount(SORT_MAX) }));
    }
    if (c && c.kind === 'cat') { showCategory(catPos); }
  }

  function showCategory(pos: number): void {
    const t0 = d.now();
    const moved = catPos !== pos;
    catPos = pos;
    if (moved) { catList.refresh(); } // selected tint follows the shown category
    const c = cats[pos];
    const lockedCat = !!c && c.kind === 'cat' && isLocked(d.parental, !!c.adult);
    myItems = view && c && c.kind === 'mylist' ? savedItems() : null;
    list = !view || !c || lockedCat ? EMPTY : myItems ? { length: myItems.length, at: function () { return -1; } } : c.kind === 'search' ? arrayList(results) : c.kind === 'cat' ? sortedList(c.id) : view.all();
    listGen++;
    message.textContent = list.length ? '' : lockedCat ? t('pin.lockedCategory') : c && c.kind === 'mylist' ? t('vod.myListEmpty') : c && c.kind === 'search' ? (searchJob ? t('vod.searching', { n: '0' }) : query ? t('vod.noResults') : t('vod.searchHint')) : t('vod.emptyCategory');
    focus.remember('grid', 0);
    focusCol = -1;
    grid.reset();
    grid.setCount(rows());
    focus.refresh('grid');
    perf.lastCategoryMs = d.now() - t0;
  }

  function renderStatus(): void {
    if (job) {
      return;
    }
    const st = d.vod.state(pid, p.section);
    status.textContent = st ? t('vod.updated', { when: formatDateTime(st.at), n: formatCount(st.items) }) : '';
  }

  function applyView(next: VodView): void {
    const t1 = d.now();
    if (searchJob) { searchJob.cancel(); searchJob = null; }
    view = next;
    query = '';
    results = [];
    cats = catItems();
    if (catPos >= cats.length) { catPos = ALL_POS; }
    catList.setCount(cats.length);
    catList.refresh();
    showCategory(catPos);
    renderCounter(catPos);
    const cur = focus.current();
    if (!cur) {
      focus.focus('cats', catPos);
      if (list.length) { focus.focus('grid', 0); }
    }
    perf.renderMs = d.now() - t1;
    perf.items = next.total;
    d.log.info('vod browse ready', { section: p.section, items: next.total, categories: cats.length, loadMs: perf.loadMs, renderMs: perf.renderMs });
  }

  function load(): void {
    const t0 = d.now();
    tOpen = t0;
    message.textContent = t('vod.loading');
    d.vod.load(pid, p.section).then(function (l) {
      if (!alive) {
        return;
      }
      perf.loadMs = d.now() - t0;
      if (l.status === 'ok') {
        applyView(l.view);
        renderStatus();
        return;
      }
      if (l.status === 'missing') {
        update(); // first open: download the list
        return;
      }
      message.textContent = t('vod.failed', { reason: t('vod.err.' + l.code) });
    });
  }

  function update(): void {
    if (job) {
      return;
    }
    if (!d.vod.supported(pid)) {
      message.textContent = t('vod.notSupported');
      return;
    }
    status.textContent = t('vod.downloadingStart');
    chipText.textContent = t('vod.downloadingStart');
    chip.className = 'ss-chip';
    if (!view) { message.textContent = t('vod.downloadingStart'); }
    const t0 = d.now();
    job = d.vod.refresh(pid, p.section, function (n) {
      if (alive) {
        status.textContent = t('vod.downloading', { n: formatCount(n) });
        chipText.textContent = status.textContent;
      }
    });
    job.result.then(function (r) {
      job = null;
      if (!alive) {
        return;
      }
      chip.className = 'ss-chip is-hidden';
      perf.refreshMs = d.now() - t0;
      if (!r.ok) {
        status.textContent = t('vod.failed', { reason: t('vod.err.' + (r.code || 'network')) });
        if (!view) {
          message.textContent = status.textContent;
        } else {
          // The stored list stays in use (Stage 6.1 commit rule); say so briefly.
          const st = d.vod.state(pid, p.section);
          showToast(t('vod.failTitle'), st ? t('vod.failBody', { when: formatDateTime(st.at) }) : t('vod.failBodyNone'));
        }
        return;
      }
      tOpen = d.now();
      delete perf.firstItemsMs;
      d.vod.load(pid, p.section).then(function (l) {
        if (!alive) {
          return;
        }
        if (l.status === 'ok') {
          applyView(l.view);
        } else {
          message.textContent = t('vod.failed', { reason: t('vod.err.' + (l.status === 'error' ? l.code : 'storage')) });
        }
        renderStatus();
      });
    });
  }

  function openSearch(): void {
    d.openText(nav, {
      title: t('vod.searchTitle'), value: query, mode: 'text', maxLength: 40,
      onDone: function (q) {
        if (!view || !alive) {
          return;
        }
        const v = view;
        const t0 = d.now();
        if (searchJob) { searchJob.cancel(); searchJob = null; }
        query = q.replace(/^\s+|\s+$/g, '');
        results = [];
        let focused = false;
        function show(r: number[], running: boolean): void {
          if (!alive || v !== view) {
            return;
          }
          results = r;
          cats[0].count = r.length;
          catList.refresh();
          if (catPos === 0) {
            // Same list grows: keep the grid position, only the count changes.
            list = arrayList(results);
            listGen++;
            grid.setCount(rows());
            grid.refresh();
            message.textContent = r.length ? '' : running ? t('vod.searching', { n: '0' }) : t('vod.noResults');
            status.textContent = running ? t('vod.searching', { n: formatCount(r.length) }) : status.textContent;
            if (r.length && !focused) {
              focused = true;
              const cur = focus.current();
              if (!cur || cur.zone === 'cats') { focus.focus('grid', 0); }
            }
          }
        }
        if (!query) {
          cats = catItems();
          catList.refresh();
          showCategory(0);
          return;
        }
        const sj = v.search(query, SEARCH_MAX, function (sofar) {
          if (searchJob === sj) { show(sofar, true); }
        });
        searchJob = sj;
        cats = catItems();
        catList.refresh();
        showCategory(0);
        sj.result.then(function (r) {
          if (searchJob !== sj) {
            return;
          }
          searchJob = null;
          perf.lastSearchMs = d.now() - t0;
          show(r, false);
          renderStatus();
        });
      }
    });
  }

  // Find a category (design 23a): side sheet inside this screen; the filter is typed in the text
  // entry, which opens on top while the sheet stays visible.
  const find = createFindPanel(d.doc, t);
  let findWhere: number[] = [];
  function openFind(): void {
    if (!view) {
      return;
    }
    const names: string[] = [];
    const counts: number[] = [];
    findWhere = [];
    for (let i = 0; i < cats.length; i++) {
      if (cats[i].kind === 'cat') {
        names.push(cats[i].name);
        counts.push(cats[i].count);
        findWhere.push(i);
      }
    }
    find.open(names, counts);
  }
  function findKey(k: RemoteKeyEvent['key']): void {
    const r = find.key(k);
    if (r === 'edit') {
      d.openText(nav, {
        title: t('vod.findFilter'), value: find.query(), mode: 'text', maxLength: 40,
        onDone: function (v) { if (alive) { find.setQuery(v.replace(/^\s+|\s+$/g, '')); } }
      });
    } else if (typeof r === 'number') {
      const pos = findWhere[r];
      find.close();
      if (catTimer !== null) { d.clearTimer(catTimer); catTimer = null; }
      showCategory(pos);
      focus.focus('cats', pos);
      if (list.length) { focus.focus('grid', 0); }
    }
  }


  // Stage 14: "Manage categories" (category-manager.ts). Changes are saved at once; the category
  // column is rebuilt from the saved prefs when the sheet closes (ids only, no catalogue copies).
  const manager = createCategoryManager(d.doc, t);
  let noteTimer: unknown = null;
  function flashNote(text: string): void {
    showToast(t('cat.title'), text);
  }
  function openManager(): void {
    const cs = view ? view.categories : null;
    if (!cs || !d.catPrefs) { return; }
    const free = d.memoryMB ? d.memoryMB() : -1;
    if (d.minFreeMB && free >= 0 && free < d.minFreeMB) {
      d.log.warn('categories: manager not opened, memory low', { section: 'vod', freeMB: free, minFreeMB: d.minFreeMB });
      flashNote(t('cat.lowMemory'));
      return;
    }
    if (catTimer !== null) { d.clearTimer(catTimer); catTimer = null; }
    const names: string[] = [];
    const counts: number[] = [];
    const listed: number[] = [];
    for (let i = 0; i < cs.length; i++) {
      names.push(cs[i].name || t('vod.uncategorised'));
      counts.push(cs[i].count);
      if (cs[i].count > 0) { listed.push(i); }
    }
    manager.open({ section: movies ? t('vod.movies') : t('vod.series'), provider: cs, names: names, counts: counts, listed: listed, prefs: prefs });
    d.log.info('categories: manager opened', { section: 'vod', categories: listed.length, hidden: prefs.hidden.length, ordered: prefs.order.length > 0, freeMB: free });
  }
  function saveManager(): void {
    if (!d.catPrefs) { return; }
    prefs = manager.prefs();
    const ok = d.catPrefs.set(pid, p.section, prefs);
    manager.note(ok ? t('cat.saved') : t('cat.notSaved'), !ok);
    if (!ok) { d.log.warn('categories: not saved', { section: 'vod' }); }
  }
  function confirmRestore(): void {
    const cp: ConfirmParams = {
      title: t('cat.restoreTitle'), paragraphs: [t('cat.restoreText', { section: movies ? t('vod.movies') : t('vod.series') })],
      buttons: [{ label: t('common.cancel') }, {
        label: t('cat.restoreOk'), run: function () {
          if (!alive || !d.catPrefs || !manager.isOpen()) { return; }
          d.catPrefs.reset(pid, p.section);
          prefs = emptyPrefs();
          manager.reload(prefs);
          manager.note(t('cat.saved'), false);
          d.log.info('categories: defaults restored', { section: 'vod' });
        }
      }]
    };
    nav.openOverlay('confirm', cp as unknown as Record<string, unknown>);
  }
  /** Category column from the saved prefs; the shown category stays shown unless it was hidden. */
  function applyPrefs(): void {
    if (!view) { return; }
    const was = cats[catPos];
    cats = catItems();
    let at = -1;
    let manageAt = -1;
    for (let i = 0; i < cats.length; i++) {
      if (was && at < 0 && cats[i].kind === was.kind && cats[i].id === was.id) { at = i; }
      if (cats[i].kind === 'manage') { manageAt = i; }
    }
    catList.setCount(cats.length);
    if (at < 0) {
      catList.refresh();
      showCategory(ALL_POS); // the shown category was hidden: All
    } else {
      catPos = at;
      catList.refresh();
    }
    renderCounter(catPos);
    focus.focus('cats', manageAt >= 0 ? manageAt : catPos);
  }
  function managerResult(r: ManagerResult): void {
    if (r === 'changed') { saveManager(); }
    if (r === 'restore') { confirmRestore(); }
    if (r === 'close') { manager.close(); applyPrefs(); }
  }

  function open(pos: number): void {
    const it = itemAt(pos);
    if (!it) {
      // OK before the card's page arrived: open it once read (unless the list changed meanwhile).
      const v = view;
      const gen = listGen;
      if (v && pos < list.length && !v.failed(list.at(pos))) {
        v.ensure([list.at(pos)]).then(function () {
          if (alive && v === view && gen === listGen && itemAt(pos) && nav.stack().slice(-1)[0] === 'vod-browse') { open(pos); }
        });
      }
      return;
    }
    const dp: VodDetailsParams = { playlistId: pid, section: p.section, item: it };
    withParental(nav, d.parental, it.adult, t('pin.lockedTitle'), function () {
      if (alive) { grid.refresh(); nav.push('vod-details', dp as unknown as Record<string, unknown>); }
    });
  }

  const focus = createFocusManager(function (zone, index, focused) {
    if (zone === 'rail') {
      rail.setFocused(index, focused);
      rail.setOpen(focused);
      return;
    }
    if (zone === 'cats') {
      catList.setFocused(index, focused);
      if (focused) { renderCounter(index); }
      return;
    }
    if (zone === 'sort') {
      paintSort(focused);
      return;
    }
    const row = Math.floor(index / GRID_COLUMNS);
    focusCol = focused ? index % GRID_COLUMNS : -1;
    grid.setFocused(row, focused);
    grid.refresh(); // the focused card within the row changed
    scheduleEnsure(); // keep the screen above/below read ahead while moving
  });
  focus.register({
    id: 'rail', kind: 'column', size: function () { return rail.size(); }, neighbours: { right: 'cats' },
    onSelect: function (i) {
      if (!rail.select(i)) { focus.focus('cats', catPos); }
    }
  });
  focus.remember('rail', rail.currentIndex());
  focus.register({
    id: 'cats', kind: 'column', size: function () { return cats.length; }, neighbours: { left: 'rail', right: 'grid' },
    onFocus: function (i) {
      // Stage 14: a category passed on the way (or left again within 150 ms) is not shown later.
      if (catTimer !== null) { d.clearTimer(catTimer); catTimer = null; }
      if (i === catPos || !view || cats[i].kind === 'update' || cats[i].kind === 'search' || cats[i].kind === 'find' || cats[i].kind === 'manage' || cats[i].kind === 'sort') {
        return;
      }
      if (catTimer !== null) { d.clearTimer(catTimer); }
      catTimer = d.setTimer(function () { catTimer = null; if (alive) { showCategory(i); } }, 150);
    },
    onSelect: function (i) {
      const c = cats[i];
      if (!c) {
        return;
      }
      if (c.kind === 'search') { openSearch(); return; }
      if (c.kind === 'find') { openFind(); return; }
      if (c.kind === 'update') { update(); return; }
      if (c.kind === 'manage') { openManager(); return; }
      if (catTimer !== null) { d.clearTimer(catTimer); catTimer = null; }
      if (c.kind === 'cat' && isLocked(d.parental, !!c.adult)) {
        withParental(nav, d.parental, true, c.name, function () {
          if (!alive) { return; }
          showCategory(i);
          if (list.length) { focus.focus('grid', 0); }
        });
        return;
      }
      if (i !== catPos) { showCategory(i); }
      if (list.length) { focus.focus('grid', 0); }
    }
  });
  {
    focus.register({
      id: 'sort', kind: 'row', size: function () { return view ? 1 : 0; }, neighbours: { down: 'grid', left: 'cats' },
      onSelect: function () { cycleSort(); }
    });
  }
  focus.register({
    id: 'grid', kind: 'grid', columns: GRID_COLUMNS, size: function () { return list.length; }, neighbours: { left: 'cats', up: 'sort' }, fallback: 'cats',
    onSelect: open
  });

  return {
    mount: function (layer: HostLayer) {
      const def = d.playlists.get(pid);
      (layer.element as HTMLElement).appendChild(rail.element);
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-vod' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [
          h(d.doc, 'div', { className: 'ss-live__title', text: movies ? t('vod.movies') : t('vod.series') }),
          h(d.doc, 'div', { className: 'ss-live__account', text: def ? def.name : '' }),
          status,
          h(d.doc, 'div', { className: 'ss-vod__spacer' }),
          sortBtn,
          chip
        ]),
        h(d.doc, 'div', { className: 'ss-live__columns' }, [
          h(d.doc, 'div', { className: 'ss-vod__side' }, [catList.element, counter]),
          h(d.doc, 'div', { className: 'ss-vod__main' }, [grid.element, message])
        ]),
        toast
      ]));
      (layer.element as HTMLElement).appendChild(find.element);
      (layer.element as HTMLElement).appendChild(manager.element);
      paintSort(false);
      if (!d.vod.supported(pid)) {
        message.textContent = t('vod.notSupported');
        return;
      }
      load();
    },
    onShow: function () {
      renderStatus();
      // Stage 11: back from Details, where a title may have been added to or removed from My List.
      if (view && d.myList) {
        const at = focus.current();
        cats = catItems();
        catList.refresh();
        if (myItems) {
          showCategory(catPos);
          if (at && at.zone === 'grid' && list.length) { focus.focus('grid', Math.min(at.index, list.length - 1)); } else if (at && at.zone === 'grid') { focus.focus('cats', catPos); }
        }
      }
    },
    onHide: function () { /* details on top */ },
    onKey: function (e: RemoteKeyEvent) {
      if (manager.isOpen()) {
        managerResult(manager.key(e.key)); // the sheet is modal while open
        return true;
      }
      if (find.isOpen()) {
        findKey(e.key); // the sheet is modal while open
        return true;
      }
      const cur = focus.current();
      if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      if ((e.key === 'chUp' || e.key === 'chDown') && cur && cur.zone === 'grid' && list.length) {
        const step = GRID_COLUMNS * GRID_VISIBLE;
        focus.focus('grid', Math.max(0, Math.min(list.length - 1, cur.index + (e.key === 'chDown' ? step : -step))));
        return true;
      }
      if ((e.key === 'chUp' || e.key === 'chDown') && cur && cur.zone === 'cats' && cats.length) {
        focus.focus('cats', Math.max(0, Math.min(cats.length - 1, cur.index + (e.key === 'chDown' ? CATEGORY_PAGE : -CATEGORY_PAGE))));
        return true;
      }
      if (e.key === 'yellow' && cur && cur.zone !== 'rail') {
        openFind();
        return true;
      }
      return false;
    },
    onBack: function () {
      if (manager.isOpen()) {
        managerResult(manager.back());
        return true;
      }
      if (find.isOpen()) {
        find.close(); // no change; focus stays where it was ("Find a category" or the grid)
        return true;
      }
      const cur = focus.current();
      if (cur && cur.zone === 'rail') {
        focus.focus('cats', catPos);
        return true;
      }
      if (cur && (cur.zone === 'grid' || cur.zone === 'sort')) {
        focus.focus('cats', catPos);
        return true;
      }
      return false;
    },
    destroy: function () {
      if (view) {
        const tm = view.timings();
        d.log.info('vod browse closed', { section: p.section, pages: view.pagesInMemory(), maxPageReadMs: tm.maxReadMs, maxPageDecodeMs: tm.maxDecodeMs, lastSearchMs: perf.lastSearchMs || 0 });
      }
      alive = false;
      if (job) { job.abort(); job = null; }
      if (searchJob) { searchJob.cancel(); searchJob = null; }
      if (catTimer !== null) { d.clearTimer(catTimer); }
      if (ensureTimer !== null) { d.clearTimer(ensureTimer); ensureTimer = null; }
      if (toastTimer !== null) { d.clearTimer(toastTimer); toastTimer = null; }
      if (noteTimer !== null) { d.clearTimer(noteTimer); noteTimer = null; }
      if (manager.isOpen()) { manager.close(); }
      view = null;
    },
    perf: function () {
      perf.binds = grid.binds();
      if (view) {
        perf.pagesInMemory = view.pagesInMemory();
        const tm = view.timings();
        perf.maxPageReadMs = tm.maxReadMs;
        perf.maxPageDecodeMs = tm.maxDecodeMs;
      }
      return perf;
    }
  };
}
