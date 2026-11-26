// Exit confirmation overlay. Default focus is "No" so a stray OK never quits.
import type { HostLayer, Screen, Router } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { h } from '../utils/dom.ts';

export function createExitDialog(doc: Document, nav: Router, exitApp: () => void): Screen {
  const buttons = createButtonList(doc, ['No', 'Yes, exit'], true);
  const focus = createFocusManager(function (_zone, index, focused) { buttons.setFocused(index, focused); });
  focus.register({
    id: 'choice',
    kind: 'row',
    size: function () { return buttons.size(); },
    neighbours: {},
    onSelect: function (i) {
      if (i === 1) {
        exitApp();
      } else {
        nav.closeOverlay();
      }
    }
  });
  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(h(doc, 'div', { className: 'ss-dialog' }, [
        h(doc, 'div', { className: 'ss-dialog__title', text: 'Exit EliteStream?' }),
        buttons.element
      ]));
      focus.focus('choice', 0);
    },
    onShow: function () { /* static */ },
    onHide: function () { /* static */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      return true;
    },
    onBack: function () { return false; },
    destroy: function () { /* nothing held */ }
  };
}
