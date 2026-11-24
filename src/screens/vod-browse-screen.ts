// Movies / Series browse screen (Stage 6): categories | poster grid.
//   Left:  Search, Update list, All movies/series, then the provider's categories (with counts).
//   Right: virtualised poster grid, 7 columns × 3 visible rows; a fixed pool of row nodes is
//          rebound while scrolling, so 50,000 titles cost the same DOM as 28 cards. Posters load
//          only for bound cards; a missing or broken image shows the title instead.
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
import { createVodIndex } from '../content/vod-index.ts';
import type { VodIndex } from '../content/vod-index.ts';
import type { VodItem } from '../models/content.ts';
import type { Translate } from '../i18n/strings.ts';
import type { KeyboardParams } from './keyboard-overlay.ts';
import type { Logger } from '../utils/log.ts';
import { formatCount, formatDateTime } from './format.ts';
import { h } from '../utils/dom.ts';

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

type CatKind = 'search' | 'update' | 'all' | 'cat';
interface CatItem { kind: CatKind; id: string; name: string; count: number }
interface CatRow { name: HTMLElement; count: HTMLElement }
interface Card { root: HTMLElement; img: HTMLElement; ph: HTMLElement; title: HTMLElement; src: string }
interface GridRow { cards: Card[] }

export const GRID_COLUMNS = 7;
const GRID_ROWS = 4; // 3 visible + 1 partly visible
const CATEGORY_ROWS = 13;

