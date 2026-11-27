// AI-02: enter details with the phone (QR), end-to-end encrypted. docs/AI-02-PHONE-PAIRING.md.
// Used for an AI provider API key (Settings → AI Intelligence → "<provider> API key with phone (QR)")
// and for an Xtream login (Add Xtream account → "Fill in with phone (QR)"); a PairPurpose says what
// is expected and what happens with it.
//   1. A fresh key pair per code (pair-crypto.ts); the QR code holds the pairing page address with
//      the TV PUBLIC key and the kind in the URL fragment.
//   2. The TV polls the relay (GET /v1/s/<sid>) every 2 s for at most 5 minutes.
//   3. A sealed envelope arrives: decrypted here, the secret key is wiped at once. The purpose
//      validates it; the screen shows the 6-digit check code (the phone shows the same) and a
//      masked summary; Discard is focused.
//   4. Only the confirm button hands the details on (key: secure key store; Xtream: the form).
// Secrets are never shown in full, logged or sent anywhere. Back, Cancel, expiry and leaving the
// screen end the session at the relay (best effort) and wipe the secret key.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { Translate } from '../i18n/strings.ts';
import type { AiHttpClient } from '../api/ai-http-client.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import type { ButtonList } from '../components/button-list.ts';
import { qrImage } from '../components/qr-code.ts';
import { clear, h } from '../utils/dom.ts';
import { createPairSession, MAX_ENVELOPE_CHARS, PAIR_TTL_MS, pairUrl } from '../ai/pairing/pair-crypto.ts';
import type { PairSession } from '../ai/pairing/pair-crypto.ts';

export const PHONE_PAIR_SCREEN = 'ai-phone-pair';
/** Largest QR image (px of the 1920×1080 layout); the code uses a whole number of px per module. */
const QR_MAX_PX = 560;

/** What a pairing screen expects from the phone and what it does with it. */
export interface PairPurpose {
  /** Kind in the QR link and in the payload ("gemini", "xtream"). */
  kind: string;
  title: string;
  intro: string;
  confirmLabel: string;
  /** Validates the decrypted payload. On success: a masked summary and the action for the confirm button. */
  accept(data: Record<string, unknown>): { ok: true; summary: string; commit: () => Promise<void> } | { ok: false; note: string };
  /** Text after commit; null closes the screen right after commit (another screen takes over). */
  savedText: string | null;
  /** Shown when commit fails. */
  failText: string;
}

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

