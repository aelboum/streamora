// Foundation root screen: shows platform facts, capabilities, warnings and recent log entries.
// It is the only real screen until Stage 4 (onboarding/playlists) replaces it as the root.
//
// DI-1.1 layout (fix after the TV check): the 1080 px TV page cannot scroll by itself, so the
// actions sit at the top, "top" sections (playlist storage) come first where they are always
// visible, and everything below scrolls with ▲▼ inside a clipped viewport.
import type { HostLayer, Screen, Router } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { clear, h } from '../utils/dom.ts';

export interface DiagnosticsSection {
  title: string;
  lines: Array<{ label: string; value: string }>;
  /** Plain text rows (e.g. recent storage events). */
  rows?: string[];
  /** 'top': shown first, above the platform facts (always visible). Default: below them. */
  position?: 'top' | 'bottom';
}

export interface DiagnosticsData {
  title: string;
  lines(): Array<{ label: string; value: string }>;
  recentLog(): string[];
  /** DI-1.1: further read-only sections (playlist storage, storage events). */
  sections?(): DiagnosticsSection[];
  /** DI-1.1: re-reads data that needs I/O (read-only); the screen renders again when it resolves. */
  refresh?(): Promise<void>;
}

/** Distance moved by one ▲/▼ press (px). */
export const DIAG_SCROLL_STEP = 300;

export function createDiagnosticsScreen(doc: Document, data: DiagnosticsData, nav: Router): Screen {
  let details: HTMLElement | null = null;
  let logView: HTMLElement | null = null;
  let extraTop: HTMLElement | null = null;
  let extraBottom: HTMLElement | null = null;
  let viewport: HTMLElement | null = null;
  let inner: HTMLElement | null = null;
  let offset = 0;
  let alive = true;
  /** DI-1.1: re-read (read-only), then render; shown immediately with what is known. */
  function reload(): void {
    render();
    if (!data.refresh) { return; }
    data.refresh().then(function () { if (alive) { render(); } }, function () { if (alive) { render(); } });
  }
  const buttons = createButtonList(doc, ['Refresh', 'Exit'], true);
  const focus = createFocusManager(function (_zone, index, focused) { buttons.setFocused(index, focused); });
  focus.register({
    id: 'actions',
    kind: 'row',
    size: function () { return buttons.size(); },
    neighbours: {},
    onSelect: function (i) {
      if (i === 0) {
        reload();
      } else {
        nav.openOverlay('exit-dialog');
      }
    }
  });

  function scrollBy(dir: number): void {
    if (!viewport || !inner) { return; }
    const total = inner.offsetHeight;
    const visible = viewport.offsetHeight;
    const max = typeof total === 'number' && typeof visible === 'number' ? Math.max(0, total - visible) : 0;
    offset = Math.max(0, Math.min(max, offset + dir * DIAG_SCROLL_STEP));
    inner.style.top = (-offset) + 'px';
  }

  function section(s: DiagnosticsSection): HTMLElement {
    const dl = h(doc, 'dl', { className: 'ss-details ss-details--diag' });
    for (let m = 0; m < s.lines.length; m++) {
      dl.appendChild(h(doc, 'dt', { text: s.lines[m].label }));
      dl.appendChild(h(doc, 'dd', { text: s.lines[m].value }));
    }
    const rows = h(doc, 'div', { className: 'ss-log' });
    const list = s.rows || [];
    for (let n = 0; n < list.length; n++) {
      rows.appendChild(h(doc, 'div', { className: 'ss-log__line', text: list[n] }));
    }
    return h(doc, 'div', { className: 'ss-panel ss-diag-section' }, [h(doc, 'div', { className: 'ss-panel__label', text: s.title }), dl, rows]);
  }

  function render(): void {
    if (!details || !logView || !extraTop || !extraBottom) {
      return;
    }
    clear(details);
    const lines = data.lines();
    for (let i = 0; i < lines.length; i++) {
      details.appendChild(h(doc, 'dt', { text: lines[i].label }));
      details.appendChild(h(doc, 'dd', { text: lines[i].value }));
    }
    clear(extraTop);
    clear(extraBottom);
    const secs = data.sections ? data.sections() : [];
    for (let k = 0; k < secs.length; k++) {
      (secs[k].position === 'top' ? extraTop : extraBottom).appendChild(section(secs[k]));
    }
    clear(logView);
    const log = data.recentLog();
    for (let j = 0; j < log.length; j++) {
      logView.appendChild(h(doc, 'div', { className: 'ss-log__line', text: log[j] }));
    }
  }

  return {
    mount: function (layer: HostLayer) {
      const root = layer.element as HTMLElement;
      details = h(doc, 'dl', { className: 'ss-details' });
      logView = h(doc, 'div', { className: 'ss-log' });
      extraTop = h(doc, 'div', { className: 'ss-diag-top' });
      extraBottom = h(doc, 'div', { className: 'ss-diag-bottom' });
      inner = h(doc, 'div', { className: 'ss-diag-scroll__inner' }, [
        extraTop,
        h(doc, 'div', { className: 'ss-panel ss-diag-section' }, [details]),
        extraBottom,
        logView
      ]);
      viewport = h(doc, 'div', { className: 'ss-diag-scroll' }, [inner]);
      root.appendChild(h(doc, 'div', { className: 'ss-shell' }, [
        h(doc, 'header', { className: 'ss-header' }, [
          h(doc, 'h1', { className: 'ss-title', text: 'ScreenShelf' }),
          h(doc, 'div', { className: 'ss-subtitle', text: data.title })
        ]),
        h(doc, 'div', { className: 'ss-diag-actions' }, [buttons.element]),
        viewport
      ]));
      reload();
      focus.focus('actions', 0);
    },
    onShow: function () { render(); },
    onHide: function () { /* nothing to pause */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'up' || e.key === 'down') {
        // The actions are a single row: ▲▼ scroll the content instead.
        scrollBy(e.key === 'down' ? 1 : -1);
        return true;
      }
      if (e.key === 'left' || e.key === 'right') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      return false;
    },
    onBack: function () { return false; },
    destroy: function () {
      alive = false;
      details = null;
      logView = null;
      extraTop = null;
      extraBottom = null;
      viewport = null;
      inner = null;
    }
  };
}