export function createVodBrowseScreen(d: VodBrowseDeps, p: VodBrowseParams, nav: Router): Screen & { perf(): Record<string, number> } {
  const t = d.t;
  const pid = p.playlistId;
  const movies = p.section === 'movie';
  let idx: VodIndex | null = null;
  let cats: CatItem[] = [];
  let catPos = 2; // "All"
  let list: number[] = [];
  let query = '';
  let results: number[] = [];
  let alive = true;
  let job: VodJob | null = null;
  let catTimer: unknown = null;
  let focusCol = -1;
  const perf: Record<string, number> = {};

  const status = h(d.doc, 'div', { className: 'ss-live__status' });
  const message = h(d.doc, 'div', { className: 'ss-vod__message' });

  const catList: VirtualList = createVirtualList<CatRow>(d.doc, {
    rows: CATEGORY_ROWS, className: 'ss-live__cats',
    createRow: function () {
      const name = h(d.doc, 'div', { className: 'ss-cat__name' });
      const count = h(d.doc, 'div', { className: 'ss-cat__count' });
      return { root: h(d.doc, 'div', { className: 'ss-cat' }, [name, count]), parts: { name: name, count: count } };
    },
    bind: function (r, i) {
      const c = cats[i];
      r.name.textContent = c.kind === 'search' && query ? t('vod.searchFor', { q: query }) : c.name;
      r.count.textContent = c.kind === 'update' || (c.kind === 'search' && !query) ? '' : formatCount(c.count);
    }
  });

  function itemAt(pos: number): VodItem | null {
    return idx && pos >= 0 && pos < list.length ? idx.catalogue.items[list[pos]] : null;
  }

  const grid: VirtualList = createVirtualList<GridRow>(d.doc, {
    rows: GRID_ROWS, className: 'ss-vod__grid',
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
        const it = itemAt(row * GRID_COLUMNS + c);
        if (!it) {
          card.root.style.visibility = 'hidden';
          continue;
        }
        card.root.style.visibility = 'visible';
        card.root.className = 'ss-card' + (rowFocused && c === focusCol ? ' is-focused' : '');
        card.title.textContent = it.name;
        card.ph.textContent = it.name;
        const src = it.poster || '';
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
    if (!idx) {
      return [];
    }
    const out: CatItem[] = [
      { kind: 'search', id: '', name: t('vod.search'), count: results.length },
      { kind: 'update', id: '', name: t('vod.update'), count: 0 },
      { kind: 'all', id: '', name: movies ? t('vod.allMovies') : t('vod.allSeries'), count: idx.catalogue.items.length }
    ];
    const cs = idx.catalogue.categories;
    for (let i = 0; i < cs.length; i++) {
      if (cs[i].count > 0) {
        out.push({ kind: 'cat', id: cs[i].id, name: cs[i].name || t('vod.uncategorised'), count: cs[i].count });
      }
    }
    return out;
  }

  function showCategory(pos: number): void {
    const t0 = d.now();
    catPos = pos;
    const c = cats[pos];
    list = !idx || !c ? [] : c.kind === 'search' ? results : c.kind === 'all' || c.kind === 'update' ? idx.all() : idx.byCategory(c.id);
    message.textContent = list.length ? '' : c && c.kind === 'search' ? (query ? t('vod.noResults') : t('vod.searchHint')) : t('vod.emptyCategory');
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

  function applyIndex(next: VodIndex): void {
    const t1 = d.now();
    idx = next;
    cats = catItems();
    if (catPos >= cats.length) { catPos = 2; }
    catList.setCount(cats.length);
    catList.refresh();
    showCategory(catPos);
    const cur = focus.current();
    if (!cur) {
      focus.focus('cats', catPos);
      if (list.length) { focus.focus('grid', 0); }
    }
    perf.renderMs = d.now() - t1;
    perf.items = next.catalogue.items.length;
    d.log.info('vod browse ready', { section: p.section, items: next.catalogue.items.length, categories: cats.length, loadMs: perf.loadMs, renderMs: perf.renderMs });
  }

  function load(): void {
    const t0 = d.now();
    message.textContent = t('vod.loading');
    d.vod.load(pid, p.section).then(function (l) {
      if (!alive) {
        return;
      }
      perf.loadMs = d.now() - t0;
      if (l.status === 'ok') {
        applyIndex(createVodIndex(l.catalogue));
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
    if (!idx) { message.textContent = t('vod.downloadingStart'); }
    const t0 = d.now();
    job = d.vod.refresh(pid, p.section, function (n) {
      if (alive) { status.textContent = t('vod.downloading', { n: formatCount(n) }); }
    });
    job.result.then(function (r) {
      job = null;
      if (!alive) {
        return;
      }
      perf.refreshMs = d.now() - t0;
      if (!r.ok) {
        status.textContent = t('vod.failed', { reason: t('vod.err.' + (r.code || 'network')) });
        if (!idx) { message.textContent = status.textContent; }
        return;
      }
      d.vod.load(pid, p.section).then(function (l) {
        if (!alive) {
          return;
        }
        if (l.status === 'ok') {
          applyIndex(createVodIndex(l.catalogue));
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
        if (!idx || !alive) {
          return;
        }
        const t0 = d.now();
        query = q.replace(/^\s+|\s+$/g, '');
        results = idx.search(query, 2000);
        perf.lastSearchMs = d.now() - t0;
        cats = catItems();
        catList.refresh();
        showCategory(0);
        if (results.length) {
          focus.focus('grid', 0);
        }
      }
    });
  }

  function open(pos: number): void {
    const it = itemAt(pos);
    if (!it) {
      return;
    }
    const dp: VodDetailsParams = { playlistId: pid, section: p.section, item: it };
    nav.push('vod-details', dp as unknown as Record<string, unknown>);
  }

  const focus = createFocusManager(function (zone, index, focused) {
    if (zone === 'cats') {
      catList.setFocused(index, focused);
      return;
    }
    const row = Math.floor(index / GRID_COLUMNS);
    focusCol = focused ? index % GRID_COLUMNS : -1;
    grid.setFocused(row, focused);
    grid.refresh(); // the focused card within the row changed
  });
  focus.register({
    id: 'cats', kind: 'column', size: function () { return cats.length; }, neighbours: { right: 'grid' },
    onFocus: function (i) {
      if (i === catPos || !idx || cats[i].kind === 'update' || cats[i].kind === 'search') {
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
      if (c.kind === 'update') { update(); return; }
      if (catTimer !== null) { d.clearTimer(catTimer); catTimer = null; }
      if (i !== catPos) { showCategory(i); }
      if (list.length) { focus.focus('grid', 0); }
    }
  });
  focus.register({
    id: 'grid', kind: 'grid', columns: GRID_COLUMNS, size: function () { return list.length; }, neighbours: { left: 'cats' }, fallback: 'cats',
    onSelect: open
  });

  return {
    mount: function (layer: HostLayer) {
      const def = d.playlists.get(pid);
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-vod' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [
          h(d.doc, 'div', { className: 'ss-live__title', text: (movies ? t('vod.movies') : t('vod.series')) + (def ? ' · ' + def.name : '') }),
          status
        ]),
        h(d.doc, 'div', { className: 'ss-live__columns' }, [
          catList.element,
          h(d.doc, 'div', { className: 'ss-vod__main' }, [grid.element, message])
        ])
      ]));
      if (!d.vod.supported(pid)) {
        message.textContent = t('vod.notSupported');
        return;
      }
      load();
    },
    onShow: function () { renderStatus(); },
    onHide: function () { /* details on top */ },
    onKey: function (e: RemoteKeyEvent) {
      const cur = focus.current();
      if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      if ((e.key === 'chUp' || e.key === 'chDown') && cur && cur.zone === 'grid' && list.length) {
        const step = GRID_COLUMNS * 3;
        focus.focus('grid', Math.max(0, Math.min(list.length - 1, cur.index + (e.key === 'chDown' ? step : -step))));
        return true;
      }
      return false;
    },
    onBack: function () {
      const cur = focus.current();
      if (cur && cur.zone === 'grid') {
        focus.focus('cats', catPos);
        return true;
      }
      return false;
    },
    destroy: function () {
      alive = false;
      if (job) { job.abort(); job = null; }
      if (catTimer !== null) { d.clearTimer(catTimer); }
      idx = null;
    },
    perf: function () {
      perf.binds = grid.binds();
      return perf;
    }
  };
}
