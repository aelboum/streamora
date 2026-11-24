// Incremental top-level JSON array reader (Xtream stream lists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonArrayStream } from '../../src/content/json-array-stream.ts';

function read(text, chunk, options) {
  const out = [];
  const r = createJsonArrayStream((v) => out.push(v), options);
  if (!chunk) r.push(text);
  else for (let i = 0; i < text.length; i += chunk) if (!r.push(text.substring(i, i + chunk))) break;
  return { out, sum: r.end() };
}

const TRICKY = [
  { name: 'quote " inside', s: 'brackets ] } [ { and , commas' },
  { name: 'backslash \\', esc: '\\"', unicode: '\u00e9\u4e2d\ud83d\udcfa' },
  { nested: { a: [1, [2, { b: '}' }]], c: null } },
  'a plain string with "quotes"',
  12345, -1.5e3, true, false, null, [], {}
];

test('elements are delivered in order regardless of chunk size', () => {
  const text = ' \n[' + TRICKY.map((x) => JSON.stringify(x)).join(' ,\n ') + ']  ';
  for (const size of [0, 1, 2, 3, 5, 17, 1000]) {
    const { out, sum } = read(text, size);
    assert.deepEqual(out, TRICKY, 'chunk ' + size);
    assert.equal(sum.verdict, 'array');
    assert.equal(sum.elements, TRICKY.length);
    assert.equal(sum.invalid, 0);
  }
});

test('escaped backslashes before a quote at a chunk boundary', () => {
  const v = [{ p: 'C:\\\\dir\\\\' }, { q: 'x\\"y' }];
  const text = JSON.stringify(v);
  for (let cut = 1; cut < text.length; cut++) {
    const out = [];
    const r = createJsonArrayStream((x) => out.push(x));
    r.push(text.substring(0, cut));
    r.push(text.substring(cut));
    assert.equal(r.end().verdict, 'array', 'cut ' + cut);
    assert.deepEqual(out, v, 'cut ' + cut);
  }
});

test('non-array responses are captured for inspection (Xtream error objects)', () => {
  const { out, sum } = read('{"user_info":{"auth":0}}', 3);
  assert.equal(out.length, 0);
  assert.equal(sum.verdict, 'not-array');
  assert.deepEqual(JSON.parse(sum.prefix), { user_info: { auth: 0 } });
  assert.equal(read('<html>502</html>').sum.verdict, 'not-array');
  assert.equal(read('').sum.verdict, 'empty');
  assert.equal(read('   ').sum.verdict, 'empty');
  const big = read('x'.repeat(200000), 1000);
  assert.equal(big.sum.prefix.length, 65536, 'prefix is capped');
});

test('truncated, invalid and oversized elements', () => {
  const t = read('[{"a":1},{"b":2');
  assert.equal(t.sum.verdict, 'truncated');
  assert.deepEqual(t.out, [{ a: 1 }]);
  assert.equal(read('[1,2').sum.verdict, 'truncated');
  const inv = read('[{"a":1},{bad json},{"c":3}, nope ,4]');
  assert.deepEqual(inv.out, [{ a: 1 }, { c: 3 }, 4]);
  assert.equal(inv.sum.invalid, 2);
  assert.equal(inv.sum.verdict, 'array');
  const stray = read('[{"a":1}},]');
  assert.deepEqual(stray.out, [{ a: 1 }]);
  assert.equal(stray.sum.verdict, 'array');
  const huge = read('[{"a":"' + 'x'.repeat(5000) + '"},{"b":1}]', 100, { maxElementChars: 1000 });
  assert.equal(huge.sum.verdict, 'too-large');
  assert.equal(huge.out.length, 0);
  const capped = read('[1,2,3,4,5]', 0, { maxElements: 3 });
  assert.deepEqual(capped.out, [1, 2, 3]);
  assert.equal(capped.sum.capped, true);
});

test('large list: 50,000 elements streamed in 64 KB chunks', () => {
  const items = [];
  for (let i = 0; i < 50000; i++) items.push({ num: i, name: 'Channel ' + i, stream_id: 100000 + i, stream_icon: 'http://logos.example.org/' + i + '.png', category_id: String(i % 40) });
  const text = JSON.stringify(items);
  let n = 0;
  let last = null;
  const r = createJsonArrayStream((v) => { n++; last = v; });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < text.length; i += 65536) r.push(text.substring(i, i + 65536));
  const sum = r.end();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(sum.verdict, 'array');
  assert.equal(n, 50000);
  assert.deepEqual(last, items[49999]);
  console.log('json-array-stream: ' + (text.length / 1e6).toFixed(1) + ' M chars, 50,000 elements, ' + ms.toFixed(0) + ' ms [W]');
});
