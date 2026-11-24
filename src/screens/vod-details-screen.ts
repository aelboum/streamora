// Movie / series details (Stage 6).
//   Movie:  poster | title, year · genre · duration · rating, description, director, cast, [Play].
//           Details come from get_vod_info; the list entry is shown at once, so a slow or failing
//           provider still allows playback.
//   Series: poster | title, year · genre · rating, description; below: seasons | episodes
//           (get_series_info). The focused episode's description is shown under the list.
// Remote: ↑↓←→ move, OK plays (movie: Play; series: an episode), Back returns to the grid.
// Every provider field may be missing: empty fields are left out, never shown as "undefined".
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { createVirtualList } from '../components/virtual-list.ts';
import type { VirtualList } from '../components/virtual-list.ts';
import type { SeriesDetails, VodService } from '../services/vod-service.ts';
import type { Episode, MediaDetails, StreamRef, VodItem } from '../models/content.ts';
import type { Translate } from '../i18n/strings.ts';
import type { VodDetailsParams } from './vod-browse-screen.ts';
import { clear, h } from '../utils/dom.ts';

export interface VodDetailsDeps {
  doc: Document;
  t: Translate;
  vod: VodService;
}

export interface VodPlayerParams {
  playlistId: string;
  ref: StreamRef;
  title: string;
}

interface SeasonRow { name: HTMLElement; count: HTMLElement }
interface EpisodeRow { name: HTMLElement; dur: HTMLElement }

const SEASON_ROWS = 6;
const EPISODE_ROWS = 6;

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
  const meta = h(d.doc, 'div', { className: 'ss-details__meta' });
  const plot = h(d.doc, 'div', { className: 'ss-details__plot' });
  const credits = h(d.doc, 'div', { className: 'ss-details__credits' });
  const note = h(d.doc, 'div', { className: 'ss-details__note' });
  const actions = createButtonList(d.doc, [t('vod.play')], true);
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
      r.name.textContent = e.title ? t('vod.episode', { e: e.episode, title: e.title }) : t('vod.episodeUntitled', { e: e.episode });
      r.dur.textContent = e.durationSec ? t('vod.minutes', { m: Math.round(e.durationSec / 60) }) : '';
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

  function play(ref: StreamRef, name: string): void {
    const pp: VodPlayerParams = { playlistId: p.playlistId, ref: ref, title: name };
    nav.push('vod-player', pp as unknown as Record<string, unknown>);
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
      id: 'actions', kind: 'row', size: function () { return 1; }, neighbours: {},
      onSelect: function () { play(d.vod.movieRef(p.playlistId, item), item.name); }
    });
  } else {
    focus.register({
      id: 'seasons', kind: 'column', size: function () { return series ? series.seasons.length : (seriesFailed ? 1 : 0); }, neighbours: { right: 'episodes' },
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
          play(e.streamRef, item.name + ' · ' + (e.title ? t('vod.episode', { e: e.episode, title: e.title }) : t('vod.episodeUntitled', { e: e.episode })));
        }
      }
    });
  }

  return {
    mount: function (layer: HostLayer) {
      setPoster(item.poster || '');
      const text = h(d.doc, 'div', { className: 'ss-details__text' }, [title, meta, plot, credits, note]);
      const top = h(d.doc, 'div', { className: 'ss-details__top' + (movie ? '' : ' ss-details__top--series') }, [
        h(d.doc, 'div', { className: 'ss-details__art' }, [posterPh, poster]), text
      ]);
      const children: HTMLElement[] = [top];
      if (movie) {
        text.appendChild(h(d.doc, 'div', { className: 'ss-details__actions' }, [actions.element]));
      } else {
        children.push(h(d.doc, 'div', { className: 'ss-details__bottom' }, [
          seasonList.element,
          h(d.doc, 'div', { className: 'ss-details__eps' }, [episodeList.element, epPlot])
        ]));
      }
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-details' }, children));
      renderInfo();
      if (movie) {
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
        loadSeries();
      }
    },
    onShow: function () { /* back from the player */ },
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
