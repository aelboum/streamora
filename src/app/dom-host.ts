// DOM implementation of the router's ScreenHost: one absolutely positioned layer per screen.
import type { HostLayer, ScreenHost } from '../navigation/router.ts';
import { h } from '../utils/dom.ts';

export function createDomHost(doc: Document, root: HTMLElement): ScreenHost {
  return {
    createLayer: function (id, overlay) {
      const el = h(doc, 'div', { className: 'ss-layer' + (overlay ? ' ss-layer--overlay' : ''), attrs: { 'data-layer': id } });
      el.style.display = 'none';
      root.appendChild(el);
      const layer: HostLayer = {
        element: el,
        show: function () { el.style.display = ''; },
        hide: function () { el.style.display = 'none'; },
        remove: function () {
          if (el.parentNode) {
            el.parentNode.removeChild(el);
          }
        }
      };
      return layer;
    }
  };
}
