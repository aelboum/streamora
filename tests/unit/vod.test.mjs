// Stage 6 / 6.1: movies and series. Xtream parsing (categories, lists, vod/series info, episodes),
// VodService (import, persistence through a TV-like file store, incremental updates, missing-file
// recovery, empty and malformed responses, large catalogues), playback URL construction and
// credential redaction. Synthetic fixtures: tests/fakes/fake-xtream-vod.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVodStream, parseSeries, parseVodInfo, parseSeriesInfo } from '../../src/api/xtream/xtream-types.ts';
import { createVodPageWriter, createVodView, isVodIndex } from '../../src/content/vod-pages.ts';
import { createVodService } from '../../src/services/vod-service.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore, pageFileName } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { xtreamVodRoute, byCategory, manyMovies, MOVIES, SERIES, SERIES_INFO, VOD_INFO } from '../fakes/fake-xtream-vod.mjs';

const PASS = 'demo_pass_9f3k';
const XT = { name: 'XT', kind: 'xtream', server: 'provider.example:8080', username: 'demo_user', password: PASS };

/** A FileStore that damages non-ASCII text, as the TV's FileStream does (Stage 5.2). */
function tvLikeFiles() {
  const mem = createMemoryFileStore();
  return {
    atomicReplace: true, read: (n) => mem.read(n), write: (n, t) => mem.write(n, t.replace(/[^\x00-\x7f]/g, '�')),
    remove: (n) => mem.remove(n), list: () => mem.list()
  };
}

function setup(route, files) {
  let t = 1763856000000;
  const now = () => (t += 7);
  const log = createLogger(3000, now);
  const kv = createKeyValueStore(createMemoryLocalStore(), log);
  const srv = createFakeServer((url) => route.fn(url));
  const catalogue = createCatalogueStore(files || tvLikeFiles(), { budgetChars: 50000000, maxChars: 100000000 }, now, log);
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
  const playlists = createPlaylistService({
    kv, catalogue, secrets: createSecretStore(createMemoryKeyStore()), http: createHttpClient({ xhrFactory: srv.factory }), now, log: log.child('playlists'),
    timers, retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000 }
  });
  const vod = createVodService({ playlists, catalogue, kv, now, log: log.child('vod') });
  return { playlists, vod, log, kv, srv, catalogue };
}

// ---------------------------------------------------------------- parsing

test('movie list entries: tolerant typing, ratings, years, extensions, unsafe images dropped, invalid entries rejected', () => {
  const p = MOVIES.map(parseVodStream);
  assert.deepEqual(p[0], { streamId: '5001', name: 'The Long Night (2019)', icon: 'http://img.example.org/posters/5001.jpg', categoryId: '10', rating: 7.4, added: 1700000000, year: 2019, ext: 'mkv', adult: false });
  assert.equal(p[1].streamId, '5002');
  assert.equal(p[1].rating, 8.4, 'rating_5based × 2 when rating is empty');
  assert.equal(p[1].ext, 'mp4', 'extension lower-cased');
  assert.equal(p[1].name, 'Amélie ✨ 🇫🇷', 'Unicode kept');
  assert.equal(p[2].icon, '', 'javascript: image URL rejected');
  assert.equal(p[2].rating, null);
  assert.equal(p[3].categoryId, '', 'null category');
  assert.equal(p[5].adult, true);
  assert.equal(p[6], null, 'empty name');
  assert.equal(p[7], null, 'id with a space');
  assert.equal(p[9], null, 'null entry');
  assert.equal(parseVodStream({ stream_id: 1, name: 'x', rating: '11', rating_5based: '6' }).rating, null, 'out-of-range ratings');
  assert.equal(parseVodStream({ stream_id: 1, name: 'x', added: '-5' }).added, null);
});

