// Foundation root screen: shows platform facts, capabilities, warnings and recent log entries.
// It is the only real screen until Stage 4 (onboarding/playlists) replaces it as the root.
import type { HostLayer, Screen, Router } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { clear, h } from '../utils/dom.ts';

export interface DiagnosticsData {
  title: string;
  lines(): Array<{ label: string; value: string }>;
  recentLog(): string[];
}

export function createDiagnosticsScreen(doc: Document, data: DiagnosticsData, nav: Router): Screen {
  let details: HTMLElement | null = null;
  let logView: HTMLElement | null = null;
  const buttons = createButtonList(doc, ['Refresh', 'Exit'], true);
  const focus = createFocusManager(function (_zone, index, focused) { buttons.setFocused(index, focused); });
  focus.register({
    id: 'actions',
    kind: 'row',
    size: function () { return buttons.size(); },
    neighbours: {},
    onSelect: function (i) {
      if (i === 0) {
        render();
      } else {
        nav.openOverlay('exit-dialog');
      }
    }
  });

  function render(): void {
    if (!details || !logView) {
      return;
    }
    clear(details);
    const lines = data.lines();
    for (let i = 0; i < lines.length; i++) {
      details.appendChild(h(doc, 'dt', { text: lines[i].label }));
      details.appendChild(h(doc, 'dd', { text: lines[i].value }));
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
      root.appendChild(h(doc, 'div', { className: 'ss-shell' }, [
        h(doc, 'header', { className: 'ss-header' }, [
          h(doc, 'h1', { className: 'ss-title', text: 'ScreenShelf' }),
          h(doc, 'div', { className: 'ss-subtitle', text: data.title })
        ]),
        h(doc, 'div', { className: 'ss-panel' }, [details, buttons.element]),
        logView
      ]));
      render();
      focus.focus('actions', 0);
    },
    onShow: function () { render(); },
    onHide: function () { /* nothing to pause */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right' || e.key === 'up' || e.key === 'down') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      return false;
    },
    onBack: function () { return false; },
    destroy: function () {
      details = null;
      logView = null;
    }
  };
}
