// Full-screen live player (Stage 5). The layer is transparent so the AVPlay video plane shows.
// Remote:
//   ↑ / CH+  next channel in the list it was opened from   ↓ / CH−  previous channel (wraps)
//   OK       Stage 10: the channel list over the video (it keeps playing); on an error: try again
//   0–9      Stage 10: channel number (123 pad); tuned 2 s after the last digit or on OK; Back cancels
//   Blue     Stage 10: previous channel (also PreviousChannel, should a remote send it)
//   Play/Pause/PlayPause  pause or resume where the stream allows it
//   Info, ← → show the banner        Back  close the list / number, else stop and return to the list
// The banner (number, logo, name, now/next, state) appears immediately on every zap; the stream
// opens after the controller's debounce. Recently watched is recorded when the picture starts.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { LiveController, LiveState } from '../player/live-controller.ts';
import type { EpgService } from '../services/epg-service.ts';
import type { Lifecycle } from '../app/lifecycle.ts';
import type { Channel } from '../models/content.ts';
import type { Translate } from '../i18n/strings.ts';
import type { PlayerParams } from './live-tv-screen.ts';
import { clock } from './live-tv-screen.ts';
import { h } from '../utils/dom.ts';
import { createVirtualList } from '../components/virtual-list.ts';
import { createNumberEntry, createZapHistory, findById, findByNumber } from './live-controls.ts';
import type { ZapHistory } from './live-controls.ts';

export interface PlayerDeps {
  doc: Document;
  t: Translate;
  epg: EpgService;
  lifecycle: Lifecycle;
  /** Creates the controller for this screen (engine is shared). */
  createController: (playlistId: string) => LiveController;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  /** Stage 10: channels whose picture started (shared across player screens); see live-controls.ts. */
  history?: ZapHistory;
  /** Stage 10: a channel number is tuned this long after its last digit (ms). */
  numberEntryMs?: number;
}

const BANNER_MS = 5000;
/** Stage 10: rows of the channel list over the video (virtualised: 22,000 channels cost 9 rows). */
export const CHLIST_ROWS = 9;
const NOTE_MS = 2000;

