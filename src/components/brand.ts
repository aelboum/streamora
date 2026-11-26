// EliteStream brand mark ("Signal Play", Claude Design "EliteStream Logo" option 3a) and icons.
// The mark is an SVG data URI shown through <img> (Tizen 3.0 renders SVG images; no SVG DOM is
// needed). Its geometry is copied exactly from the design file; production artwork still has to
// come from a brand designer (Handover §14).
// Icons use the bundled Material Symbols Rounded subset (fonts/MaterialSymbolsRounded-subset.woff2,
// FILL 1, weight 400), as in the design files: a <span> whose text is the ligature name.
// Only the glyphs listed in ICONS exist in the subset; adding one means regenerating the font.
import { h } from '../utils/dom.ts';

const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3FC6FF"/><stop offset="1" stop-color="#1F6FE0"/></linearGradient></defs>' +
  '<path d="M20 24 L20 76 L58 50 Z" fill="url(#g)" stroke="url(#g)" stroke-width="8" stroke-linejoin="round"/>' +
  '<path d="M67.9 40.1 A14 14 0 0 1 67.9 59.9" fill="none" stroke="#4FA8FF" stroke-width="8" stroke-linecap="round"/>' +
  '<path d="M76.4 31.6 A26 26 0 0 1 76.4 68.4" fill="none" stroke="#3FC6FF" stroke-width="8" stroke-linecap="round"/>' +
  '</svg>';

export const MARK_URI = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(MARK_SVG);

/** App icon name → Material Symbols ligature (all present in the bundled subset). */
const ICONS: Record<string, string> = {
  home: 'home',
  live: 'live_tv',
  movie: 'movie',
  series: 'video_library',
  search: 'search',
  star: 'star',
  settings: 'settings',
  add: 'add',
  person: 'person',
  sync: 'sync',
  warning: 'warning',
  filter: 'filter_list',
  play: 'play_arrow',
  pause: 'pause',
  replay10: 'replay_10',
  forward10: 'forward_10',
  replay: 'replay',
  check: 'check',
  checkCircle: 'check_circle',
  subtitles: 'closed_caption',
  audio: 'graphic_eq',
  audiotrack: 'audiotrack',
  lock: 'lock',
  lockOpen: 'lock_open',
  backspace: 'backspace',
  tv: 'tv',
  list: 'format_list_bulleted',
  next: 'skip_next',
  info: 'info',
  translate: 'translate',
  storage: 'storage',
  dns: 'dns',
  chevron: 'chevron_right',
  history: 'history',
  schedule: 'schedule',
  calendar: 'calendar_month'
};

export function iconNames(): string[] {
  return Object.keys(ICONS);
}

/** Changes an icon element's glyph and (optionally) colour. */
export function setIcon(el: HTMLElement, name: string, color?: string): void {
  const glyph = ICONS[name] || '';
  if (el.textContent !== glyph) { el.textContent = glyph; }
  if (color !== undefined) { el.style.color = color; }
}

/** Icon element; className sets its size (font-size). An empty color inherits from the parent. */
export function createIcon(doc: Document, name: string, color: string, className: string): HTMLElement {
  const el = h(doc, 'span', { className: 'ss-ms ' + className, text: ICONS[name] || '' });
  if (color) { el.style.color = color; }
  return el;
}

/** The Signal Play mark at the size given by className (e.g. ss-mark--56). */
export function createMark(doc: Document, className: string): HTMLElement {
  return h(doc, 'img', { className: 'ss-mark ' + className, attrs: { src: MARK_URI, alt: '' } });
}

/** Mark + two-line ELITE / STREAM wordmark (Home header). */
export function createLockup(doc: Document): HTMLElement {
  return h(doc, 'div', { className: 'ss-lockup' }, [
    createMark(doc, 'ss-mark--64'),
    h(doc, 'div', { className: 'ss-lockup__word' }, [
      h(doc, 'div', { className: 'ss-lockup__elite', text: 'ELITE' }),
      h(doc, 'div', { className: 'ss-lockup__stream', text: 'STREAM' })
    ])
  ]);
}
