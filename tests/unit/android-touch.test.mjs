// Android touch: a tap only works on elements in FOCUSABLE. Every class a screen renders with
// is-focused must be listed, or taps on it do nothing (0.3.5 phone finding: Settings rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOCUSABLE, installTouch } from '../../src/app/platform/android-platform.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const NOT_TAPPABLE = ['ss-vbar__track']; // the seek bar: a tap must not press OK

function files(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'dev') { out.push(...files(p)); } } else if (n.endsWith('.ts')) { out.push(p); }
  }
  return out;
}

test('android touch: every class rendered with is-focused is a tap target', () => {
  const found = new Set();
  for (const f of files(join(src, 'screens')).concat(files(join(src, 'components')))) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(/'(ss-[a-z0-9_-]+)'[^;\n]{0,80}is-focused/g)) {
      if (!/--/.test(m[1])) { found.add(m[1]); }
    }
  }
  assert.ok(found.has('ss-set__row') && found.has('ss-guide__cell'), 'scan finds the known classes');
  const missing = [...found].filter((c) => !FOCUSABLE.includes(c) && !NOT_TAPPABLE.includes(c)).sort();
  assert.deepEqual(missing, []);
});

// A small layout like Add M3U: QR panel (New code) on the left, four field rows on the right,
// Save and Cancel below the rows, starting a little left of the rows' centre.
function formScreen() {
  const els = [];
  const doc = { activeElement: null, listeners: {} };
  function el(cls, x, y, w, h) {
    const e = { className: cls, nodeType: 1, isConnected: true, offsetParent: {}, parentNode: null,
      getBoundingClientRect: () => ({ left: x, top: y, width: w, height: h }), getAttribute: () => null };
    els.push(e); return e;
  }
  const newCode = el('ss-button', 280, 700, 160, 60);
  const rows = [0, 1, 2, 3].map((i) => el('ss-row', 760, 180 + i * 85, 840, 70));
  const save = el('ss-button', 760, 540, 140, 60);
  const cancel = el('ss-button', 920, 540, 140, 60);
  // Focus graph: rows down to Save; left of any row or button = New code; right of New code = the last row used.
  let focus = rows[2]; let lastRight = rows[2]; let oks = [];
  const order = rows.concat([save]);
  function setFocus(e) { for (const x of els) { x.className = x.className.replace(' is-focused', ''); } e.className += ' is-focused'; focus = e; }
  setFocus(focus);
  function press(code) {
    if (code === 13) { oks.push(focus); return; }
    if (focus === newCode) { if (code === 39) { setFocus(lastRight); } return; }
    if (code === 37) { if (focus === cancel) { setFocus(save); } else { lastRight = focus; setFocus(newCode); } return; }
    if (code === 39) { if (focus === save) { setFocus(cancel); } return; }
    const i = order.indexOf(focus);
    if (code === 40 && focus !== cancel && i < order.length - 1) { setFocus(order[i + 1]); }
    if (code === 38) { if (focus === cancel) { setFocus(rows[3]); } else if (i > 0) { setFocus(order[i - 1]); } }
  }
  doc.querySelectorAll = (sel) => (sel === '.is-focused' ? els.filter((e) => / is-focused/.test(e.className)) : []);
  doc.querySelector = () => null;
  doc.elementFromPoint = (x, y) => els.find((e) => { const r = e.getBoundingClientRect(); return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height; }) || null;
  doc.addEventListener = (n, f) => { doc.listeners[n] = f; };
  doc.removeEventListener = () => {};
  installTouch(doc, press);
  function tapOn(e) {
    const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    doc.listeners.touchstart({ touches: [{ clientX: x, clientY: y }], target: e });
    doc.listeners.touchend({ changedTouches: [{ clientX: x, clientY: y }], preventDefault() {} });
  }
  return { tapOn, save, cancel, newCode, rows, oks: () => oks, focused: () => focus, raw: doc.listeners };
}

test('android touch: Save and Cancel below the fields are reached in one tap (no bouncing to the QR panel)', () => {
  const s = formScreen();
  s.tapOn(s.save);
  assert.deepEqual(s.oks(), [s.save]);
  const c = formScreen();
  c.tapOn(c.cancel);
  assert.deepEqual(c.oks(), [c.cancel]);
  const n = formScreen();
  n.tapOn(n.newCode);
  assert.deepEqual(n.oks(), [n.newCode]);
  const r = formScreen();
  r.tapOn(r.rows[0]);
  assert.deepEqual(r.oks(), [r.rows[0]]);
});

test('android touch: a touch that starts on a text field is left to the WebView (cursor, keyboard, Paste)', () => {
  const s = formScreen();
  const r = s.save.getBoundingClientRect();
  s.raw.touchstart({ touches: [{ clientX: r.left + 10, clientY: r.top + 10 }], target: { nodeName: 'INPUT' } });
  s.raw.touchend({ changedTouches: [{ clientX: r.left + 10, clientY: r.top + 10 }], preventDefault() { throw new Error('must not prevent the native tap'); } });
  assert.deepEqual(s.oks(), []);
});