export function createPlayerScreen(d: PlayerDeps, p: PlayerParams, _nav: Router): Screen & { controller(): LiveController } {
  const t = d.t;
  const ctl = d.createController(p.playlistId);
  // Stage 10: the list being zapped through; a number or previous channel found only outside it
  // switches to all channels (same order as Live TV's "All").
  let list = p.list;
  let pos = Math.max(0, Math.min(list.length - 1, p.pos));
  const history = d.history || createZapHistory();
  const numMemo: { list: number[] | null; map: Record<string, number> | null } = { list: null, map: null };
  let bannerTimer: unknown = null;
  let offState: (() => void) | null = null;
  let offLife: (() => void) | null = null;
  const banner = h(d.doc, 'div', { className: 'ss-banner' });
  const status = h(d.doc, 'div', { className: 'ss-player__status' });
  const bNum = h(d.doc, 'div', { className: 'ss-banner__num' });
  const bLogo = h(d.doc, 'img', { className: 'ss-banner__logo', attrs: { alt: '' } });
  const bName = h(d.doc, 'div', { className: 'ss-banner__name' });
  const bNow = h(d.doc, 'div', { className: 'ss-banner__now' });
  const bNext = h(d.doc, 'div', { className: 'ss-banner__next' });
  const bState = h(d.doc, 'div', { className: 'ss-banner__state' });
  bLogo.addEventListener('error', function () { bLogo.style.visibility = 'hidden'; });

  /** Makes the page transparent so the video plane behind it is visible. */
  function setPlaying(on: boolean): void {
    const els: Array<HTMLElement | null> = [d.doc.documentElement || null, d.doc.body || null];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el) {
        el.className = el.className.replace(/ ?ss-playing/g, '') + (on ? ' ss-playing' : '');
      }
    }
  }

  function channelAt(i: number): Channel {
    return p.index.channels[list[i]];
  }

  function stateText(s: LiveState): string {
    switch (s.phase) {
      case 'tuning': return t('player.loading');
      case 'loading': return s.ready ? '' : t('player.loading'); // prepared: the picture is coming
      case 'buffering': return t('player.buffering', { pct: Math.round(s.bufferPercent) });
      case 'retrying': return t('player.reconnecting', { n: s.attempt });
      case 'paused': return t('player.paused');
      case 'error': return t('player.err.' + (s.error || 'unknown'));
      default: return '';
    }
  }

  function renderBanner(): void {
    const c = channelAt(pos);
    bNum.textContent = String(c.num);
    bName.textContent = c.name;
    if (c.logo) {
      bLogo.style.visibility = 'visible';
      bLogo.setAttribute('src', c.logo);
    } else {
      bLogo.style.visibility = 'hidden';
      bLogo.removeAttribute('src');
    }
    const nn = d.epg.nowNext(c);
    bNow.textContent = nn.now ? t('live.now') + '  ' + clock(nn.now.start) + '–' + clock(nn.now.end) + '  ' + nn.now.title : t('live.noGuide');
    bNext.textContent = nn.next ? t('live.next') + '  ' + clock(nn.next.start) + '  ' + nn.next.title : '';
  }

  function render(s: LiveState): void {
    const txt = stateText(s);
    bState.textContent = txt;
    status.textContent = s.phase === 'error' ? txt + ' ' + t('player.errorHint') : ((s.phase === 'loading' && !s.ready) || s.phase === 'tuning' || s.phase === 'buffering' || s.phase === 'retrying' ? txt : '');
    status.className = 'ss-player__status' + (s.phase === 'error' ? ' ss-player__status--error' : '') + (status.textContent ? '' : ' is-empty');
    if (s.phase !== 'playing') {
      showBanner(false);
    } else {
      armHide();
    }
  }

  function armHide(): void {
    if (bannerTimer !== null) {
      d.clearTimer(bannerTimer);
    }
    bannerTimer = d.setTimer(function () {
      bannerTimer = null;
      if (ctl.state().phase === 'playing') {
        banner.className = 'ss-banner is-hidden';
      }
    }, BANNER_MS);
  }

  function showBanner(autoHide: boolean): void {
    banner.className = 'ss-banner';
    if (autoHide) {
      armHide();
    }
  }

  function zap(delta: number): void {
    if (list.length < 2) {
      return;
    }
    pos = (pos + delta + list.length) % list.length;
    renderBanner();
    showBanner(true);
    ctl.select(channelAt(pos));
  }

  // ---------------------------------------------------------------- Stage 10 controls
  /** Tunes position `i` of `l` at once (number entry, previous channel, the channel list). */
  function tuneTo(l: number[], i: number): void {
    list = l;
    pos = i;
    renderBanner();
    showBanner(true);
    ctl.selectNow(channelAt(pos));
  }

  // The number box: the digits being typed, or a short note ("No channel 999").
  const numBox = h(d.doc, 'div', { className: 'ss-numentry is-hidden' });
  let noteTimer: unknown = null;
  function showNumber(text: string, note: boolean): void {
    if (noteTimer !== null) { d.clearTimer(noteTimer); noteTimer = null; }
    numBox.textContent = text;
    numBox.className = 'ss-numentry' + (text ? '' : ' is-hidden') + (note ? ' ss-numentry--note' : '');
    if (note && text) {
      noteTimer = d.setTimer(function () { noteTimer = null; numBox.className = 'ss-numentry is-hidden'; }, NOTE_MS);
    }
  }
  const entry = createNumberEntry({
    timeoutMs: d.numberEntryMs || 2000, setTimer: d.setTimer, clearTimer: d.clearTimer,
    onChange: function (text) { showNumber(text ? text + (text.length < 6 ? '_' : '') : '', false); },
    onCommit: function (num) {
      let l = list;
      let i = findByNumber(p.index.channels, l, num, numMemo);
      if (i < 0 && num > 0 && l !== p.index.all()) { l = p.index.all(); i = findByNumber(p.index.channels, l, num, numMemo); }
      if (i < 0) { showNumber(t('player.noChannel', { n: num > 0 ? String(num) : '0' }), true); return; }
      closeList();
      if (l === list && i === pos) { renderBanner(); showBanner(true); return; } // already on it
      tuneTo(l, i);
    }
  });

  function previousChannel(): void {
    const id = history.previous(p.playlistId);
    if (!id) { showNumber(t('player.noPrevious'), true); return; }
    let l = list;
    let i = findById(p.index.channels, l, id);
    if (i < 0) { l = p.index.all(); i = findById(p.index.channels, l, id); }
    if (i < 0) { showNumber(t('player.noPrevious'), true); return; } // no longer in the playlist
    closeList();
    tuneTo(l, i);
  }

  // The channel list over the video: a fixed pool of CHLIST_ROWS rows (no node per channel).
  let listOpen = false;
  let listFocus = 0;
  const chTitle = h(d.doc, 'div', { className: 'ss-chlist__title' });
  const chList = createVirtualList<{ num: HTMLElement; name: HTMLElement }>(d.doc, {
    rows: CHLIST_ROWS, className: 'ss-chlist__list',
    createRow: function () {
      const num = h(d.doc, 'div', { className: 'ss-chlist__num' });
      const name = h(d.doc, 'div', { className: 'ss-chlist__name' });
      return { root: h(d.doc, 'div', { className: 'ss-chlist__row' }, [num, name]), parts: { num: num, name: name } };
    },
    bind: function (parts, idx) {
      const c = p.index.channels[list[idx]];
      parts.num.textContent = String(c.num);
      parts.name.textContent = c.name;
      parts.name.className = 'ss-chlist__name' + (idx === pos ? ' is-current' : '');
    }
  });
  const chPanel = h(d.doc, 'div', { className: 'ss-chlist is-hidden' }, [chTitle, chList.element]);
  function paintTitle(): void { chTitle.textContent = t('player.channels') + '  ' + (listFocus + 1) + ' / ' + list.length; }
  function openList(): void {
    listOpen = true;
    listFocus = pos;
    chList.setCount(list.length);
    chList.setFocused(listFocus, true);
    chList.refresh();
    paintTitle();
    chPanel.className = 'ss-chlist';
    banner.className = 'ss-banner is-hidden';
  }
  function closeList(): void {
    if (!listOpen) { return; }
    listOpen = false;
    chPanel.className = 'ss-chlist is-hidden';
  }
  function moveList(delta: number): void {
    const n = list.length;
    if (!n) { return; }
    listFocus = Math.max(0, Math.min(n - 1, listFocus + delta));
    chList.setFocused(listFocus, true);
    paintTitle();
  }
  function listKey(e: RemoteKeyEvent): boolean {
    switch (e.key) {
      case 'up': moveList(-1); return true;
      case 'down': moveList(1); return true;
      case 'chUp': moveList(-CHLIST_ROWS); return true;
      case 'chDown': moveList(CHLIST_ROWS); return true;
      case 'ok': {
        const i = listFocus;
        closeList();
        if (i !== pos) { tuneTo(list, i); } else { renderBanner(); showBanner(true); }
        return true;
      }
      case 'channelList': closeList(); return true;
      default: return true; // the list owns the remote while open (no zapping behind it)
    }
  }

  return {
    mount: function (layer: HostLayer) {
      const root = layer.element as HTMLElement;
      root.className += ' ss-layer--video';
      setPlaying(true);
      banner.appendChild(h(d.doc, 'div', { className: 'ss-banner__row' }, [bNum, bLogo, h(d.doc, 'div', { className: 'ss-banner__text' }, [bName, bNow, bNext]), bState]));
      root.appendChild(h(d.doc, 'div', { className: 'ss-player' }, [status, banner, chPanel, numBox]));
      offState = ctl.onChange(render);
      offLife = d.lifecycle.on(function (e) {
        if (e === 'hidden') { ctl.suspend(); }
        if (e === 'visible') { ctl.restore(); }
      });
      renderBanner();
      showBanner(true);
      ctl.selectNow(channelAt(pos));
    },
    onShow: function () { /* nothing */ },
    onHide: function () { ctl.stop(); },
    onKey: function (e: RemoteKeyEvent) {
      // Stage 10: digits build a channel number (also while the list is open).
      if (e.key === 'digit' && typeof e.digit === 'number') { entry.digit(e.digit); return true; }
      if (entry.active()) {
        if (e.key === 'ok') { entry.confirm(); return true; }
        entry.cancel(); // any other key: the typed number is dropped, the key acts as usual
      }
      if (e.key === 'blue' || e.key === 'prevChannel') { previousChannel(); return true; }
      if (listOpen) { return listKey(e); }
      if (e.key === 'channelList') { openList(); return true; }
      switch (e.key) {
        case 'up':
        case 'chUp': zap(1); return true;
        case 'down':
        case 'chDown': zap(-1); return true;
        case 'ok':
          if (ctl.state().phase === 'error') {
            ctl.retry();
            showBanner(false);
          } else {
            openList(); // Stage 10 (your decision): OK opens the channel list over the video
          }
          return true;
        case 'play':
        case 'pause':
        case 'playPause':
          ctl.togglePause();
          return true;
        case 'left':
        case 'right':
        case 'info':
          renderBanner();
          showBanner(true);
          return true;
        default:
          return false;
      }
    },
    onBack: function () {
      // Stage 10: Back first closes the number entry, then the channel list; playback goes on.
      if (entry.cancel()) { return true; }
      if (listOpen) { closeList(); return true; }
      ctl.stop();
      return false; // router pops back to Live TV
    },
    destroy: function () {
      setPlaying(false);
      if (bannerTimer !== null) { d.clearTimer(bannerTimer); }
      if (noteTimer !== null) { d.clearTimer(noteTimer); }
      entry.destroy();
      numMemo.list = null;
      numMemo.map = null;
      if (offState) { offState(); }
      if (offLife) { offLife(); }
      ctl.destroy();
    },
    controller: function () { return ctl; }
  };
}
