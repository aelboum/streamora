// Left navigation rail for section screens (Design System "Rail", Handover §4): collapsed 120 wide
// with the Signal Play mark and icon items; when it has focus it expands to 380 with labels.
// The current section is tinted; unavailable sections (Search and Live without an account; Movies/Series
// without an Xtream account) are shown at 40 % opacity and skipped by focus.
// Focus is driven by the owning screen through size()/setFocused()/select().
import type { Router } from '../navigation/router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { Translate } from '../i18n/strings.ts';
import { openSection, sectionAvailable } from '../screens/sections.ts';
import type { SectionId } from '../screens/sections.ts';
import { createIcon, createMark, setIcon } from './brand.ts';
import { h } from '../utils/dom.ts';

const ITEMS: Array<{ id: SectionId; icon: string; label: string }> = [
  { id: 'home', icon: 'home', label: 'nav.home' },
  { id: 'live', icon: 'live', label: 'nav.live' },
  { id: 'movies', icon: 'movie', label: 'nav.movies' },
  { id: 'series', icon: 'series', label: 'nav.series' },
  { id: 'search', icon: 'search', label: 'nav.search' },
  { id: 'favourites', icon: 'star', label: 'nav.favourites' },
  { id: 'settings', icon: 'settings', label: 'nav.settings' }
];

const GREY = '#8A93A6';
const BLUE = '#4FA8FF';
const DARK = '#080C18';

export interface Rail {
  readonly element: HTMLElement;
  /** Focusable (available) items. */
  size(): number;
  /** Index of the current section among the focusable items (focus target when entering). */
  currentIndex(): number;
  setFocused(index: number, focused: boolean): void;
  /** Expanded (labels shown) while the rail has focus. */
  setOpen(open: boolean): void;
  /** Opens the section. Returns false for the current section (the screen just closes the rail). */
  select(index: number): boolean;
}

interface Item { id: SectionId; root: HTMLElement; icon: HTMLElement; name: string; enabled: boolean }

export function createRail(doc: Document, t: Translate, current: SectionId, nav: Router, playlists: PlaylistService): Rail {
  const items: Item[] = [];
  const box = h(doc, 'div', { className: 'ss-rail__items' });
  for (let i = 0; i < ITEMS.length; i++) {
    const it = ITEMS[i];
    const enabled = it.id === current || sectionAvailable(nav, playlists, it.id);
    const icon = createIcon(doc, it.icon, '', 'ss-rail__icon');
    const root = h(doc, 'div', { className: 'ss-rail__item', attrs: { 'data-section': it.id } }, [icon, h(doc, 'div', { className: 'ss-rail__label', text: t(it.label) })]);
    items.push({ id: it.id, root: root, icon: icon, name: it.icon, enabled: enabled });
    box.appendChild(root);
  }
  const element = h(doc, 'div', { className: 'ss-rail' }, [createMark(doc, 'ss-mark--56'), box]);
  const enabledItems: Item[] = items.filter(function (x) { return x.enabled; });
  let focused = -1;

  function paint(): void {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const f = focused >= 0 && enabledItems[focused] === it;
      const cur = it.id === current;
      it.root.className = 'ss-rail__item' + (f ? ' is-focused' : '') + (cur ? ' is-current' : '') + (it.enabled ? '' : ' is-disabled');
      setIcon(it.icon, it.name, f ? DARK : cur ? BLUE : GREY);
    }
  }
  paint();

  return {
    element: element,
    size: function () { return enabledItems.length; },
    currentIndex: function () {
      for (let i = 0; i < enabledItems.length; i++) {
        if (enabledItems[i].id === current) { return i; }
      }
      return 0;
    },
    setFocused: function (index, f) {
      if (f) { focused = index; } else if (focused === index) { focused = -1; }
      paint();
    },
    setOpen: function (open) {
      element.className = 'ss-rail' + (open ? ' is-open' : '');
    },
    select: function (index) {
      const it = enabledItems[index];
      if (!it || it.id === current) {
        return false;
      }
      return openSection(nav, playlists, it.id, false);
    }
  };
}
