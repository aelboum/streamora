// Stage 5.1: gzip-compressed XMLTV guides. The streaming decoder (src/content/gzip.ts) against
// Node's zlib, and the EPG refresh path end to end (real PlaylistService and EpgService over memory
// stores and the fake HTTP server, which models the TV's x-user-defined binary downloads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, constants } from 'node:zlib';
import { createByteTextDecoder, gzipByName, startsLikeGzip } from '../../src/content/gzip.ts';
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
const NOW = Date.UTC(2025, 10, 23, 12, 15);

/** Feeds bytes to a decoder in pieces of `piece` bytes; returns the text and the error. */
function decode(buf, piece, max = 1e9) {
  const d = createByteTextDecoder({ maxOutputBytes: max });
  const s = buf.toString('latin1');
  let out = '';
  for (let i = 0; i < s.length; i += piece) out += d.push(s.substring(i, i + piece));
  out += d.end();
  return { out, err: d.error(), gz: d.compressed(), bytes: d.outputBytes() };
}

function bigGuide(channels, perChannel) {
  const t = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').substring(0, 14) + ' +0000';
  const base = Date.UTC(2025, 10, 23, 10);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n'];
  for (let c = 0; c < channels; c++) parts.push('<channel id="ch' + c + '"><display-name>Channel ' + c + '</display-name></channel>\n');
  for (let c = 0; c < channels; c++) {
    for (let k = 0; k < perChannel; k++) {
      const s = base + k * 3600000;
      parts.push('<programme start="' + t(s) + '" stop="' + t(s + 3600000) + '" channel="ch' + c + '"><title>Prog ' + k + ' ch ' + c +
        ' – café</title><desc>Description ' + k + ' &amp; ' + c + ' 𝄞</desc></programme>\n');
    }
  }
  parts.push('</tv>\n');
  return parts.join('');
}

test('gzip decoder: identical to zlib for every strategy, piece size and multi-member files; UTF-8 split anywhere', () => {
  const text = bigGuide(40, 26);
  const variants = {
    default: gzipSync(text),
    best: gzipSync(text, { level: 9 }),
    stored: gzipSync(text, { level: 0 }),
    fixed: gzipSync(text, { strategy: constants.Z_FIXED }),
    huffman: gzipSync(text, { strategy: constants.Z_HUFFMAN_ONLY }),
    rle: gzipSync(text, { strategy: constants.Z_RLE }),
    multi: Buffer.concat([gzipSync(text.slice(0, 7777)), gzipSync(text.slice(7777))])
  };
  for (const name of Object.keys(variants)) {
    for (const piece of [1, 3, 97, 2048, 1 << 22]) {
      if (piece === 1 && variants[name].length > 300000) continue;
      const r = decode(variants[name], piece);
      assert.equal(r.err, null, name + '/' + piece);
      assert.equal(r.gz, true);
      assert.ok(r.out === text, name + ' piece ' + piece + ': output differs');
    }
  }
  // Header with every optional field (FEXTRA, FNAME, FCOMMENT, FHCRC) built by hand.
  const plain = gzipSync('<tv></tv>');
  const body = plain.subarray(10);
  const head = Buffer.from([0x1f, 0x8b, 8, 4 | 8 | 16 | 2, 0, 0, 0, 0, 0, 3, 3, 0, 1, 2, 3]);
  const withFields = Buffer.concat([head, Buffer.from('guide.xml\0a comment\0'), Buffer.from([0xaa, 0xbb]), body]);
  const rf = decode(withFields, 5);
  assert.deepEqual([rf.out, rf.err], ['<tv></tv>', null]);
  // Trailing zero padding after a complete member is ignored (as gzip(1) does).
  const rp = decode(Buffer.concat([plain, Buffer.alloc(100)]), 64);
  assert.deepEqual([rp.out, rp.err], ['<tv></tv>', null]);
});

