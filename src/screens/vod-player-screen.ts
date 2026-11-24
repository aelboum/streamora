// Full-screen movie / episode player (Stage 6). The layer is transparent so the AVPlay video plane
// shows (same mechanism as the live player).
// Remote:
//   OK                   pause / resume (on an error: try again); shows the bar
//   Play/Pause/PlayPause pause / resume
//   any arrow, Info      show the bar (title, state, position / duration)
//   Back                 stop and return to the details screen
// The bar hides 5 s after playback runs. Position and duration update once a second.
// Seeking and resume points are not part of Stage 6 (no progress system exists yet).
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { VodController, VodState } from '../player/vod-controller.ts';
import type { Lifecycle } from '../app/lifecycle.ts';
import type { Translate } from '../i18n/strings.ts';
import type { VodPlayerParams } from './vod-details-screen.ts';
import { h } from '../utils/dom.ts';

export interface VodPlayerDeps {
  doc: Document;
  t: Translate;
  lifecycle: Lifecycle;
  createController: (playlistId: string) => VodController;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

const BAR_MS = 5000;

function two(n: number): string { return (n < 10 ? '0' : '') + n; }
export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return (hh > 0 ? hh + ':' + two(mm) : String(mm)) + ':' + two(s % 60);
}

export function createVodPlayerScreen(d: VodPlayerDeps, p: VodPlayerParams, _nav: Router): Screen & { controller(): VodController } {
  const t = d.t;
  const ctl = d.createController(p.playlistId);
  let barTimer: unknown = null;
  let tickTimer: unknown = null;
  let offState: (() => void) | null = null;
  let offLife: (() => void) | null = null;
  let alive = true;
  const bar = h(d.doc, 'div', { className: 'ss-vbar' });
  const bTitle = h(d.doc, 'div', { className: 'ss-vbar__title', text: p.title });
  const bState = h(d.doc, 'div', { className: 'ss-vbar__state' });
  const bFill = h(d.doc, 'div', { className: 'ss-vbar__fill' });
  const bTime = h(d.doc, 'div', { className: 'ss-vbar__time' });
  const status = h(d.doc, 'div', { className: 'ss-player__status is-empty' });

  function setPlaying(on: boolean): void {
    const els: Array<HTMLElement | null> = [d.doc.documentElement || null, d.doc.body || null];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el) {
        el.className = el.className.replace(/ ?ss-playing/g, '') + (on ? ' ss-playing' : '');
      }
    }
  }

  function stateText(s: VodState): string {
    switch (s.phase) {
      case 'loading': return t('player.loading');
      case 'buffering': return t('player.buffering', { pct: Math.round(s.bufferPercent) });
      case 'paused': return t('player.paused');
      case 'ended': return t('vod.player.ended');
      case 'error': return t('vod.player.err.' + (s.error || 'unknown'));
      default: return '';
    }
  }

  function render(s: VodState): void {
    const txt = stateText(s);
    bState.textContent = txt;
    const pct = s.durationMs > 0 ? Math.max(0, Math.min(100, s.positionMs * 100 / s.durationMs)) : 0;
    bFill.style.width = pct.toFixed(1) + '%';
    bTime.textContent = s.durationMs > 0 ? formatTime(s.positionMs) + ' / ' + formatTime(s.durationMs) : (s.positionMs > 0 ? formatTime(s.positionMs) : '');
    status.textContent = s.phase === 'error' ? txt + ' ' + t('vod.player.errorHint') : (s.phase === 'loading' || s.phase === 'buffering' ? txt : '');
    status.className = 'ss-player__status' + (s.phase === 'error' ? ' ss-player__status--error' : '') + (status.textContent ? '' : ' is-empty');
    if (s.phase === 'playing') {
      armHide();
    } else {
      showBar(false);
    }
  }

  function armHide(): void {
    if (barTimer !== null) {
      d.clearTimer(barTimer);
    }
    barTimer = d.setTimer(function () {
      barTimer = null;
      if (ctl.state().phase === 'playing') {
        bar.className = 'ss-vbar is-hidden';
      }
    }, BAR_MS);
  }

  function showBar(autoHide: boolean): void {
    bar.className = 'ss-vbar';
    if (autoHide) {
      armHide();
    }
  }

  function tick(): void {
    tickTimer = null;
    if (!alive) {
      return;
    }
    ctl.tick();
    tickTimer = d.setTimer(tick, 1000);
  }

  return {
    mount: function (layer: HostLayer) {
      const root = layer.element as HTMLElement;
      root.className += ' ss-layer--video';
      setPlaying(true);
      bar.appendChild(bTitle);
      bar.appendChild(h(d.doc, 'div', { className: 'ss-vbar__line' }, [h(d.doc, 'div', { className: 'ss-vbar__track' }, [bFill]), bTime]));
      bar.appendChild(bState);
      root.appendChild(h(d.doc, 'div', { className: 'ss-player' }, [status, bar]));
      offState = ctl.onChange(render);
      offLife = d.lifecycle.on(function (e) {
        if (e === 'hidden') { ctl.suspend(); }
        if (e === 'visible') { ctl.restore(); }
      });
      showBar(false);
      ctl.play(p.ref);
      tickTimer = d.setTimer(tick, 1000);
    },
    onShow: function () { /* nothing */ },
    onHide: function () { ctl.stop(); },
    onKey: function (e: RemoteKeyEvent) {
      switch (e.key) {
        case 'ok':
          if (ctl.state().phase === 'error') {
            ctl.retry();
          } else {
            ctl.togglePause();
          }
          showBar(true);
          return true;
        case 'play':
        case 'pause':
        case 'playPause':
          ctl.togglePause();
          showBar(true);
          return true;
        case 'up':
        case 'down':
        case 'left':
        case 'right':
        case 'info':
          showBar(true);
          return true;
        default:
          return false;
      }
    },
    onBack: function () {
      ctl.stop();
      return false; // router pops back to the details screen
    },
    destroy: function () {
      alive = false;
      setPlaying(false);
      if (barTimer !== null) { d.clearTimer(barTimer); }
      if (tickTimer !== null) { d.clearTimer(tickTimer); }
      if (offState) { offState(); }
      if (offLife) { offLife(); }
      ctl.destroy();
    },
    controller: function () { return ctl; }
  };
}
