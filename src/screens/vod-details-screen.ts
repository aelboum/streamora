// Movie / series details (Stage 6).
//   Movie:  poster | title, year · genre · duration · rating, description, director, cast, [Play].
//           Details come from get_vod_info; the list entry is shown at once, so a slow or failing
//           provider still allows playback.
//   Series: poster | title, year · genre · rating, description; below: seasons | episodes
//           (get_series_info). The focused episode's description is shown under the list.
// Remote: ↑↓←→ move, OK plays (movie: Play; series: an episode), Back returns to the grid.
// Stage 11: a My List button (movie: after Play/Resume; series: above the seasons, ▲ from the
// seasons) adds or removes the title; an episode is played with its series' episode list so the
// player can offer the next episode when it ends.
// Every provider field may be missing: empty fields are left out, never shown as "undefined".
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { createVirtualList } from '../components/virtual-list.ts';
import type { VirtualList } from '../components/virtual-list.ts';
import type { SeriesDetails, VodService } from '../services/vod-service.ts';
import type { Episode, MediaDetails, Season, StreamRef, VodItem } from '../models/content.ts';
import type { MyList } from '../services/my-list.ts';
import type { Translate } from '../i18n/strings.ts';
import type { VodDetailsParams } from './vod-browse-screen.ts';
import type { ProgressEntry, ProgressStore } from '../services/progress.ts';
import { progressKey } from '../services/progress.ts';
import type { ConfirmParams } from './confirm-dialog.ts';
import { formatTime } from './vod-player-screen.ts';
import type { Parental } from '../services/parental.ts';
import { withParental } from './parental-gate.ts';
import { clear, h } from '../utils/dom.ts';

export interface VodDetailsDeps {
  doc: Document;
  t: Translate;
  vod: VodService;
  /** Stage 7B.2: viewing progress (Resume, watched marks). */
  progress?: ProgressStore | null;
  /** Stage 7B.2: an adult title plays only after the PIN while locked. */
  parental?: Parental | null;
  /** Stage 11: My List (absent = no My List button). */
  myList?: MyList | null;
}

export interface VodPlayerParams {
  playlistId: string;
  ref: StreamRef;
  title: string;
  /** Stage 7B.2: what to store as viewing progress (absent = not tracked). */
  progress?: Pick<ProgressEntry, 'key' | 'section' | 'title' | 'sub' | 'poster' | 'item'>;
  /** Resume position (ms); 0 or absent = from the start. */
  startMs?: number;
  /** Stage 11: the series this episode belongs to, for the next-episode prompt (episodes only). */
  series?: { item: VodItem; seasons: Season[]; episodeId: string };
}

interface SeasonRow { name: HTMLElement; count: HTMLElement }
interface EpisodeRow { name: HTMLElement; dur: HTMLElement }

// Stage 11: 5 rows (was 6) so the series header can hold the My List button.
const SEASON_ROWS = 5;
const EPISODE_ROWS = 5;

export function metaLine(t: Translate, item: VodItem, d: MediaDetails | null): string {
  const parts: string[] = [];
  const year = d && d.year ? d.year : item.year;
  if (year) { parts.push(String(year)); }
  const genre = d && d.genre ? d.genre : item.genre;
  if (genre) { parts.push(genre); }
  if (d && d.durationSec) { parts.push(t('vod.minutes', { m: Math.round(d.durationSec / 60) })); }
  const rating = d && d.rating !== null ? d.rating : item.rating;
  if (rating !== undefined && rating !== null && rating > 0) { parts.push(t('vod.rating', { r: (Math.round(rating * 10) / 10).toFixed(1) })); }
  return parts.join(' · ');
}

