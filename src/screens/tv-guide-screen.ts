// TV guide grid (Stage 7B.2 part 4; design "EPG grid"). Opened from Live TV (Guide/Green key or the
// "TV guide" button) for the channel list shown there.
// Layout: header · info panel (focused programme: channel, title, time, description) · time ruler
// (every 30 min, 2 h 45 visible at 8 px/min) · 6 channel rows: number + name | programme cells.
// A vertical line marks the current time.
// Data: the stored XMLTV guide (EpgService.programmes); for Xtream channels without XMLTV data the
// provider's short EPG is fetched for the rows on screen only (cached by the service). A channel
// without data shows one "No programme information" cell; nothing is invented.
// Remote: ▲▼ channel (keeps the time position), ◀▶ previous / next programme (the window scrolls in
// 30-minute steps, from 2 h back to 24 h ahead), CH▲▼ page of channels, OK watches the channel
// (zapping over this list), Back returns to Live TV.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { EpgService } from '../services/epg-service.ts';
import type { Translate } from '../i18n/strings.ts';
import type { Channel, Programme } from '../models/content.ts';
import type { PlayerParams } from './live-tv-screen.ts';
import { clock } from './live-tv-screen.ts';
import { clear, h } from '../utils/dom.ts';

export interface TvGuideDeps {
  doc: Document;
  t: Translate;
  epg: EpgService;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

export const GUIDE_ROWS = 6; // 6 × 104 px under the info panel fits 1080
export const PX_PER_MIN = 8;
export const WINDOW_MIN = 165;
const STEP_MS = 30 * 60000;
const PAST_MS = 2 * 3600000;
const FUTURE_MS = 24 * 3600000;
const MIN = 60000;

function floorTo(ms: number, step: number): number { return Math.floor(ms / step) * step; }

export function createTvGuideScreen(d: TvGuideDeps, p: PlayerParams, nav: Router): Screen {
  const t = d.t;
  const idx = p.index;
  const list = p.list;
  let pos = Math.max(0, Math.min(list.length - 1, p.pos));
  let top = Math.max(0, Math.min(pos, list.length - GUIDE_ROWS));
  const start = d.now();
  let t0 = floorTo(start, STEP_MS) - STEP_MS;
  let focusTime = start;
  let alive = true;
  let timer: unknown = null;
  const short: Record<string, Programme[] | null | 'loading'> = {};

  const infoChan = h(d.doc, 'div', { className: 'ss-guide__ichan' });
  const infoTitle = h(d.doc, 'div', { className: 'ss-guide__ititle' });
  const infoTime = h(d.doc, 'div', { className: 'ss-guide__itime' });
  const infoDesc = h(d.doc, 'div', { className: 'ss-guide__idesc' });
  const ruler = h(d.doc, 'div', { className: 'ss-guide__ruler' });
  const rowsBox = h(d.doc, 'div', { className: 'ss-guide__rows' });
  const nowLine = h(d.doc, 'div', { className: 'ss-guide__now' });
  const status = h(d.doc, 'div', { className: 'ss-live__status' });

  function channel(i: number): Channel { return idx.channels[list[i]]; }

  function programmes(c: Channel): Programme[] {
    const from = t0 - 6 * 3600000; // long programmes that began earlier still cover the window
    const own = d.epg.programmes(c, from, t0 + WINDOW_MIN * MIN, 60);
    if (own.length) { return own; }
    const s = short[c.id];
    if (s && s !== 'loading') { return s; }
    if (s === undefined && d.epg.status().shortEpg) {
      short[c.id] = 'loading';
      d.epg.shortEpg(c).then(function (l) {
        short[c.id] = l || [];
        if (alive) { paint(); }
      }, function () { short[c.id] = []; });
    }
    return [];
  }

  function at(list2: Programme[], ms: number): number {
    for (let i = 0; i < list2.length; i++) { if (list2[i].start <= ms && list2[i].end > ms) { return i; } }
    return -1;
  }

  function keepVisible(pr: Programme | null): void {
    // Shift the window in 30-minute steps so the focused moment is on screen.
    const lo = floorTo(start, STEP_MS) - PAST_MS;
    const hi = floorTo(start, STEP_MS) + FUTURE_MS;
    const ms = pr ? Math.max(pr.start, Math.min(focusTime, pr.end - 1)) : focusTime;
    while (ms < t0 && t0 > lo) { t0 -= STEP_MS; }
    while (ms >= t0 + (WINDOW_MIN - 15) * MIN && t0 < hi) { t0 += STEP_MS; }
  }

  function paint(): void {
    const now = d.now();
    clear(ruler);
    for (let m = 0; m < WINDOW_MIN; m += 30) {
      const mark = h(d.doc, 'div', { className: 'ss-guide__mark', text: clock(t0 + m * MIN) });
      mark.style.left = (m * PX_PER_MIN) + 'px';
      ruler.appendChild(mark);
    }
    clear(rowsBox);
    let focusedProg: Programme | null = null;
    for (let r = top; r < list.length && r < top + GUIDE_ROWS; r++) {
      const c = channel(r);
      const progs = programmes(c);
      const track = h(d.doc, 'div', { className: 'ss-guide__track' });
      const fi = r === pos ? at(progs, focusTime) : -2;
      let any = false;
      for (let i = 0; i < progs.length; i++) {
        const pr = progs[i];
        const x0 = Math.max(0, (pr.start - t0) / MIN * PX_PER_MIN);
        const x1 = Math.min(WINDOW_MIN * PX_PER_MIN, (pr.end - t0) / MIN * PX_PER_MIN);
        if (x1 <= x0 + 1) { continue; }
        any = true;
        const f = fi === i;
        if (f) { focusedProg = pr; }
        const live = pr.start <= now && pr.end > now;
        const cell = h(d.doc, 'div', { className: 'ss-guide__cell' + (f ? ' is-focused' : '') + (live ? ' is-live' : '') + (pr.end <= now ? ' is-past' : '') }, [
          h(d.doc, 'div', { className: 'ss-guide__ptitle', text: pr.title }),
          h(d.doc, 'div', { className: 'ss-guide__ptime', text: clock(pr.start) + ' – ' + clock(pr.end) })
        ]);
        cell.style.left = Math.round(x0) + 'px';
        cell.style.width = Math.max(4, Math.round(x1 - x0) - 6) + 'px';
        track.appendChild(cell);
      }
      if (!any) {
        const loading = short[c.id] === 'loading';
        const cell = h(d.doc, 'div', { className: 'ss-guide__cell ss-guide__cell--empty' + (r === pos ? ' is-focused' : ''), text: loading ? t('guide.loading') : t('guide.noInfo') });
        cell.style.left = '0px';
        cell.style.width = (WINDOW_MIN * PX_PER_MIN - 6) + 'px';
        track.appendChild(cell);
      }
      rowsBox.appendChild(h(d.doc, 'div', { className: 'ss-guide__row' + (r === pos ? ' is-current' : ''), attrs: { 'data-ch': c.id } }, [
        h(d.doc, 'div', { className: 'ss-guide__chan' }, [
          h(d.doc, 'div', { className: 'ss-guide__num', text: c.num ? String(c.num) : '' }),
          h(d.doc, 'div', { className: 'ss-guide__name', text: c.name })
        ]),
        track
      ]));
    }
    const nx = (now - t0) / MIN * PX_PER_MIN;
    nowLine.style.left = Math.round(nx) + 'px';
    nowLine.style.visibility = nx >= 0 && nx <= WINDOW_MIN * PX_PER_MIN ? 'visible' : 'hidden';
    const fc = list.length ? channel(pos) : null;
    infoChan.textContent = fc ? (fc.num ? fc.num + '  ' : '') + fc.name : '';
    infoTitle.textContent = focusedProg ? focusedProg.title : t('guide.noInfo');
    infoTime.textContent = focusedProg ? clock(focusedProg.start) + ' – ' + clock(focusedProg.end) + (focusedProg.start <= now && focusedProg.end > now ? ' · ' + t('guide.now') : '') : '';
    infoDesc.textContent = focusedProg && focusedProg.desc ? focusedProg.desc : '';
    status.textContent = t('guide.day', { d: dayLabel(t0) });
  }

  function dayLabel(ms: number): string {
    const a = new Date(ms);
    const b = new Date(start);
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()) { return t('guide.today'); }
    return t('day.' + a.getDay()) + ' ' + a.getDate() + ' ' + t('month.' + a.getMonth());
  }