test('series list entries and vod info: missing fields become empty, never errors', () => {
  const s = SERIES.map(parseSeries);
  assert.deepEqual(s[0], { seriesId: '7001', name: 'City Lights', cover: 'http://img.example.org/covers/7001.jpg', categoryId: '20', rating: 8.1, year: 2018, genre: 'Drama, Crime', updated: 1700000000 });
  assert.deepEqual([s[1].cover, s[1].rating, s[1].year, s[1].genre], ['', null, null, '']);
  assert.equal(s[5], null);
  const v = parseVodInfo(VOD_INFO[5001]);
  assert.deepEqual([v.name, v.genre, v.durationSec, v.year, v.rating, v.ext, v.backdrop], ['The Long Night', 'Thriller', 6300, 2019, 7.4, 'mkv', 'http://img.example.org/bd/5001.jpg']);
  assert.equal(v.plot, 'A long night in a small town – “with Unicode”.');
  const v2 = parseVodInfo(VOD_INFO[5002]);
  assert.deepEqual([v2.plot, v2.durationSec, v2.director, v2.poster], ['Une fille à Paris.', 7320, '', ''], 'description fallback, hh:mm:ss duration');
  assert.equal(parseVodInfo(VOD_INFO[5003]).name, '', 'info sent as an array');
  assert.equal(parseVodInfo(VOD_INFO[5004]), null);
});

test('series info: seasons sorted, episodes sorted, invalid episodes counted, arrays of arrays, missing seasons', () => {
  const a = parseSeriesInfo(SERIES_INFO[7001], 'City Lights');
  assert.deepEqual(a.seasons.map((s) => [s.number, s.name, s.episodes.map((e) => e.episode)]), [[1, 'Season One', [1, 2]], [2, 'Season Two', [1]]],
    'season 9 has no episodes and is left out');
  assert.equal(a.invalid, 2);
  const pilot = a.seasons[0].episodes[0];
  assert.deepEqual([pilot.id, pilot.title, pilot.ext, pilot.durationSec, pilot.plot, pilot.image], ['9101', 'Pilot 🎬', 'mp4', 2640, 'It begins.', 'http://img.example.org/ep/9101.jpg']);
  assert.equal(a.seasons[0].episodes[1].durationSec, 2640, '"00:44:00"');
  assert.equal(a.seasons[0].cover, 'http://img.example.org/s/1.jpg');
  const b = parseSeriesInfo(SERIES_INFO[7002], 'Fallback');
  assert.deepEqual([b.seasons.length, b.seasons[0].episodes[0].episode, b.seasons[0].episodes[0].title], [1, 1, ''], 'episode number from its position');
  const c = parseSeriesInfo(SERIES_INFO[7003], 'X');
  assert.deepEqual(c.seasons.map((s) => s.number), [1, 2], 'array of arrays');
  assert.equal(c.info.name, 'X', 'fallback name');
  assert.deepEqual(parseSeriesInfo(SERIES_INFO[7004], 'E').seasons, []);
  assert.equal(parseSeriesInfo(SERIES_INFO[7005], 'B'), null);
});

// ---------------------------------------------------------------- paged storage (Stage 6.1)

async function storedFiles(files, id) {
  const names = (await files.list()).filter((n) => n.indexOf('cat.' + id + '.') === 0);
  let chars = 0;
  let maxFile = 0;
  for (const n of names) {
    const len = (await files.read(n)).length;
    chars += len;
    if (len > maxFile) maxFile = len;
  }
  return { names, chars, maxFile };
}

