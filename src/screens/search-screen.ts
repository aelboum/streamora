// Global search (Stage 7B.2 part 3): channels, movies and series of the active account in one place.
// Layout: rail | "SEARCH" header, query box, then result rows "Channels", "Movies", "Series"
// (horizontal cards, 5 visible). With an empty query the last searches are offered as chips.
// Data: channels from the stored live catalogue (channel-index search), movies/series from the stored
// paged lists (VodView.search). Nothing is downloaded: a list that was never opened is reported as
// such ("Open Movies once …") instead of being searched. Adult entries are left out here; their
// categories stay reachable in their own sections (PIN lock: part 4).
// Remote: ▲▼ between box, chips/rows; ◀▶ within a row (◀ from the first card → rail); OK on the box
// opens the keyboard, on a chip repeats that search, on a channel plays it (zapping over the channel
// results), on a movie/series opens Details. Back leaves (to Home).
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { VodService, VodSection } from '../services/vod-service.ts';
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { Translate } from '../i18n/strings.ts';
import type { OpenText } from './live-screens.ts';
import type { PlayerParams } from './live-tv-screen.ts';
import type { ChannelIndex } from '../content/channel-index.ts';
import { createChannelIndex } from '../content/channel-index.ts';
import type { SearchJob, VodView } from '../content/vod-pages.ts';
import type { VodItem } from '../models/content.ts';
import { createRail } from '../components/rail.ts';
import { createIcon } from '../components/brand.ts';
import { formatCount } from './format.ts';
import { clear, h } from '../utils/dom.ts';

export interface SearchDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  vod: VodService | null;
  kv: KeyValueStore;
  openText: OpenText;
  /**
   * Stage 10 (Search memory audit): free memory in MB (−1 unknown) and the floor below which the
   * stored lists are loaded one after another instead of all at once (TV: 135 MB low while three
   * loaded together). Optional; without it the lists load in parallel as before.
   */
  memoryMB?: () => number;
  minFreeMB?: number;
}

export const SEARCH_VISIBLE = 5;
const MAX_LIVE = 200;
const MAX_VOD = 40;
const MAX_RECENT = 8;
const RECENT_KEY = 'search.recent';

interface Card { key: string; title: string; sub: string; img: string; open: () => void }
interface Row { kind: 'live' | 'movie' | 'series'; cards: Card[]; total: number; top: number }

function isQueries(x: unknown): x is string[] {
  if (Object.prototype.toString.call(x) !== '[object Array]') { return false; }
  const a = x as unknown[];
  for (let i = 0; i < a.length; i++) { if (typeof a[i] !== 'string' || (a[i] as string).length > 40) { return false; } }
  return true;
}

