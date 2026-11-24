// Streaming M3U/M3U8 parser: metadata extraction, encodings, chunking, malformed and hostile input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createM3uParser, parseAttributes } from '../../src/content/m3u-parser.ts';

const fixture = (name) => readFileSync(new URL('../fixtures/m3u/' + name, import.meta.url), 'utf8');

function parse(text, chunkSize, options) {
  const entries = [];
  const p = createM3uParser((e) => entries.push(e), options);
  if (!chunkSize) {
    p.push(text);
  } else {
    for (let i = 0; i < text.length; i += chunkSize) {
      if (!p.push(text.substring(i, i + chunkSize))) break;
    }
  }
  return { entries, summary: p.end() };
}

test('extended M3U: header EPG URLs and every metadata field', () => {
  const { entries, summary } = parse(fixture('provider-extended.m3u'));
  assert.equal(summary.verdict, 'playlist');
  assert.equal(summary.header.extended, true);
  assert.deepEqual(summary.header.epgUrls, [
    'http://provider.example:8080/xmltv.php?username=demo_user&password=demo_pass_9f3k',
    'http://epg.example.org/guide.xml.gz'
  ]);
  assert.equal(summary.entries, 14);
  assert.equal(summary.malformed, 1, '#EXTINF without a URL');
  const first = entries[0];
  assert.deepEqual(
    { title: first.title, tvgId: first.tvgId, tvgName: first.tvgName, logo: first.logo, group: first.group, duration: first.duration, url: first.url },
    { title: 'News One HD', tvgId: 'news.one.uk', tvgName: 'News One HD', logo: 'http://logos.example.org/uk/news-one.png',
      group: 'UK | News', duration: -1, url: 'http://provider.example:8080/demo_user/demo_pass_9f3k/1001' });
  assert.equal(entries[1].chno, 102);
  assert.equal(entries[2].catchup, 'default');
  assert.equal(entries[2].catchupDays, 7);
  const kids = entries.find((e) => e.title === 'Kids Fun');
  assert.equal(kids.userAgent, 'ExamplePlayer/2.1', '#EXTVLCOPT user agent');
  assert.equal(kids.referrer, 'http://portal.example.org/');
  assert.equal(entries.find((e) => e.title === 'Nieuws 24').userAgent, 'KodiLike/19.0', 'user-agent attribute');
  assert.equal(entries.find((e) => e.title === 'Jazz Radio').radio, true);
  assert.equal(entries.find((e) => e.title === 'Docs Channel').group, 'UK | Documentary', 'group-title wins over #EXTGRP');
  assert.equal(entries.find((e) => e.title === 'Grouped By EXTGRP').group, 'Music', '#EXTGRP used when group-title is absent');
  assert.equal(entries.find((e) => e.title === 'Old Film Without Prefix').group, '', 'missing metadata stays empty');
});

test('chunking never changes the result (every split point, 1-char chunks, random sizes)', () => {
  const text = fixture('provider-extended.m3u') + fixture('mojibake-cr.m3u').replace('#EXTM3U', '');
  const whole = parse(text);
  for (const size of [1, 2, 3, 7, 64, 100, 4096]) {
    const r = parse(text, size);
    assert.deepEqual(r.entries, whole.entries, 'chunk size ' + size);
    assert.deepEqual(r.summary, whole.summary, 'chunk size ' + size);
  }
  // CRLF split between the CR and the LF.
  const crlf = '#EXTM3U\r\n#EXTINF:-1,A\r\nhttp://a.example/1\r\n#EXTINF:-1,B\r\nhttp://a.example/2\r\n';
  for (let cut = 1; cut < crlf.length; cut++) {
    const entries = [];
    const p = createM3uParser((e) => entries.push(e));
    p.push(crlf.substring(0, cut));
    p.push(crlf.substring(cut));
    p.end();
    assert.deepEqual(entries.map((e) => e.title + '|' + e.url), ['A|http://a.example/1', 'B|http://a.example/2'], 'cut at ' + cut);
  }
});

test('encodings: UTF-8 BOM, CRLF, CR-only line ends, double-encoded UTF-8 names', () => {
  const plain = parse(fixture('plain-crlf.m3u'));
  assert.equal(plain.summary.verdict, 'playlist');
  assert.equal(plain.summary.header.extended, false);
  assert.deepEqual(plain.entries.map((e) => e.url), [
    'http://stream.example.org/live/channel-one.ts', 'http://stream.example.org/live/channel-two.m3u8',
    'https://stream.example.org/vod/film.mp4', 'rtmp://stream.example.org/live/three'
  ], 'BOM stripped, comments skipped; URL validation is the source\'s job');
  const moj = parse(fixture('mojibake-cr.m3u'));
  assert.deepEqual(moj.entries.map((e) => e.title), ['Télé Ünïon', 'Café TV', 'Ελληνικά', 'Ящик', 'Música 24']);
  assert.equal(moj.entries[0].group, 'Europé');
});

