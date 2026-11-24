// Live TV (Stage 5): categories | channels | channel details.
//   Left:   Search, Favourites, Recently watched, All channels, then the playlist's categories.
//   Middle: virtualised channel list (number, logo, name, current programme, ★ favourite).
//   Right:  details of the focused channel (now/next with times and description) and actions
//           Watch / Favourite / Update guide.
// Remote: ↑↓ move, ←→ change column, OK selects (category → channels, channel → watch),
// CH+/CH− page through the channel list, Back steps left and finally leaves the screen.
// Data comes from PlaylistService (catalogue), EpgService (guide), UserLists (favourites, recent);
// the screen only arranges and renders it. Category changes rebind index arrays, never channels.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import type { ButtonList } from '../components/button-list.ts';
import { createVirtualList } from '../components/virtual-list.ts';
import type { VirtualList } from '../components/virtual-list.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { EpgJob, EpgService } from '../services/epg-service.ts';
import type { UserLists } from '../services/user-lists.ts';
import { createChannelIndex } from '../content/channel-index.ts';
import type { ChannelIndex } from '../content/channel-index.ts';
import type { Channel, Programme } from '../models/content.ts';
import type { Translate } from '../i18n/strings.ts';
import type { KeyboardParams } from './keyboard-overlay.ts';
import type { Logger } from '../utils/log.ts';
import { formatCount } from './format.ts';
import { clear, h } from '../utils/dom.ts';

export interface LiveTvDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  epg: EpgService;
  lists: UserLists;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  /** Opens the preferred text entry (system IME or the app keyboard). */
  openText: (nav: Router, p: KeyboardParams) => void;
  log: Logger;
}

export interface LiveTvParams {
  playlistId: string;
}

/** What the player screen receives to zap within the current list. */
export interface PlayerParams {
  playlistId: string;
  index: ChannelIndex;
  list: number[];
  pos: number;
}

type CatKind = 'search' | 'fav' | 'recent' | 'all' | 'cat';
interface CatItem { kind: CatKind; id: string; name: string; count: number }

const CHANNEL_ROWS = 11;
const CATEGORY_ROWS = 13;
const PAGE = 10;

function two(n: number): string { return (n < 10 ? '0' : '') + n; }
export function clock(ms: number): string {
  const d = new Date(ms);
  return two(d.getHours()) + ':' + two(d.getMinutes());
}

interface ChanRow { num: HTMLElement; logo: HTMLElement; name: HTMLElement; now: HTMLElement; fav: HTMLElement; logoSrc: string }
interface CatRow { name: HTMLElement; count: HTMLElement }