test('paged writer and view: pages, runs per category, shared image prefixes, malformed rows skipped, LRU bound', async () => {
  const files = tvLikeFiles();
  const log = createLogger(100);
  const store = createCatalogueStore(files, { budgetChars: 50000000, maxChars: 100000000 }, () => 1, log);
  const w = createVodPageWriter(store, 'p1', 'movie', 'g1');
  const a = w.addCategory('10', 'Action', false);
  const x = w.addCategory('13', 'XXX | Adults', true);
  assert.equal(w.addCategory('10', 'again', false), a, 'repeated category id → same index');
  for (let i = 0; i < 2500; i++) {
    w.addItem(a, { id: String(i), name: 'Movie ' + i + (i === 1 ? ' é 🎬' : ''), image: i % 2 ? 'http://i.example/p/' + i + '.jpg' : '', year: i % 3 ? 2000 + (i % 20) : null, rating: i === 0 ? 7.25 : null, ext: 'mkv', genre: '', adult: false });
  }
  assert.equal(w.addItem(a, { id: '5', name: 'dup', image: '', year: null, rating: null, ext: '', genre: '', adult: false }), false, 'duplicate id dropped');
  w.addItem(x, { id: 'a1', name: 'Adult', image: '', year: null, rating: null, ext: '', genre: '', adult: false });
  const idx = await w.finish();
  assert.deepEqual([idx.t, idx.ip, idx.np, idx.p.length], [2501, 3, 1, 1]);
  assert.deepEqual(idx.c.map((c) => c[3]), [[0, 2500], [2500, 1]], 'each category one run');
  assert.equal(isVodIndex(JSON.parse(JSON.stringify(idx))), true);
  assert.equal(isVodIndex({ v: 1, s: 'movie', c: [], p: [], r: [] }), false, 'Stage 6 single-file list is not an index');
  const view = createVodView(store, 'p1', idx);
  assert.equal(view.item(0), null, 'nothing in memory before ensure');
  await view.ensure([0, 1, 2500]);
  assert.deepEqual(view.item(0), { id: '0', name: 'Movie 0', categoryId: '10', adult: false, rating: 7.3, ext: 'mkv' });
  assert.deepEqual([view.item(1).name, view.item(1).poster, view.item(1).year], ['Movie 1 é 🎬', 'http://i.example/p/1.jpg', 2001], 'Unicode survives the TV-like store');
  assert.deepEqual([view.item(2500).categoryId, view.item(2500).adult], ['13', true], 'adult category flags its titles');
  assert.equal(view.byCategory('13').length, 1);
  assert.equal(view.byCategory('13').at(0), 2500);
  assert.equal(view.byCategory('nope').length, 0);
  // A damaged row is skipped (shown as unavailable), not fatal for the page.
  const page = JSON.parse((await files.read('cat.p1.movie.g1-i1.json')).split('\n').slice(1).join('\n'));
  page.r[3] = ['x', 5];
  await store.savePage('p1', 'movie', 'g1', 'i', 1, page);
  const v2 = createVodView(store, 'p1', idx);
  await v2.ensure([1002, 1003]);
  assert.equal(v2.item(1003), null);
  assert.equal(v2.failed(1003), true);
  assert.equal(v2.item(1002).name, 'Movie 1002');
  // A missing page: positions report failed, not retried forever.
  await files.remove('cat.p1.movie.g1-i2.json');
  await v2.ensure([2400]);
  assert.equal(v2.failed(2400), true);
  assert.equal(v2.failed(0), false);
  // Store guards page names.
  assert.throws(() => pageFileName('p1', 'live', 'g1', 'i', 0));
  assert.throws(() => pageFileName('p1', 'movie', 'G/1', 'i', 0));
});

test('paged view: page cache stays bounded; requested items stay available (search hits on many pages)', async () => {
  const store = createCatalogueStore(createMemoryFileStore(), { budgetChars: 50000000, maxChars: 100000000 }, () => 1, createLogger(10));
  const w = createVodPageWriter(store, 'p1', 'movie', 'g2');
  const c = w.addCategory('1', 'C', false);
  for (let i = 0; i < 30000; i++) w.addItem(c, { id: String(i), name: 'T ' + i, image: '', year: null, rating: null, ext: '', genre: '', adult: false });
  const view = createVodView(store, 'p1', await w.finish());
  const spread = [];
  for (let k = 0; k < 28; k++) spread.push(k * 1000 + 7); // 28 cards on 28 different pages
  await view.ensure(spread);
  assert.ok(view.pagesInMemory() <= 8, 'at most 8 item pages in memory: ' + view.pagesInMemory());
  assert.equal(spread.every((p) => view.item(p) && view.item(p).name === 'T ' + p), true, 'all 28 requested items available');
});

