// Parental PIN dialog (Stage 7B.2 part 4; design P2 "PIN 19": 8 cells, number pad).
// Modes:
//   verify    enter the PIN → unlocks adult content for the session → onDone
//   set       choose a new PIN (6–8 digits) twice → recovery code shown once → onDone
//   change    current PIN → new PIN twice → onDone
//   remove    current PIN → PIN and parental settings removed → onDone
//   recovery  current PIN → a new recovery code is shown once (the old one stops working)
// Input: the remote's digit keys, or the on-screen pad (1–9, ⌫, 0, OK) with the arrows and OK, so
// remotes without number keys work. OK submits (6–8 digits; an older 4–5 digit PIN still verifies).
// While the PBKDF2 check runs ("Checking…") keys are ignored. Wrong PIN: attempts left; too many:
// the lockout time. "Forgot PIN?" asks for the recovery code (alphanumeric, system keyboard) and
// removes the PIN when it matches. PINs and codes are never logged or kept after the dialog closes.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { Translate } from '../i18n/strings.ts';
import type { Parental } from '../services/parental.ts';
import type { PinResult } from '../security/pin.ts';
import { formatRecoveryCode, MIN_PIN_LENGTH } from '../security/pin.ts';
import type { OpenText } from './live-screens.ts';
import type { ConfirmParams } from './confirm-dialog.ts';
import { createIcon } from '../components/brand.ts';
import { clear, h } from '../utils/dom.ts';

export type PinMode = 'verify' | 'set' | 'change' | 'remove' | 'recovery';

export interface PinDialogParams {
  mode: PinMode;
  /** Shown under the title (why the PIN is asked, e.g. the category name). */
  reason?: string;
  onDone?: () => void;
}

export interface PinDialogDeps {
  doc: Document;
  t: Translate;
  parental: Parental;
  openText: OpenText;
}

export const PIN_MAX = 8;
const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];

type Step = 'pin' | 'new' | 'again' | 'code';

