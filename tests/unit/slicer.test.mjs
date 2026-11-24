// Time slicer used by the importers so parsing never blocks the UI for long.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlicer } from '../../src/content/slicer.ts';

const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), now: () => Date.now() };

test('without timers text is consumed synchronously, in pieces', () => {
  const got = [];
  const s = createSlicer((p) => { got.push(p); return true; }, undefined, { pieceChars: 4 });
  s.push('abcdefghij');
  assert.deepEqual(got, ['abcd', 'efgh', 'ij']);
  assert.equal(s.backlog(), 0);
});

test('with timers work yields to the event loop after the budget; order and content preserved', async () => {
  const got = [];
  let slices = 0;
  let lastSlice = -1;
  let tick = 0;
  const fakeNow = { ...timers, now: () => tick };
  const s = createSlicer((p) => { got.push(p); tick += 5; if (slices !== lastSlice) { lastSlice = slices; } return true; },
    { ...fakeNow, setTimer: (fn, ms) => setTimeout(() => { slices++; fn(); }, ms) }, { pieceChars: 10, budgetMs: 16 });
  const text = 'x'.repeat(1000);
  s.push(text.substring(0, 500));
  s.push(text.substring(500));
  assert.equal(got.length, 0, 'nothing runs inside push');
  let interleaved = 0;
  const other = setInterval(() => { interleaved++; }, 0);
  await s.drained();
  clearInterval(other);
  assert.equal(got.join(''), text);
  assert.equal(got.length, 100);
  assert.ok(slices >= 25, 'budget 16 ms / 5 ms per piece -> at most 4 pieces per slice (' + slices + ' slices)');
  assert.ok(interleaved > 0, 'other timers ran between slices');
});

test('consumer returning false stops and drops the rest; cancel resolves waiters', async () => {
  const got = [];
  const s = createSlicer((p) => { got.push(p); return got.length < 3; }, timers, { pieceChars: 2 });
  s.push('aabbccddeeff');
  await s.drained();
  assert.deepEqual(got, ['aa', 'bb', 'cc']);
  assert.equal(s.stopped(), true);
  s.push('more');
  assert.equal(s.backlog(), 0);
  const c = createSlicer(() => true, timers);
  c.push('x'.repeat(100000));
  const w = c.drained();
  c.cancel();
  await w;
  assert.equal(c.stopped(), true);
});