test('paged search: word match, prefix matches first, Unicode, incremental progress, cancel', async () => {
  const store = createCatalogueStore(tvLikeFiles(), { budgetChars: 50000000, maxChars: 100000000 }, () => 1, createLogger(10));
  const w = createVodPageWriter(store, 'p1', 'movie', 'g3');
  const c = w.addCategory('1', 'C', false);
  const names = ['The Matrix', 'Matrix Reloaded', 'Amélie', 'Another Matrix Story', 'matrix'];
  for (let i = 0; i < 25000; i++) w.addItem(c, { id: String(i), name: i < names.length ? names[i] : 'Filler ' + i, image: '', year: null, rating: null, ext: '', genre: '', adult: false });
  const view = createVodView(store, 'p1', await w.finish());
  assert.deepEqual(await view.search('matrix', 10).result, [1, 4, 0, 3]);
  assert.deepEqual(await view.search('MATRIX story', 10).result, [3]);
  assert.deepEqual(await view.search('amé', 10).result, [2]);
  assert.deepEqual(await view.search('  ', 10).result, []);
  assert.equal((await view.search('matrix', 2).result).length, 2);
  const progress = [];
  const all = await view.search('filler 2', 5000, (r) => progress.push(r.length)).result;
  assert.ok(progress.length >= 2, 'results reported while the scan runs: ' + progress.join());
  assert.equal(all.length, 5000, 'filler 20-29, 200-299, 2000-2999, 20000-24999 = 6110 matches, capped at 5000');
  assert.ok(all.every((p) => p >= 5));
  const job = view.search('filler', 100000);
  job.cancel();
  assert.ok((await job.result).length < 25000, 'cancelled search stops early');
});

// ---------------------------------------------------------------- service

test('movies: import per category, persistence on a TV-like store (Unicode), reload after a restart, details, playback URL', async () => {
  const files = tvLikeFiles();
  const route = xtreamVodRoute();
  const e = setup(route, files);
  const id = (await e.playlists.add(XT)).playlist.id;
  assert.equal(e.vod.supported(id), true);
  assert.equal((await e.vod.load(id, 'movie')).status, 'missing');
  const r = await e.vod.refresh(id, 'movie').result;
  // Four categories → four list requests; per category: 5001, 5002, 5003, 5006. In category 10 the
  // empty name and the bad id are invalid and the duplicate 5001 is dropped.
  assert.deepEqual([r.ok, r.items, r.categories, r.invalid, r.unchanged, r.requests], [true, 4, 4, 2, false, 4], JSON.stringify(r));
  assert.equal(route.calls.filter((c) => c === 'get_vod_streams').length, 4);
  const st = await storedFiles(files, id);
  for (const n of st.names) assert.equal(/[^\x00-\x7f]/.test(await files.read(n)), false, n + ' stored as ASCII');
  assert.equal(st.names.filter((n) => /-i\d+\.json$/.test(n)).length, 1, 'one item page');
  // Fresh service over the same stores = app restart.
  const e2 = createVodService({ playlists: e.playlists, catalogue: e.catalogue, kv: e.kv, now: () => 1, log: e.log });
  const l = await e2.load(id, 'movie');
  assert.equal(l.status, 'ok');
  const v = l.view;
  assert.equal(v.total, 4);
  await v.ensure([0, 1, 2, 3]);
  const items = [0, 1, 2, 3].map((i) => v.item(i));
  assert.deepEqual(items.map((x) => x.name), ['The Long Night (2019)', 'Amélie ✨ 🇫🇷', 'فيلم عربي', 'Adult title']);
  assert.equal(v.categories.find((c) => c.id === '12').name, 'أفلام عربية');
  assert.equal(items[3].adult, true);
  assert.equal(e2.state(id, 'movie').items, 4);
  // Details on demand, cached.
  const det = await e2.movieDetails(id, items[0]);
  assert.equal(det.genre, 'Thriller');
  const calls = route.calls.length;
  await e2.movieDetails(id, items[0]);
  assert.equal(route.calls.length, calls, 'details cached');
  // Playback URL: /movie/<user>/<pass>/<id>.<ext>, built at play time.
  const src = await e2.resolve(id, e2.movieRef(id, items[0]));
  assert.deepEqual([src.url, src.type, src.live], ['http://provider.example:8080/movie/demo_user/' + PASS + '/5001.mkv', 'mkv', false]);
  assert.equal(e2.movieRef(id, items[3]).ext, 'mp4', 'mp4 when the provider gives no extension');
  assert.equal(JSON.stringify(e.log.entries()).includes(PASS), false, 'no credentials in the log');
  for (const n of st.names) assert.equal((await files.read(n)).includes(PASS), false, 'no credentials in ' + n);
});

