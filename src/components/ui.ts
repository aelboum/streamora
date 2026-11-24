// Presentational building blocks for the playlist screens. No business logic: they render
// view data and focus state only. All text goes through textContent (utils/dom.ts h()).
import { clear, h } from '../utils/dom.ts';

export type Tone = 'normal' | 'error' | 'ok';

export interface Row {
  primary: string;
  secondary?: string;
  badge?: string;
  /** Visual tone of the secondary line. */
  tone?: Tone;
}

export interface RowList {
  readonly element: HTMLElement;
  setRows(rows: Row[]): void;
  size(): number;
  setFocused(index: number, focused: boolean): void;
}

export function createRowList(doc: Document, className?: string): RowList {
  const element = h(doc, 'div', { className: 'ss-rows' + (className ? ' ' + className : '') });
  let items: HTMLElement[] = [];
  let focusedIndex = -1;
  return {
    element: element,
    setRows: function (rows) {
      clear(element);
      items = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const kids: Node[] = [h(doc, 'div', { className: 'ss-row__primary', text: r.primary })];
        if (r.badge) {
          kids.push(h(doc, 'div', { className: 'ss-row__badge', text: r.badge }));
        }
        if (r.secondary) {
          kids.push(h(doc, 'div', { className: 'ss-row__secondary' + (r.tone && r.tone !== 'normal' ? ' ss-tone--' + r.tone : ''), text: r.secondary }));
        }
        const el = h(doc, 'div', { className: 'ss-row' + (i === focusedIndex ? ' is-focused' : ''), attrs: { 'data-index': String(i) } }, kids);
        items.push(el);
        element.appendChild(el);
      }
    },
    size: function () { return items.length; },
    setFocused: function (index, focused) {
      const el = items[index];
      if (focused) {
        focusedIndex = index;
      } else if (focusedIndex === index) {
        focusedIndex = -1;
      }
      if (el) {
        el.className = 'ss-row' + (focused ? ' is-focused' : '');
        const s = el as unknown as { scrollIntoView?: (alignTop?: boolean) => void };
        if (focused && typeof s.scrollIntoView === 'function') {
          // Keep the focused row on screen (lists here are short; no virtualisation needed).
          try { s.scrollIntoView(false); } catch (e) { /* ignore */ }
        }
      }
    }
  };
}

export interface InfoList {
  readonly element: HTMLElement;
  setLines(lines: Array<{ label: string; value: string; tone?: Tone }>): void;
}

export function createInfoList(doc: Document): InfoList {
  const element = h(doc, 'dl', { className: 'ss-details' });
  return {
    element: element,
    setLines: function (lines) {
      clear(element);
      for (let i = 0; i < lines.length; i++) {
        element.appendChild(h(doc, 'dt', { text: lines[i].label }));
        const tone = lines[i].tone;
        element.appendChild(h(doc, 'dd', { text: lines[i].value, className: tone && tone !== 'normal' ? 'ss-tone--' + tone : '' }));
      }
    }
  };
}

export interface Frame {
  root: HTMLElement;
  body: HTMLElement;
  message: HTMLElement;
}

/** Screen frame: header (app title + screen title), body, message line. */
export function createFrame(doc: Document, appTitle: string, title: string): Frame {
  const body = h(doc, 'div', { className: 'ss-body' });
  const message = h(doc, 'div', { className: 'ss-message' });
  const root = h(doc, 'div', { className: 'ss-shell' }, [
    h(doc, 'header', { className: 'ss-header' }, [h(doc, 'h1', { className: 'ss-title', text: appTitle }), h(doc, 'div', { className: 'ss-subtitle', text: title })]),
    body,
    message
  ]);
  return { root: root, body: body, message: message };
}

export function setMessage(el: HTMLElement, text: string, tone?: Tone): void {
  el.textContent = text;
  el.className = 'ss-message' + (tone && tone !== 'normal' ? ' ss-tone--' + tone : '');
}
