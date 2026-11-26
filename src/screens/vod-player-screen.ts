// Full-screen movie / episode player (Stage 6; Stage 7B.2 controls, seeking and resume, design 12).
// The layer is transparent so the video plane shows (AVPlay on Tizen, ExoPlayer on Android).
// Remote:
//   ◀ ▶ (scrubber)       move the seek cursor −/+10 s (held: 30 s steps after 1.5 s, 60 s after 4 s);
//                        the title keeps playing; OK jumps to the cursor, Back cancels (Stage 7E)
//   Rewind / FF          the same
//   OK (scrubber)        pause / resume (on an error: try again)
//   −10 / +10 buttons    jump at once
//   ▼ / ▲                to the button row (−10 s · play/pause · +10 s) and back
//   Play/Pause keys      pause / resume
//   Info, any arrow      show the controls
//   OK on [CC] (4th button) audio & subtitles side sheet (track-sheet.ts); Back closes it
//   Back                 save the position, stop, return
// The controls (title band included) hide 3 s after the last key while playing (Stage 7F: the timer
// is armed by keys and by the start of playback only, never by the 1 s position updates); they stay
// while paused, while the seek cursor is shown and while the Audio & subtitles sheet is open. Resume: when started with startMs, a toast
// "Resuming at 1:12:40 · ◀ to start over" shows for 5 s; ◀ during the toast restarts from 0.
// Progress is saved every 10 s while playing, and on Back, Home and the end of the title.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { VodController, VodState } from '../player/vod-controller.ts';
import type { Lifecycle } from '../app/lifecycle.ts';
import type { Translate } from '../i18n/strings.ts';
import type { ProgressStore } from '../services/progress.ts';
import type { VodPlayerParams } from './vod-details-screen.ts';
import type { TrackPrefStore } from '../services/track-prefs.ts';
import { preferredText } from '../services/track-prefs.ts';
import { autoAudio } from '../player/track-info.ts';
import { createTrackSheet } from './track-sheet.ts';
import { createIcon, setIcon } from '../components/brand.ts';
import { clear, h } from '../utils/dom.ts';
import { nextEpisode } from '../content/next-episode.ts';
import type { Episode } from '../models/content.ts';
import { progressKey } from '../services/progress.ts';

export interface VodPlayerDeps {
  doc: Document;
  t: Translate;
  lifecycle: Lifecycle;
  createController: (playlistId: string) => VodController;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  progress?: ProgressStore | null;
  /** Stage 7B.2: preferred audio / subtitle language. */
  trackPrefs?: TrackPrefStore | null;
}

/** Cue text from the engine may carry markup (<i>, <font …>): draw plain lines only. */
export function subtitleLines(text: string): string[] {
  const plain = String(text || '').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').replace(/\r/g, '');
  const out: string[] = [];
  const parts = plain.split('\n');
  for (let i = 0; i < parts.length && out.length < 4; i++) {
    const l = parts[i].replace(/^\s+|\s+$/g, '');
    if (l) { out.push(l); }
  }
  return out;
}

export const BAR_MS = 3000;
const TOAST_MS = 5000;
const SAVE_EVERY_TICKS = 10;

function two(n: number): string { return (n < 10 ? '0' : '') + n; }
export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return (hh > 0 ? hh + ':' + two(mm) : String(mm)) + ':' + two(s % 60);
}

/** Seek step for a held key: 10 s, then 30 s after 1.5 s, 60 s after 4 s. */
export function seekStep(heldMs: number): number {
  return heldMs >= 4000 ? 60000 : heldMs >= 1500 ? 30000 : 10000;
}