test('no categories listed: the whole list in one request (fallback); uncategorised titles kept', async () => {
  const e = setup(xtreamVodRoute({ get_vod_categories: () => ({ status: 200, body: '[]' }) }));
  const id = (await e.playlists.add(XT)).playlist.id;
  const r = await e.vod.refresh(id, 'movie').result;
  assert.deepEqual([r.ok, r.items, r.requests], [true, 6, 0], JSON.stringify(r));
  const v = (await e.vod.load(id, 'movie')).view;
  await v.ensure([0, 1, 2, 3, 4, 5]);
  const byId = {};
  for (let i = 0; i < 6; i++) byId[v.item(i).id] = v.item(i).categoryId;
  assert.equal(byId['5004'], '_', 'no category_id → uncategorised');
  assert.equal(byId['5005'], '999');
  let noInfo = null;
  for (let i = 0; i < 6; i++) if (v.item(i).id === '5004') noInfo = v.item(i);
  assert.equal(await e.vod.movieDetails(id, noInfo), null, 'unusable info → null');
});

test('series: import, seasons and episodes from get_series_info, episode URLs', async () => {
  const route = xtreamVodRoute();
  const e = setup(route);
  const id = (await e.playlists.add(XT)).playlist.id;
  const r = await e.vod.refresh(id, 'series').result;
  assert.deepEqual([r.ok, r.items, r.requests], [true, 5, 2]);
  const v = (await e.vod.load(id, 'series')).view;
  await v.ensure([0, 1, 2, 3, 4]);
  const city = v.item(0);
  assert.deepEqual([city.name, city.genre, city.year, city.rating], ['City Lights', 'Drama, Crime', 2018, 8.1]);
  assert.equal(v.item(4).name, 'Bébé & Co 🧸');
  const s = await e.vod.seriesDetails(id, city);
  assert.deepEqual(s.seasons.map((x) => x.number), [1, 2]);
  const ep = s.seasons[0].episodes[0];
  assert.deepEqual(ep.streamRef, { kind: 'xtream', type: 'series', id: '9101', ext: 'mp4' });
  const src = await e.vod.resolve(id, ep.streamRef);
  assert.equal(src.url, 'http://provider.example:8080/series/demo_user/' + PASS + '/9101.mp4');
  assert.equal(await e.vod.seriesDetails(id, v.item(3)), null, 'malformed series info');
  const empty = await e.vod.seriesDetails(id, v.item(2));
  assert.deepEqual(empty.seasons, [], 'a series without episodes');
  assert.equal(JSON.stringify(e.log.entries()).includes(PASS), false);
});

test('incremental updates, missing pages, empty/malformed/failed responses keep the stored list; no orphan pages', async () => {
  let movies = MOVIES;
  let mode = 'ok';
  const route = xtreamVodRoute({
    get_vod_streams: (url) => (mode === 'ok' ? { status: 200, body: JSON.stringify(byCategory(url, movies)) } : mode === 'empty' ? { status: 200, body: '[]' }
      : mode === 'object' ? { status: 200, body: '{"error":"nope"}' } : mode === 'auth' ? { status: 200, body: '{"user_info":{"auth":0}}' }
        : mode === 'cut' ? { status: 200, body: JSON.stringify(byCategory(url, movies)).slice(0, 30) } : { fail: 'network' })
  });
  const files = tvLikeFiles();
  const e = setup(route, files);
  const id = (await e.playlists.add(XT)).playlist.id;
  assert.equal((await e.vod.refresh(id, 'movie').result).unchanged, false);
  const first = await storedFiles(files, id);
  assert.equal((await e.vod.refresh(id, 'movie').result).unchanged, true, 'same list: not rewritten');
  assert.deepEqual((await storedFiles(files, id)).names, first.names, 'same files, new generation removed');
  const page = first.names.find((n) => /-i0\.json$/.test(n));
  await files.remove(page);
  const again = await e.vod.refresh(id, 'movie').result;
  assert.deepEqual([again.ok, again.unchanged], [true, false], 'missing page rewritten although unchanged');
  movies = MOVIES.slice(0, 2);
  assert.equal((await e.vod.refresh(id, 'movie').result).items, 2, 'changed list rewritten');
  const good = await storedFiles(files, id);
  for (const [m, code] of [['empty', 'empty'], ['object', 'invalid-response'], ['auth', 'auth'], ['cut', 'invalid-response'], ['down', 'network']]) {
    mode = m;
    const r = await e.vod.refresh(id, 'movie').result;
    assert.deepEqual([r.ok, r.code], [false, code], m);
    const fresh = createVodService({ playlists: e.playlists, catalogue: e.catalogue, kv: e.kv, now: () => 1, log: e.log });
    const l = await fresh.load(id, 'movie');
    assert.equal(l.status === 'ok' && l.view.total, 2, m + ': stored list kept');
    assert.deepEqual((await storedFiles(files, id)).names, good.names, m + ': no pages of the failed update left');
  }
});