function safeImg(u: string | undefined): string {
  return u && /^https?:\/\/[^"'()\\\s]+$/.test(u) ? u : '';
}

export function createSearchScreen(d: SearchDeps, nav: Router): Screen {
  const t = d.t;
  const pid = d.playlists.activeId() || '';
  const def = pid ? d.playlists.get(pid) : null;
  const rail = createRail(d.doc, t, 'search', nav, d.playlists);
  const boxText = h(d.doc, 'div', { className: 'ss-srch__query' });
  const box = h(d.doc, 'div', { className: 'ss-srch__box' }, [createIcon(d.doc, 'search', '#4FA8FF', 'ss-srch__icon'), boxText]);
  const chips = h(d.doc, 'div', { className: 'ss-srch__chips' });
  const rowsBox = h(d.doc, 'div', { className: 'ss-srch__rows' });
  const message = h(d.doc, 'div', { className: 'ss-srch__message' });
  let query = '';
  let gen = 0;
  let rows: Row[] = [];
  let recent: string[] = d.kv.get<string[]>(RECENT_KEY, isQueries, []);
  // Focus: 'rail' | 'box' | 'chips' | 'row' (row index + card index per row).
  let zone: 'rail' | 'box' | 'chips' | 'row' = 'box';
  let railIdx = rail.currentIndex();
  let chipIdx = 0;
  let rowIdx = 0;
  const cardIdx: number[] = [0, 0, 0];
  let alive = true;
  let idx: ChannelIndex | null = null;
  const views: Record<string, VodView | null | 'missing'> = {};
  const notes: string[] = [];

  function remember(q: string): void {
    const next = [q];
    for (let i = 0; i < recent.length && next.length < MAX_RECENT; i++) {
      if (recent[i].toLowerCase() !== q.toLowerCase()) { next.push(recent[i]); }
    }
    recent = next;
    d.kv.set(RECENT_KEY, recent);
  }

  function paint(): void {
    rail.setFocused(railIdx, zone === 'rail');
    rail.setOpen(zone === 'rail');
    box.className = 'ss-srch__box' + (zone === 'box' ? ' is-focused' : '');
    boxText.textContent = query || t('search.hint');
    boxText.className = 'ss-srch__query' + (query ? '' : ' is-hint');
    clear(chips);
    if (!query && recent.length) {
      chips.appendChild(h(d.doc, 'div', { className: 'ss-srch__label', text: t('search.recent') }));
      for (let i = 0; i < recent.length; i++) {
        chips.appendChild(h(d.doc, 'div', { className: 'ss-srch__chip' + (zone === 'chips' && chipIdx === i ? ' is-focused' : ''), text: recent[i] }));
      }
    }
    clear(rowsBox);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const ci = cardIdx[r];
      if (ci < row.top) { row.top = ci; }
      if (ci >= row.top + SEARCH_VISIBLE) { row.top = ci - SEARCH_VISIBLE + 1; }
      const cards = h(d.doc, 'div', { className: 'ss-srch__cards' });
      for (let i = row.top; i < row.cards.length && i < row.top + SEARCH_VISIBLE; i++) {
        const c = row.cards[i];
        const f = zone === 'row' && rowIdx === r && ci === i;
        const art = h(d.doc, 'div', { className: 'ss-srch__art' });
        if (c.img) {
          art.style.background = 'url("' + c.img + '") center / ' + (row.kind === 'live' ? 'contain' : 'cover') + ' no-repeat, #121A2E';
        } else {
          art.appendChild(createIcon(d.doc, row.kind === 'live' ? 'live' : row.kind === 'movie' ? 'movie' : 'series', '#3A4560', 'ss-srch__ph'));
        }
        cards.appendChild(h(d.doc, 'div', { className: 'ss-srch__card ss-srch__card--' + row.kind + (f ? ' is-focused' : '') }, [
          art,
          h(d.doc, 'div', { className: 'ss-srch__title', text: c.title }),
          h(d.doc, 'div', { className: 'ss-srch__sub', text: c.sub })
        ]));
      }
      rowsBox.appendChild(h(d.doc, 'div', { className: 'ss-srch__row', attrs: { 'data-kind': row.kind } }, [
        h(d.doc, 'div', { className: 'ss-srch__label', text: t('search.row.' + row.kind, { n: formatCount(row.total) }) }),
        cards
      ]));
    }
  }

  function setMessage(s: string): void { message.textContent = s; }

  function liveRow(q: string): Row | null {
    if (!idx) { return null; }
    const ix = idx;
    const hits = ix.search(q, MAX_LIVE);
    const list: number[] = [];
    for (let i = 0; i < hits.length; i++) { if (!ix.channels[hits[i]].adult) { list.push(hits[i]); } }
    if (!list.length) { return null; }
    const cards: Card[] = [];
    for (let i = 0; i < list.length; i++) {
      const c = ix.channels[list[i]];
      const pos = i;
      cards.push({
        key: c.id, title: c.name, sub: c.num ? String(c.num) : '', img: safeImg(c.logo),
        open: function () {
          const pp: PlayerParams = { playlistId: pid, index: ix, list: list, pos: pos };
          nav.push('player', pp as unknown as Record<string, unknown>);
        }
      });
    }
    return { kind: 'live', cards: cards, total: list.length, top: 0 };
  }

  function vodRow(section: VodSection, view: VodView, positions: number[]): Row | null {
    const cards: Card[] = [];
    for (let i = 0; i < positions.length; i++) {
      const it = view.item(positions[i]);
      if (!it || it.adult) { continue; }
      const item: VodItem = it;
      cards.push({
        key: item.id, title: item.name, sub: item.year ? String(item.year) : '', img: safeImg(item.poster),
        open: function () { nav.push('vod-details', { playlistId: pid, section: section, item: item }); }
      });
    }
    return cards.length ? { kind: section, cards: cards, total: cards.length, top: 0 } : null;
  }

  // Stored lists, loaded once per screen (no network). Stage 9: each list has its own load, shared
  // by every query, so a slow one (the channel file after the cache was released) delays only itself.
  let liveLoad: Promise<void> | null = null;
  const viewLoad: Record<string, Promise<void>> = {};
  // Loads queued one after another while memory is low (each starts when the previous one ended).
  let loadChain: Promise<void> = Promise.resolve();
  function memoryLow(): boolean {
    if (!d.memoryMB || !d.minFreeMB) { return false; }
    const mb = d.memoryMB();
    return mb >= 0 && mb < d.minFreeMB;
  }
  function queued(start: () => Promise<void>): Promise<void> {
    if (!memoryLow()) { return start(); }
    const p = loadChain.then(start, start);
    loadChain = p.then(null, function () { /* next load still runs */ });
    return p;
  }
  function liveReady(): Promise<void> {
    if (idx || !pid) { return Promise.resolve(); }
    if (!liveLoad) {
      liveLoad = queued(function () {
        return d.playlists.loadLive(pid).then(function (l) {
          if (l.status === 'ok' && alive) { idx = createChannelIndex(l.catalogue); }
        }, function () { /* no channels */ });
      });
      liveLoad.then(function () { liveLoad = null; });
    }
    return liveLoad;
  }
  function viewReady(sec: VodSection): Promise<void> {
    const vod = d.vod;
    if (views[sec] !== undefined || !vod) { return Promise.resolve(); }
    if (!Object.prototype.hasOwnProperty.call(viewLoad, sec)) {
      viewLoad[sec] = queued(function () {
        return vod.load(pid, sec).then(function (l) {
          views[sec] = l.status === 'ok' ? l.view : l.status === 'missing' ? 'missing' : null;
        }, function () { views[sec] = null; });
      });
      viewLoad[sec].then(function () { delete viewLoad[sec]; });
    }
    return viewLoad[sec];
  }

  // Stage 9: the running movie/series scans of the current query (cancelled by a newer query).
  let jobs: SearchJob[] = [];
  let running = false;

  function cancelJobs(): void {
    for (let i = 0; i < jobs.length; i++) { jobs[i].cancel(); }
    jobs = [];
  }

  /** Replaces the rows, keeping the focused card on the same title when it is still listed. */
  function setRows(out: Row[]): void {
    const cur = zone === 'row' && rows[rowIdx] ? rows[rowIdx] : null;
    const curKey = cur && cur.cards[cardIdx[rowIdx]] ? cur.cards[cardIdx[rowIdx]].key : '';
    const curKind = cur ? cur.kind : '';
    rows = out;
    for (let r = 0; r < 3; r++) { if (!rows[r] || cardIdx[r] >= rows[r].cards.length) { cardIdx[r] = 0; } }
    if (curKind) {
      let ri = -1;
      for (let r = 0; r < rows.length; r++) { if (rows[r].kind === curKind) { ri = r; } }
      if (ri < 0) { rowIdx = 0; if (!rows.length) { zone = 'box'; } return; }
      rowIdx = ri;
      for (let i = 0; i < rows[ri].cards.length; i++) { if (rows[ri].cards[i].key === curKey) { cardIdx[ri] = i; break; } }
    }
  }

  function run(q: string): void {
    // A repeated identical query while it is still running is not started twice.
    if (q && q === query && running) { return; }
    const my = ++gen;
    cancelJobs();
    query = q;
    rows = [];
    cardIdx[0] = cardIdx[1] = cardIdx[2] = 0;
    if (!q) { running = false; setMessage(''); paint(); return; }
    running = true;
    remember(q);
    setMessage(t('search.searching'));
    paint();
    let lr: Row | null = null;
    const vodRows: Record<string, Row | null> = { movie: null, series: null };
    const failed: string[] = [];
    let pending = 0;
    let moved = false;
    notes.length = 0;
    // Channels, movies and series each appear as soon as their own list is ready; movies and series
    // also grow while their name pages are scanned (Stage 9: no blank screen until all are done).
    function publish(): void {
      if (!alive || my !== gen) { return; }
      const out: Row[] = [];
      if (lr) { out.push(lr); }
      if (vodRows.movie) { out.push(vodRows.movie); }
      if (vodRows.series) { out.push(vodRows.series); }
      setRows(out);
      if (pending > 0) {
        setMessage(t('search.searching'));
      } else {
        running = false;
        const tail = notes.concat(failed).join(' ');
        setMessage((out.length || failed.length ? '' : t('search.none', { q: q })) + (tail ? (out.length || failed.length ? '' : ' ') + tail : ''));
      }
      if (out.length && zone === 'box' && !moved) { zone = 'row'; rowIdx = 0; moved = true; }
      paint();
    }
    function scan(sec: VodSection, view: VodView): void {
      let finished = false;
      let shown = '';
      let step = 0;
      const job = view.search(q, MAX_VOD, function (sofar) {
        // Interim results: only the first cards that fit on screen are read from their pages.
        const key = sofar.join(',');
        if (finished || key === shown) { return; }
        shown = key;
        const mine = ++step;
        const head = sofar.slice(0, SEARCH_VISIBLE * 2);
        view.ensure(head).then(function () {
          if (finished || mine !== step || my !== gen) { return; }
          vodRows[sec] = vodRow(sec, view, head);
          publish();
        }, function () { /* the final result decides */ });
      });
      jobs.push(job);
      job.result.then(function (pos): Promise<void> | undefined {
        // A replaced query reads no more title pages (Stage 10 audit).
        if (my !== gen || !alive) { finished = true; return undefined; }
        return view.ensure(pos).then(function () {
          finished = true;
          vodRows[sec] = vodRow(sec, view, pos);
        });
      }).then(null, function () {
        finished = true;
        vodRows[sec] = null;
        failed.push(t('search.failed.' + sec));
      }).then(function () {
        pending--;
        publish();
      });
    }
    if (pid) {
      pending++;
      liveReady().then(function () {
        if (my === gen) { lr = liveRow(q); }
      }).then(function () { pending--; publish(); });
    }
    const vod = d.vod;
    if (pid && vod && vod.supported(pid)) {
      const secs: VodSection[] = ['movie', 'series'];
      for (let s = 0; s < secs.length; s++) {
        const sec = secs[s];
        if (views[sec] === undefined && !vod.state(pid, sec)) { views[sec] = 'missing'; }
        if (views[sec] === 'missing') { notes.push(t('search.notLoaded.' + sec)); continue; }
        pending++;
        viewReady(sec).then(function () {
          if (!alive || my !== gen) { return; }
          const v = views[sec];
          if (v && v !== 'missing') { scan(sec, v); return; } // its completion counts it down
          if (v === 'missing') { notes.push(t('search.notLoaded.' + sec)); } else { failed.push(t('search.failed.' + sec)); }
          pending--;
          publish();
        });
      }
    }
    publish();
  }

  function openKeyboard(): void {
    d.openText(nav, {
      title: t('search.title'), value: query, mode: 'text', maxLength: 40,
      onDone: function (q) { if (alive) { run(q.replace(/^\s+|\s+$/g, '')); } }
    });
  }

  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(rail.element);
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-srch' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [
          h(d.doc, 'div', { className: 'ss-live__title', text: t('search.title') }),
          h(d.doc, 'div', { className: 'ss-live__account', text: def ? def.name : '' })
        ]),
        box, chips, message, rowsBox
      ]));
      if (!def) { setMessage(t('search.noAccount')); }
      paint();
    },
    onShow: function () { paint(); },
    onHide: function () { /* nothing running */ },
    onKey: function (e: RemoteKeyEvent) {
      const k = e.key;
      const hasChips = !query && recent.length > 0;
      if (k === 'ok') {
        if (zone === 'rail') { if (!rail.select(railIdx)) { zone = 'box'; paint(); } return true; }
        if (zone === 'box') { if (def) { openKeyboard(); } return true; }
        if (zone === 'chips') { run(recent[chipIdx]); return true; }
        const row = rows[rowIdx];
        const c = row ? row.cards[cardIdx[rowIdx]] : null;
        if (c) { c.open(); }
        return true;
      }
      if (zone === 'rail') {
        if (k === 'up' || k === 'down') { railIdx = Math.max(0, Math.min(rail.size() - 1, railIdx + (k === 'up' ? -1 : 1))); }
        else if (k === 'right') { zone = 'box'; }
        else { return false; }
      } else if (k === 'left') {
        if (zone === 'chips' && chipIdx > 0) { chipIdx--; }
        else if (zone === 'row' && cardIdx[rowIdx] > 0) { cardIdx[rowIdx]--; }
        else { zone = 'rail'; railIdx = rail.currentIndex(); }
      } else if (k === 'right') {
        if (zone === 'chips') { chipIdx = Math.min(recent.length - 1, chipIdx + 1); }
        else if (zone === 'row') { cardIdx[rowIdx] = Math.min(rows[rowIdx].cards.length - 1, cardIdx[rowIdx] + 1); }
      } else if (k === 'down') {
        if (zone === 'box') { if (hasChips) { zone = 'chips'; chipIdx = 0; } else if (rows.length) { zone = 'row'; rowIdx = 0; } }
        else if (zone === 'row' && rowIdx < rows.length - 1) { rowIdx++; }
      } else if (k === 'up') {
        if (zone === 'chips') { zone = 'box'; }
        else if (zone === 'row') { if (rowIdx > 0) { rowIdx--; } else { zone = 'box'; } }
      } else {
        return false;
      }
      paint();
      return true;
    },
    onBack: function () {
      if (zone === 'rail') { zone = 'box'; paint(); return true; }
      return false;
    },
    destroy: function () { alive = false; gen++; cancelJobs(); }
  };
}
