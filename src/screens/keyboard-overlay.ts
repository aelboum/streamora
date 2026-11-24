// On-screen keyboard (ARCHITECTURE.md rev 3 §9): arrows/OK only, with URL helper keys.
// Digit keys on the remote type digits directly. Back cancels. Secret fields are masked unless
// the user chooses "Show". The typed value lives only in this overlay until "Done" hands it to
// the caller's onDone callback; it is never logged.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import type { Translate } from '../i18n/strings.ts';
import { h } from '../utils/dom.ts';

export type KeyboardMode = 'text' | 'url' | 'secret';

export interface KeyboardParams {
  title: string;
  value: string;
  mode: KeyboardMode;
  maxLength: number;
  onDone(value: string): void;
}

type Action = 'char' | 'backspace' | 'shift' | 'space' | 'clear' | 'show' | 'done' | 'cancel';
interface KeyDef { label: string; action: Action; text?: string; wide?: boolean }

export const KEY_COLUMNS = 11;

function chars(s: string): KeyDef[] {
  const out: KeyDef[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push({ label: s.charAt(i), action: 'char', text: s.charAt(i) });
  }
  return out;
}

/** 5 rows of 11 keys, then a helper row (the grid's partial last row). */
export function keyboardLayout(t: Translate, mode: KeyboardMode): KeyDef[] {
  const keys: KeyDef[] = [];
  Array.prototype.push.apply(keys, chars('1234567890'));
  keys.push({ label: t('kb.delete'), action: 'backspace' });
  Array.prototype.push.apply(keys, chars('qwertyuiop:'));
  Array.prototype.push.apply(keys, chars('asdfghjkl/.'));
  Array.prototype.push.apply(keys, chars('zxcvbnm-_@?'));
  Array.prototype.push.apply(keys, chars('=&%~+!*#$,'));
  keys.push({ label: t('kb.shift'), action: 'shift' });
  if (mode === 'url') {
    keys.push({ label: 'http://', action: 'char', text: 'http://', wide: true });
    keys.push({ label: 'https://', action: 'char', text: 'https://', wide: true });
    keys.push({ label: ':8080', action: 'char', text: ':8080', wide: true });
    keys.push({ label: '.m3u', action: 'char', text: '.m3u', wide: true });
  } else {
    keys.push({ label: t('kb.space'), action: 'space', wide: true });
  }
  if (mode === 'secret') {
    keys.push({ label: t('kb.show'), action: 'show', wide: true });
  }
  keys.push({ label: t('kb.clear'), action: 'clear', wide: true });
  keys.push({ label: t('kb.cancel'), action: 'cancel', wide: true });
  keys.push({ label: t('kb.done'), action: 'done', wide: true });
  return keys;
}

export function createKeyboardOverlay(doc: Document, p: KeyboardParams, nav: Router, t: Translate): Screen {
  const keys = keyboardLayout(t, p.mode);
  const keyEls: HTMLElement[] = [];
  let value = typeof p.value === 'string' ? p.value : '';
  let shift = false;
  let reveal = false;
  let focusedKey = -1;
  let display: HTMLElement | null = null;

  function keyClass(i: number): string {
    return 'ss-key' + (keys[i].wide ? ' ss-key--wide' : '') + (i === focusedKey ? ' is-focused' : '') +
      (keys[i].action === 'shift' && shift ? ' is-on' : '');
  }

  function render(): void {
    if (!display) {
      return;
    }
    let shown = value;
    if (p.mode === 'secret' && !reveal) {
      shown = '';
      for (let i = 0; i < value.length; i++) { shown += '•'; }
    }
    display.textContent = shown + '▏';
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (key.action === 'char' && key.text && key.text.length === 1) {
        keyEls[k].textContent = shift ? key.text.toUpperCase() : key.text;
      } else if (key.action === 'show') {
        keyEls[k].textContent = reveal ? t('kb.hide') : t('kb.show');
      }
      keyEls[k].className = keyClass(k);
    }
  }

  function insert(text: string): void {
    const add = shift && text.length === 1 ? text.toUpperCase() : text;
    if (value.length + add.length <= p.maxLength) {
      value += add;
    }
  }

  function press(i: number): void {
    const k = keys[i];
    switch (k.action) {
      case 'char': insert(k.text || ''); break;
      case 'space': insert(' '); break;
      case 'backspace': value = value.substring(0, value.length - 1); break;
      case 'clear': value = ''; break;
      case 'shift': shift = !shift; break;
      case 'show': reveal = !reveal; break;
      case 'cancel': nav.closeOverlay(); return;
      case 'done': {
        const v = value;
        nav.closeOverlay();
        p.onDone(v);
        return;
      }
    }
    render();
  }

  const focus = createFocusManager(function (_z, index, focused) {
    if (focused) {
      focusedKey = index;
    } else if (focusedKey === index) {
      focusedKey = -1;
    }
    if (keyEls[index]) {
      keyEls[index].className = keyClass(index);
    }
  });
  focus.register({ id: 'keys', kind: 'grid', columns: KEY_COLUMNS, size: function () { return keys.length; }, neighbours: {}, onSelect: press });

  return {
    mount: function (layer: HostLayer) {
      display = h(doc, 'div', { className: 'ss-kb__value' });
      const grid = h(doc, 'div', { className: 'ss-kb__keys' });
      for (let i = 0; i < keys.length; i++) {
        const el = h(doc, 'div', { className: 'ss-key', text: keys[i].label, attrs: { 'data-key': String(i) } });
        keyEls.push(el);
        grid.appendChild(el);
      }
      (layer.element as HTMLElement).appendChild(h(doc, 'div', { className: 'ss-kb' }, [
        h(doc, 'div', { className: 'ss-dialog__title', text: p.title }),
        display,
        grid
      ]));
      focus.focus('keys', KEY_COLUMNS); // 'q': start on the letters
      render();
    },
    onShow: function () { /* static */ },
    onHide: function () { /* static */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
        focus.move(e.key);
        return true;
      }
      if (e.key === 'ok') {
        focus.select();
        return true;
      }
      if (e.key === 'digit' && e.digit !== undefined) {
        insert(String(e.digit));
        render();
        return true;
      }
      return true; // modal
    },
    onBack: function () { return false; }, // the router closes the overlay = cancel
    destroy: function () {
      value = '';
      display = null;
    }
  };
}