test('interrupted indexing: abort mid-update and an app killed mid-update keep the previous list; leftovers removed', async () => {
  let n = 0;
  let job = null;
  let abortAt = 0;
  const route = xtreamVodRoute({
    get_vod_streams: (url) => {
      n++;
      if (n === abortAt) setImmediate(() => job.abort());
      return { status: 200, body: JSON.stringify(byCategory(url, MOVIES)), chunk: 40 };
    }
  });
  const files = tvLikeFiles();
  const e = setup(route, files);
  const id = (await e.playlists.add(XT)).playlist.id;
  assert.equal((await e.vod.refresh(id, 'movie').result).ok, true);
  const good = await storedFiles(files, id);
  // 1. Aborted (e.g. playback started) during the third category.
  n = 0;
  abortAt = 3;
  job = e.vod.refresh(id, 'movie');
  const r = await job.result;
  assert.deepEqual([r.ok, r.code], [false, 'aborted']);
  assert.deepEqual((await storedFiles(files, id)).names, good.names, 'nothing of the aborted update left');
  assert.equal((await e.vod.load(id, 'movie')).view.total, 4);
  // 2. App killed while writing: pages of an uncommitted generation are on disk.
  const w = createVodPageWriter(e.catalogue, id, 'movie', 'zz9');
  w.addItem(w.addCategory('1', 'x', false), { id: '1', name: 'half', image: '', year: null, rating: null, ext: '', genre: '', adult: false });
  await w.finish(); // pages written, index never saved
  assert.ok((await files.list()).some((f) => f.indexOf('.zz9-') > 0));
  const e2 = createVodService({ playlists: e.playlists, catalogue: e.catalogue, kv: e.kv, now: () => 1, log: e.log });
  assert.equal((await e2.load(id, 'movie')).view.total, 4, 'the committed list is still the one shown');
  abortAt = 0;
  assert.equal((await e2.refresh(id, 'movie').result).ok, true);
  assert.equal((await files.list()).some((f) => f.indexOf('.zz9-') > 0), false, 'leftover pages removed by the next update');
  // abortRefresh() without a running update is harmless.
  e2.abortRefresh();
});

test('storage failure while writing pages: update fails, previous list kept, partial pages removed', async () => {
  const mem = tvLikeFiles();
  let failPages = false;
  const files = { ...mem, write: (name, text) => (failPages && /-i0\.json/.test(name) ? Promise.reject(new Error('disk full')) : mem.write(name, text)) };
  const e = setup(xtreamVodRoute(), files);
  const id = (await e.playlists.add(XT)).playlist.id;
  assert.equal((await e.vod.refresh(id, 'movie').result).ok, true);
  const good = await storedFiles(mem, id);
  failPages = true;
  const r = await e.vod.refresh(id, 'movie').result;
  assert.deepEqual([r.ok, r.code], [false, 'storage']);
  assert.deepEqual((await storedFiles(mem, id)).names, good.names);
  assert.equal((await e.vod.load(id, 'movie')).view.total, 4);
});

test('Stage 6 single-file list (v1) is treated as missing and replaced by the paged list', async () => {
  const files = tvLikeFiles();
  const e = setup(xtreamVodRoute(), files);
  const id = (await e.playlists.add(XT)).playlist.id;
  await e.catalogue.save(id, 'movie', { v: 1, s: 'movie', c: [], p: [], r: [['1', 'old', -1, -1, '', 0, -1, 0, '', '', 0]] });
  assert.equal((await e.vod.load(id, 'movie')).status, 'missing');
  assert.equal((await e.vod.refresh(id, 'movie').result).ok, true);
  assert.equal((await e.vod.load(id, 'movie')).view.total, 4);
});