export function createLiveTvScreen(d: LiveTvDeps, p: LiveTvParams, nav: Router): Screen & { perf(): Record<string, number> } {
  const t = d.t;
  const pid = p.playlistId;
  let idx: ChannelIndex | null = null;
  let cats: CatItem[] = [];
  let catPos = 3; // "All channels"
  let list: number[] = [];
  let query = '';
  let searchResults: number[] = [];
  let alive = true;
  let epgJob: EpgJob | null = null;
  let infoTimer: unknown = null;
  let catTimer: unknown = null;
  let shortFor = '';
  let shortList: Programme[] | null = null;
  let playing = false;
  const perf: Record<string, number> = {};

  const header = h(d.doc, 'div', { className: 'ss-live__status' });
  const message = h(d.doc, 'div', { className: 'ss-live__message' });
  const info = h(d.doc, 'div', { className: 'ss-live__info' });
  let actions: ButtonList = createButtonList(d.doc, [t('live.watch'), t('live.favAdd'), t('live.updateGuide')], true);
  const actionsBox = h(d.doc, 'div', { className: 'ss-live__actions' }, [actions.element]);

  const catList: VirtualList = createVirtualList<CatRow>(d.doc, {
    rows: CATEGORY_ROWS, className: 'ss-live__cats',
    createRow: function () {
      const name = h(d.doc, 'div', { className: 'ss-cat__name' });
      const count = h(d.doc, 'div', { className: 'ss-cat__count' });
      return { root: h(d.doc, 'div', { className: 'ss-cat' }, [name, count]), parts: { name: name, count: count } };
    },
    bind: function (r, i) {
      const c = cats[i];
      r.name.textContent = c.kind === 'search' && query ? t('live.searchFor', { q: query }) : c.name;
      r.count.textContent = c.kind === 'search' && !query ? '' : formatCount(c.count);
    }
  });

  const chanList: VirtualList = createVirtualList<ChanRow>(d.doc, {
    rows: CHANNEL_ROWS, className: 'ss-live__chans',
    createRow: function () {
      const num = h(d.doc, 'div', { className: 'ss-ch__num' });
      const logo = h(d.doc, 'img', { className: 'ss-ch__logo', attrs: { alt: '' } });
      logo.addEventListener('error', function () { logo.style.visibility = 'hidden'; });
      const name = h(d.doc, 'div', { className: 'ss-ch__name' });
      const now = h(d.doc, 'div', { className: 'ss-ch__now' });
      const fav = h(d.doc, 'div', { className: 'ss-ch__fav' });
      const text = h(d.doc, 'div', { className: 'ss-ch__text' }, [name, now]);
      return { root: h(d.doc, 'div', { className: 'ss-ch' }, [num, logo, text, fav]), parts: { num: num, logo: logo, name: name, now: now, fav: fav, logoSrc: '' } };
    },
    bind: function (r, i) {
      if (!idx) {
        return;
      }
      const c = idx.channels[list[i]];
      r.num.textContent = String(c.num);
      r.name.textContent = c.name;
      const src = c.logo || '';
      if (src !== r.logoSrc) {
        r.logoSrc = src;
        r.logo.style.visibility = src ? 'visible' : 'hidden';
        if (src) { r.logo.setAttribute('src', src); } else { r.logo.removeAttribute('src'); }
      }
      const nn = d.epg.nowNext(c);
      r.now.textContent = nn.now ? nn.now.title : '';
      r.fav.textContent = d.lists.isFavourite(pid, c.id) ? '★' : '';
    }
  });

  function focusedChannel(): Channel | null {
    const cur = focus.current();
    if (!idx || !cur || cur.zone === 'cats' || list.length === 0) {
      return null;
    }
    const pos = focus.memory('chans');
    return pos < list.length ? idx.channels[list[pos]] : null;
  }

  function catItems(): CatItem[] {
    if (!idx) {
      return [];
    }
    const out: CatItem[] = [
      { kind: 'search', id: '', name: t('live.search'), count: searchResults.length },
      { kind: 'fav', id: '', name: t('live.favourites'), count: idx.resolve(d.lists.favourites(pid)).length },
      { kind: 'recent', id: '', name: t('live.recent'), count: idx.resolve(d.lists.recent(pid)).length },
      { kind: 'all', id: '', name: t('live.all'), count: idx.channels.length }
    ];
    for (let i = 0; i < idx.categories.length; i++) {
      const c = idx.categories[i];
      if (c.count > 0) {
        out.push({ kind: 'cat', id: c.id, name: c.name || t('live.uncategorised'), count: c.count });
      }
    }
    return out;
  }

  function listFor(c: CatItem): number[] {
    if (!idx) {
      return [];
    }
    switch (c.kind) {
      case 'search': return searchResults;
      case 'fav': return idx.resolve(d.lists.favourites(pid));
      case 'recent': return idx.resolve(d.lists.recent(pid));
      case 'all': return idx.all();
      default: return idx.byCategory(c.id);
    }
  }

  function showCategory(pos: number, keepChannelPos: boolean): void {
    const t0 = d.now();
    catPos = pos;
    list = listFor(cats[pos]);
    message.textContent = list.length ? '' : cats[pos].kind === 'fav' ? t('live.noFavourites') : cats[pos].kind === 'recent' ? t('live.noRecent')
      : cats[pos].kind === 'search' ? (query ? t('live.noResults') : t('live.searchHint')) : t('live.noChannels');
    if (!keepChannelPos) {
      // A new list starts at its top; the focus itself stays where it is (usually the categories).
      focus.remember('chans', 0);
      const cur = focus.current();
      chanList.reset();
      chanList.setCount(list.length);
      if (cur && cur.zone === 'chans') {
        chanList.setFocused(0, true);
      }
    } else {
      chanList.setCount(list.length);
    }
    focus.refresh('chans');
    perf.lastCategoryMs = d.now() - t0;
  }

  function renderStatus(): void {
    const s = d.epg.status();
    let text: string;
    if (s.refreshing) {
      text = t('live.guideUpdating');
    } else if (s.state === 'ready') {
      text = t('live.guideUpdated', { when: clock(s.builtAt), channels: formatCount(s.channels) });
    } else if (s.error === 'no-source') {
      text = s.shortEpg ? t('live.guideShortOnly') : t('live.guideNone');
    } else if (s.error) {
      text = t('live.guideFailed', { reason: t('epg.err.' + s.error) });
    } else {
      text = s.shortEpg ? t('live.guideShortOnly') : t('live.guideNone');
    }
    header.textContent = text;
  }

  function progLine(pr: Programme): string {
    return clock(pr.start) + '–' + clock(pr.end) + '  ' + (pr.title || t('live.noTitle'));
  }

  function renderInfo(): void {
    clear(info);
    const c = focusedChannel() || (idx && list.length ? idx.channels[list[Math.min(focus.memory('chans'), list.length - 1)]] : null);
    if (!c || !idx) {
      return;
    }
    const cat = c.categoryId;
    let catName = '';
    for (let i = 0; i < idx.categories.length; i++) {
      if (idx.categories[i].id === cat) { catName = idx.categories[i].name; break; }
    }
    if (c.logo) {
      const img = h(d.doc, 'img', { className: 'ss-info__logo', attrs: { src: c.logo, alt: '' } });
      img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
      info.appendChild(img);
    }
    info.appendChild(h(d.doc, 'div', { className: 'ss-info__name', text: c.name }));
    info.appendChild(h(d.doc, 'div', { className: 'ss-info__meta', text: t('live.channelMeta', { num: c.num, category: catName || t('live.uncategorised') }) +
      (c.catchupDays ? ' · ' + t('live.catchup', { days: c.catchupDays }) : '') }));
    let nn = d.epg.nowNext(c);
    if (!nn.now && !nn.next && shortFor === c.id && shortList && shortList.length) {
      const tn = d.now();
      let nowP: Programme | null = null;
      let nextP: Programme | null = null;
      for (let j = 0; j < shortList.length; j++) {
        if (shortList[j].start <= tn && shortList[j].end > tn) { nowP = shortList[j]; } else if (shortList[j].start > tn && !nextP) { nextP = shortList[j]; }
      }
      nn = { now: nowP, next: nextP };
    }
    if (nn.now) {
      const tn = d.now();
      const pct = Math.max(0, Math.min(100, Math.round((tn - nn.now.start) * 100 / Math.max(1, nn.now.end - nn.now.start))));
      info.appendChild(h(d.doc, 'div', { className: 'ss-info__label', text: t('live.now') }));
      info.appendChild(h(d.doc, 'div', { className: 'ss-info__prog', text: progLine(nn.now) }));
      const bar = h(d.doc, 'div', { className: 'ss-info__bar' }, [h(d.doc, 'div', { className: 'ss-info__barfill' })]);
      (bar.firstChild as HTMLElement).style.width = pct + '%';
      info.appendChild(bar);
      if (nn.now.desc) {
        info.appendChild(h(d.doc, 'div', { className: 'ss-info__desc', text: nn.now.desc }));
      }
    }
    if (nn.next) {
      info.appendChild(h(d.doc, 'div', { className: 'ss-info__label', text: t('live.next') }));
      info.appendChild(h(d.doc, 'div', { className: 'ss-info__prog', text: progLine(nn.next) }));
    }
    if (!nn.now && !nn.next) {
      info.appendChild(h(d.doc, 'div', { className: 'ss-info__none', text: t('live.noGuide') }));
      if (d.epg.status().shortEpg && shortFor !== c.id) {
        // Xtream fallback: ask the panel for this channel only (debounced by the caller).
        shortFor = c.id;
        shortList = null;
        const want = c.id;
        d.epg.shortEpg(c).then(function (l) {
          if (alive && shortFor === want) {
            shortList = l;
            if (l && l.length) { renderInfo(); }
          }
        });
      }
    }
    setFavLabel(c);
  }

  function setFavLabel(c: Channel): void {
    const fav = d.lists.isFavourite(pid, c.id);
    const labels = [t('live.watch'), fav ? t('live.favRemove') : t('live.favAdd'), t('live.updateGuide')];
    const cur = focus.current();
    const focusedIdx = cur && cur.zone === 'actions' ? cur.index : -1;
    clear(actionsBox);
    actions = createButtonList(d.doc, labels, true);
    actionsBox.appendChild(actions.element);
    if (focusedIdx >= 0) {
      actions.setFocused(focusedIdx, true);
    }
  }

  function scheduleInfo(): void {
    if (infoTimer !== null) {
      d.clearTimer(infoTimer);
    }
    infoTimer = d.setTimer(function () { infoTimer = null; if (alive) { renderInfo(); } }, 120);
  }

  function play(pos: number): void {
    if (!idx || pos >= list.length) {
      return;
    }
    if (epgJob) {
      // Rule R4: no large downloads during playback.
      epgJob.abort();
      epgJob = null;
    }
    const pp: PlayerParams = { playlistId: pid, index: idx, list: list.slice(), pos: pos };
    playing = true;
    nav.push('player', pp as unknown as Record<string, unknown>);
  }

  function toggleFavourite(): void {
    const c = focusedChannel() || (idx && list.length ? idx.channels[list[focus.memory('chans')]] : null);
    if (!c) {
      return;
    }
    d.lists.toggleFavourite(pid, c.id);
    cats = catItems();
    catList.refresh();
    if (cats[catPos].kind === 'fav') {
      showCategory(catPos, true);
    }
    chanList.refresh();
    renderInfo();
  }

  function refreshGuide(): void {
    if (!idx || epgJob) {
      return;
    }
    epgJob = d.epg.refresh(pid, idx.channels, function (chars) {
      if (alive) { header.textContent = t('live.guideReading', { mb: (Math.round(chars / 104857.6) / 10).toFixed(1) }); }
    });
    renderStatus();
    epgJob.result.then(function () {
      epgJob = null;
      if (alive) {
        renderStatus();
        chanList.refresh();
        renderInfo();
      }
    });
  }

  function openSearch(): void {
    d.openText(nav, {
      title: t('live.search'), value: query, mode: 'text', maxLength: 40,
      onDone: function (q) {
        if (!idx || !alive) {
          return;
        }
        const t0 = d.now();
        query = q.replace(/^\s+|\s+$/g, '');
        searchResults = idx.search(query, 2000);
        perf.lastSearchMs = d.now() - t0;
        cats = catItems();
        catList.refresh();
        showCategory(0, false);
        if (searchResults.length) {
          focus.focus('chans', 0);
        }
      }
    });
  }

  const focus = createFocusManager(function (zone, index, focused) {
    if (zone === 'cats') {
      catList.setFocused(index, focused);
    } else if (zone === 'chans') {
      chanList.setFocused(index, focused);
      if (focused) { scheduleInfo(); }
    } else {
      actions.setFocused(index, focused);
    }
  });
  focus.register({
    id: 'cats', kind: 'column', size: function () { return cats.length; }, neighbours: { right: 'chans' },
    onFocus: function (i) {
      if (i === catPos || !idx) {
        return;
      }
      // Debounced so that holding ↑/↓ doesn't rebuild the list on every step.
      if (catTimer !== null) { d.clearTimer(catTimer); }
      catTimer = d.setTimer(function () { catTimer = null; if (alive) { showCategory(i, false); } }, 150);
    },
    onSelect: function (i) {
      if (cats[i] && cats[i].kind === 'search') {
        openSearch();
        return;
      }
      if (catTimer !== null) { d.clearTimer(catTimer); catTimer = null; }
      if (i !== catPos) { showCategory(i, false); }
      if (list.length) { focus.focus('chans', 0); }
    }
  });
  focus.register({
    id: 'chans', kind: 'column', size: function () { return list.length; }, neighbours: { left: 'cats', right: 'actions' }, fallback: 'cats',
    onSelect: play
  });
  focus.register({
    id: 'actions', kind: 'row', size: function () { return list.length ? 3 : 0; }, neighbours: { left: 'chans' },
    onSelect: function (i) {
      if (i === 0) { play(focus.memory('chans')); }
      if (i === 1) { toggleFavourite(); }
      if (i === 2) { refreshGuide(); }
    }
  });

  function loadAll(): void {
    const t0 = d.now();
    message.textContent = t('live.loading');
    d.playlists.loadLive(pid).then(function (l) {
      if (!alive) {
        return;
      }
      perf.loadMs = d.now() - t0;
      if (l.status !== 'ok') {
        message.textContent = l.status === 'missing' ? t('live.notLoaded') : t('live.loadFailed');
        return;
      }
      const t1 = d.now();
      idx = createChannelIndex(l.catalogue);
      cats = catItems();
      catList.setCount(cats.length);
      showCategory(catPos, false);
      focus.focus('cats', catPos);
      if (list.length) {
        focus.focus('chans', 0);
      }
      perf.renderMs = d.now() - t1;
      perf.channels = idx.channels.length;
      d.log.info('live tv ready', { channels: idx.channels.length, categories: cats.length, loadMs: perf.loadMs, renderMs: perf.renderMs });
      return d.epg.status().playlistId === pid && d.epg.status().state !== 'loading' ? Promise.resolve(d.epg.status()) : d.epg.load(pid);
    }).then(function () {
      if (!alive || !idx) {
        return;
      }
      perf.epgLoadMs = d.now() - t0 - (perf.loadMs || 0) - (perf.renderMs || 0);
      renderStatus();
      chanList.refresh();
      renderInfo();
      if (d.epg.isStale() && !playing) {
        refreshGuide();
      }
    });
  }

  return {
    mount: function (layer: HostLayer) {
      const def = d.playlists.get(pid);
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [
          h(d.doc, 'div', { className: 'ss-live__title', text: t('live.title') + (def ? ' · ' + def.name : '') }),
          header
        ]),
        h(d.doc, 'div', { className: 'ss-live__columns' }, [
          catList.element,
          h(d.doc, 'div', { className: 'ss-live__middle' }, [chanList.element, message]),
          h(d.doc, 'div', { className: 'ss-live__side' }, [info, actionsBox])
        ])
      ]));
      renderStatus();
      loadAll();
    },
    onShow: function () {
      if (!idx) {
        return;
      }
      playing = false;
      // Back from the player: recent list and favourites may have changed.
      cats = catItems();
      catList.refresh();
      if (cats[catPos] && (cats[catPos].kind === 'recent' || cats[catPos].kind === 'fav')) {
        showCategory(catPos, true);
      }
      chanList.refresh();
      renderStatus();
      renderInfo();
    },
    onHide: function () { /* player on top; EPG refresh already aborted in play() */ },
    onKey: function (e: RemoteKeyEvent) {
      const cur = focus.current();
      if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      if ((e.key === 'chUp' || e.key === 'chDown') && cur && cur.zone === 'chans' && list.length) {
        const next = Math.max(0, Math.min(list.length - 1, cur.index + (e.key === 'chDown' ? PAGE : -PAGE)));
        focus.focus('chans', next);
        return true;
      }
      return false;
    },
    onBack: function () {
      const cur = focus.current();
      if (cur && (cur.zone === 'chans' || cur.zone === 'actions')) {
        focus.focus('cats', catPos);
        return true;
      }
      return false; // leave Live TV
    },
    destroy: function () {
      alive = false;
      if (epgJob) { epgJob.abort(); epgJob = null; }
      if (infoTimer !== null) { d.clearTimer(infoTimer); }
      if (catTimer !== null) { d.clearTimer(catTimer); }
      idx = null;
    },
    perf: function () {
      perf.binds = chanList.binds();
      return perf;
    }
  };
}
