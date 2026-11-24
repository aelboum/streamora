// XMLTV parsing, time zones, channel mapping, now/next, missing data, EPG caching and refresh
// (real PlaylistService and EpgService over memory stores and the fake HTTP server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createXmltvParser, parseXmltvTime, decodeEntities } from '../../src/content/xmltv-parser.ts';
import { createEpgBuilder, epgKeyFor, nowNext, normaliseName } from '../../src/content/epg-index.ts';
import { createEpgService } from '../../src/services/epg-service.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';

const GUIDE = readFileSync(new URL('../fixtures/xmltv/guide.xml', import.meta.url), 'utf8');
const M3U = readFileSync(new URL('../fixtures/m3u/provider-extended.m3u', import.meta.url), 'utf8');
const NOW = Date.UTC(2025, 10, 23, 12, 15); // 12:15 UTC
const U = (h, m = 0) => Date.UTC(2025, 10, 23, h, m);

function parse(text, chunk) {
  const channels = [];
  const progs = [];
  const p = createXmltvParser((c) => channels.push(c), (x) => progs.push(x));
  if (!chunk) p.push(text); else for (let i = 0; i < text.length; i += chunk) p.push(text.substring(i, i + chunk));
  return { channels, progs, sum: p.end() };
}

test('XMLTV time parsing: offsets, Z, missing seconds, default offset, invalid', () => {
  assert.equal(parseXmltvTime('20251123130000 +0100', 0), U(12));
  assert.equal(parseXmltvTime('20251123073000 -0500', 0), U(12, 30));
  assert.equal(parseXmltvTime('20251123120000Z', 0), U(12));
  assert.equal(parseXmltvTime('20251123120000 +05:30', 0), U(6, 30));
  assert.equal(parseXmltvTime('202511231400', 0), U(14), 'no seconds, no offset = UTC');
  assert.equal(parseXmltvTime('202511231400', 60), U(13), 'configured default offset +01:00');
  for (const bad of ['', 'garbage', '20251323120000 +0000', '20251123250000 +0000', '20251123120000 +1900']) {
    assert.ok(Number.isNaN(parseXmltvTime(bad, 0)), bad);
  }
});

test('XMLTV parsing: channels, programmes, entities, CDATA, skipped elements, invalid entries', () => {
  const { channels, progs, sum } = parse(GUIDE);
  assert.equal(sum.verdict, 'xmltv');
  assert.deepEqual(channels.map((c) => c.id), ['news.one.uk', 'SPORT.MAX.UK', 'docs.xmltv.id', 'kids.fun.nl', 'not.in.playlist']);
  assert.deepEqual(channels[0], { id: 'news.one.uk', names: ['News One HD'], icon: 'http://logos.example.org/uk/news-one.png' });
  assert.equal(sum.programmes, 9);
  assert.equal(sum.invalid, 3, 'stop before start, bad start, no channel');
  const first = progs[0];
  assert.deepEqual([first.channel, first.start, first.stop, first.title], ['news.one.uk', U(11), U(12), 'Morning News']);
  assert.equal(first.desc, 'Headlines & weather — live <studio>.', 'entities decoded, markup stays text');
  assert.equal(progs[1].title, 'Midday "Special"');
  assert.equal(progs[1].subTitle, 'Part 1');
  assert.equal(progs[1].desc, 'Raw <b>text</b> & more', 'CDATA kept literally');
  assert.equal(progs[1].category, 'News');
  assert.equal(progs[8].title, 'Cartoons 😀', 'numeric entity beyond the BMP');
  assert.equal(decodeEntities('&unknown; &#0; &#xD800;'), '&unknown;  ', 'unknown entities kept, invalid code points dropped');
});

test('XMLTV parsing is identical for every chunk size (incremental)', () => {
  const whole = parse(GUIDE);
  for (const size of [1, 2, 7, 64, 333]) {
    const r = parse(GUIDE, size);
    assert.deepEqual(r.progs, whole.progs, 'chunk ' + size);
    assert.deepEqual(r.channels, whole.channels, 'chunk ' + size);
    assert.deepEqual(r.sum, whole.sum, 'chunk ' + size);
  }
});

