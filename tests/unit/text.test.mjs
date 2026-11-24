// Text helpers for untrusted metadata: cleaning, UTF-8 and base64 decoding, mojibake repair, tolerant scalars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText, stripBom, utf8Decode, repairMojibake, base64Decode, decodeBase64Text, toInt, toId, toFlag
} from '../../src/content/text.ts';

const enc = (s) => Array.from(Buffer.from(s, 'utf8'));

test('cleanText removes control, zero-width and bidi-override characters, collapses whitespace, caps length', () => {
  assert.equal(cleanText('  News\u0000 One\t\tHD​‮  ', 50), 'News One HD');
  assert.equal(cleanText('a  b\r\nc', 50), 'a b c');
  assert.equal(cleanText('x'.repeat(500), 10), 'xxxxxxxxxx');
  assert.equal(cleanText('<script>alert(1)</script>', 100), '<script>alert(1)</script>', 'markup stays text; it is never rendered as HTML');
  assert.equal(cleanText(undefined, 10), '');
  assert.equal(stripBom('﻿#EXTM3U'), '#EXTM3U');
  assert.equal(stripBom('#EXTM3U'), '#EXTM3U');
});

test('utf8Decode handles 1-4 byte sequences and rejects invalid ones', () => {
  for (const s of ['plain', 'Café', 'Ελληνικά', 'Ящик', '中文频道', 'emoji 📺 ok']) {
    assert.equal(utf8Decode(enc(s)), s);
    assert.equal(utf8Decode(enc(s), true), s);
  }
  // overlong '/', lone continuation, truncated sequence, surrogate code point, > U+10FFFF
  const bad = [[0xc0, 0xaf], [0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]];
  for (const b of bad) {
    assert.equal(utf8Decode(b, true), null, JSON.stringify(b));
    assert.match(utf8Decode(b), /�/);
  }
  assert.equal(utf8Decode([0x41, 0xff, 0x42]), 'A�B');
});

test('repairMojibake restores double-encoded UTF-8 and leaves everything else alone', () => {
  for (const s of ['Télé Ünïon', 'Café TV', 'Ελληνικά', 'Ящик']) {
    const mojibake = Buffer.from(s, 'utf8').toString('latin1');
    assert.notEqual(mojibake, s);
    assert.equal(repairMojibake(mojibake), s);
  }
  assert.equal(repairMojibake('Café TV'), 'Café TV', 'real Latin-1 accented text is not touched');
  assert.equal(repairMojibake('Ã and nothing after'), 'Ã and nothing after');
  assert.equal(repairMojibake('中文 Ã©'), '中文 Ã©', 'mixed scripts: not reinterpreted');
});

test('base64 decoding (standard, URL alphabet, no padding) and malformed input', () => {
  const b = (s) => Buffer.from(s, 'utf8').toString('base64');
  assert.equal(decodeBase64Text(b('Morning News'), 100), 'Morning News');
  assert.equal(decodeBase64Text(b('Café Ünïon — live'), 100), 'Café Ünïon — live');
  assert.equal(decodeBase64Text(b('Morning News').replace(/=+$/, ''), 100), 'Morning News');
  assert.deepEqual(base64Decode('-_8', 10), [0xfb, 0xff]);
  assert.equal(decodeBase64Text('not-base64!!', 100), '');
  assert.equal(decodeBase64Text('A', 100), '');
  assert.equal(decodeBase64Text(null, 100), '');
  assert.equal(base64Decode(b('x'.repeat(100)), 10), null, 'size cap');
  assert.equal(decodeBase64Text(b('line1\u0000‮line2'), 100), 'line1line2');
});

test('tolerant scalars as Xtream panels send them', () => {
  assert.equal(toInt(5), 5);
  assert.equal(toInt('42'), 42);
  assert.equal(toInt(' 7 '), 7);
  assert.equal(toInt('7a'), null);
  assert.equal(toInt(null), null);
  assert.equal(toInt(NaN), null);
  assert.equal(toId(1001, 10), '1001');
  assert.equal(toId(' 12 ', 10), '12');
  assert.equal(toId('a b', 10), null);
  assert.equal(toId('', 10), null);
  assert.equal(toId('x'.repeat(11), 10), null);
  assert.equal(toId({}, 10), null);
  for (const v of [1, '1', true, 'true']) assert.equal(toFlag(v), true);
  for (const v of [0, '0', false, null, undefined, 'yes']) assert.equal(toFlag(v), false);
});