test('gzip decoder: plain data, empty input, bad header, truncation, corruption, checksum and size limits', () => {
  // Not gzip at all: decoded as UTF-8 (a .gz URL served uncompressed or decoded by Content-Encoding).
  const r0 = decode(Buffer.from('<tv>é</tv>'), 1);
  assert.deepEqual([r0.out, r0.err, r0.gz], ['<tv>é</tv>', null, false]);
  // Empty file and a lone byte.
  const e = createByteTextDecoder({ maxOutputBytes: 100 });
  assert.equal(e.end(), '');
  assert.equal(e.error(), 'empty');
  assert.equal(decode(Buffer.from([0x1f]), 1).err, null, 'one byte is not gzip; the XMLTV parser rejects it later');
  const gz = gzipSync(bigGuide(20, 26));
  // Bad header: wrong method, reserved flags.
  const badCm = Buffer.from(gz); badCm[2] = 7;
  assert.equal(decode(badCm, 4096).err, 'bad-header');
  const badFlg = Buffer.from(gz); badFlg[3] = 0x20;
  assert.equal(decode(badFlg, 4096).err, 'bad-header');
  // Truncated at many points, including inside the header and the trailer.
  for (const cut of [5, 11, 100, gz.length >> 1, gz.length - 9, gz.length - 4, gz.length - 1]) {
    assert.equal(decode(gz.subarray(0, cut), 1000).err, 'truncated', 'cut at ' + cut);
  }
  // Corrupted compressed data: every flipped byte is detected, never accepted.
  let detected = 0;
  for (let i = 20; i < gz.length - 8; i += Math.max(1, Math.floor(gz.length / 60))) {
    const c = Buffer.from(gz); c[i] ^= 0x5a;
    const r = decode(c, 4096);
    assert.ok(r.err === 'bad-data' || r.err === 'checksum' || r.err === 'truncated', 'byte ' + i + ' → ' + r.err);
    detected++;
  }
  assert.ok(detected > 40);
  // Damaged trailer: CRC and ISIZE.
  const crc = Buffer.from(gz); crc[gz.length - 8] ^= 1;
  assert.equal(decode(crc, 4096).err, 'checksum');
  const isize = Buffer.from(gz); isize[gz.length - 1] ^= 1;
  assert.equal(decode(isize, 4096).err, 'checksum');
  // Decompression bomb: 50 MB of zeros compress to ≈ 50 KB; the limit stops it early.
  const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024), { level: 9 });
  const d = createByteTextDecoder({ maxOutputBytes: 1000000 });
  const s = bomb.toString('latin1');
  let produced = 0;
  for (let i = 0; i < s.length && !d.error(); i += 2048) produced += d.push(s.substring(i, i + 2048)).length;
  assert.equal(d.error(), 'too-large');
  assert.ok(d.outputBytes() < 1100000 && produced < 1100000, 'stopped within one output buffer of the limit');
  // Plain data over the limit.
  assert.equal(decode(Buffer.alloc(5000, 0x41), 100, 1000).err, 'too-large');
});

test('gzip detection helpers', () => {
  assert.equal(gzipByName('http://x.example/epg/guide.xml.gz'), true);
  assert.equal(gzipByName('http://x.example/guide.XML.GZ?user=a&pass=b'), true);
  assert.equal(gzipByName('http://x.example/guide.gzip#f'), true);
  assert.equal(gzipByName('http://x.example/guide.xml?file=a.gz'), false, 'only the path counts');
  assert.equal(gzipByName('http://x.example/xmltv.php?username=a'), false);
  assert.equal(startsLikeGzip('\u001f�\b'), true);
  assert.equal(startsLikeGzip('<?xml'), false);
  assert.equal(startsLikeGzip(''), false);
});

// ------------------------------------------------------------------ EPG refresh end to end

function env(route, limitsOver = {}) {
  const log = createLogger(500);
  const local = createMemoryLocalStore();
  const files = createMemoryFileStore();
  const kv = createKeyValueStore(local, log);
  const srv = createFakeServer((url, n) => route.fn(url, n));
  const http = createHttpClient({ xhrFactory: srv.factory });
  const catalogue = createCatalogueStore(files, { budgetChars: 50000000, maxChars: 50000000 }, () => NOW, log);
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), now: () => Date.now() };
  const playlists = createPlaylistService({
    kv, catalogue, secrets: createSecretStore(createMemoryKeyStore()), http, now: () => NOW, log, timers, retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000 }
  });
  const limits = Object.assign({ maxChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000, pastHours: 2, futureHours: 24, maxPerChannel: 300,
    maxTotal: 1000000, staleMs: 12 * 3600000, defaultOffsetMin: 0, maxGzipBytes: 20000000 }, limitsOver);
  const epg = createEpgService({ playlists, catalogue, http, now: () => NOW, timers, log, limits });
  return { epg, playlists, srv, log, files, catalogue, limits, timers };
}

