// S3: "Resuming <channel>… Press any key to cancel." — overlay shown for a few seconds before the
// last channel opens at start-up. Every key (Back included) cancels; nothing else happens on a key.
// Reuses the existing toast look (ss-toast, as in the movie/series browser).
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { h } from '../utils/dom.ts';

export interface ResumeToastParams {
  title: string;
  body: string;
  cancel: () => void;
}

export function createResumeToast(doc: Document, p: ResumeToastParams, _nav: Router): Screen {
  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(h(doc, 'div', { className: 'ss-toast ss-toast--resume' }, [
        h(doc, 'div', { className: 'ss-toast__text' }, [
          h(doc, 'div', { className: 'ss-toast__title', text: p.title }),
          h(doc, 'div', { className: 'ss-toast__body', text: p.body })
        ])
      ]));
    },
    onShow: function () { /* static */ },
    onHide: function () { /* static */ },
    onKey: function (_e: RemoteKeyEvent) { p.cancel(); return true; },
    onBack: function () { p.cancel(); return true; },
    destroy: function () { /* nothing held */ }
  };
}