  function currentProg(): Programme | null {
    if (!list.length) { return null; }
    const progs = programmes(channel(pos));
    const i = at(progs, focusTime);
    return i >= 0 ? progs[i] : null;
  }

  function moveTime(dir: number): void {
    const progs = list.length ? programmes(channel(pos)) : [];
    const i = at(progs, focusTime);
    if (i >= 0) {
      const target = dir > 0 ? progs[i].end : progs[i].start - 1;
      const j = at(progs, target);
      focusTime = j >= 0 ? progs[j].start : target; // a gap: the moment right after / before
    } else {
      focusTime += dir * STEP_MS;
    }
    const lo = floorTo(start, STEP_MS) - PAST_MS;
    const hi = floorTo(start, STEP_MS) + FUTURE_MS;
    focusTime = Math.max(lo, Math.min(hi, focusTime));
    keepVisible(currentProg());
  }

  function tick(): void {
    timer = null;
    if (!alive) { return; }
    paint();
    timer = d.setTimer(tick, 60000);
  }

  return {
    mount: function (layer: HostLayer) {
      const grid = h(d.doc, 'div', { className: 'ss-guide__grid' }, [rowsBox, nowLine]);
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-guide' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [h(d.doc, 'div', { className: 'ss-live__title', text: t('guide.title') }), status]),
        h(d.doc, 'div', { className: 'ss-guide__info' }, [infoChan, infoTitle, infoTime, infoDesc]),
        h(d.doc, 'div', { className: 'ss-guide__head' }, [h(d.doc, 'div', { className: 'ss-guide__corner' }), ruler]),
        grid,
        h(d.doc, 'div', { className: 'ss-guide__hint', text: t('guide.hint') })
      ]));
      const s = d.epg.status();
      if (s.playlistId !== p.playlistId || s.state === 'none') {
        d.epg.load(p.playlistId).then(function () { if (alive) { paint(); } });
      }
      paint();
    },
    onShow: function () { if (timer === null) { tick(); } },
    onHide: function () { if (timer !== null) { d.clearTimer(timer); timer = null; } },
    onKey: function (e: RemoteKeyEvent) {
      if (!list.length) { return false; }
      if (e.key === 'up' || e.key === 'down' || e.key === 'chUp' || e.key === 'chDown') {
        const step = e.key === 'up' ? -1 : e.key === 'down' ? 1 : e.key === 'chUp' ? -GUIDE_ROWS : GUIDE_ROWS;
        pos = Math.max(0, Math.min(list.length - 1, pos + step));
        if (pos < top) { top = pos; }
        if (pos >= top + GUIDE_ROWS) { top = pos - GUIDE_ROWS + 1; }
      } else if (e.key === 'left' || e.key === 'right') {
        moveTime(e.key === 'left' ? -1 : 1);
      } else if (e.key === 'ok') {
        const pp: PlayerParams = { playlistId: p.playlistId, index: idx, list: list, pos: pos };
        nav.push('player', pp as unknown as Record<string, unknown>);
        return true;
      } else {
        return false;
      }
      paint();
      return true;
    },
    onBack: function () { return false; },
    destroy: function () {
      alive = false;
      if (timer !== null) { d.clearTimer(timer); timer = null; }
    }
  };
}