const M3U = '#EXTM3U\n#EXTINF:-1 tvg-id="news.one.uk",News One HD\nhttp://s.example/1.ts\n#EXTINF:-1,Docs Channel\nhttp://s.example/2.ts\n';

async function setup(e, epgUrl) {
  const a = await e.playlists.add({ name: 'P', kind: 'm3u', url: 'http://s.example/list.m3u', epgUrl });
  assert.equal(a.ok, true, JSON.stringify(a));
  await e.playlists.refresh(a.playlist.id).result;
  const l = await e.playlists.loadLive(a.playlist.id);
  await e.epg.load(a.playlist.id);
  return { id: a.playlist.id, channels: l.catalogue.channels };
}

function server(guideRoute) {
  return {
    fn: (url, n) => {
      if (url.endsWith('list.m3u')) return { status: 200, body: M3U };
      return guideRoute(url, n);
    }
  };
}

test('EPG refresh reads gzip guides: .gz name, Content-Type, magic bytes, Content-Encoding; uncompressed unchanged', async () => {
  const gz = gzipSync(Buffer.from(GUIDE));
  const cases = [
    ['plain XMLTV (regression)', 'http://g.example/guide.xml', () => ({ status: 200, body: GUIDE, chunk: 97 }), 1, false],
    ['.gz name', 'http://g.example/guide.xml.gz', () => ({ status: 200, body: gz, chunk: 61 }), 1, true],
    ['Content-Type application/gzip, no .gz name', 'http://g.example/epg?id=1', () => ({ status: 200, body: gz, headers: { 'Content-Type': 'application/gzip' } }), 2, true],
    ['no hint but the magic bytes', 'http://g.example/epg.php', () => ({ status: 200, body: gz, headers: { 'Content-Type': 'application/octet-stream' } }), 2, true],
    ['.gz name with Content-Encoding gzip (browser decodes)', 'http://g.example/guide.xml.gz', () => ({ status: 200, body: gz, contentEncoding: 'gzip' }), 1, true],
    ['.gz name served uncompressed', 'http://g.example/guide.xml.gz', () => ({ status: 200, body: Buffer.from(GUIDE) }), 1, true]
  ];
  for (const [label, url, route, requests, binary] of cases) {
    const e = env(server(route));
    const { id, channels } = await setup(e, url);
    const r = await e.epg.refresh(id, channels).result;
    assert.equal(r.ok, true, label + ': ' + JSON.stringify(r));
    const news = channels.find((c) => c.name === 'News One HD');
    assert.equal(e.epg.nowNext(news).now.title, 'Midday "Special"', label);
    const docs = channels.find((c) => c.name === 'Docs Channel');
    assert.equal(e.epg.nowNext(docs).now.title, 'Planet Docs', label + ': display-name mapping');
    const guideRequests = e.srv.requests.filter((q) => q.url === url);
    assert.equal(guideRequests.length, requests, label + ': requests (a text download restarts once as binary)');
    const last = guideRequests[guideRequests.length - 1];
    assert.equal(!!(last.mime && /x-user-defined/.test(last.mime)), binary, label + ': binary download');
  }
});