export function createVodDetailsScreen(d: VodDetailsDeps, p: VodDetailsParams, nav: Router): Screen {
  const t = d.t;
  const item = p.item;
  const movie = p.section === 'movie';
  let alive = true;
  let details: MediaDetails | null = null;
  let series: SeriesDetails | null = null;
  let seriesFailed = false;
  let seasonPos = 0;
  let episodes: Episode[] = [];

  const poster = h(d.doc, 'img', { className: 'ss-details__poster', attrs: { alt: '' } });
  const posterPh = h(d.doc, 'div', { className: 'ss-details__ph', text: item.name });
  poster.addEventListener('error', function () { poster.style.visibility = 'hidden'; });
  poster.addEventListener('load', function () { posterPh.style.visibility = 'hidden'; });
  const title = h(d.doc, 'div', { className: 'ss-details__title', text: item.name });
  // Design 07: backdrop (provider backdrop_path; fallback = the poster, dimmed, no blur on Tier B)
  // behind a left-to-right and bottom scrim, and an overline "MOVIE · GENRE".
  const backdrop = h(d.doc, 'img', { className: 'ss-details__backdrop', attrs: { alt: '' } });
  backdrop.style.visibility = 'hidden';
  backdrop.addEventListener('error', function () { backdrop.style.visibility = 'hidden'; });
  backdrop.addEventListener('load', function () { backdrop.style.visibility = 'visible'; });
  let backdropSrc = '';
  const over = h(d.doc, 'div', { className: 'ss-details__over' });
  const meta = h(d.doc, 'div', { className: 'ss-details__meta' });
  const plot = h(d.doc, 'div', { className: 'ss-details__plot' });
  const credits = h(d.doc, 'div', { className: 'ss-details__credits' });
  const note = h(d.doc, 'div', { className: 'ss-details__note' });
  let actions = createButtonList(d.doc, [t('vod.play')], true);
  const actionsBox = h(d.doc, 'div', { className: 'ss-details__actions' }, [actions.element]);
  const movieKey = progressKey('movie', item.id);

  // Stage 11: My List state of this title and its button label.
  function inMyList(): boolean { return !!d.myList && d.myList.has(p.playlistId, p.section, item.id); }
  function myListLabel(): string { return inMyList() ? t('vod.removeMyList') : t('vod.addMyList'); }
  function toggleMyList(): void {
    if (!d.myList) { return; }
    const r = d.myList.toggle(p.playlistId, p.section, item);
    // Series: the button label shows the new state (no extra line in the fixed-height header).
    note.textContent = r === 'full' ? t('vod.myListFull') : r === 'error' ? t('vod.myListError') : !movie ? '' : (r === 'added' ? t('vod.myListAdded') : t('vod.myListRemoved'));
    renderActions();
  }

  function saved(key: string): ProgressEntry | null {
    return d.progress ? d.progress.get(p.playlistId, key) : null;
  }

  // Movie actions: [Play] or, with saved progress, [Resume · 1:12:40] [Play from start].
  function renderActions(): void {
    const e = movie ? saved(movieKey) : null;
    const labels = !movie ? [] : e ? [t('vod.resume', { t: formatTime(e.pos) }), t('vod.fromStart')] : [t('vod.play')];
    if (d.myList) { labels.push(myListLabel()); }
    clear(actionsBox);
    actions = createButtonList(d.doc, labels, true);
    actionsBox.appendChild(actions.element);
    focus.refresh('actions');
    // New buttons: repaint the focused one (focus.focus is a no-op when the index is unchanged).
    const now = focus.current();
    if (now && now.zone === 'actions') { actions.setFocused(now.index, true); }
  }
  const epPlot = h(d.doc, 'div', { className: 'ss-details__epplot' });

  const seasonList: VirtualList = createVirtualList<SeasonRow>(d.doc, {
    rows: SEASON_ROWS, className: 'ss-details__seasons',
    createRow: function () {
      const name = h(d.doc, 'div', { className: 'ss-cat__name' });
      const count = h(d.doc, 'div', { className: 'ss-cat__count' });
      return { root: h(d.doc, 'div', { className: 'ss-cat' }, [name, count]), parts: { name: name, count: count } };
    },
    bind: function (r, i) {
      if (!series || !series.seasons.length) {
        r.name.textContent = t('vod.episodes');
        r.count.textContent = '';
        return;
      }
      const s = series.seasons[i];
      r.name.textContent = s.name || t('vod.season', { n: s.number });
      r.count.textContent = String(s.episodes.length);
    }
  });

  const episodeList: VirtualList = createVirtualList<EpisodeRow>(d.doc, {
    rows: EPISODE_ROWS, className: 'ss-details__episodes',
    createRow: function () {
      const name = h(d.doc, 'div', { className: 'ss-ep__name' });
      const dur = h(d.doc, 'div', { className: 'ss-ep__dur' });
      return { root: h(d.doc, 'div', { className: 'ss-ep' }, [name, dur]), parts: { name: name, dur: dur } };
    },
    bind: function (r, i) {
      const e = episodes[i];
      const key = progressKey('series', e.id);
      const watched = !!d.progress && d.progress.isWatched(p.playlistId, key);
      const part = saved(key);
      r.name.textContent = (watched ? '✓ ' : '') + (e.title ? t('vod.episode', { e: e.episode, title: e.title }) : t('vod.episodeUntitled', { e: e.episode }));
      r.dur.textContent = part && part.dur > 0 ? t('vod.minLeft', { m: Math.max(1, Math.round((part.dur - part.pos) / 60000)) })
        : e.durationSec ? t('vod.minutes', { m: Math.round(e.durationSec / 60) }) : '';
    }
  });

  function setPoster(src: string): void {
    if (src) {
      poster.style.visibility = 'visible';
      poster.setAttribute('src', src);
    } else {
      poster.style.visibility = 'hidden';
    }
  }

  function renderInfo(): void {
    const m = movie ? details : (series ? series.details : null);
    const genre = m && m.genre ? m.genre : item.genre;
    over.textContent = (movie ? t('vod.overMovie') : t('vod.overSeries')) + (genre ? ' · ' + genre : '');
    const bd = m && m.backdrop ? m.backdrop : (item.poster || (m ? m.poster : ''));
    if (bd && bd !== backdropSrc) {
      backdropSrc = bd;
      backdrop.className = 'ss-details__backdrop' + (m && m.backdrop ? '' : ' is-fallback');
      backdrop.setAttribute('src', bd);
    }
    meta.textContent = metaLine(t, item, m);
    plot.textContent = m && m.plot ? m.plot : '';
    clear(credits);
    if (m && m.director) { credits.appendChild(h(d.doc, 'div', { text: t('vod.director', { v: m.director }) })); }
    if (m && m.cast) { credits.appendChild(h(d.doc, 'div', { text: t('vod.cast', { v: m.cast }) })); }
    if (m && m.poster && !item.poster) { setPoster(m.poster); }
  }

  function showSeason(i: number): void {
    seasonPos = i;
    episodes = series && series.seasons[i] ? series.seasons[i].episodes : [];
    focus.remember('episodes', 0);
    episodeList.reset();
    episodeList.setCount(episodes.length);
    focus.refresh('episodes');
    showEpisodePlot(0);
  }

  function showEpisodePlot(i: number): void {
    const e = episodes[i];
    epPlot.textContent = e && e.plot ? e.plot : '';
  }

  function loadSeries(): void {
    seriesFailed = false;
    note.textContent = t('vod.detailsLoading');
    d.vod.seriesDetails(p.playlistId, item).then(function (s) {
      if (!alive) {
        return;
      }
      series = s;
      if (!s) {
        seriesFailed = true;
        note.textContent = t('vod.episodesFailed');
        seasonList.setCount(1);
        focus.refresh('seasons');
        focus.focus('seasons', 0);
        return;
      }
      note.textContent = s.seasons.length ? '' : t('vod.noEpisodes');
      renderInfo();
      seasonList.setCount(s.seasons.length);
      seasonList.refresh();
      focus.refresh('seasons');
      if (s.seasons.length) {
        showSeason(0);
        focus.focus('seasons', 0);
      }
    });
  }

  function play(ref: StreamRef, name: string, meta: VodPlayerParams['progress'], startMs: number): void {
    const pp: VodPlayerParams = { playlistId: p.playlistId, ref: ref, title: name, progress: meta, startMs: startMs };
    if (series && meta && meta.section === 'series' && ref.kind === 'xtream') { pp.series = { item: item, seasons: series.seasons, episodeId: ref.id }; }
    withParental(nav, d.parental, item.adult, item.name, function () { nav.push('vod-player', pp as unknown as Record<string, unknown>); });
  }

  function playMovie(fromStart: boolean): void {
    const e = saved(movieKey);
    if (fromStart && e && d.progress) { d.progress.remove(p.playlistId, movieKey); }
    const meta = { key: movieKey, section: 'movie' as const, title: item.name, sub: '', poster: item.poster || '', item: item };
    play(d.vod.movieRef(p.playlistId, item), item.name, meta, !fromStart && e ? e.pos : 0);
  }

  function playEpisode(e: Episode): void {
    const key = progressKey('series', e.id);
    const part = saved(key);
    // Stage 7F: "Series · S1 E3 · Episode title" in the player (the same text as Continue watching).
    const sub = t('vod.epSub', { s: e.season, e: e.episode }) + (e.title ? ' · ' + e.title : '');
    const meta = { key: key, section: 'series' as const, title: item.name, sub: sub, poster: e.image || item.poster || '', item: item };
    play(e.streamRef, item.name + ' · ' + sub, meta, part ? part.pos : 0);
  }

  const focus = createFocusManager(function (zone, index, focused) {
    if (zone === 'actions') { actions.setFocused(index, focused); }
    if (zone === 'seasons') { seasonList.setFocused(index, focused); }
    if (zone === 'episodes') {
      episodeList.setFocused(index, focused);
      if (focused) { showEpisodePlot(index); }
    }
  });
  if (movie) {
    focus.register({
      id: 'actions', kind: 'row', size: function () { return actions.size(); }, neighbours: {},
      onSelect: function (i) {
        if (d.myList && i === actions.size() - 1) { toggleMyList(); return; }
        const e = saved(movieKey);
        if (i === 0) { playMovie(false); return; }
        if (!e) { return; }
        // "Play from start" replaces saved progress: confirm first (design P3 Details · Modal).
        const cp: ConfirmParams = {
          title: t('vod.fromStartTitle'),
          paragraphs: [t('vod.fromStartText', { t: formatTime(e.pos) })],
          buttons: [
            { label: t('vod.fromStart'), run: function () { playMovie(true); } },
            { label: t('vod.resume', { t: formatTime(e.pos) }), run: function () { playMovie(false); } },
            { label: t('common.cancel') }
          ]
        };
        nav.openOverlay('confirm', cp as unknown as Record<string, unknown>);
      }
    });
  } else {
    if (d.myList) {
      focus.register({
        id: 'actions', kind: 'row', size: function () { return actions.size(); }, neighbours: { down: 'seasons' },
        onSelect: function () { toggleMyList(); }
      });
    }
    focus.register({
      id: 'seasons', kind: 'column', size: function () { return series ? series.seasons.length : (seriesFailed ? 1 : 0); }, neighbours: d.myList ? { right: 'episodes', up: 'actions' } : { right: 'episodes' },
      onFocus: function (i) { if (series && i !== seasonPos) { showSeason(i); } },
      onSelect: function (i) {
        if (seriesFailed) { loadSeries(); return; }
        if (i !== seasonPos) { showSeason(i); }
        if (episodes.length) { focus.focus('episodes', 0); }
      }
    });
    focus.register({
      id: 'episodes', kind: 'column', size: function () { return episodes.length; }, neighbours: { left: 'seasons' }, fallback: 'seasons',
      onSelect: function (i) {
        const e = episodes[i];
        if (e) {
          playEpisode(e);
        }
      }
    });
  }

  return {
    mount: function (layer: HostLayer) {
      setPoster(item.poster || '');
      const text = h(d.doc, 'div', { className: 'ss-details__text' }, [over, title, meta, plot, credits, note]);
      const art = h(d.doc, 'div', { className: 'ss-details__art' }, [posterPh, poster]);
      // Stage 11 (your request): the series My List button is the movie button, in the same place; the
      // series header is taller and its plot/credits shorter so it never reaches the seasons below.
      const top = h(d.doc, 'div', { className: 'ss-details__top' + (movie ? '' : ' ss-details__top--series') + (!movie && d.myList ? ' has-actions' : '') }, [art, text]);
      const children: HTMLElement[] = [backdrop, h(d.doc, 'div', { className: 'ss-details__scrim' }), top];
      if (movie || d.myList) {
        text.appendChild(actionsBox);
      }
      if (!movie) {
        children.push(h(d.doc, 'div', { className: 'ss-details__bottom' }, [
          seasonList.element,
          h(d.doc, 'div', { className: 'ss-details__eps' }, [episodeList.element, epPlot])
        ]));
      }
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-details' }, children));
      renderInfo();
      if (movie) {
        renderActions();
        focus.focus('actions', 0);
        note.textContent = t('vod.detailsLoading');
        d.vod.movieDetails(p.playlistId, item).then(function (m) {
          if (!alive) {
            return;
          }
          details = m;
          note.textContent = m ? '' : t('vod.detailsNone');
          renderInfo();
        });
      } else {
        if (d.myList) { renderActions(); }
        loadSeries();
      }
    },
    onShow: function () {
      // Back from the player: the saved position (Resume, episode marks) may have changed.
      if (movie) { renderActions(); } else { episodeList.refresh(); }
    },
    onHide: function () { /* player on top */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
        focus.move(e.key);
        return true;
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      return false;
    },
    onBack: function () {
      const cur = focus.current();
      if (cur && cur.zone === 'episodes') {
        focus.focus('seasons', seasonPos);
        return true;
      }
      return false;
    },
    destroy: function () { alive = false; }
  };
}
