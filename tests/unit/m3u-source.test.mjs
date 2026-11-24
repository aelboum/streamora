// M3U import (download -> parse -> compact catalogue), credential templating and the compact codec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHttpClient } from '../../src/api/http-client.ts';
import { importM3u, classifyEntry } from '../../src/content/m3u-source.ts';
import { decodeLive, isLivePayload, createLiveBuilder } from '../../src/content/catalogue-codec.ts';
import { createTemplater, credentialsFromUrl, resolveTemplate } from '../../src/content/credential-template.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';

const fixture = (name) => readFileSync(new URL('../fixtures/m3u/' + name, import.meta.url), 'utf8');
const PL_URL = 'http://provider.example:8080/get.php?username=demo_user&password=demo_pass_9f3k&type=m3u_plus&output=ts';
const LIMITS = { maxChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000 };

function run(body, opts = {}) {
  const srv = createFakeServer(() => (opts.route ? opts.route() : { status: 200, body, chunk: opts.chunk || 113 }));
  const http = createHttpClient({ xhrFactory: srv.factory });
  const h = importM3u({ http, url: opts.url || PL_URL, name: 'My list', ...LIMITS, ...(opts.limits || {}) });
  return { srv, h };
}

test('section classification (Xtream paths, extensions, episode naming)', () => {
  assert.equal(classifyEntry('http://p.example/movie/u/p/1.mkv', 'x'), 'movie');
  assert.equal(classifyEntry('http://p.example/series/u/p/1.mp4', 'x'), 'series');
  assert.equal(classifyEntry('http://p.example/u/p/1.mp4', 'Film'), 'movie');
  assert.equal(classifyEntry('http://p.example/u/p/1.mp4', 'Show S02E10'), 'series');
  assert.equal(classifyEntry('http://p.example/u/p/1', 'News'), 'live');
  assert.equal(classifyEntry('http://p.example/live/u/p/1.m3u8', 'News'), 'live');
  assert.equal(classifyEntry('https://radio.example.org/jazz.mp3', 'Jazz'), 'live');
});

test('provider playlist: counts, categories, metadata and EPG references', async () => {
  const { srv, h } = run(fixture('provider-extended.m3u'));
  const r = await h.result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.counts, { live: 10, movie: 2, series: 1, invalid: 0, duplicate: 1 });
  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0].url, PL_URL);
  const cat = decodeLive(r.data.payload);
  assert.equal(cat.channels.length, 10);
  const names = cat.categories.map((c) => c.name);
  assert.deepEqual(names, ['UK | News', 'UK | Sports', 'NL | Kinderen', 'Radio', 'NL | Nieuws', 'Adults | XXX', 'UK | Documentary', 'Music']);
  assert.equal(cat.categories.find((c) => c.name === 'Adults | XXX').adult, true);
  assert.equal(cat.categories.find((c) => c.name === 'UK | News').count, 2);
  const news = cat.channels[0];
  assert.deepEqual(news, {
    id: news.id, num: 1, name: 'News One HD', categoryId: cat.categories[0].id, adult: false,
    logo: 'http://logos.example.org/uk/news-one.png', epgKey: 'news.one.uk',
    streamRef: { kind: 'xtream', type: 'live', id: '1001' }
  });
  assert.equal(cat.channels[1].num, 102, 'tvg-chno');
  assert.equal(cat.channels[2].catchupDays, 7);
  assert.deepEqual(cat.channels[2].streamRef, { kind: 'xtream', type: 'live', id: '1003', ext: 'm3u8' });
  const kids = cat.channels.find((c) => c.name === 'Kids Fun');
  assert.deepEqual(kids.streamRef, { kind: 'url', url: 'http://cdn2.example.net:8000/{U}/{P}/2001.ts', cred: true }, 'other host: placeholders');
  assert.equal(kids.userAgent, 'ExamplePlayer/2.1');
  assert.equal(kids.referrer, 'http://portal.example.org/');
  assert.deepEqual(cat.channels.find((c) => c.name === 'Nieuws 24').streamRef,
    { kind: 'url', url: 'http://free-tv.example.com/hls/nieuws24/index.m3u8?token=abc' }, 'unrelated token: stored as given');
  assert.equal(cat.channels.find((c) => c.name === 'Late Night 1').adult, true, 'adult from category');
  assert.deepEqual(r.data.epg, [
    { kind: 'xmltv', url: 'http://provider.example:8080/xmltv.php?username={U}&password={P}', cred: true },
    { kind: 'xmltv', url: 'http://epg.example.org/guide.xml.gz' }
  ]);
  assert.ok(r.data.warnings.some((w) => /1 malformed/.test(w)));
});

test('the stored catalogue never contains the playlist credentials', async () => {
  const r = await run(fixture('provider-extended.m3u')).h.result;
  const stored = JSON.stringify(r.data);
  assert.equal(stored.indexOf('demo_pass_9f3k'), -1);
  assert.equal(stored.indexOf('demo_user'), -1);
});

