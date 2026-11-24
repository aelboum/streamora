// Generic modal dialog: title, text paragraphs, a row of buttons. Used for the HTTP security
// warning and the remove confirmation. The first button gets focus, so callers put the safe
// choice first (Cancel). Back = the safe choice (close).
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { h } from '../utils/dom.ts';

export interface DialogButton {
  label: string;
  /** Runs after the dialog closed. */
  run?: () => void;
}

export interface ConfirmParams {
  title: string;
  paragraphs: string[];
  buttons: DialogButton[];
  /** Extra class, e.g. 'ss-dialog--warning'. */
  variant?: string;
}

export function createConfirmDialog(doc: Document, p: ConfirmParams, nav: Router): Screen {
  const labels: string[] = [];
  for (let i = 0; i < p.buttons.length; i++) {
    labels.push(p.buttons[i].label);
  }
  const buttons = createButtonList(doc, labels, true);
  const focus = createFocusManager(function (_z, index, focused) { buttons.setFocused(index, focused); });
  focus.register({
    id: 'buttons', kind: 'row', size: function () { return buttons.size(); }, neighbours: {},
    onSelect: function (i) {
      const b = p.buttons[i];
      nav.closeOverlay();
      if (b && b.run) {
        b.run();
      }
    }
  });
  return {
    mount: function (layer: HostLayer) {
      const kids: Node[] = [h(doc, 'div', { className: 'ss-dialog__title', text: p.title })];
      for (let i = 0; i < p.paragraphs.length; i++) {
        kids.push(h(doc, 'p', { className: 'ss-dialog__text', text: p.paragraphs[i] }));
      }
      kids.push(buttons.element);
      (layer.element as HTMLElement).appendChild(h(doc, 'div', { className: 'ss-dialog' + (p.variant ? ' ' + p.variant : '') }, kids));
      focus.focus('buttons', 0);
    },
    onShow: function () { /* static */ },
    onHide: function () { /* static */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right') {
        focus.move(e.key);
      } else if (e.key === 'ok') {
        focus.select();
      }
      return true;
    },
    onBack: function () { return false; },
    destroy: function () { /* nothing held */ }
  };
}
