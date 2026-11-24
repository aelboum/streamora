// Full-screen live player (Stage 5). The layer is transparent so the AVPlay video plane shows.
// Remote:
//   ↑ / CH+  next channel in the list it was opened from   ↓ / CH−  previous channel (wraps)
//   OK       show/hide the channel banner; on an error: try again
//   Play/Pause/PlayPause  pause or resume where the stream allows it
//   Info, ← → show the banner        Back  stop playback and return to the channel list
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

export interface PlayerDeps {
  doc: Document;
  t: Translate;
  epg: EpgService;
  lifecycle: Lifecycle;
  /** Creates the controller for this screen (engine is shared). */
  createController: (playlistId: string) => LiveController;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

const BANNER_MS = 5000;

export function createPlayerScreen(d: PlayerDeps, p: PlayerParams, _nav: Router): Screen & { controller(): LiveController } {
  const t = d.t;
  const ctl = d.createController(p.playlistId);
  let pos = Math.max(0, Math.min(p.list.length - 1, p.pos));
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
    return p.index.channels[p.list[i]];
  }

  function stateText(s: LiveState): string {
    switch (s.phase) {
      case 'tuning':
      case 'loading': return t('player.loading');
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
    status.textContent = s.phase === 'error' ? txt + ' ' + t('player.errorHint') : (s.phase === 'loading' || s.phase === 'tuning' || s.phase === 'buffering' || s.phase === 'retrying' ? txt : '');
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
    if (p.list.length < 2) {
      return;
    }
    pos = (pos + delta + p.list.length) % p.list.length;
    renderBanner();
    showBanner(true);
    ctl.select(channelAt(pos));
  }

  return {
    mount: function (layer: HostLayer) {
      const root = layer.element as HTMLElement;
      root.className += ' ss-layer--video';
      setPlaying(true);
      banner.appendChild(h(d.doc, 'div', { className: 'ss-banner__row' }, [bNum, bLogo, h(d.doc, 'div', { className: 'ss-banner__text' }, [bName, bNow, bNext]), bState]));
      root.appendChild(h(d.doc, 'div', { className: 'ss-player' }, [status, banner]));
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
      switch (e.key) {
        case 'up':
        case 'chUp': zap(1); return true;
        case 'down':
        case 'chDown': zap(-1); return true;
        case 'ok':
          if (ctl.state().phase === 'error') {
            ctl.retry();
            showBanner(false);
          } else if (banner.className.indexOf('is-hidden') >= 0) {
            renderBanner();
            showBanner(true);
          } else {
            banner.className = 'ss-banner is-hidden';
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
      ctl.stop();
      return false; // router pops back to Live TV
    },
    destroy: function () {
      setPlaying(false);
      if (bannerTimer !== null) { d.clearTimer(bannerTimer); }
      if (offState) { offState(); }
      if (offLife) { offLife(); }
      ctl.destroy();
    },
    controller: function () { return ctl; }
  };
}