test('XMLTV verdicts and hostile input: gzip bytes, HTML, huge tags, markup in titles', () => {
  assert.equal(parse(gzipSync(Buffer.from(GUIDE)).toString('latin1')).sum.verdict, 'not-xmltv', 'compressed file served without Content-Encoding');
  assert.equal(parse('<html><body>Login</body></html>').sum.verdict, 'not-xmltv');
  assert.equal(parse('').sum.verdict, 'not-xmltv');
  const huge = '<tv><channel id="a"><display-name>' + 'x'.repeat(5000) + '</display-name></channel><' + 'y'.repeat(20000) +
    '<programme start="20251123110000 +0000" stop="20251123120000 +0000" channel="a"><title><script>alert(1)</script></title></programme></tv>';
  const r = parse(huge, 1000);
  assert.equal(r.channels[0].names[0].length, 200, 'names capped');
  assert.ok(r.sum.malformed >= 1, 'over-long tag skipped');
  assert.equal(r.progs.length, 1);
  assert.equal(r.progs[0].title.includes('<script>'), false, 'element markup inside a title is never kept as markup');
});

const CHANNELS = [
  { id: 'a', num: 1, name: 'News One HD', epgKey: 'news.one.uk', categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/1' } },
  { id: 'b', num: 2, name: 'Sport Max 1', epgKey: 'sport.max.uk', categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/2' } },
  { id: 'c', num: 3, name: 'Docs Channel', epgKey: 'uk.docs', categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/3' } },
  { id: 'd', num: 4, name: 'Kids Fun', epgKey: 'kids.fun.nl', categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/4' } },
  { id: 'e', num: 5, name: 'No Guide TV', categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/5' } }
];

function buildIndex() {
  const b = createEpgBuilder(CHANNELS, NOW - 2 * 3600000, NOW + 24 * 3600000, 300, 100000);
  createXmltvParser((c) => b.addChannel(c.id, c.names), (p) => b.addProgramme(p.channel, p.start, p.stop, p.title, p.desc)).push(GUIDE);
  return b.finish(NOW);
}

test('channel mapping (tvg-id case-insensitive, display name), window filter and now/next', () => {
  const { payload, channels, programmes } = buildIndex();
  assert.equal(channels, 4);
  assert.equal(programmes, 7, 'outside-window and unmapped programmes dropped');
  assert.equal(payload.ch['not.in.playlist'], undefined);
  assert.equal(epgKeyFor(payload, CHANNELS[0]), 'news.one.uk');
  assert.equal(epgKeyFor(payload, CHANNELS[1]), 'sport.max.uk', 'tvg-id matched regardless of case');
  assert.equal(epgKeyFor(payload, CHANNELS[2]), 'docs.xmltv.id', 'mapped by display name');
  assert.equal(epgKeyFor(payload, CHANNELS[4]), null, 'missing EPG');
  const nn = nowNext(payload.ch['news.one.uk'], NOW);
  assert.deepEqual([nn.now.title, nn.now.start, nn.now.end], ['Midday "Special"', U(12), U(12, 30)]);
  assert.equal(nn.next.title, 'Afternoon Report');
  assert.equal(nn.now.desc, 'Raw <b>text</b> & more');
  const sport = nowNext(payload.ch['sport.max.uk'], NOW);
  assert.deepEqual([sport.now.title, sport.next.start], ['Live Football', U(14)]);
  const gap = nowNext(payload.ch['news.one.uk'], U(13, 30));
  assert.deepEqual([gap.now, gap.next], [null, null], 'after the last programme: nothing');
  const before = nowNext(payload.ch['news.one.uk'], U(10, 30));
  assert.deepEqual([before.now, before.next.title], [null, 'Morning News'], 'before the first programme: next only');
  assert.deepEqual(nowNext(undefined, NOW), { now: null, next: null });
  assert.equal(normaliseName('Sport-Max 1 HD'), 'sportmax1');
});

function env(route) {
  let now = NOW;
  const log = createLogger(500);
  const local = createMemoryLocalStore();
  const files = createMemoryFileStore();
  const kv = createKeyValueStore(local, log);
  const srv = createFakeServer((url, n) => route.fn(url, n));
  const http = createHttpClient({ xhrFactory: srv.factory });
  const catalogue = createCatalogueStore(files, { budgetChars: 5000000, maxChars: 20000000 }, () => now, log);
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), now: () => now };
  const playlists = createPlaylistService({
    kv, catalogue, secrets: createSecretStore(createMemoryKeyStore()), http, now: () => now, log, timers, retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000 }
  });
  const limits = { maxChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000, pastHours: 2, futureHours: 24, maxPerChannel: 300, maxTotal: 100000, staleMs: 12 * 3600000, defaultOffsetMin: 0, maxGzipBytes: 5000000 };
  const epg = createEpgService({ playlists, catalogue, http, now: () => now, timers, log, limits });
  return { epg, playlists, files, srv, log, catalogue, limits, timers, setNow: (t) => { now = t; } };
}

const XMLTV_URL = 'http://provider.example:8080/xmltv.php?username=demo_user&password=demo_pass_9f3k';
const routes = (over = {}) => ({
  fn: (url) => {
    if (over[url]) return over[url]();
    if (url.includes('get.php')) return { status: 200, body: M3U };
    if (url.includes('xmltv.php')) return { status: 200, body: GUIDE, chunk: 97 };
    if (url.includes('guide.xml.gz')) return { status: 200, body: gzipSync(Buffer.from(GUIDE)).toString('latin1') };
    return { status: 404, body: '' };
  }
});
const PL = 'http://provider.example:8080/get.php?username=demo_user&password=demo_pass_9f3k';

async function playlistWithChannels(e) {
  const p = (await e.playlists.add({ name: 'P', kind: 'm3u', url: PL })).playlist;
  await e.playlists.refresh(p.id).result;
  const l = await e.playlists.loadLive(p.id);
  return { id: p.id, channels: l.catalogue.channels };
}

test('EPG refresh from the playlist sources: mapping, caching, reload from cache, credentials only to their origin', async () => {
  const e = env(routes());
  const { id, channels } = await playlistWithChannels(e);
  assert.equal((await e.epg.load(id)).state, 'none', 'missing EPG before the first refresh');
  assert.equal(e.epg.isStale(), true);
  const r = await e.epg.refresh(id, channels).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sources, 2, 'xmltv.php (credentials resolved) and guide.xml.gz');
  assert.ok(r.programmes >= 5);
  assert.ok(e.srv.requests.some((q) => q.url === XMLTV_URL));
  const news = channels.find((c) => c.name === 'News One HD');
  assert.equal(e.epg.nowNext(news).now.title, 'Midday "Special"');
  const docs = channels.find((c) => c.name === 'Docs Channel');
  assert.equal(e.epg.nowNext(docs).now.title, 'Planet Docs', 'display-name mapping');
  const two = channels.find((c) => c.name === 'News Two');
  assert.deepEqual(e.epg.nowNext(two), { now: null, next: null }, 'channel without EPG');
  assert.equal(e.epg.status().state, 'ready');
  assert.equal(e.epg.isStale(), false);
  assert.ok((await e.files.list()).includes('cat.' + id + '.epg.json'));
  assert.equal(e.files.peek('cat.' + id + '.epg.json').includes('demo_pass_9f3k'), false, 'no credentials in the cache');
  assert.equal(JSON.stringify(e.log.entries()).includes('demo_pass_9f3k'), false, 'no credentials in the log');
  // Fresh service instance (restart): reads the cache without any network request.
  const before = e.srv.requests.length;
  const e2 = createEpgService({ playlists: e.playlists, catalogue: e.catalogue, http: null, now: () => NOW, timers: e.timers, log: e.log, limits: e.limits });
  assert.equal((await e2.load(id)).state, 'ready');
  assert.equal(e2.nowNext(news).now.title, 'Midday "Special"');
  assert.equal(e.srv.requests.length, before);
  assert.deepEqual(e.epg.programmes(news, U(11), U(13), 10).map((p) => p.title), ['Morning News', 'Midday "Special"', 'Afternoon Report']);
});

test('EPG refresh: failures keep the cached guide; staleness; abort; playlist without EPG', async () => {
  const route = routes();
  const e = env(route);
  const { id, channels } = await playlistWithChannels(e);
  await e.epg.load(id);
  await e.epg.refresh(id, channels).result;
  const news = channels.find((c) => c.name === 'News One HD');
  route.fn = () => ({ fail: 'network' });
  const f = await e.epg.refresh(id, channels).result;
  assert.deepEqual([f.ok, f.code], [false, 'network']);
  assert.equal(e.epg.status().error, 'network');
  assert.equal(e.epg.nowNext(news).now.title, 'Midday "Special"', 'old guide still used');
  e.setNow(NOW + 13 * 3600000);
  assert.equal(e.epg.isStale(), true, 'older than 12 h');
  route.fn = () => ({ fail: 'hang' });
  const job = e.epg.refresh(id, channels);
  await new Promise((r) => setTimeout(r, 20));
  job.abort();
  assert.equal((await job.result).code, 'aborted');
  const e3 = env({ fn: () => ({ status: 200, body: '#EXTM3U\n#EXTINF:-1,A\nhttp://s.example/1\n' }) });
  const p3 = (await e3.playlists.add({ name: 'N', kind: 'm3u', url: 'http://s.example/list.m3u' })).playlist;
  await e3.playlists.refresh(p3.id).result;
  await e3.epg.load(p3.id);
  const r3 = await e3.epg.refresh(p3.id, []).result;
  assert.deepEqual([r3.ok, r3.code], [false, 'no-source']);
  assert.equal(e3.epg.status().state, 'none');
});

test('EPG refresh replaces the guide when the source changes; a failed source keeps the old guide', async () => {
  const route = routes();
  const e = env(route);
  const { id, channels } = await playlistWithChannels(e);
  await e.epg.load(id);
  await e.epg.refresh(id, channels).result;
  const news = channels.find((c) => c.name === 'News One HD');
  route.fn = routes({ [XMLTV_URL]: () => ({ status: 200, body: GUIDE.replace('Midday &quot;Special&quot;', 'Changed Title') }) }).fn;
  assert.equal((await e.epg.refresh(id, channels).result).ok, true);
  assert.equal(e.epg.nowNext(news).now.title, 'Changed Title');
  route.fn = routes({
    [XMLTV_URL]: () => ({ status: 404, body: '' }),
    'http://epg.example.org/guide.xml.gz': () => ({ status: 200, body: gzipSync(Buffer.from(GUIDE)).subarray(0, 200) })
  }).fn;
  const r = await e.epg.refresh(id, channels).result;
  assert.deepEqual([r.ok, r.code], [false, 'http'], 'first failure reported (the truncated .gz source fails too)');
  assert.equal(e.epg.nowNext(news).now.title, 'Changed Title', 'previous guide kept');
});

test('Xtream short EPG fallback for channels without XMLTV data', async () => {
  const xt = (name) => readFileSync(new URL('../fixtures/xtream/' + name, import.meta.url), 'utf8');
  const e = env({
    fn: (url) => {
      const a = (/[?&]action=([a-z_]+)/.exec(url) || [])[1] || '';
      if (url.includes('xmltv.php')) return { status: 200, body: '<tv></tv>' };
      if (a === '') return { status: 200, body: xt('auth-ok.json') };
      if (a === 'get_live_categories') return { status: 200, body: xt('live-categories.json') };
      if (a === 'get_live_streams') return { status: 200, body: xt('live-streams.json') };
      if (a === 'get_short_epg') return { status: 200, body: xt('short-epg.json') };
      return { status: 404 };
    }
  });
  const p = (await e.playlists.add({ name: 'X', kind: 'xtream', server: 'http://provider.example:8080', username: 'demo_user', password: 'demo_pass_9f3k' })).playlist;
  await e.playlists.refresh(p.id).result;
  const ch = (await e.playlists.loadLive(p.id)).catalogue.channels;
  const st = await e.epg.load(p.id);
  assert.equal(st.shortEpg, true);
  await e.epg.refresh(p.id, ch).result;
  const news = ch.find((c) => c.name === 'News One HD');
  assert.deepEqual(e.epg.nowNext(news), { now: null, next: null });
  const list = await e.epg.shortEpg(news);
  assert.deepEqual(list.map((x) => x.title), ['Morning News', 'Café Ünïon', '']);
  const n = e.srv.requests.length;
  await e.epg.shortEpg(news);
  assert.equal(e.srv.requests.length, n, 'cached for 15 minutes');
});
