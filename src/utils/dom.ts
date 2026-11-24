// Tiny DOM helper. Text is only ever set through textContent; there is no HTML path.

export interface ElementProps {
  id?: string;
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function h(doc: Document, tag: string, props?: ElementProps, children?: Node[]): HTMLElement {
  const el = doc.createElement(tag);
  if (props) {
    if (props.id) {
      el.id = props.id;
    }
    if (props.className) {
      el.className = props.className;
    }
    if (props.text !== undefined) {
      el.textContent = props.text;
    }
    if (props.attrs) {
      for (const name in props.attrs) {
        if (Object.prototype.hasOwnProperty.call(props.attrs, name)) {
          // Event-handler attributes are refused outright.
          if (/^on/i.test(name)) {
            throw new Error('h(): event-handler attribute not allowed: ' + name);
          }
          el.setAttribute(name, props.attrs[name]);
        }
      }
    }
  }
  if (children) {
    for (let i = 0; i < children.length; i++) {
      el.appendChild(children[i]);
    }
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}