test('credential templating and play-time substitution', () => {
  const cred = credentialsFromUrl(PL_URL);
  assert.deepEqual(cred, { username: 'demo_user', password: 'demo_pass_9f3k' });
  assert.equal(credentialsFromUrl('http://p.example/list.m3u'), null);
  assert.equal(credentialsFromUrl('http://p.example/get.php?username=a&password=b'), null, 'too short to template safely');
  const t = createTemplater('http://provider.example:8080', cred);
  assert.deepEqual(t.streamRef('http://provider.example:8080/movie/demo_user/demo_pass_9f3k/5.mkv', 'movie'), { kind: 'xtream', type: 'movie', id: '5', ext: 'mkv' });
  assert.deepEqual(t.streamRef('http://other.example/stream?username=demo_user&password=demo_pass_9f3k&id=5', 'live'),
    { kind: 'url', url: 'http://other.example/stream?username={U}&password={P}&id=5', cred: true });
  assert.deepEqual(t.streamRef('http://other.example/demo_user_extra/x', 'live'), { kind: 'url', url: 'http://other.example/demo_user_extra/x' }, 'partial match is not replaced');
  assert.equal(resolveTemplate('http://cdn2.example.net:8000/{U}/{P}/2001.ts', { username: 'a b', password: 'p/w' }), 'http://cdn2.example.net:8000/a%20b/p%2Fw/2001.ts');
  assert.equal(resolveTemplate('javascript:{U}', cred), null);
  const plain = createTemplater('http://x.example', null);
  assert.deepEqual(plain.streamRef('http://x.example/a/b/1', 'live'), { kind: 'url', url: 'http://x.example/a/b/1' });
});

test('hostile playlist: dangerous URLs dropped, text inert, nothing executable survives', async () => {
  const body = '#EXTM3U url-tvg="javascript:alert(1)"\n' +
    '#EXTINF:-1 tvg-logo="javascript:alert(1)" group-title="<b>x</b>",<script>alert(1)</script>\n' +
    'javascript:alert(document.cookie)\n' +
    '#EXTINF:-1 tvg-logo="data:image/svg+xml,<svg onload=alert(1)>",Data logo\n' +
    'http://ok.example/1.ts\n' +
    '#EXTINF:-1,Userinfo\nhttp://user:pass@evil.example/2.ts\n' +
    '#EXTINF:-1,RTMP\nrtmp://evil.example/live\n' +
    '#EXTINF:-1,File\nfile:///etc/passwd\n' +
    '#EXTINF:-1,Spaces\nhttp://ok.example/a b.ts\n' +
    '#EXTINF:-1,Too long\nhttp://ok.example/' + 'a'.repeat(3000) + '\n' +
    '#EXTINF:-1 tvg-logo="http://logo.example/ok.png" group-title="<img src=x onerror=alert(1)>",<img src=x onerror=alert(1)>\n' +
    'http://ok.example/3.ts\n';
  const r = await run(body).h.result;
  assert.equal(r.ok, true);
  assert.equal(r.data.counts.live, 2);
  assert.equal(r.data.counts.invalid, 6);
  const cat = decodeLive(r.data.payload);
  assert.equal(cat.channels[0].logo, undefined, 'data: logo dropped');
  assert.equal(cat.channels[1].name, '<img src=x onerror=alert(1)>', 'kept as inert text');
  assert.equal(cat.channels[1].logo, 'http://logo.example/ok.png');
  assert.deepEqual(r.data.epg, []);
  const all = JSON.stringify(r.data);
  for (const bad of ['javascript:', 'data:', 'rtmp:', 'file:', 'user:pass@']) assert.equal(all.indexOf(bad), -1, bad);
});

test('not a playlist, single HLS stream, empty, VOD-only', async () => {
  let r = await run(fixture('not-a-playlist.html')).h.result;
  assert.deepEqual([r.ok, r.code], [false, 'not-playlist']);
  r = await run(fixture('hls-master.m3u8'), { url: 'http://stream.example.org/hls/master.m3u8' }).h.result;
  assert.equal(r.ok, true);
  const one = decodeLive(r.data.payload).channels;
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].name, one[0].streamRef.url], ['My list', 'http://stream.example.org/hls/master.m3u8']);
  r = await run('#EXTM3U\n').h.result;
  assert.deepEqual([r.ok, r.code], [false, 'empty']);
  r = await run('#EXTM3U\n#EXTINF:-1,Film\nhttp://p.example/movie/a/b/1.mkv\n').h.result;
  assert.deepEqual([r.ok, r.code], [false, 'empty']);
  assert.match(r.message, /movies\/series only/);
});

test('download stops early for a non-playlist response', async () => {
  const big = '<html>' + 'x'.repeat(1000000) + '</html>';
  const srv = createFakeServer(() => ({ status: 200, body: big, chunk: 1000 }));
  const http = createHttpClient({ xhrFactory: srv.factory });
  let delivered = 0;
  const h = importM3u({ http, url: 'http://p.example/list.m3u', name: 'x', ...LIMITS, onProgress: () => delivered++ });
  const r = await h.result;
  assert.equal(r.code, 'not-playlist');
  assert.equal(delivered, 0, 'aborted on the first chunk, long before 1 MB');
});

