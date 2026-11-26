// S1: About screen, opened from Settings → "About ScreenShelf". Read-only: version, platform,
// screen, storage and the font licences. No buttons; Back (router) returns to Settings, which
// keeps its focus on the About row. Fits the fixed 1080 px TV frame (a handful of rows).
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { Translate } from '../i18n/strings.ts';
import { h } from '../utils/dom.ts';

export interface AboutDeps {
  doc: Document;
  t: Translate;
  /** Label / value rows (version, platform, screen, storage, licences). */
  lines: () => Array<{ label: string; value: string }>;
}

export function createAboutScreen(d: AboutDeps, _nav: Router): Screen {
  let list: HTMLElement | null = null;

  function render(): void {
    if (!list) { return; }
    while (list.firstChild) { list.removeChild(list.firstChild); }
    const lines = d.lines();
    for (let i = 0; i < lines.length; i++) {
      list.appendChild(h(d.doc, 'dt', { text: lines[i].label }));
      list.appendChild(h(d.doc, 'dd', { text: lines[i].value }));
    }
  }

  return {
    mount: function (layer: HostLayer) {
      list = h(d.doc, 'dl', { className: 'ss-details ss-details--diag ss-about__list' });
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-shell ss-about' }, [
        h(d.doc, 'header', { className: 'ss-header' }, [
          h(d.doc, 'h1', { className: 'ss-title', text: 'EliteStream' }),
          h(d.doc, 'div', { className: 'ss-subtitle', text: d.t('set.about') })
        ]),
        h(d.doc, 'div', { className: 'ss-panel ss-about__panel' }, [list]),
        h(d.doc, 'div', { className: 'ss-about__hint', text: d.t('about.back') })
      ]));
      render();
    },
    onShow: function () { render(); },
    onHide: function () { /* nothing to pause */ },
    // Nothing to focus or select: every key except Back (handled by the router) is ignored.
    onKey: function (_e: RemoteKeyEvent) { return false; },
    onBack: function () { return false; },
    destroy: function () { list = null; }
  };
}
