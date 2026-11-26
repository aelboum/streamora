// Home hub (Stage 7B.1; Claude Design "EliteStream Home v2" 2a, now screen 01). Root screen.
//   Header: Signal Play lockup · clock and date · provider chip (active account + status dot).
//   Tiles: Live TV · Movies · Series (408×620) · Settings (376×340) · Add account (376×248).
//   Bottom bar: Home (current) · Search · Favourites · TV.
// Only existing destinations are reachable (screens/sections.ts): Settings opens the Settings screen,
// Search the global search (Stage 7B.2), Favourites opens Live TV on its favourites category, TV opens
// Live TV. Tiles and items that need an account the user does not have are shown disabled (40 %) and
// skipped by focus.
// Remote (design 01): ◀▶ across the tiles; ▶ from Series → Settings; ▼ from Settings → Add account;
// ▼ from a tile → the bar item below it; ▲ from the bar → the tile above; OK opens; Back = exit
// confirm (router root-back handler). Default focus: Live TV, else the first available tile.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { VodService } from '../services/vod-service.ts';
import type { Translate } from '../i18n/strings.ts';
import type { ConfirmParams } from './confirm-dialog.ts';
import { openSection, sectionAvailable } from './sections.ts';
import type { SectionId } from './sections.ts';
import { createIcon, createLockup, setIcon } from '../components/brand.ts';
import { formatCount } from './format.ts';
import type { ProgressEntry, ProgressStore } from '../services/progress.ts';
import type { VodPlayerParams } from './vod-details-screen.ts';
import type { Parental } from '../services/parental.ts';
import { isLocked } from './parental-gate.ts';
import { clear, h } from '../utils/dom.ts';

const CONT_VISIBLE = 4;
const CONT_MAX = 10;

export interface HomeDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  vod: VodService | null;
  /** Stage 7B.2: Continue watching row (Home v2b) when progress exists. */
  progress?: ProgressStore | null;
  /** Stage 7B.2: adult titles are left out of Continue watching while locked. */
  parental?: Parental | null;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

type TileId = 'live' | 'movies' | 'series' | 'settings' | 'add';
const TILE_ORDER: TileId[] = ['live', 'movies', 'series', 'settings', 'add'];
const BAR: Array<{ id: SectionId; icon: string; label: string }> = [
  { id: 'home', icon: 'home', label: 'nav.home' },
  { id: 'search', icon: 'search', label: 'nav.search' },
  { id: 'favourites', icon: 'star', label: 'nav.favourites' },
  { id: 'live', icon: 'live', label: 'nav.tv' }
];
/** ▼ from a tile lands on this bar item; ▲ from a bar item lands on this tile. */
const DOWN: Record<string, number> = { live: 0, movies: 1, series: 2, settings: 3, add: 3 };
const UP: TileId[] = ['live', 'movies', 'series', 'settings'];

interface Tile { root: HTMLElement; sub: HTMLElement; count: HTMLElement | null; art: HTMLElement | null; enabled: boolean }

/** Poster URLs used in an inline CSS background must not be able to break out of url("…"). */
function safeUrl(u: string): boolean {
  return /^https?:\/\/[^"'()\\\s]+$/.test(u);
}

/** Design 01 tile art: three posters side by side (centre, left, right) over the tile colour. */
export function collage(urls: string[]): string {
  const pos = ['50% 0%', '0% 0%', '100% 0%'];
  const order = [urls[1] || urls[0], urls[0], urls[2] || urls[0]];
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) { parts.push('url("' + order[i] + '") ' + pos[i] + ' / auto 100% no-repeat'); }
  return parts.join(', ') + ', #121A2E';
}
interface BarItem { root: HTMLElement; icon: HTMLElement; enabled: boolean }

function two(n: number): string { return (n < 10 ? '0' : '') + n; }

