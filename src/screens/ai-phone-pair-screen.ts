// AI-02: enter details with the phone (QR), end-to-end encrypted, full screen.
// docs/AI-02-PHONE-PAIRING.md. Used for an AI provider API key (Settings → AI Intelligence →
// "<provider> API key with phone (QR)") and for the Edit playlist forms ("Fill in with phone (QR)").
// The Add M3U / Add Xtream forms embed the same panel next to their fields instead. The pairing
// logic lives in components/pair-panel.ts; this screen adds the title, the intro and the focus.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { Translate } from '../i18n/strings.ts';
import type { AiHttpClient } from '../api/ai-http-client.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createPairPanel } from '../components/pair-panel.ts';
import type { PairPanel, PairPurpose } from '../components/pair-panel.ts';
import { h } from '../utils/dom.ts';

export type { PairPurpose } from '../components/pair-panel.ts';

export const PHONE_PAIR_SCREEN = 'ai-phone-pair';
/** Largest QR image (px of the 1920×1080 layout); the code uses a whole number of px per module. */
const QR_MAX_PX = 560;

export interface PhonePairDeps {
  doc: Document;
  t: Translate;
  /** AI HTTP client whose allow-list holds the pairing relay origin. */
  http: AiHttpClient;
  /** https origin of the pairing relay (AI_PAIRING_URL). */
  baseUrl: string;
  purpose: PairPurpose;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  pollMs?: number;
}

/** "AIza…Wx9Q": enough to recognise, not enough to use. */
export function maskKey(key: string): string {
  if (key.length <= 12) { return '…'; }
  return key.substring(0, 4) + '…' + key.substring(key.length - 4);
}

/** API key for an AI provider: stored in the secure key store after confirmation. */
export function keyPurpose(t: Translate, o: {
  provider: string; providerName: string; validKey: (key: string) => boolean; saveKey: (key: string) => Promise<void>; onSaved: () => void;
}): PairPurpose {
  return {
    kind: o.provider,
    title: t('pair.title', { provider: o.providerName }),
    intro: t('pair.intro'),
    confirmLabel: t('pair.save'),
    savedText: t('pair.saved', { provider: o.providerName }),
    failText: t('ai.keyNotSaved'),
    accept: function (data) {
      if (data.p !== o.provider) { return { ok: false, note: t('pair.wrongProvider') }; }
      const key = typeof data.k === 'string' ? data.k.replace(/^\s+|\s+$/g, '') : '';
      data.k = '';
      if (!key) { return { ok: false, note: t('pair.openFailed') }; }
      if (!o.validKey(key)) { return { ok: false, note: t('ai.keyInvalidFormat') }; }
      return {
        ok: true,
        summary: t('pair.received', { key: maskKey(key), length: key.length }),
        commit: function () { return o.saveKey(key).then(function () { o.onSaved(); }); }
      };
    }
  };
}

export function createPhonePairScreen(d: PhonePairDeps, nav: Router): Screen {
  let closed = false;
  // eslint-disable-next-line prefer-const
  let panel: PairPanel;
  const focus = createFocusManager(function (_z, index, focused) { panel.setFocused(index, focused); });
  focus.register({ id: 'buttons', kind: 'row', size: function () { return panel.size(); }, neighbours: {}, onSelect: function (i) { panel.select(i); } });

  function close(): void {
    if (closed) { return; }
    closed = true;
    panel.shutdown();
    nav.pop();
  }

  panel = createPairPanel({
    doc: d.doc, t: d.t, http: d.http, baseUrl: d.baseUrl, purpose: d.purpose, now: d.now,
    setTimer: d.setTimer, clearTimer: d.clearTimer, pollMs: d.pollMs, qrMaxPx: QR_MAX_PX, embedded: false
  }, {
    close: close,
    buttonsChanged: function () {
      focus.focus('buttons', 0);
      panel.setFocused(0, true); // new elements: the focus manager skips an unchanged position
    }
  });

  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-set ss-pair' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [h(d.doc, 'div', { className: 'ss-live__title', text: d.purpose.title })]),
        h(d.doc, 'div', { className: 'ss-message', text: d.purpose.intro }),
        panel.element
      ]));
      panel.start();
    },
    onShow: function () { /* static */ },
    onHide: function () { /* keeps running while an overlay is open */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right') { focus.move(e.key); }
      else if (e.key === 'ok') { focus.select(); }
      return true;
    },
    onBack: function () { closed = true; panel.shutdown(); return false; }, // the router closes the screen
    destroy: function () { closed = true; panel.destroy(); }
  };
}
