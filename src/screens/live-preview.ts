// Stage 7E: miniature live preview in the Live TV details column (option (a), approved 2026-11-25).
//
// The TV has ONE AVPlay decoder (webapis.avplay is one player per app). The preview is therefore
// the app's only player shown in the 556×313 slot while the channel list is browsed; nothing plays
// full screen at the same time. Opening a channel (OK) stops the preview first and the full-screen
// player opens the channel itself.
//
// Rules (TV run 2, experiment E4: the window plays real channels, unthrottled zapping never
// reaches a picture):
//   - tuning goes through a LiveController: every change stops the old stream before the next
//     load, late callbacks of an older channel are ignored, the load opens only after the focus
//     has rested (the controller's zap debounce), so rapid ↑↓ opens nothing;
//   - no reconnect loop while browsing: a failed or dropped preview shows the channel logo;
//   - locked adult channels are never previewed (the PIN is asked only when the channel is opened);
//   - stop() releases the decoder, restores the full-screen video rectangle and the opaque page;
//     the controller is destroyed then, so it never reacts to the full-screen player's events.
//
// How the video shows through: AVPlay draws on the video plane behind the page. While the preview
// is active the page background is made transparent (the player's `ss-playing` class) and four
// "ground" strips repaint the app background everywhere except the slot.
import type { Channel } from '../models/content.ts';
import type { PlaybackEngine } from '../player/engine.ts';
import type { LiveController, LiveState } from '../player/live-controller.ts';
import type { Lifecycle } from '../app/lifecycle.ts';
import type { Translate } from '../i18n/strings.ts';
import { h } from '../utils/dom.ts';

export interface LivePreviewDeps {
  doc: Document;
  t: Translate;
  engine: PlaybackEngine;
  lifecycle?: Lifecycle | null;
  /** A controller that tunes after the focus has rested (its zap debounce). */
  createController: () => LiveController;
}

export interface LivePreview {
  /** The 556×313 slot (logo / status while not live; transparent while the picture shows). */
  slot: HTMLElement;
  /** Background strips around the slot; insert as the first child of the screen layer. */
  ground: HTMLElement;
  /** Shows this channel: logo at once, picture after the debounce. allowed=false = logo only. */
  show(ch: Channel | null, allowed: boolean): void;
  /** Releases the decoder and restores full screen + opaque page. Safe to call repeatedly. */
  stop(): void;
  /** Current phase ('idle' when stopped); for tests and dev checks. */
  phase(): string;
  destroy(): void;
}

interface Rect { x: number; y: number; w: number; h: number }
const FULL: Rect = { x: 0, y: 0, w: 1920, h: 1080 };

/** Position in the 1920×1080 layout (offsets, so a CSS scale of the body does not change it). */
function layoutRect(el: HTMLElement): Rect {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n) {
    x += n.offsetLeft || 0;
    y += n.offsetTop || 0;
    n = n.offsetParent as HTMLElement | null;
  }
  return { x: x, y: y, w: el.offsetWidth || 556, h: el.offsetHeight || 313 };
}

