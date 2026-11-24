// Text entry with the Samsung system keyboard (IME), Stage 5 keyboard strategy:
//   1. the native IME is preferred when available (a focused <input> raises it on the TV [V probe 2]);
//   2. the app's own keyboard (keyboard-overlay.ts) stays available as the fallback ("On-screen
//      keyboard" button) and is used directly where no IME exists (browser, tests);
//   3. password fields use <input type="password">, autocomplete off; the value is read only on
//      Done and the field is cleared on close; nothing is logged;
//   4. Back while the IME is open closes the IME first (stays in this dialog); Back again cancels.
// While the input has focus the key router passes only Back (textInput.active), so arrows, OK and
// digits reach the IME. Samsung IME keys: Done 65376, Cancel 65385 [A: Samsung documentation; the
// app also accepts Enter 13].
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import type { Translate } from '../i18n/strings.ts';
import type { KeyboardParams } from './keyboard-overlay.ts';
import { h } from '../utils/dom.ts';

export const IME_DONE = 65376;
export const IME_CANCEL = 65385;

/** Shared flag read by the key router (bootstrap): true while a text field owns the keys. */
export interface TextInputState { active: boolean }

export interface TextEntryDeps {
  doc: Document;
  t: Translate;
  textInput: TextInputState;
  setTimer: (fn: () => void, ms: number) => unknown;
}

interface InputLike extends HTMLElement {
  value: string;
  focus(): void;
  blur(): void;
}

export function createTextEntryOverlay(d: TextEntryDeps, p: KeyboardParams, nav: Router): Screen {
  const t = d.t;
  let input: InputLike | null = null;
  let hint: HTMLElement | null = null;
  let editing = false;
  let closed = false;
  let fieldFocused = false;
  const buttons = createButtonList(d.doc, [t('kb.done'), t('ime.appKeyboard'), t('kb.cancel')], true);
  const fieldRow = h(d.doc, 'div', { className: 'ss-ime__field' });

  function paintField(): void {
    fieldRow.className = 'ss-ime__field' + (fieldFocused ? ' is-focused' : '') + (editing ? ' is-editing' : '');
  }

  function setEditing(on: boolean): void {
    editing = on;
    d.textInput.active = on;
    paintField();
    if (hint) {
      hint.textContent = on ? t('ime.hintTyping') : t('ime.hintButtons');
    }
  }

  function startEditing(): void {
    if (!input || closed) {
      return;
    }
    setEditing(true);
    try { input.focus(); } catch (e) { setEditing(false); }
  }

  function stopEditing(): void {
    if (input && editing) {
      setEditing(false);
      try { input.blur(); } catch (e) { /* ignore */ }
    }
  }

  function take(): string {
    const v = input ? String(input.value || '').substring(0, p.maxLength) : '';
    closed = true;
    stopEditing();
    d.textInput.active = false;
    if (input) { input.value = ''; }
    return v;
  }

  function finish(commit: boolean): void {
    if (closed) {
      return;
    }
    const v = take();
    nav.closeOverlay();
    if (commit) {
      p.onDone(v);
    }
  }

  function fallback(): void {
    if (closed) {
      return;
    }
    const v = take();
    // The app keyboard replaces this overlay and starts with the text typed so far.
    nav.openOverlay('keyboard', { title: p.title, value: v, mode: p.mode, maxLength: p.maxLength, onDone: p.onDone } as unknown as Record<string, unknown>);
  }

  const focus = createFocusManager(function (zone, index, focused) {
    if (zone === 'buttons') {
      buttons.setFocused(index, focused);
    } else {
      fieldFocused = focused;
      paintField();
    }
  });
  focus.register({ id: 'field', kind: 'row', size: function () { return 1; }, neighbours: { down: 'buttons' }, onSelect: startEditing });
  focus.register({
    id: 'buttons', kind: 'row', size: function () { return buttons.size(); }, neighbours: { up: 'field' },
    onSelect: function (i) { if (i === 0) { finish(true); } else if (i === 1) { fallback(); } else { finish(false); } }
  });

  function onKeyDown(ev: Event): void {
    const code = (ev as KeyboardEvent).keyCode;
    if (code === IME_DONE || code === 13) {
      finish(true);
    } else if (code === IME_CANCEL) {
      stopEditing();
      focus.focus('buttons', 0);
    }
  }
  function onBlur(): void {
    if (editing && !closed) {
      setEditing(false);
      focus.focus('buttons', 0);
    }
  }

  return {
    mount: function (layer: HostLayer) {
      const el = d.doc.createElement('input') as unknown as InputLike;
      el.setAttribute('type', p.mode === 'secret' ? 'password' : 'text');
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('autocapitalize', 'off');
      el.setAttribute('spellcheck', 'false');
      el.setAttribute('maxlength', String(p.maxLength));
      el.className = 'ss-ime__input';
      el.value = typeof p.value === 'string' ? p.value : '';
      el.addEventListener('keydown', onKeyDown);
      el.addEventListener('blur', onBlur);
      input = el;
      fieldRow.appendChild(el);
      hint = h(d.doc, 'div', { className: 'ss-dialog__text ss-muted' });
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-dialog ss-dialog--ime' }, [
        h(d.doc, 'div', { className: 'ss-dialog__title', text: p.title }),
        fieldRow, hint, buttons.element
      ]));
      focus.focus('field', 0);
      setEditing(false);
      // Raise the IME once the overlay is on screen.
      d.setTimer(startEditing, 0);
    },
    onShow: function () { /* static */ },
    onHide: function () { /* static */ },
    onKey: function (e: RemoteKeyEvent) {
      if (editing) {
        return true; // the key router lets only Back through while editing
      }
      if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
        focus.move(e.key);
      } else if (e.key === 'ok') {
        focus.select();
      }
      return true;
    },
    onBack: function () {
      if (editing) {
        stopEditing(); // first Back closes the IME, the dialog stays
        focus.focus('buttons', 0);
        return true;
      }
      take();
      return false; // router closes the overlay = cancel
    },
    destroy: function () {
      d.textInput.active = false;
      if (input) {
        input.removeEventListener('keydown', onKeyDown);
        input.removeEventListener('blur', onBlur);
        input.value = '';
      }
      input = null;
    }
  };
}