export function createPinDialog(d: PinDialogDeps, p: PinDialogParams, nav: Router): Screen {
  const t = d.t;
  const svc = d.parental.pin();
  let step: Step = p.mode === 'set' ? 'new' : 'pin';
  let digits = '';
  let current = '';
  let first = '';
  let code = '';
  let busy = false;
  let alive = true;
  let msg = '';
  let msgError = false;
  // Focus: 'pad' (0–11) or 'buttons'.
  let zone: 'pad' | 'buttons' = 'pad';
  let padIdx = 0;
  let btnIdx = 0;
  const title = h(d.doc, 'div', { className: 'ss-dialog__title' });
  const sub = h(d.doc, 'p', { className: 'ss-dialog__text' });
  const cells = h(d.doc, 'div', { className: 'ss-pin__cells' });
  const pad = h(d.doc, 'div', { className: 'ss-pin__pad' });
  const note = h(d.doc, 'div', { className: 'ss-pin__msg' });
  const codeBox = h(d.doc, 'div', { className: 'ss-pin__code' });
  const btnBox = h(d.doc, 'div', { className: 'ss-pin__buttons' });

  function buttons(): Array<{ label: string; run: () => void }> {
    if (step === 'code') {
      return [{ label: t('pin.wroteDown'), run: finish }];
    }
    const out: Array<{ label: string; run: () => void }> = [];
    if (step === 'pin') { out.push({ label: t('pin.forgot'), run: forgot }); }
    out.push({ label: t('common.cancel'), run: function () { nav.closeOverlay(); } });
    return out;
  }

  function titles(): { title: string; sub: string } {
    if (step === 'code') { return { title: t('pin.codeTitle'), sub: t('pin.codeText') }; }
    if (step === 'new') { return { title: t('pin.newTitle'), sub: t('pin.newText') }; }
    if (step === 'again') { return { title: t('pin.againTitle'), sub: t('pin.againText') }; }
    const m = p.mode;
    return {
      title: t(m === 'verify' ? 'pin.enterTitle' : 'pin.currentTitle'),
      sub: p.reason || t(m === 'verify' ? 'pin.enterText' : m === 'remove' ? 'pin.removeText' : m === 'recovery' ? 'pin.recoveryText' : 'pin.changeText')
    };
  }

  function paint(): void {
    const tt = titles();
    title.textContent = tt.title;
    sub.textContent = tt.sub;
    clear(cells);
    clear(pad);
    clear(codeBox);
    const showPad = step !== 'code';
    cells.className = 'ss-pin__cells' + (showPad ? '' : ' is-hidden');
    pad.className = 'ss-pin__pad' + (showPad ? '' : ' is-hidden');
    codeBox.className = 'ss-pin__code' + (showPad ? ' is-hidden' : '');
    if (showPad) {
      for (let i = 0; i < PIN_MAX; i++) {
        cells.appendChild(h(d.doc, 'div', {
          className: 'ss-pin__cell' + (i < digits.length ? ' is-filled' : '') + (i === digits.length && !busy ? ' is-next' : '') + (i >= MIN_PIN_LENGTH ? ' is-optional' : '')
        }, i < digits.length ? [h(d.doc, 'div', { className: 'ss-pin__dot' })] : []));
      }
      for (let i = 0; i < PAD.length; i++) {
        const k = PAD[i];
        const f = zone === 'pad' && padIdx === i;
        const kids: Node[] = k === 'del' ? [createIcon(d.doc, 'backspace', '', 'ss-pin__icon')] : k === 'ok' ? [createIcon(d.doc, 'check', '', 'ss-pin__icon')] : [];
        const el = h(d.doc, 'div', { className: 'ss-pin__key' + (f ? ' is-focused' : '') + (k === 'ok' ? ' ss-pin__key--ok' : ''), attrs: { 'data-key': k }, text: k.length === 1 ? k : undefined }, kids);
        pad.appendChild(el);
      }
    } else {
      codeBox.textContent = formatRecoveryCode(code);
    }
    note.textContent = busy ? t('pin.checking') : msg;
    note.className = 'ss-pin__msg' + (msgError && !busy ? ' is-error' : '');
    clear(btnBox);
    const bs = buttons();
    if (btnIdx >= bs.length) { btnIdx = bs.length - 1; }
    for (let i = 0; i < bs.length; i++) {
      btnBox.appendChild(h(d.doc, 'div', { className: 'ss-button' + (zone === 'buttons' && btnIdx === i ? ' is-focused' : ''), text: bs[i].label }));
    }
  }

  function say(text: string, error: boolean): void { msg = text; msgError = error; }

  function failure(r: PinResult): string {
    if (r.ok) { return ''; }
    if (r.reason === 'wrong') { return t('pin.wrong', { n: r.attemptsLeft }); }
    if (r.reason === 'locked') { return t('pin.locked', { m: Math.max(1, Math.ceil(r.retryInMs / 60000)) }); }
    if (r.reason === 'invalid-format') { return t('pin.format'); }
    if (r.reason === 'unavailable') { return t('pin.unavailable'); }
    return t('pin.error');
  }

  function finish(): void {
    digits = current = first = code = '';
    nav.closeOverlay();
    if (p.onDone) { p.onDone(); }
  }

  function run(job: Promise<PinResult>, ok: (r: PinResult) => void): void {
    busy = true;
    say('', false);
    paint();
    job.then(function (r) {
      if (!alive) { return; }
      busy = false;
      if (r.ok) { ok(r); } else { digits = ''; say(failure(r), true); }
      if (alive) { paint(); }
    }, function () {
      if (!alive) { return; }
      busy = false;
      digits = '';
      say(t('pin.error'), true);
      paint();
    });
  }

  function submit(): void {
    if (!svc || busy) { return; }
    const v = digits;
    const min = step === 'pin' ? 4 : MIN_PIN_LENGTH;
    if (v.length < min) { say(step === 'pin' ? t('pin.short') : t('pin.format'), true); paint(); return; }
    if (step === 'pin') {
      const m = p.mode;
      if (m === 'verify') {
        run(svc.verify(v), function () { d.parental.unlock(); finish(); });
      } else if (m === 'remove') {
        run(svc.resetWithPin(v), function () { d.parental.relock(); finish(); });
      } else if (m === 'recovery') {
        run(svc.regenerateRecoveryCode(v), function (r) {
          code = r.ok && r.recoveryCode ? r.recoveryCode : '';
          digits = '';
          if (!code) { finish(); return; }
          step = 'code';
          zone = 'buttons';
          btnIdx = 0;
        });
      } else {
        run(svc.verify(v), function () { current = v; digits = ''; step = 'new'; });
      }
      return;
    }
    if (step === 'new') {
      first = v;
      digits = '';
      step = 'again';
      say('', false);
      paint();
      return;
    }
    if (step === 'again') {
      if (v !== first) {
        first = '';
        digits = '';
        step = 'new';
        say(t('pin.mismatch'), true);
        paint();
        return;
      }
      run(svc.setPin(p.mode === 'set' ? null : current, v), function (r) {
        current = first = '';
        digits = '';
        if (r.ok && r.recoveryCode) { code = r.recoveryCode; step = 'code'; zone = 'buttons'; btnIdx = 0; } else { finish(); }
      });
    }
  }

  function forgot(): void {
    const s = svc;
    if (!s) { return; }
    const done = p.onDone;
    nav.closeOverlay();
    d.openText(nav, {
      title: t('pin.recoveryTitle'), value: '', mode: 'text', maxLength: 16,
      onDone: function (v) {
        if (!v) { return; }
        s.resetWithRecoveryCode(v).then(function (r) {
          let cp: ConfirmParams;
          if (r.ok) {
            d.parental.relock();
            cp = { title: t('pin.resetTitle'), paragraphs: [t('pin.resetText')], buttons: [{ label: t('common.ok'), run: done }] };
          } else {
            const text = r.reason === 'locked' ? t('pin.locked', { m: Math.max(1, Math.ceil(r.retryInMs / 60000)) })
              : r.reason === 'wrong' ? t('pin.codeWrong', { n: r.attemptsLeft }) : r.reason === 'invalid-format' ? t('pin.codeFormat') : t('pin.error');
            cp = { title: t('pin.recoveryFailed'), paragraphs: [text], buttons: [{ label: t('common.ok') }] };
          }
          nav.openOverlay('confirm', cp as unknown as Record<string, unknown>);
        });
      }
    });
  }

  function press(k: string): void {
    if (k === 'del') { digits = digits.slice(0, -1); }
    else if (k === 'ok') { submit(); return; }
    else if (digits.length < PIN_MAX) { digits += k; }
    say('', false);
    paint();
  }

  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-dialog ss-pin' }, [title, sub, cells, codeBox, pad, note, btnBox]));
      if (!svc) { say(t('pin.unavailable'), true); }
      paint();
    },
    onShow: function () { /* static */ },
    onHide: function () { /* static */ },
    onKey: function (e: RemoteKeyEvent) {
      if (busy) { return true; }
      if (e.key === 'digit' && typeof e.digit === 'number' && step !== 'code') {
        // Typed with the number keys: put the focus on the pad's OK so the next OK submits.
        zone = 'pad';
        padIdx = PAD.length - 1;
        press(String(e.digit));
        return true;
      }
      if (e.key === 'ok') {
        if (zone === 'buttons') { const b = buttons()[btnIdx]; if (b) { b.run(); } return true; }
        press(PAD[padIdx]);
        return true;
      }
      if (zone === 'pad') {
        const r = Math.floor(padIdx / 3);
        const c = padIdx % 3;
        if (e.key === 'left' && c > 0) { padIdx--; }
        else if (e.key === 'right' && c < 2) { padIdx++; }
        else if (e.key === 'up' && r > 0) { padIdx -= 3; }
        else if (e.key === 'down') { if (r < 3) { padIdx += 3; } else { zone = 'buttons'; btnIdx = 0; } }
      } else {
        if (e.key === 'left') { btnIdx = Math.max(0, btnIdx - 1); }
        else if (e.key === 'right') { btnIdx = Math.min(buttons().length - 1, btnIdx + 1); }
        else if (e.key === 'up' && step !== 'code') { zone = 'pad'; padIdx = 10; }
      }
      paint();
      return true;
    },
    onBack: function () {
      if (busy) { return true; }
      if (step === 'code') { finish(); return true; } // the code was shown; the PIN is already set
      return false; // closes the dialog
    },
    destroy: function () { alive = false; digits = current = first = code = ''; }
  };
}