test('network failures and limits map to import error codes', async () => {
  const cases = [
    [{ fail: 'network' }, 'network'],
    [{ status: 404, body: '' }, 'http'],
    [{ status: 403, body: '' }, 'auth'],
    [{ status: 200, body: fixture('provider-extended.m3u'), finalUrl: 'http://evil.example/x' }, 'redirect-blocked'],
    [{ status: 200, body: fixture('provider-extended.m3u'), chunk: 100, dropAt: 500 }, 'network']
  ];
  for (const [resp, code] of cases) {
    const r = await run('', { route: () => resp }).h.result;
    assert.deepEqual([r.ok, r.code], [false, code], JSON.stringify(resp).substring(0, 80));
    assert.equal(JSON.stringify(r).indexOf('demo_pass_9f3k'), -1);
  }
  const tooBig = await run(fixture('provider-extended.m3u'), { limits: { maxChars: 1000 } }).h.result;
  assert.equal(tooBig.code, 'too-large');
  assert.equal((await run('', { url: 'ftp://x.example/list' }).h.result).code, 'invalid-url');
  const hang = run('', { route: () => ({ fail: 'hang' }) });
  setImmediate(() => hang.h.abort());
  assert.equal((await hang.h.result).code, 'aborted');
});

test('codec: prefix sharing, de-duplication, round trip and malformed rows', () => {
  const b = createLiveBuilder();
  b.addCategory('c1', 'News', false);
  const base = { num: null, categoryId: 'c1', epgKey: '', adult: false, radio: false, catchupDays: null, userAgent: '', referrer: '' };
  for (let i = 0; i < 3; i++) {
    assert.equal(b.addChannel({ ...base, name: 'Ch ' + i, logo: 'http://logos.example/set/' + i + '.png', ref: { kind: 'url', url: 'http://s.example/live/' + i + '.ts' } }), true);
  }
  assert.equal(b.addChannel({ ...base, name: 'dup', logo: '', ref: { kind: 'url', url: 'http://s.example/live/0.ts' } }), false);
  assert.equal(b.addChannel({ ...base, name: 'Orphan', logo: '', categoryId: 'nope', ref: { kind: 'xtream', type: 'live', id: '7' }, providerId: '7' }), true);
  const { payload } = b.finish();
  assert.ok(isLivePayload(payload));
  assert.deepEqual(payload.p, ['http://logos.example/set/', 'http://s.example/live/'], 'shared prefixes stored once');
  const cat = decodeLive(JSON.parse(JSON.stringify(payload)));
  assert.equal(cat.channels.length, 4);
  assert.equal(cat.channels[2].logo, 'http://logos.example/set/2.png');
  assert.deepEqual(cat.channels[2].streamRef, { kind: 'url', url: 'http://s.example/live/2.ts' });
  assert.equal(cat.channels[3].categoryId, '_', 'unknown category -> uncategorised');
  assert.deepEqual(cat.channels.map((c) => c.num), [1, 2, 3, 4]);
  for (const mutate of [
    (p) => { p.r[0][3] = 99; }, (p) => { p.r[0].length = 5; }, (p) => { p.r[0][8] = '42'; }, (p) => { p.r[3][8] = 'bogus:'; }, (p) => { p.c[0] = 5; }
  ]) {
    const copy = JSON.parse(JSON.stringify(payload));
    mutate(copy);
    assert.equal(decodeLive(copy), null);
  }
});

test('large playlist: 50,000 channels streamed in 64 KB chunks', async () => {
  let text = '#EXTM3U url-tvg="http://epg.example.org/guide.xml"\n';
  for (let i = 0; i < 50000; i++) {
    const g = 'Group ' + (i % 120);
    text += '#EXTINF:-1 tvg-id="ch' + i + '.example" tvg-name="Channel ' + i + '" tvg-logo="http://logos.example.org/set/' + i + '.png" group-title="' + g + '",Channel ' + i + '\n' +
      'http://provider.example:8080/demo_user/demo_pass_9f3k/' + (100000 + i) + '\n';
  }
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const r = await run(text, { chunk: 65536 }).h.result;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.ok, true);
  assert.equal(r.data.counts.live, 50000);
  assert.equal(r.data.categories, 120);
  const stored = JSON.stringify(r.data.payload);
  const t1 = process.hrtime.bigint();
  const cat = decodeLive(JSON.parse(stored));
  const decodeMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(cat.channels.length, 50000);
  assert.equal(stored.indexOf('demo_pass_9f3k'), -1);
  assert.ok(stored.length < text.length * 0.6, 'compact form: ' + stored.length + ' vs ' + text.length);
  console.log('m3u import [W]: ' + (text.length / 1e6).toFixed(1) + ' M chars -> ' + (stored.length / 1e6).toFixed(2) +
    ' M stored, 50,000 channels, import ' + ms.toFixed(0) + ' ms, decode ' + decodeMs.toFixed(0) + ' ms, heap +' +
    ((process.memoryUsage().heapUsed - heap0) / 1048576).toFixed(0) + ' MB');
});