export function createVodPlayerScreen(d: VodPlayerDeps, p: VodPlayerParams, _nav: Router): Screen & { controller(): VodController } {
  const t = d.t;
  const ctl = d.createController(p.playlistId);
  let barTimer: unknown = null;
  let tickTimer: unknown = null;
  let toastTimer: unknown = null;
  let offState: (() => void) | null = null;
  let offLife: (() => void) | null = null;
  let alive = true;
  let ticks = 0;
  let zone: 'scrub' | 'buttons' = 'scrub';
  let btn = 1;
  let resumeToast = false;
  let finished = false; // ended: watched mark stored, later saves must not bring the title back
  // Stage 11: next-episode prompt (series only), shown once per episode: NEXT_LEAD_MS before the end
  // while the episode keeps playing (your TV check: the end credits can't be detected here, so
  // 2 minutes before the end), or when the stream ended by itself, whichever comes first. Never on
  // Back or an error. Nothing starts until OK on "Play next" (your decision: no countdown).
  let nextChecked = false;
  let nextEp: Episode | null = null;
  let promptOpen = false;
  let promptBtn = 0;
  const nTitle = h(d.doc, 'div', { className: 'ss-nextep__title', text: t('vod.nextEpisode') });
  const nName = h(d.doc, 'div', { className: 'ss-nextep__name' });
  const nPlay = h(d.doc, 'div', { className: 'ss-nextep__button', text: t('vod.playNext') });
  const nCancel = h(d.doc, 'div', { className: 'ss-nextep__button', text: t('common.cancel') });
  const NEXT_LEAD_MS = 120000;
  const NEXT_MIN_DURATION_MS = 300000; // short items (trailers, extras): only at the real end
  const prompt = h(d.doc, 'div', { className: 'ss-nextep is-hidden' }, [nTitle, nName, h(d.doc, 'div', { className: 'ss-nextep__buttons' }, [nPlay, nCancel])]);
  const bar = h(d.doc, 'div', { className: 'ss-vbar' });
  const bTitle = h(d.doc, 'div', { className: 'ss-vbar__title', text: p.title });
  const bState = h(d.doc, 'div', { className: 'ss-vbar__state' });
  const bFill = h(d.doc, 'div', { className: 'ss-vbar__fill' });
  const bKnob = h(d.doc, 'div', { className: 'ss-vbar__knob' });
  // Stage 7E: seek cursor + time bubble (no preview picture on this TV, see the report).
  const bCursor = h(d.doc, 'div', { className: 'ss-vbar__cursor is-hidden' });
  const bBubbleTime = h(d.doc, 'div', { className: 'ss-vbar__bubble-time' });
  const bBubble = h(d.doc, 'div', { className: 'ss-vbar__bubble is-hidden' }, [bBubbleTime, h(d.doc, 'div', { className: 'ss-vbar__bubble-hint', text: t('vod.scrubHint') })]);
  const bTrack = h(d.doc, 'div', { className: 'ss-vbar__track' }, [bFill, bKnob, bCursor, bBubble]);
  let scrubbing = false;
  let scrubMs = 0;
  const bTime = h(d.doc, 'div', { className: 'ss-vbar__time' });
  const bLeft = h(d.doc, 'div', { className: 'ss-vbar__time ss-vbar__time--left' });
  const icons = [createIcon(d.doc, 'replay10', '', 'ss-vbar__icon ss-vbar__icon--small'), createIcon(d.doc, 'pause', '', 'ss-vbar__icon'), createIcon(d.doc, 'forward10', '', 'ss-vbar__icon ss-vbar__icon--small'), createIcon(d.doc, 'subtitles', '', 'ss-vbar__icon ss-vbar__icon--small')];
  const buttons = [
    h(d.doc, 'div', { className: 'ss-vbar__button ss-vbar__button--small' }, [icons[0]]),
    h(d.doc, 'div', { className: 'ss-vbar__button' }, [icons[1]]),
    h(d.doc, 'div', { className: 'ss-vbar__button ss-vbar__button--small' }, [icons[2]]),
    h(d.doc, 'div', { className: 'ss-vbar__button ss-vbar__button--small' }, [icons[3]])
  ];
  const sheet = createTrackSheet(d.doc, t);
  const subs = h(d.doc, 'div', { className: 'ss-subs' });
  let subsText = '';
  let tracksRev = 0;
  // Stage 7E: automatic audio (best quality of the chosen language) and subtitle choice, once per
  // title, after the file's track table is known; a manual pick before that cancels it.
  let audioApplied = false;
  let textApplied = false;
  let seekableShown = true;
  const toast = h(d.doc, 'div', { className: 'ss-toast is-hidden' });
  const status = h(d.doc, 'div', { className: 'ss-player__status is-empty' });

  /** Phase seen by the last render: the hide timer reacts to phase changes, not to position updates. */
  let lastPhase = '';

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

  function paintFocus(): void {
    const seekable = ctl.state().seekable;
    bTrack.className = 'ss-vbar__track' + (zone === 'scrub' && seekable ? ' is-focused' : '');
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].className = 'ss-vbar__button' + (i === 1 ? '' : ' ss-vbar__button--small') + (zone === 'buttons' && btn === i ? ' is-focused' : '') +
        (!seekable && (i === 0 || i === 2) ? ' is-disabled' : '');
    }
    subs.className = 'ss-subs' + (bar.className.indexOf('is-hidden') < 0 ? ' ss-subs--raised' : '');
  }

  function renderSubs(text: string): void {
    if (text === subsText) { return; }
    subsText = text;
    clear(subs);
    const lines = subtitleLines(text);
    for (let i = 0; i < lines.length; i++) { subs.appendChild(h(d.doc, 'div', { className: 'ss-subs__line', text: lines[i] })); }
  }

  function onTracks(): void {
    const list = ctl.tracks();
    if (list.length && ctl.tracksFinal()) {
      const prefs = d.trackPrefs ? d.trackPrefs.get() : { audio: '', text: '' };
      if (!audioApplied) {
        audioApplied = true;
        const a = autoAudio(list, prefs.audio);
        if (a >= 0) { ctl.selectTrack('audio', a); }
      }
      if (!textApplied) {
        // Subtitles stay off unless a subtitle language was chosen before.
        textApplied = true;
        const x = preferredText(list, prefs);
        if (x) { ctl.selectTrack('text', x.id); }
      }
    }
    sheet.update(ctl.tracks());
  }

  function render(s: VodState): void {
    renderSubs(s.subtitle);
    if (!s.seekable && seekableShown) {
      // TV test (Stage 7B.2): some providers' streams cannot be seeked by AVPlay. Say so once.
      seekableShown = false;
      if (s.startFailed) { notice(t('vod.resumeFailedTitle'), t('vod.resumeFailedText')); } else { notice(t('vod.noSeekTitle'), t('vod.noSeekText')); }
    }
    if (s.tracksRev !== tracksRev) {
      tracksRev = s.tracksRev;
      onTracks();
    }
    const txt = stateText(s);
    bState.textContent = txt;
    const pct = s.durationMs > 0 ? Math.max(0, Math.min(100, s.positionMs * 100 / s.durationMs)) : 0;
    bFill.style.width = pct.toFixed(1) + '%';
    bKnob.style.left = pct.toFixed(1) + '%';
    // Stage 7F: "elapsed / total" on the left, "−remaining" on the right.
    bLeft.textContent = s.durationMs > 0 ? formatTime(s.positionMs) + ' / ' + formatTime(s.durationMs) : (s.positionMs > 0 ? formatTime(s.positionMs) : '');
    bTime.textContent = s.durationMs > 0 ? '−' + formatTime(Math.max(0, s.durationMs - s.positionMs)) : '';
    setIcon(icons[1], s.phase === 'paused' || s.phase === 'ended' ? 'play' : 'pause');
    status.textContent = s.phase === 'error' ? txt + ' ' + t('vod.player.errorHint') : (s.phase === 'loading' || s.phase === 'buffering' ? txt : '');
    status.className = 'ss-player__status' + (s.phase === 'error' ? ' ss-player__status--error' : '') + (status.textContent ? '' : ' is-empty');
    if (s.phase === 'ended') {
      save(true);
      checkNext();
    } else if (s.phase === 'playing' && p.series && !nextChecked && s.durationMs >= NEXT_MIN_DURATION_MS && s.durationMs - s.positionMs <= NEXT_LEAD_MS) {
      checkNext(); // the episode keeps playing behind the prompt
    }
    if (s.phase === 'error' || s.phase === 'ended' || !s.seekable) { endScrub(); } else if (scrubbing) { paintScrub(); }
    if (s.phase !== lastPhase) {
      const was = lastPhase;
      lastPhase = s.phase;
      if (s.phase === 'playing') {
        // Picture started, playback resumed or buffering ended: hide after BAR_MS from now.
        if (bar.className.indexOf('is-hidden') < 0) { armHide(); }
      } else if (s.phase === 'buffering' && was === 'playing') {
        // A short stall during playback: only the status text shows, the controls stay as they are.
      } else {
        // Loading, paused, ended, error: controls stay until playback runs again.
        showBar(false);
      }
    }
    paintFocus();
  }

  // Viewing progress (Stage 7B.2). `end` = the title finished (counts as watched).
  function save(end: boolean): void {
    if (!d.progress || !p.progress || finished) {
      return;
    }
    const s = ctl.state();
    if (s.durationMs <= 0) {
      return;
    }
    const m = p.progress;
    d.progress.save(p.playlistId, {
      key: m.key, section: m.section, title: m.title, sub: m.sub, poster: m.poster, item: m.item, ref: p.ref,
      pos: end ? s.durationMs : s.positionMs, dur: s.durationMs, at: 0
    });
    if (end) { finished = true; }
  }

  function armHide(): void {
    if (barTimer !== null) {
      d.clearTimer(barTimer);
    }
    barTimer = d.setTimer(function () {
      barTimer = null;
      if (ctl.state().phase === 'playing' && !sheet.isOpen() && !scrubbing) {
        bar.className = 'ss-vbar is-hidden';
        zone = 'scrub';
        paintFocus();
      }
    }, BAR_MS);
  }

  /** Shows the controls. autoHide: (re)start the one hide timer; false: keep them up (timer cleared). */
  function showBar(autoHide: boolean): void {
    bar.className = 'ss-vbar';
    paintFocus();
    if (autoHide) {
      armHide();
    } else if (barTimer !== null) {
      d.clearTimer(barTimer);
      barTimer = null;
    }
  }

  function paintScrub(): void {
    const s = ctl.state();
    if (!scrubbing) {
      bCursor.className = 'ss-vbar__cursor is-hidden';
      bBubble.className = 'ss-vbar__bubble is-hidden';
      return;
    }
    const pct = s.durationMs > 0 ? Math.max(0, Math.min(100, scrubMs * 100 / s.durationMs)) : 0;
    bCursor.className = 'ss-vbar__cursor';
    bBubble.className = 'ss-vbar__bubble';
    bCursor.style.left = pct.toFixed(1) + '%';
    // The bubble stays inside the bar near its ends.
    bBubble.style.left = Math.max(12, Math.min(88, pct)).toFixed(1) + '%';
    const delta = scrubMs - s.positionMs;
    bBubbleTime.textContent = formatTime(scrubMs) + '  (' + (delta >= 0 ? '+' : '−') + formatTime(Math.abs(delta)) + ')';
  }

  function endScrub(): void {
    if (!scrubbing) { return; }
    scrubbing = false;
    paintScrub();
  }

  function hideToast(): void {
    resumeToast = false;
    toast.className = 'ss-toast is-hidden';
    if (toastTimer !== null) { d.clearTimer(toastTimer); toastTimer = null; }
  }

  function seekBy(delta: number): void {
    const s = ctl.state();
    if (!s.seekable) {
      notice(t('vod.noSeekTitle'), t('vod.noSeekText'));
      showBar(true);
      return;
    }
    ctl.seekTo(s.positionMs + delta);
    showBar(true);
  }

  /** Stage 7E: ◀▶ move the cursor only; playback is not touched until OK. */
  function scrubBy(delta: number): void {
    const s = ctl.state();
    if (!s.seekable) {
      notice(t('vod.noSeekTitle'), t('vod.noSeekText'));
      showBar(true);
      return;
    }
    const max = s.durationMs > 1000 ? s.durationMs - 1000 : Math.max(0, s.positionMs + delta);
    scrubMs = Math.max(0, Math.min(max, (scrubbing ? scrubMs : s.positionMs) + delta));
    scrubbing = true;
    paintScrub();
    showBar(false);
  }

  /** Toast for 5 s (replaces the resume toast). */
  function notice(title: string, body: string): void {
    hideToast();
    clear(toast);
    toast.className = 'ss-toast';
    toast.appendChild(createIcon(d.doc, 'info', '#4FA8FF', 'ss-toast__icon'));
    toast.appendChild(h(d.doc, 'div', { className: 'ss-toast__text' }, [
      h(d.doc, 'div', { className: 'ss-toast__title', text: title }),
      h(d.doc, 'div', { className: 'ss-toast__body', text: body })
    ]));
    toastTimer = d.setTimer(function () { toastTimer = null; hideToast(); }, TOAST_MS);
  }

  function tick(): void {
    tickTimer = null;
    if (!alive) {
      return;
    }
    ctl.tick();
    if (++ticks % SAVE_EVERY_TICKS === 0 && ctl.state().phase === 'playing') {
      save(false);
    }
    tickTimer = d.setTimer(tick, 1000);
  }

  function paintPrompt(): void {
    prompt.className = 'ss-nextep' + (promptOpen ? '' : ' is-hidden');
    nPlay.className = 'ss-nextep__button' + (promptBtn === 0 ? ' is-focused' : '');
    nCancel.className = 'ss-nextep__button' + (promptBtn === 1 ? ' is-focused' : '');
  }
  function episodeSub(e: Episode): string { return t('vod.epSub', { s: e.season, e: e.episode }) + (e.title ? ' · ' + e.title : ''); }
  /** The stream ended by itself: offer the next episode once, when it is known for sure. */
  function checkNext(): void {
    if (nextChecked || !p.series) { return; }
    nextChecked = true;
    const r = nextEpisode(p.series.seasons, p.series.episodeId);
    if (!('episode' in r)) { return; } // last episode, or numbers missing / ambiguous: no prompt
    nextEp = r.episode;
    nName.textContent = episodeSub(r.episode);
    promptOpen = true;
    promptBtn = 0;
    paintPrompt();
  }
  function closePrompt(): void { promptOpen = false; paintPrompt(); }
  /** Plays the next episode in this screen, on the same controller (no second player). */
  function playNext(): void {
    const e = nextEp;
    const ser = p.series;
    closePrompt();
    if (!e || !ser) { return; }
    const sub = episodeSub(e);
    const key = progressKey('series', e.id);
    const part = d.progress ? d.progress.get(p.playlistId, key) : null;
    p.ref = e.streamRef;
    p.title = ser.item.name + ' · ' + sub;
    p.progress = { key: key, section: 'series', title: ser.item.name, sub: sub, poster: e.image || ser.item.poster || '', item: ser.item };
    ser.episodeId = e.id;
    bTitle.textContent = p.title;
    finished = false;
    nextChecked = false;
    nextEp = null;
    audioApplied = false;
    textApplied = false;
    ticks = 0;
    ctl.play(e.streamRef, part ? part.pos : 0);
    showBar(false);
  }

  return {
    mount: function (layer: HostLayer) {
      const root = layer.element as HTMLElement;
      root.className += ' ss-layer--video';
      setPlaying(true);
      // Stage 7F: no time-of-day clock while watching.
      bar.appendChild(h(d.doc, 'div', { className: 'ss-vbar__top' }, [bTitle]));
      bar.appendChild(h(d.doc, 'div', { className: 'ss-vbar__bottom' }, [
        bTrack,
        h(d.doc, 'div', { className: 'ss-vbar__line' }, [bLeft, h(d.doc, 'div', { className: 'ss-vod__spacer' }), bTime]),
        h(d.doc, 'div', { className: 'ss-vbar__controls' }, [buttons[0], buttons[1], buttons[2], bState, h(d.doc, 'div', { className: 'ss-vod__spacer' }), buttons[3]])
      ]));
      root.appendChild(h(d.doc, 'div', { className: 'ss-player' }, [subs, status, bar, toast, sheet.element, prompt]));
      paintFocus();
      offState = ctl.onChange(render);
      offLife = d.lifecycle.on(function (e) {
        if (e === 'hidden') { save(false); ctl.suspend(); }
        if (e === 'visible') { ctl.restore(); }
      });
      showBar(false);
      const start = p.startMs && p.startMs > 0 ? p.startMs : 0;
      ctl.play(p.ref, start);
      if (start > 0) {
        resumeToast = true;
        toast.className = 'ss-toast';
        toast.appendChild(createIcon(d.doc, 'history', '#4FA8FF', 'ss-toast__icon'));
        toast.appendChild(h(d.doc, 'div', { className: 'ss-toast__text' }, [
          h(d.doc, 'div', { className: 'ss-toast__title', text: t('vod.resumingAt', { t: formatTime(start) }) }),
          h(d.doc, 'div', { className: 'ss-toast__body', text: t('vod.resumeRestart') })
        ]));
        toastTimer = d.setTimer(function () { toastTimer = null; hideToast(); }, TOAST_MS);
      }
      tickTimer = d.setTimer(tick, 1000);
    },
    onShow: function () { /* nothing */ },
    onHide: function () { save(false); ctl.stop(); },
    onKey: function (e: RemoteKeyEvent) {
      const phase = ctl.state().phase;
      if (promptOpen && (e.key === 'left' || e.key === 'right' || e.key === 'ok')) {
        // The prompt takes ←/→/OK; other keys (pause, ▲▼, info) still work on the playing episode.
        if (e.key === 'ok') { if (promptBtn === 0) { playNext(); } else { closePrompt(); showBar(true); } } else { promptBtn = e.key === 'left' ? 0 : 1; paintPrompt(); }
        return true;
      }
      if (sheet.isOpen()) {
        const r = sheet.key(e.key);
        if (r === 'close') {
          sheet.close();
          showBar(true);
        } else if (r) {
          ctl.selectTrack(r.kind, r.id);
          if (r.kind === 'audio') { audioApplied = true; } else { textApplied = true; }
          if (d.trackPrefs) {
            if (r.kind === 'audio') { d.trackPrefs.set({ audio: r.language }); } else { d.trackPrefs.set({ text: r.id < 0 ? '' : r.language }); }
          }
          sheet.update(ctl.tracks());
        }
        return true;
      }
      switch (e.key) {
        case 'ok':
          if (phase === 'error') {
            ctl.retry();
          } else if (zone === 'buttons') {
            if (btn === 0) { seekBy(-10000); } else if (btn === 2) { seekBy(10000); } else if (btn === 3) { sheet.open(ctl.tracks()); } else { ctl.togglePause(); }
          } else if (scrubbing) {
            // Jump to the cursor.
            const to = scrubMs;
            endScrub();
            ctl.seekTo(to);
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
        case 'left':
        case 'right':
          if (zone === 'buttons') {
            btn = Math.max(0, Math.min(3, btn + (e.key === 'left' ? -1 : 1)));
            paintFocus();
            showBar(true);
            return true;
          }
          if (e.key === 'left' && resumeToast) {
            hideToast();
            // Start over: a seek where the stream allows it, else the title is opened again from 0.
            if (ctl.state().seekable) { ctl.seekTo(0); } else { ctl.play(p.ref, 0); }
            showBar(true);
            return true;
          }
          scrubBy((e.key === 'left' ? -1 : 1) * seekStep(e.heldMs));
          return true;
        case 'rewind':
        case 'fastForward':
          scrubBy((e.key === 'rewind' ? -1 : 1) * seekStep(e.heldMs));
          return true;
        case 'down':
          endScrub();
          if (bar.className.indexOf('is-hidden') < 0) { zone = 'buttons'; btn = 1; paintFocus(); }
          showBar(true);
          return true;
        case 'up':
          zone = 'scrub';
          paintFocus();
          showBar(true);
          return true;
        case 'info':
          showBar(true);
          return true;
        default:
          return false;
      }
    },
    onBack: function () {
      if (promptOpen) {
        closePrompt(); // Cancel: stays on the ended episode; Back again returns to the series
        showBar(true);
        return true;
      }
      if (scrubbing) {
        // Cancel: playback was never changed.
        endScrub();
        showBar(true);
        return true;
      }
      if (sheet.isOpen()) {
        sheet.close();
        showBar(true);
        return true;
      }
      save(false);
      ctl.stop();
      return false; // router pops back to the details screen
    },
    destroy: function () {
      alive = false;
      setPlaying(false);
      if (barTimer !== null) { d.clearTimer(barTimer); }
      if (tickTimer !== null) { d.clearTimer(tickTimer); }
      if (toastTimer !== null) { d.clearTimer(toastTimer); }
      if (offState) { offState(); }
      if (offLife) { offLife(); }
      ctl.destroy();
    },
    controller: function () { return ctl; }
  };
}