test('M3U playlists are not supported; one refresh at a time; removing the playlist removes state and pages', async () => {
  const files = tvLikeFiles();
  const e = setup(xtreamVodRoute(), files);
  const m3u = (await e.playlists.add({ name: 'M', kind: 'm3u', url: 'http://m.example/list.m3u' })).playlist.id;
  assert.equal(e.vod.supported(m3u), false);
  assert.equal((await e.vod.refresh(m3u, 'movie').result).code, 'not-supported');
  const id = (await e.playlists.add(XT)).playlist.id;
  const a = e.vod.refresh(id, 'movie');
  const b = await e.vod.refresh(id, 'series').result;
  assert.equal(b.code, 'busy');
  assert.equal((await a.result).ok, true);
  assert.equal((await e.vod.refresh(id, 'series').result).ok, true);
  assert.ok(e.kv.names().includes('vod.' + id));
  await e.playlists.remove(id);
  assert.equal(e.kv.names().includes('vod.' + id), false);
  assert.equal((await e.vod.load(id, 'movie')).status, 'missing', 'catalogue files removed');
  assert.deepEqual((await storedFiles(files, id)).names, [], 'page files removed with the playlist');
});

test('repeated Movies ↔ Series switching: cached views, bounded pages, correct counts', async () => {
  const e = setup(xtreamVodRoute());
  const id = (await e.playlists.add(XT)).playlist.id;
  await e.vod.refresh(id, 'movie').result;
  await e.vod.refresh(id, 'series').result;
  for (let i = 0; i < 20; i++) {
    const m = (await e.vod.load(id, 'movie')).view;
    const s = (await e.vod.load(id, 'series')).view;
    await m.ensure([0, 3]);
    await s.ensure([0, 4]);
    assert.deepEqual([m.total, s.total, m.item(3).name, s.item(4).name], [4, 5, 'Adult title', 'Bébé & Co 🧸']);
    assert.ok(m.pagesInMemory() <= 8 && s.pagesInMemory() <= 8);
  }
});

// ---------------------------------------------------------------- large catalogues

function manySeries(n, cats) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ num: i + 1, name: 'Series ' + i + (i % 5 === 0 ? ' – ü 📺' : ''), series_id: 300000 + i, cover: 'http://img.example.org/c/' + (i % 500) + '/' + i + '.jpg',
      genre: 'Drama', releaseDate: '2019-01-01', rating: '7.5', category_id: String(i % cats) });
  }
  return out;
}