export function createLivePreview(d: LivePreviewDeps): LivePreview {
  const logo = h(d.doc, 'img', { className: 'ss-preview__logo', attrs: { alt: '' } });
  logo.addEventListener('error', function () { hasLogo = false; paintSlot(); });
  const note = h(d.doc, 'div', { className: 'ss-preview__note' });
  const slot = h(d.doc, 'div', { className: 'ss-preview' }, [logo, note]);
  const strips: HTMLElement[] = [];
  for (let i = 0; i < 4; i++) { strips.push(h(d.doc, 'div', { className: 'ss-ground__strip' })); }
  const ground = h(d.doc, 'div', { className: 'ss-ground is-hidden' }, strips);

  let ctl: LiveController | null = null;
  let offState: (() => void) | null = null;
  let offLife: (() => void) | null = null;
  let current = '';
  let transparent = false;
  let rect: Rect = FULL;

  function setTransparent(on: boolean): void {
    if (on === transparent) { return; }
    transparent = on;
    const els: Array<HTMLElement | null> = [d.doc.documentElement || null, d.doc.body || null];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el) { el.className = el.className.replace(/ ?ss-playing/g, '') + (on ? ' ss-playing' : ''); }
    }
    ground.className = 'ss-ground' + (on ? '' : ' is-hidden');
  }

  function placeGround(): void {
    rect = layoutRect(slot);
    const r = rect;
    const parts: Rect[] = [
      { x: 0, y: 0, w: 1920, h: r.y },
      { x: 0, y: r.y + r.h, w: 1920, h: 1080 - r.y - r.h },
      { x: 0, y: r.y, w: r.x, h: r.h },
      { x: r.x + r.w, y: r.y, w: 1920 - r.x - r.w, h: r.h }
    ];
    for (let i = 0; i < 4; i++) {
      const s = strips[i].style;
      const p = parts[i];
      s.left = p.x + 'px';
      s.top = p.y + 'px';
      s.width = Math.max(0, p.w) + 'px';
      s.height = Math.max(0, p.h) + 'px';
      // Each strip shows the part of the full-screen background that lies under it.
      s.backgroundPosition = (-p.x) + 'px ' + (-p.y) + 'px';
    }
  }

  function render(s: LiveState): void {
    // 'buffering' / 'paused' only happen after the first picture (the controller reports
    // 'loading' until then), so the picture stays and no logo returns over it.
    live = s.phase === 'playing' || s.phase === 'buffering' || s.phase === 'paused';
    const active = s.phase === 'tuning' || s.phase === 'loading' || s.phase === 'retrying' || live;
    if (active && !transparent) { placeGround(); }
    setTransparent(active);
    if (s.phase === 'loading' || s.phase === 'playing') {
      // Android applies the rectangle only to an open player; AVPlay keeps it for the next open.
      d.engine.setRect(rect.x, rect.y, rect.w, rect.h);
    }
    paintSlot();
    note.textContent = s.phase === 'loading' || s.phase === 'tuning' ? d.t('live.previewLoading')
      : s.phase === 'error' ? d.t('live.previewUnavailable') : '';
  }

  function release(): void {
    if (offState) { offState(); offState = null; }
    if (offLife) { offLife(); offLife = null; }
    if (ctl) { ctl.destroy(); ctl = null; }
    current = '';
    d.engine.setRect(FULL.x, FULL.y, FULL.w, FULL.h);
    setTransparent(false);
    live = false;
    paintSlot();
    note.textContent = '';
  }

  // Stage 7F: the logo is shown and hidden by classes only (an inline `visibility` beat the
  // `.is-live` rule, so the logo stayed over the picture). States:
  //   ss-preview          logo (or empty box) + note: loading, failed, locked, stopped
  //   ss-preview is-live  picture only: logo and note hidden
  //   + no-logo           the channel has no logo or it failed to load
  let hasLogo = false;
  let live = false;

  function paintSlot(): void {
    slot.className = 'ss-preview' + (live ? ' is-live' : '') + (hasLogo ? '' : ' no-logo');
  }

  function setLogo(ch: Channel | null): void {
    const src = ch && ch.logo ? ch.logo : '';
    hasLogo = !!src;
    if (src) {
      if (logo.getAttribute('src') !== src) { logo.setAttribute('src', src); }
    } else {
      logo.removeAttribute('src');
    }
    paintSlot();
  }

  return {
    slot: slot,
    ground: ground,
    show: function (ch, allowed) {
      setLogo(ch);
      if (!ch || !allowed) {
        if (ctl) { release(); }
        return;
      }
      if (ch.id === current) { return; }
      current = ch.id;
      if (!ctl) {
        rect = layoutRect(slot);
        d.engine.setRect(rect.x, rect.y, rect.w, rect.h);
        const c = d.createController();
        ctl = c;
        offState = c.onChange(render);
        offLife = d.lifecycle ? d.lifecycle.on(function (e) {
          if (e === 'hidden') { c.suspend(); }
          if (e === 'visible') { c.restore(); }
        }) : null;
      }
      ctl.select(ch);
    },
    stop: function () {
      if (ctl) { release(); }
    },
    phase: function () { return ctl ? ctl.state().phase : 'idle'; },
    destroy: function () {
      if (ctl) { release(); }
    }
  };
}