test('attribute syntax: double, single and missing quotes, commas inside quotes, unterminated quotes', () => {
  const a = {};
  const after = parseAttributes(' tvg-id="a,b" tvg-name=\'Single Q\' tvg-chno=7 junk group-title="G",Title, with comma', 0, a);
  assert.deepEqual(a, { 'tvg-id': 'a,b', 'tvg-name': 'Single Q', 'tvg-chno': '7', 'group-title': 'G' });
  const line = ' tvg-id="a,b" tvg-name=\'Single Q\' tvg-chno=7 junk group-title="G",Title, with comma';
  assert.equal(line.substring(after), 'Title, with comma');
  const { entries } = parse('#EXTM3U\n#EXTINF:-1 tvg-name="Unterminated,Title\nhttp://a.example/1\n#EXTINF:-1 ,  \nhttp://a.example/2\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, 'http://a.example/1');
  assert.equal(entries[1].title, '', 'empty title kept empty (the source derives a name)');
});

test('hostile metadata is cleaned and capped, never interpreted', () => {
  const long = 'A'.repeat(2500); // line stays under the 8,192-character line limit
  const text = '#EXTM3U\n' +
    '#EXTINF:-1 tvg-name="<script>alert(1)</script>" tvg-logo="javascript:alert(1)" group-title="‮evil\u0007",<img src=x onerror=alert(1)>\u0000​\n' +
    'javascript:alert(document.cookie)\n' +
    '#EXTINF:-1 tvg-id="' + long + '" group-title="' + long + '",' + long + '\n' +
    'http://a.example/long\n';
  const { entries, summary } = parse(text);
  assert.equal(summary.entries, 2);
  assert.equal(entries[0].title, '<img src=x onerror=alert(1)>', 'kept as inert text (rendered with textContent only)');
  assert.equal(entries[0].group, 'evil', 'bidi override and control characters removed');
  assert.equal(entries[0].logo, 'javascript:alert(1)', 'parser passes URLs through; the source rejects them');
  assert.equal(entries[1].title.length, 200);
  assert.equal(entries[1].group.length, 100);
  assert.equal(entries[1].tvgId.length, 128);
});

test('over-long lines are skipped without buffering them; entry cap stops parsing', () => {
  const huge = 'x'.repeat(200000);
  const text = '#EXTM3U\n#EXTINF:-1,Before\nhttp://a.example/1\n' + huge + '\n#EXTINF:-1,After\nhttp://a.example/2\n';
  for (const size of [0, 1000, 65536]) {
    const r = parse(text, size, { maxLineChars: 8192 });
    assert.deepEqual(r.entries.map((e) => e.title), ['Before', 'After'], 'chunk ' + size);
    assert.equal(r.summary.oversized, 1);
  }
  // A single line with no newline at all (e.g. a binary file) stays bounded.
  const r2 = parse('#EXTM3U\n' + huge + huge, 4096, { maxLineChars: 8192 });
  assert.equal(r2.summary.oversized, 1);
  assert.equal(r2.entries.length, 0);

  let lines = '#EXTM3U\n';
  for (let i = 0; i < 50; i++) lines += '#EXTINF:-1,C' + i + '\nhttp://a.example/' + i + '\n';
  const capped = parse(lines, 0, { maxEntries: 10 });
  assert.equal(capped.entries.length, 10);
  assert.equal(capped.summary.truncated, true);
});

test('verdicts: HLS manifest, HTML/JSON responses, empty input', () => {
  assert.equal(parse(fixture('hls-master.m3u8')).summary.verdict, 'hls-stream');
  assert.equal(parse(fixture('hls-master.m3u8')).entries.length, 0);
  assert.equal(parse(fixture('not-a-playlist.html')).summary.verdict, 'not-playlist');
  assert.equal(parse('{"user_info":{"auth":0}}').summary.verdict, 'not-playlist');
  assert.equal(parse('').summary.verdict, 'not-playlist');
  assert.equal(parse('\n\n  \n').summary.verdict, 'not-playlist');
  assert.equal(parse('#EXTM3U\n').summary.verdict, 'playlist', 'empty but well-formed; the source reports "empty"');
  // HLS tags after channel entries (some providers append them) do not discard the channels.
  const mixed = parse('#EXTM3U\n#EXTINF:-1,A\nhttp://a.example/1\n#EXT-X-ENDLIST\n#EXTINF:-1,B\nhttp://a.example/2\n');
  assert.equal(mixed.summary.verdict, 'playlist');
  assert.equal(mixed.entries.length, 2);
});
