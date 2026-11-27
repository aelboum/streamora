// Phone pairing panel (QR, end-to-end encrypted; docs/AI-02-PHONE-PAIRING.md). Used full-screen by
// the pairing screen (API keys; the Edit playlist forms) and embedded on the left of the Add M3U /
// Add Xtream forms, with the input fields on the right.
//   1. A fresh key pair per code (pair-crypto.ts); the QR code holds the pairing page address with
//      the TV PUBLIC key and the kind in the URL fragment.
//   2. The panel polls the relay (GET /v1/s/<sid>) every 2 s for at most 5 minutes.
//   3. A sealed envelope arrives: decrypted here, the secret key is wiped at once. The purpose
//      validates it; the panel shows the 6-digit check code (the phone shows the same) and a masked
//      summary; Discard is focused.
//   4. Only the confirm button hands the details on (key: secure key store; playlists: the form).
// Secrets are never shown in full, logged or sent anywhere. Cancel, expiry and shutdown end the
// session at the relay (best effort) and wipe the secret key.
import type { Translate } from '../i18n/strings.ts';
import type { AiHttpClient } from '../api/ai-http-client.ts';
import { createButtonList } from './button-list.ts';
import type { ButtonList } from './button-list.ts';
import { qrImage } from './qr-code.ts';
import { clear, h } from '../utils/dom.ts';
import { createPairSession, MAX_ENVELOPE_CHARS, PAIR_TTL_MS, pairUrl } from '../ai/pairing/pair-crypto.ts';
import type { PairSession } from '../ai/pairing/pair-crypto.ts';

/** What a pairing panel expects from the phone and what it does with it. */
export interface PairPurpose {
  /** Kind in the QR link and in the payload ("gemini", "xtream", "m3u"). */
  kind: string;
  title: string;
  intro: string;
  confirmLabel: string;
  /** Validates the decrypted payload. On success: a masked summary and the action for the confirm button. */
  accept(data: Record<string, unknown>): { ok: true; summary: string; commit: () => Promise<void> } | { ok: false; note: string };
  /** Full screen: text after commit; null closes the screen right after commit (another screen takes over). */
  savedText: string | null;
  /** Shown when commit fails. */
  failText: string;
}

export interface PairPanelDeps {
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
  /** Largest QR image in px; the code uses a whole number of px per module. */
  qrMaxPx: number;
  /**
   * Embedded next to a form: no Cancel/Done buttons (the form has its own), Discard and Use keep
   * the panel open with a New code button, and after Use the panel says the form was filled in.
   */
  embedded: boolean;
}

export interface PairPanelEvents {
  /** Full screen only: Cancel, Discard, Done, or Use when the purpose has no saved text. */
  close(): void;
  /** The buttons were rebuilt; focus=true when the host should move the focus to the panel (details arrived). */
  buttonsChanged(focus: boolean): void;
}

export interface PairPanel {
  readonly element: HTMLElement;
  /** Starts a fresh code (also New code). */
  start(): void;
  /** Ends everything: relay session (best effort), timers, secret key, pending details. */
  shutdown(): void;
  /** No further callbacks after this. */
  destroy(): void;
  size(): number;
  setFocused(index: number, focused: boolean): void;
  select(index: number): void;
}

type State = 'waiting' | 'unreachable' | 'received' | 'saving' | 'saved' | 'expired' | 'failed' | 'cancelled';

export function createPairPanel(d: PairPanelDeps, ev: PairPanelEvents): PairPanel {
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
  const element = h(d.doc, 'div', { className: 'ss-pair__panel' }, [h(d.doc, 'div', { className: 'ss-pair__box' }, [img, hint, big, timeLine]), status, btnBox]);
  let buttons: ButtonList = createButtonList(d.doc, [], true);
  let actions: Array<() => void> = [];

  function setButtons(list: Array<{ label: string; run: () => void }>, focus: boolean): void {
    clear(btnBox);
    const labels: string[] = [];
    actions = [];
    for (let i = 0; i < list.length; i++) { labels.push(list[i].label); actions.push(list[i].run); }
    buttons = createButtonList(d.doc, labels, true);
    btnBox.appendChild(buttons.element);
    if (alive) { ev.buttonsChanged(focus); }
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
    status.className = 'ss-message ss-pair__status' + (state === 'saved' ? ' ss-tone--ok' : state === 'waiting' || review || (d.embedded && state === 'cancelled') ? '' : ' ss-tone--error');
    status.textContent =
      state === 'waiting' ? t('pair.waiting') :
      state === 'unreachable' ? t('pair.unreachable') :
      state === 'received' ? (pending ? pending.summary : '') :
      state === 'saving' ? t('pair.saving') :
      state === 'saved' ? (d.embedded ? t('pair.filled') : purpose.savedText || '') :
      state === 'expired' ? t('pair.expired') :
      state === 'failed' ? failNote :
      t('pair.cancelled');
  }

  /** Waiting, expired, failed: full screen [Cancel, New code]; embedded [New code]. */
  function retryButtons(focus: boolean): void {
    if (d.embedded) { setButtons([{ label: t('pair.newCode'), run: start }], focus); return; }
    setButtons([{ label: t('common.cancel'), run: ev.close }, { label: t('pair.newCode'), run: start }], focus);
  }

  function fail(note: string): void {
    stopTimers();
    endSession(false);
    pending = null;
    state = 'failed';
    failNote = note;
    retryButtons(false);
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
    setButtons([{ label: t('pair.discard'), run: discard }, { label: purpose.confirmLabel, run: save }], true);
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
    retryButtons(false);
    render();
  }

  function tick(): void {
    tickTimer = null;
    if (!alive) { return; }
    if ((state === 'waiting' || state === 'unreachable') && d.now() - started >= PAIR_TTL_MS) { expire(); return; }
    render();
    if (state === 'waiting' || state === 'unreachable') { tickTimer = d.setTimer(tick, 1000); }
  }

  function start(): void {
    stopTimers();
    endSession(state === 'waiting' || state === 'unreachable');
    pending = null;
    code = '';
    session = createPairSession(purpose.kind);
    started = d.now();
    state = 'waiting';
    const q = qrImage(pairUrl(d.baseUrl, session), d.qrMaxPx, 'L');
    img.style.width = q.px + 'px';
    img.style.height = q.px + 'px';
    img.setAttribute('src', q.uri);
    retryButtons(false);
    render();
    poll();
    tickTimer = d.setTimer(tick, 1000);
  }

  function discard(): void {
    pending = null;
    code = '';
    state = 'cancelled';
    if (!d.embedded) { ev.close(); return; }
    retryButtons(false);
    render();
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
      if (d.embedded) { setButtons([{ label: t('pair.newCode'), run: start }], false); render(); return; }
      if (purpose.savedText === null) { ev.close(); return; }
      setButtons([{ label: t('pair.done'), run: ev.close }], false);
      render();
    }, function () {
      if (!alive) { return; }
      fail(purpose.failText);
    });
  }

  function shutdown(): void {
    const open = state === 'waiting' || state === 'unreachable';
    stopTimers();
    endSession(open);
    pending = null;
    if (state !== 'saved') { state = 'cancelled'; }
  }

  return {
    element: element,
    start: start,
    shutdown: shutdown,
    destroy: function () { alive = false; shutdown(); },
    size: function () { return buttons.size(); },
    setFocused: function (index, focused) { buttons.setFocused(index, focused); },
    select: function (index) { if (actions[index]) { actions[index](); } }
  };
}