type State = 'waiting' | 'unreachable' | 'received' | 'saving' | 'saved' | 'expired' | 'failed' | 'cancelled';

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
  const t = d.t;
  const purpose = d.purpose;
  let session: PairSession | null = null;
  let started = 0;
  let state: State = 'waiting';
  let failNote = '';
  let pending: { summary: string; commit: () => Promise<void> } | null = null;
  let code = '';
  let pollTimer: unknown = null;
  let tickTimer: unknown = null;
  let inflight: { abort(): void } | null = null;
  let alive = true;

  const img = h(d.doc, 'img', { className: 'ss-pair__qr', attrs: { alt: '' } }) as HTMLImageElement;
  img.style.display = 'block';
  img.style.margin = '8px auto 12px auto';
  const hint = h(d.doc, 'div', { className: 'ss-pair__hint' });
  hint.style.fontSize = '28px';
  hint.style.textAlign = 'center';
  const big = h(d.doc, 'div', { className: 'ss-pair__code' });
  big.style.fontSize = '64px';
  big.style.textAlign = 'center';
  big.style.letterSpacing = '0.1em';
  const timeLine = h(d.doc, 'div', { className: 'ss-pair__time' });
  timeLine.style.fontSize = '26px';
  timeLine.style.textAlign = 'center';
  const status = h(d.doc, 'div', { className: 'ss-message ss-pair__status' });
  const btnBox = h(d.doc, 'div', { className: 'ss-pair__buttons' });
  let buttons: ButtonList = createButtonList(d.doc, [], true);
  let actions: Array<() => void> = [];
  const focus = createFocusManager(function (_z, index, focused) { buttons.setFocused(index, focused); });
  focus.register({ id: 'buttons', kind: 'row', size: function () { return buttons.size(); }, neighbours: {}, onSelect: function (i) { if (actions[i]) { actions[i](); } } });

  function setButtons(list: Array<{ label: string; run: () => void }>): void {
    clear(btnBox);
    const labels: string[] = [];
    actions = [];
    for (let i = 0; i < list.length; i++) { labels.push(list[i].label); actions.push(list[i].run); }
    buttons = createButtonList(d.doc, labels, true);
    btnBox.appendChild(buttons.element);
    focus.focus('buttons', 0);
    buttons.setFocused(0, true); // new elements: the focus manager skips an unchanged position
  }

  function stopTimers(): void {
    if (pollTimer !== null) { d.clearTimer(pollTimer); pollTimer = null; }
    if (tickTimer !== null) { d.clearTimer(tickTimer); tickTimer = null; }
    if (inflight) { const f = inflight; inflight = null; f.abort(); }
  }

  function endSession(notifyRelay: boolean): void {
    if (session) {
      if (notifyRelay) { d.http.request({ method: 'POST', url: d.baseUrl + '/v1/s/' + session.sid + '/cancel', timeoutMs: 5000, maxChars: 200 }); }
      session.wipe();
      session = null;
    }
  }

  function render(): void {
    const waiting = state === 'waiting' || state === 'unreachable';
    const review = state === 'received' || state === 'saving';
    img.style.display = waiting ? 'block' : 'none';
    big.style.display = review ? 'block' : 'none';
    const left = Math.max(0, PAIR_TTL_MS - (d.now() - started));
    const mm = Math.floor(left / 60000);
    const ss = Math.floor((left % 60000) / 1000);
    timeLine.textContent = waiting ? t('pair.expires', { time: mm + ':' + (ss < 10 ? '0' : '') + ss }) : '';
    hint.textContent = waiting ? t('pair.scan') : review ? t('pair.checkCode') : '';
    big.textContent = code;
    status.className = 'ss-message ss-pair__status' + (state === 'saved' ? ' ss-tone--ok' : state === 'waiting' || review ? '' : ' ss-tone--error');
    status.textContent =
      state === 'waiting' ? t('pair.waiting') :
      state === 'unreachable' ? t('pair.unreachable') :
      state === 'received' ? (pending ? pending.summary : '') :
      state === 'saving' ? t('pair.saving') :
      state === 'saved' ? (purpose.savedText || '') :
      state === 'expired' ? t('pair.expired') :
      state === 'failed' ? failNote :
      t('pair.cancelled');
  }

  function retryButtons(): void {
    setButtons([{ label: t('common.cancel'), run: close }, { label: t('pair.newCode'), run: fresh }]);
  }

  function fail(note: string): void {
    stopTimers();
    endSession(false);
    pending = null;
    state = 'failed';
    failNote = note;
    retryButtons();
    render();
  }

  function received(env: unknown): void {
    if (!session) { return; }
    const r = session.openRaw(env);
    stopTimers();
    endSession(false); // the relay deleted the envelope when it handed it over; wipe the secret key now
    if (!r.ok) { fail(t('pair.openFailed')); return; }
    const a = purpose.accept(r.data);
    if (!a.ok) { fail(a.note); return; }
    pending = { summary: a.summary, commit: a.commit };
    code = r.code;
    state = 'received';
    setButtons([{ label: t('pair.discard'), run: discard }, { label: purpose.confirmLabel, run: save }]);
    render();
  }

  function poll(): void {
    pollTimer = null;
    if (!alive || !session || (state !== 'waiting' && state !== 'unreachable')) { return; }
    const s = session;
    const req = d.http.request({ method: 'GET', url: d.baseUrl + '/v1/s/' + s.sid, timeoutMs: 10000, maxChars: MAX_ENVELOPE_CHARS + 200 });
    inflight = req;
    req.promise.then(function (res) {
      if (inflight === req) { inflight = null; }
      if (!alive || session !== s || (state !== 'waiting' && state !== 'unreachable')) { return; }
      const j = res.ok ? res.json as { state?: string; env?: unknown } : null;
      if (j && j.state === 'ready') { received(j.env); return; }
      if (j && (j.state === 'expired' || j.state === 'cancelled' || j.state === 'delivered')) { expire(); return; }
      state = j && j.state === 'waiting' ? 'waiting' : 'unreachable';
      render();
      pollTimer = d.setTimer(poll, d.pollMs || 2000);
    });
  }

  function expire(): void {
    stopTimers();
    endSession(true);
    state = 'expired';
    retryButtons();
    render();
  }

  function tick(): void {
    tickTimer = null;
    if (!alive) { return; }
    if ((state === 'waiting' || state === 'unreachable') && d.now() - started >= PAIR_TTL_MS) { expire(); return; }
    render();
    if (state === 'waiting' || state === 'unreachable') { tickTimer = d.setTimer(tick, 1000); }
  }

  function fresh(): void {
    stopTimers();
    endSession(state === 'waiting' || state === 'unreachable');
    pending = null;
    code = '';
    session = createPairSession(purpose.kind);
    started = d.now();
    state = 'waiting';
    const q = qrImage(pairUrl(d.baseUrl, session), QR_MAX_PX, 'L');
    img.style.width = q.px + 'px';
    img.style.height = q.px + 'px';
    img.setAttribute('src', q.uri);
    retryButtons();
    render();
    poll();
    tickTimer = d.setTimer(tick, 1000);
  }

  function discard(): void {
    pending = null;
    code = '';
    state = 'cancelled';
    close();
  }

  function save(): void {
    if (state !== 'received' || !pending) { return; }
    const p = pending;
    pending = null;
    state = 'saving';
    render();
    p.commit().then(function () {
      if (!alive) { return; }
      state = 'saved';
      code = '';
      if (purpose.savedText === null) { close(); return; }
      setButtons([{ label: t('pair.done'), run: close }]);
      render();
    }, function () {
      if (!alive) { return; }
      fail(purpose.failText);
    });
  }

  /** Ends everything: relay session (best effort), timers, secret key, pending details. */
  function shutdown(): void {
    const open = state === 'waiting' || state === 'unreachable';
    stopTimers();
    endSession(open);
    pending = null;
    if (state !== 'saved') { state = 'cancelled'; }
  }

  function close(): void {
    shutdown();
    nav.pop();
  }

  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-set ss-pair' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [h(d.doc, 'div', { className: 'ss-live__title', text: purpose.title })]),
        h(d.doc, 'div', { className: 'ss-message', text: purpose.intro }),
        h(d.doc, 'div', { className: 'ss-pair__box' }, [img, hint, big, timeLine]),
        status, btnBox
      ]));
      fresh();
    },
    onShow: function () { /* static */ },
    onHide: function () { /* keeps running while an overlay is open */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right') { focus.move(e.key); }
      else if (e.key === 'ok') { focus.select(); }
      return true;
    },
    onBack: function () { shutdown(); return false; }, // the router closes the screen
    destroy: function () { alive = false; shutdown(); }
  };
}
