// Presentational list of buttons. No business logic: it renders labels and focus state only.
import { h } from '../utils/dom.ts';

export interface ButtonList {
  readonly element: HTMLElement;
  size(): number;
  setFocused(index: number, focused: boolean): void;
  /** Replaces a button's label (e.g. Show / Hide). */
  setLabel(index: number, text: string): void;
}

export function createButtonList(doc: Document, labels: string[], horizontal: boolean): ButtonList {
  const buttons: HTMLElement[] = [];
  for (let i = 0; i < labels.length; i++) {
    buttons.push(h(doc, 'div', { className: 'ss-button', text: labels[i], attrs: { 'data-index': String(i) } }));
  }
  const element = h(doc, 'div', { className: 'ss-buttons' + (horizontal ? ' ss-buttons--row' : '') }, buttons);
  return {
    element: element,
    size: function () { return buttons.length; },
    setFocused: function (index, focused) {
      const b = buttons[index];
      if (b) {
        b.className = 'ss-button' + (focused ? ' is-focused' : '');
      }
    },
    setLabel: function (index, text) {
      const b = buttons[index];
      if (b && b.textContent !== text) {
        b.textContent = text;
      }
    }
  };
}
