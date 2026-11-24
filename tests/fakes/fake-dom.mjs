// Minimal DOM double: just what utils/dom.ts, app/dom-host.ts and the screens use.
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this._text = '';
    this._listeners = {};
    this.value = '';
  }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('not a child');
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { const l = this._listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  /** Test helper: fires an event on this node. */
  dispatch(type, ev = {}) { (this._listeners[type] || []).slice().forEach((fn) => fn(ev)); }
  removeAttribute(k) { delete this.attributes[k]; }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  focus() { this.ownerDocument && (this.ownerDocument.activeElement = this); this.dispatch('focus'); }
  blur() { if (this.ownerDocument && this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; this.dispatch('blur'); }
  /** Test helper: depth-first search by class name. */
  findAll(cls) {
    const out = [];
    const walk = (n) => {
      if ((' ' + n.className + ' ').indexOf(' ' + cls + ' ') >= 0) out.push(n);
      n.childNodes.forEach(walk);
    };
    walk(this);
    return out;
  }
}

export function createFakeDocument() {
  const doc = {};
  const body = new FakeNode('body');
  const html = new FakeNode('html');
  body.ownerDocument = doc;
  return Object.assign(doc, {
    body,
    documentElement: html,
    activeElement: null,
    createElement: (tag) => { const n = new FakeNode(tag); n.ownerDocument = doc; return n; },
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {}
  });
}