test('EPG refresh with damaged or oversized gzip guides fails cleanly and keeps the previous guide', async () => {
  const good = gzipSync(Buffer.from(GUIDE));
  const truncated = good.subarray(0, good.length - 20);
  const corrupt = Buffer.from(good); corrupt[good.length >> 1] ^= 0xff; corrupt[(good.length >> 1) + 1] ^= 0xff;
  const badHeader = Buffer.from(good); badHeader[2] = 9;
  const empty = Buffer.alloc(0);
  const bomb = gzipSync(Buffer.alloc(30 * 1024 * 1024, 0x20), { level: 9 });
  let body = good;
  const e = env(server(() => ({ status: 200, body })), { maxChars: 2000000 });
  const { id, channels } = await setup(e, 'http://g.example/guide.xml.gz');
  assert.equal((await e.epg.refresh(id, channels).result).ok, true);
  const news = channels.find((c) => c.name === 'News One HD');
  for (const [label, b, code] of [['truncated', truncated, 'bad-gzip'], ['corrupt', corrupt, 'bad-gzip'], ['bad header', badHeader, 'bad-gzip'],
    ['empty file', empty, 'bad-gzip'], ['decompressed size over the limit', bomb, 'too-large']]) {
    body = b;
    const r = await e.epg.refresh(id, channels).result;
    assert.deepEqual([r.ok, r.code], [false, code], label);
    assert.equal(e.epg.status().error, code);
    assert.equal(e.epg.nowNext(news).now.title, 'Midday "Special"', label + ': previous guide kept');
    assert.equal(e.epg.status().state, 'ready');
  }
  // Compressed download over its own cap.
  const e2 = env(server(() => ({ status: 200, body: good })), { maxGzipBytes: 100 });
  const s2 = await setup(e2, 'http://g.example/guide.xml.gz');
  assert.equal((await e2.epg.refresh(s2.id, s2.channels).result).code, 'too-large');
});

test('EPG refresh: engines without overrideMimeType report gzip as unsupported; credentials never logged', async () => {
  const gz = gzipSync(Buffer.from(GUIDE));
  const url = 'http://g.example/guide.xml.gz?username=demo_user&password=demo_pass_9f3k';
  const e = env(server(() => ({ status: 200, body: gz })));
  const { id, channels } = await setup(e, url);
  const r = await e.epg.refresh(id, channels).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(JSON.stringify(e.log.entries()).includes('demo_pass_9f3k'), false, 'no credentials in the log');
  assert.equal(e.files.peek('cat.' + id + '.epg.json').includes('demo_pass_9f3k'), false, 'no credentials in the cache');
  // Same server, an XHR without overrideMimeType.
  const http = createHttpClient({ xhrFactory: () => { const x = e.srv.factory(); delete x.overrideMimeType; return x; } });
  const e3 = createEpgService({ playlists: e.playlists, catalogue: e.catalogue, http, now: () => NOW, timers: e.timers, log: e.log, limits: e.limits });
  await e3.load(id);
  const r3 = await e3.refresh(id, channels).result;
  assert.deepEqual([r3.ok, r3.code], [false, 'gzip-unsupported']);
  assert.equal(e3.status().state, 'ready', 'the cached guide is still used');
});

test('large gzip guide: decompression and parsing stay in short slices (event loop keeps running)', async () => {
  const xml = bigGuide(3000, 26); // ≈ 14 MB of XMLTV, 78,000 programmes
  const gz = gzipSync(Buffer.from(xml));
  const e = env(server(() => ({ status: 200, body: gz, chunk: 65536 })));
  const { id } = await setup(e, 'http://g.example/big.xml.gz');
  const channels = [];
  for (let c = 0; c < 3000; c++) channels.push({ id: 'c' + c, name: 'Channel ' + c, epgKey: 'ch' + c });
  let maxGap = 0;
  let ticks = 0;
  let last = Date.now();
  const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 5);
  const t0 = Date.now();
  const r = await e.epg.refresh(id, channels).result;
  clearInterval(iv);
  const ms = Date.now() - t0;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.programmes, 3000 * 26);
  assert.ok(ticks > 20, 'the event loop ran during the refresh (' + ticks + ' ticks)');
  assert.ok(maxGap < 300, 'longest event-loop gap ' + maxGap + ' ms');
  console.log('# large gzip guide: ' + (xml.length / 1e6).toFixed(1) + ' MB XMLTV, ' + (gz.length / 1e6).toFixed(2) + ' MB gzip, refresh ' + ms + ' ms, longest gap ' + maxGap + ' ms, ' + ticks + ' ticks');
});