export function createHomeScreen(d: HomeDeps, nav: Router): Screen {
  const t = d.t;
  const tiles: Record<string, Tile> = {};
  const bar: BarItem[] = [];
  const clockEl = h(d.doc, 'div', { className: 'ss-home__time' });
  const dateEl = h(d.doc, 'div', { className: 'ss-home__date' });
  const chipName = h(d.doc, 'div', { className: 'ss-home__chipname' });
  const chipDot = h(d.doc, 'div', { className: 'ss-home__dot' });
  let zone: 'tiles' | 'cont' | 'bar' = 'tiles';
  let tileFocus: TileId = 'live';
  let barFocus = 0;
  // Continue watching (Home v2b): shown only when unfinished titles exist for the active account.
  let cont: ProgressEntry[] = [];
  let contFocus = 0;
  let contTop = 0;
  const contCards = h(d.doc, 'div', { className: 'ss-cont__cards' });
  const contRow = h(d.doc, 'div', { className: 'ss-cont is-hidden' }, [h(d.doc, 'div', { className: 'ss-cont__title', text: t('home.continue') }), contCards]);
  let homeRoot: HTMLElement | null = null;
  let shownOnce = false; // default focus = first Continue card only on the first show
  let clockTimer: unknown = null;
  let artTimer: unknown = null;
  let artFor = '';
  let alive = true;
  let shown = false;

  // Tile art from the stored library only (the index + the first title page; no network, no full
  // load). Runs once per active account, shortly after Home is shown.
  function loadArt(pid: string): void {
    const vod = d.vod;
    if (!vod || artFor === pid) {
      return;
    }
    artFor = pid;
    const sections: Array<['movie' | 'series', TileId]> = [['movie', 'movies'], ['series', 'series']];
    for (let s = 0; s < sections.length; s++) {
      const sec = sections[s][0];
      const tile = tiles[sections[s][1]];
      vod.load(pid, sec).then(function (l) {
        if (!alive || l.status !== 'ok' || artFor !== pid) {
          return null;
        }
        const v = l.view;
        const all = v.all();
        const want: number[] = [];
        for (let i = 0; i < all.length && i < 40; i++) { want.push(all.at(i)); }
        return v.ensure(want).then(function () {
          const urls: string[] = [];
          for (let i = 0; i < want.length && urls.length < 3; i++) {
            const it = v.item(want[i]);
            if (it && it.poster && safeUrl(it.poster)) { urls.push(it.poster); }
          }
          if (alive && artFor === pid && urls.length && tile.art) {
            tile.art.style.background = collage(urls);
          }
        });
      });
    }
  }

  function tileAvailable(id: TileId): boolean {
    if (id === 'add') { return nav.isRegistered('playlist-form'); }
    return sectionAvailable(nav, d.playlists, id);
  }

  function makeTile(id: TileId): HTMLElement {
    const big = id === 'live' || id === 'movies' || id === 'series';
    const icon = id === 'live' ? 'live' : id === 'movies' ? 'movie' : id === 'series' ? 'series' : id === 'settings' ? 'settings' : 'add';
    const sub = h(d.doc, 'div', { className: 'ss-tile__sub' });
    const count = big ? h(d.doc, 'div', { className: 'ss-tile__count' }) : null;
    const kids: Node[] = [];
    let art: HTMLElement | null = null;
    if (big) {
      art = h(d.doc, 'div', { className: 'ss-tile__art ss-tile__art--' + id });
      kids.push(art);
      kids.push(h(d.doc, 'div', { className: 'ss-tile__shade' }));
    }
    kids.push(h(d.doc, 'div', { className: 'ss-tile__iconbox' }, [createIcon(d.doc, icon, id === 'add' ? '#4FA8FF' : '#FFFFFF', 'ss-tile__icon')]));
    kids.push(h(d.doc, 'div', { className: 'ss-tile__text' }, [h(d.doc, 'div', { className: 'ss-tile__title', text: t('home.' + id) }), sub]));
    if (count) { kids.push(count); }
    const root = h(d.doc, 'div', { className: 'ss-tile ss-tile--' + id, attrs: { 'data-tile': id } }, kids);
    tiles[id] = { root: root, sub: sub, count: count, art: art, enabled: false };
    return root;
  }

  function refreshData(): void {
    const active = d.playlists.activeId();
    const def = active ? d.playlists.get(active) : null;
    for (let i = 0; i < TILE_ORDER.length; i++) {
      const id = TILE_ORDER[i];
      const tile = tiles[id];
      tile.enabled = tileAvailable(id);
      let sub = t('home.' + id + 'Sub');
      if (!tile.enabled && (id === 'live' || id === 'movies' || id === 'series')) {
        sub = def ? t('home.needsXtream') : t('home.needsAccount');
      }
      tile.sub.textContent = sub;
      if (tile.count) { tile.count.textContent = ''; }
    }
    // Counts are shown only when already known (DATA): titles from the stored library state,
    // channels from the last import's metadata. Nothing is downloaded for them.
    if (def && d.vod) {
      const m = d.vod.state(def.id, 'movie');
      const s = d.vod.state(def.id, 'series');
      if (m && tiles.movies.enabled && tiles.movies.count) { tiles.movies.count.textContent = t('home.countTitles', { n: formatCount(m.items) }); }
      if (s && tiles.series.enabled && tiles.series.count) { tiles.series.count.textContent = t('home.countSeries', { n: formatCount(s.items) }); }
    }
    if (def && tiles.live.enabled) {
      const want = def.id;
      d.playlists.meta(def.id).then(function (meta) {
        if (alive && meta && d.playlists.activeId() === want && tiles.live.count) {
          tiles.live.count.textContent = t('home.countChannels', { n: formatCount(meta.counts.live) });
        }
      });
    }
    chipName.textContent = def ? def.name : t('home.noAccount');
    chipDot.className = 'ss-home__dot' + (!def ? ' is-off' : def.lastStatus && !def.lastStatus.ok ? ' is-error' : def.lastLoadedAt ? ' is-ok' : ' is-off');
    for (let i = 0; i < bar.length; i++) {
      bar[i].enabled = BAR[i].id === 'home' || sectionAvailable(nav, d.playlists, BAR[i].id);
    }
    if (!tiles[tileFocus].enabled) {
      tileFocus = firstTile();
    }
    loadCont(def ? def.id : null);
    paint();
  }

  function loadCont(pid: string | null): void {
    const had = cont.length > 0;
    const all = pid && d.progress && nav.isRegistered('vod-player') ? d.progress.list(pid) : [];
    cont = [];
    for (let i = 0; i < all.length && cont.length < CONT_MAX; i++) { if (!isLocked(d.parental, !!all[i].item.adult)) { cont.push(all[i]); } }
    contRow.className = 'ss-cont' + (cont.length ? '' : ' is-hidden');
    if (homeRoot) { homeRoot.className = 'ss-home' + (cont.length ? ' ss-home--cont' : ''); }
    if (!cont.length && zone === 'cont') { zone = 'tiles'; }
    if (contFocus >= cont.length) { contFocus = Math.max(0, cont.length - 1); }
    if (cont.length && !had && shownOnce === false) { zone = 'cont'; contFocus = 0; }
  }

  function renderCont(): void {
    clear(contCards);
    if (!cont.length) {
      return;
    }
    if (contFocus < contTop) { contTop = contFocus; }
    if (contFocus >= contTop + CONT_VISIBLE) { contTop = contFocus - CONT_VISIBLE + 1; }
    for (let i = contTop; i < cont.length && i < contTop + CONT_VISIBLE; i++) {
      const e = cont[i];
      const f = zone === 'cont' && contFocus === i;
      const art = h(d.doc, 'div', { className: 'ss-cont__art' });
      if (e.poster && safeUrl(e.poster)) { art.style.background = 'url("' + e.poster + '") center 25% / cover no-repeat, #121A2E'; }
      const pct = e.dur > 0 ? Math.max(2, Math.min(100, e.pos * 100 / e.dur)) : 0;
      const fill = h(d.doc, 'div', { className: 'ss-cont__fill' });
      fill.style.width = pct.toFixed(1) + '%';
      const kids: Node[] = [h(d.doc, 'div', { className: 'ss-cont__card' + (f ? ' is-focused' : '') }, [art, h(d.doc, 'div', { className: 'ss-cont__bar' }, [fill])])];
      kids.push(h(d.doc, 'div', { className: 'ss-cont__name', text: e.title }));
      kids.push(h(d.doc, 'div', { className: 'ss-cont__meta', text: (e.sub ? e.sub + ' · ' : '') + t('vod.minLeft', { m: Math.max(1, Math.round((e.dur - e.pos) / 60000)) }) }));
      contCards.appendChild(h(d.doc, 'div', { className: 'ss-cont__item' + (f ? ' is-focused' : ''), attrs: { 'data-cont': String(i) } }, kids));
    }
  }

  function resume(e: ProgressEntry, details: boolean): void {
    const pid = d.playlists.activeId();
    if (!pid) { return; }
    if (details) {
      nav.push('vod-details', { playlistId: pid, section: e.section, item: e.item });
      return;
    }
    const pp: VodPlayerParams = {
      playlistId: pid, ref: e.ref, title: e.title + (e.sub ? ' · ' + e.sub : ''), startMs: e.pos,
      progress: { key: e.key, section: e.section, title: e.title, sub: e.sub, poster: e.poster, item: e.item }
    };
    nav.push('vod-player', pp as unknown as Record<string, unknown>);
  }

  function firstTile(): TileId {
    for (let i = 0; i < TILE_ORDER.length; i++) {
      if (tiles[TILE_ORDER[i]].enabled) { return TILE_ORDER[i]; }
    }
    return 'settings';
  }

  function paint(): void {
    for (let i = 0; i < TILE_ORDER.length; i++) {
      const id = TILE_ORDER[i];
      const tl = tiles[id];
      tl.root.className = 'ss-tile ss-tile--' + id + (zone === 'tiles' && tileFocus === id ? ' is-focused' : '') + (tl.enabled ? '' : ' is-disabled');
    }
    renderCont();
    for (let i = 0; i < bar.length; i++) {
      const f = zone === 'bar' && barFocus === i;
      bar[i].root.className = 'ss-bar__item' + (i === 0 ? ' is-current' : '') + (f ? ' is-focused' : '') + (bar[i].enabled ? '' : ' is-disabled');
      setIcon(bar[i].icon, BAR[i].icon, f ? '#080C18' : i === 0 ? '#EEF2F8' : '#8A93A6');
    }
  }

  function tick(): void {
    clockTimer = null;
    if (!alive) {
      return;
    }
    const now = new Date(d.now());
    clockEl.textContent = two(now.getHours()) + ':' + two(now.getMinutes());
    dateEl.textContent = t('home.date', { day: t('day.' + now.getDay()), date: now.getDate(), month: t('month.' + now.getMonth()) });
    if (shown) {
      clockTimer = d.setTimer(tick, (60 - now.getSeconds()) * 1000 + 50);
      // The clock alone must never keep a host process alive (Node test runs); no-op on the TV.
      const u = clockTimer as { unref?: () => void } | null;
      if (u && typeof u === 'object' && typeof u.unref === 'function') { u.unref(); }
    }
  }

  // Moves within the tiles, skipping disabled tiles; returns false at an edge.
  function stepTile(dir: number): boolean {
    const row: TileId[] = ['live', 'movies', 'series', 'settings'];
    let i = tileFocus === 'add' ? 3 : row.indexOf(tileFocus);
    while (true) {
      i += dir;
      if (i < 0 || i >= row.length) { return false; }
      if (tiles[row[i]].enabled) { tileFocus = row[i]; return true; }
    }
  }

  function stepBar(dir: number): boolean {
    let i = barFocus;
    while (true) {
      i += dir;
      if (i < 0 || i >= bar.length) { return false; }
      if (bar[i].enabled) { barFocus = i; return true; }
    }
  }

  function nearestBar(i: number): number {
    for (let k = 0; k < bar.length; k++) {
      const a = i - k, b = i + k;
      if (a >= 0 && bar[a].enabled) { return a; }
      if (b < bar.length && bar[b].enabled) { return b; }
    }
    return 0;
  }

  function nearestTile(id: TileId): TileId {
    if (tiles[id].enabled) { return id; }
    const row: TileId[] = ['live', 'movies', 'series', 'settings'];
    const i = row.indexOf(id);
    for (let k = 1; k < row.length; k++) {
      if (i - k >= 0 && tiles[row[i - k]].enabled) { return row[i - k]; }
      if (i + k < row.length && tiles[row[i + k]].enabled) { return row[i + k]; }
    }
    return tileFocus;
  }

  function addAccount(): void {
    const p: ConfirmParams = {
      title: t('home.addTitle'),
      paragraphs: [t('home.addText')],
      buttons: [
        { label: t('home.addXtream'), run: function () { nav.push('playlist-form', { mode: 'add-xtream' }); } },
        { label: t('home.addM3u'), run: function () { nav.push('playlist-form', { mode: 'add-m3u' }); } },
        { label: t('common.cancel') }
      ]
    };
    nav.openOverlay('confirm', p as unknown as Record<string, unknown>);
  }

  function activate(): void {
    if (zone === 'cont') {
      if (cont[contFocus]) { resume(cont[contFocus], false); }
      return;
    }
    if (zone === 'tiles') {
      if (!tiles[tileFocus].enabled) { return; }
      if (tileFocus === 'add') { addAccount(); return; }
      openSection(nav, d.playlists, tileFocus, true);
      return;
    }
    const it = BAR[barFocus];
    if (bar[barFocus].enabled && it.id !== 'home') {
      openSection(nav, d.playlists, it.id, true);
    }
  }

  return {
    mount: function (layer: HostLayer) {
      const tileRow = h(d.doc, 'div', { className: 'ss-home__tiles' }, [
        makeTile('live'), makeTile('movies'), makeTile('series'),
        h(d.doc, 'div', { className: 'ss-home__side' }, [makeTile('settings'), makeTile('add')])
      ]);
      const barBox = h(d.doc, 'div', { className: 'ss-bar' });
      for (let i = 0; i < BAR.length; i++) {
        const icon = createIcon(d.doc, BAR[i].icon, '', 'ss-bar__icon');
        const root = h(d.doc, 'div', { className: 'ss-bar__item', attrs: { 'data-bar': BAR[i].id } }, [icon, h(d.doc, 'div', { className: 'ss-bar__label', text: t(BAR[i].label) })]);
        bar.push({ root: root, icon: icon, enabled: false });
        barBox.appendChild(root);
      }
      const chip = h(d.doc, 'div', { className: 'ss-home__chip' }, [
        h(d.doc, 'div', { className: 'ss-home__avatar' }, [createIcon(d.doc, 'person', '#A9B2C3', 'ss-home__person')]),
        chipName, chipDot
      ]);
      homeRoot = h(d.doc, 'div', { className: 'ss-home' }, [
        h(d.doc, 'div', { className: 'ss-home__header' }, [
          createLockup(d.doc),
          h(d.doc, 'div', { className: 'ss-home__divider' }),
          h(d.doc, 'div', { className: 'ss-home__clock' }, [clockEl, dateEl]),
          h(d.doc, 'div', { className: 'ss-home__spacer' }),
          chip
        ]),
        tileRow,
        contRow,
        h(d.doc, 'div', { className: 'ss-bar__wrap' }, [barBox])
      ]);
      (layer.element as HTMLElement).appendChild(homeRoot);
      tileFocus = 'live';
      refreshData();
      if (!tiles.live.enabled) { tileFocus = firstTile(); }
      paint();
    },
    onShow: function () {
      shown = true;
      refreshData();
      shownOnce = true;
      paint();
      const active = d.playlists.activeId();
      const def = active ? d.playlists.get(active) : null;
      if (def && def.kind === 'xtream' && d.vod && artFor !== def.id && artTimer === null) {
        const pid = def.id;
        artTimer = d.setTimer(function () { artTimer = null; if (alive && shown) { loadArt(pid); } }, 800);
      }
      if (clockTimer === null) { tick(); }
    },
    onHide: function () {
      shown = false;
      if (clockTimer !== null) { d.clearTimer(clockTimer); clockTimer = null; }
    },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'ok') {
        activate();
        return true;
      }
      if (e.key === 'info' && zone === 'cont' && cont[contFocus]) {
        resume(cont[contFocus], true); // Info (or long-press OK on the Smart Remote) = Details
        return true;
      }
      if (zone === 'tiles') {
        if (e.key === 'left' || e.key === 'right') {
          if (tileFocus === 'add' && e.key === 'right') { return true; }
          stepTile(e.key === 'left' ? -1 : 1);
        } else if (e.key === 'down') {
          if (tileFocus === 'settings' && tiles.add.enabled) {
            tileFocus = 'add';
          } else if (cont.length) {
            zone = 'cont';
            contFocus = Math.min(cont.length - 1, contTop + Math.min(CONT_VISIBLE - 1, UP.indexOf(tileFocus === 'add' ? 'settings' : tileFocus)));
          } else {
            zone = 'bar';
            barFocus = nearestBar(DOWN[tileFocus]);
          }
        } else if (e.key === 'up') {
          if (tileFocus === 'add' && tiles.settings.enabled) { tileFocus = 'settings'; }
        } else {
          return false;
        }
      } else if (zone === 'cont') {
        if (e.key === 'left' || e.key === 'right') {
          contFocus = Math.max(0, Math.min(cont.length - 1, contFocus + (e.key === 'left' ? -1 : 1)));
        } else if (e.key === 'up') {
          zone = 'tiles';
          tileFocus = nearestTile(UP[Math.min(3, contFocus - contTop)]);
        } else if (e.key === 'down') {
          zone = 'bar';
          barFocus = nearestBar(Math.min(3, contFocus - contTop));
        } else {
          return false;
        }
      } else {
        if (e.key === 'left' || e.key === 'right') {
          stepBar(e.key === 'left' ? -1 : 1);
        } else if (e.key === 'up') {
          if (cont.length) {
            zone = 'cont';
            contFocus = Math.min(cont.length - 1, contTop + barFocus);
          } else {
            zone = 'tiles';
            tileFocus = nearestTile(UP[barFocus]);
          }
        } else if (e.key !== 'down') {
          return false;
        }
      }
      paint();
      return true;
    },
    onBack: function () { return false; },
    destroy: function () {
      alive = false;
      if (clockTimer !== null) { d.clearTimer(clockTimer); clockTimer = null; }
      if (artTimer !== null) { d.clearTimer(artTimer); artTimer = null; }
    }
  };
}