async function bigRun(n, section) {
  const cats = [];
  const ncat = Math.max(10, Math.round(n / 750)); // ≈ the user's provider: 108,521 movies in 143 categories
  for (let i = 0; i < ncat; i++) cats.push({ category_id: String(i), category_name: 'Cat ' + i + (i % 9 === 0 ? ' é' : '') });
  const list = section === 'movie' ? manyMovies(n, ncat) : manySeries(n, ncat);
  // Duplicates across categories (providers list some titles twice).
  list.push({ ...list[0], category_id: '1' }, { ...list[1], category_id: '2' });
  let maxResponse = 0;
  const reply = (url) => {
    const body = JSON.stringify(byCategory(url, list));
    if (body.length > maxResponse) maxResponse = body.length;
    return { status: 200, body, chunk: 262144 };
  };
  const files = tvLikeFiles();
  const e = setup(xtreamVodRoute(section === 'movie'
    ? { get_vod_categories: () => ({ status: 200, body: JSON.stringify(cats) }), get_vod_streams: reply }
    : { get_series_categories: () => ({ status: 200, body: JSON.stringify(cats) }), get_series: reply }), files);
  const id = (await e.playlists.add(XT)).playlist.id;
  const t0 = Date.now();
  const r = await e.vod.refresh(id, section).result;
  const importMs = Date.now() - t0;
  assert.deepEqual([r.ok, r.items, r.requests], [true, n, ncat], JSON.stringify(r));
  const e2 = createVodService({ playlists: e.playlists, catalogue: e.catalogue, kv: e.kv, now: () => 1, log: e.log });
  const t1 = Date.now();
  const v = (await e2.load(id, section)).view;
  const openMs = Date.now() - t1;
  const t2 = Date.now();
  const screen = [];
  for (let i = 0; i < 28 * 3; i++) screen.push(i);
  await v.ensure(screen);
  const firstPageMs = Date.now() - t2;
  assert.equal(v.total, n);
  assert.equal(v.categories.reduce((s, c) => s + c.count, 0), n, 'category counts add up');
  assert.equal(v.byCategory('7').length, Math.floor(n / ncat) + (7 < n % ncat ? 1 : 0));
  // Middle of a category: positions map through its run.
  const cat7 = v.byCategory('7');
  await v.ensure([cat7.at(cat7.length - 1)]);
  assert.equal(v.item(cat7.at(cat7.length - 1)).categoryId, '7');
  const t3 = Date.now();
  let firstHit = -1;
  const word = section === 'movie' ? 'movie ' : 'series ';
  const hits = await v.search(word + (n - 1), 2000, (s) => { if (firstHit < 0 && s.length) firstHit = Date.now() - t3; }).result;
  const searchMs = Date.now() - t3;
  await v.ensure([hits[0]]);
  assert.ok(v.item(hits[0]).name.indexOf((section === 'movie' ? 'Movie ' : 'Series ') + (n - 1)) === 0);
  assert.ok(v.pagesInMemory() <= 8);
  const st = await storedFiles(files, id);
  const indexChars = (await files.read('cat.' + id + '.' + section + '.json')).length;
  return { importMs, openMs, firstPageMs, searchMs, firstHit, stored: st.chars, maxFile: st.maxFile, indexChars, maxResponse, files: st.names.length, ncat };
}

for (const n of [1000, 10000, 50000, 108521]) {
  test('large catalogue: ' + n.toLocaleString('en') + ' movies (per-category import, paged store, index-only open, incremental search)', async () => {
    const m = await bigRun(n, 'movie');
    // Bounded by design: the index stays small, no file or response approaches the whole list.
    assert.ok(m.indexChars < 200000, 'index ' + m.indexChars + ' chars');
    assert.ok(m.maxFile < 400000, 'largest file ' + m.maxFile + ' chars');
    if (n >= 50000) assert.ok(m.maxResponse < m.stored / 20, 'largest provider response ' + m.maxResponse + ' vs stored ' + m.stored);
    console.log('# ' + n + ' movies / ' + m.ncat + ' categories: import ' + m.importMs + ' ms, stored ' + (m.stored / 1e6).toFixed(2) + ' M chars in ' + m.files +
      ' files (index ' + (m.indexChars / 1e3).toFixed(1) + ' k, largest file ' + (m.maxFile / 1e3).toFixed(1) + ' k), largest response ' + (m.maxResponse / 1e3).toFixed(0) +
      ' k chars; open (index) ' + m.openMs + ' ms, first 3 screens ' + m.firstPageMs + ' ms, search ' + m.searchMs + ' ms (first hit ' + m.firstHit + ' ms)');
  });
}

test('large catalogue: 30,000 series', async () => {
  const m = await bigRun(30000, 'series');
  assert.ok(m.indexChars < 200000);
  console.log('# 30000 series / ' + m.ncat + ' categories: import ' + m.importMs + ' ms, stored ' + (m.stored / 1e6).toFixed(2) + ' M chars in ' + m.files + ' files, index ' +
    (m.indexChars / 1e3).toFixed(1) + ' k; open ' + m.openMs + ' ms, first 3 screens ' + m.firstPageMs + ' ms, search ' + m.searchMs + ' ms');
});

test('empty catalogue: provider lists categories but no titles', async () => {
  const e = setup(xtreamVodRoute({ get_vod_streams: () => ({ status: 200, body: '[]' }) }));
  const id = (await e.playlists.add(XT)).playlist.id;
  const r = await e.vod.refresh(id, 'movie').result;
  assert.deepEqual([r.ok, r.code], [false, 'empty']);
  assert.equal((await e.vod.load(id, 'movie')).status, 'missing');
});
