// Stage 6: movies and series. Xtream parsing (categories, lists, vod/series info, episodes),
// VodService (import, persistence through a TV-like file store, incremental updates, missing-file
// recovery, empty and malformed responses, large catalogues), playback URL construction and
// credential redaction. Synthetic fixtures: tests/fakes/fake-xtream-vod.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVodStream, parseSeries, parseVodInfo, parseSeriesInfo } from '../../src/api/xtream/xtream-types.ts';
import { createVodBuilder, decodeVod, isVodPayload } from '../../src/content/vod-codec.ts';
import { createVodIndex } from '../../src/content/vod-index.ts';
import { createVodService } from '../../src/services/vod-service.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { xtreamVodRoute, manyMovies, MOVIES, SERIES, SERIES_INFO, VOD_INFO } from '../fakes/fake-xtream-vod.mjs';

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

test('VOD codec: round trip, shared image prefixes, uncategorised items, malformed rows skipped (not fatal)', () => {
  const b = createVodBuilder('movie');
  b.addCategory('10', 'Action', false);
  assert.equal(b.addItem({ id: '1', name: 'A', categoryId: '10', image: 'http://i.example/p/1.jpg', year: 2001, rating: 7.25, added: 5, ext: 'mkv', genre: '', adult: false }), true);
  assert.equal(b.addItem({ id: '1', name: 'dup', categoryId: '10', image: '', year: null, rating: null, added: null, ext: '', genre: '', adult: false }), false);
  b.addItem({ id: '2', name: 'B é', categoryId: 'nope', image: 'http://i.example/p/2.jpg', year: null, rating: null, added: null, ext: '', genre: 'G', adult: true });
  const { payload } = b.finish();
  assert.equal(payload.p.length, 1, 'one shared prefix');
  const d = decodeVod(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(d.catalogue.items[0], { id: '1', name: 'A', categoryId: '10', adult: false, poster: 'http://i.example/p/1.jpg', year: 2001, rating: 7.3, added: 5, ext: 'mkv' });
  assert.deepEqual([d.catalogue.items[1].categoryId, d.catalogue.items[1].genre, d.catalogue.items[1].adult], ['_', 'G', true]);
  assert.deepEqual(d.catalogue.categories.map((c) => [c.id, c.count]), [['10', 1], ['_', 1]]);
  const bad = JSON.parse(JSON.stringify(payload));
  bad.r.push(['x', 5], null, ['3', 'C', 99, -1, '', 0, -1, 0, '', '', 0]);
  const d2 = decodeVod(bad);
  assert.deepEqual([d2.catalogue.items.length, d2.skipped], [2, 3]);
  assert.equal(isVodPayload({ v: 1, s: 'tv', c: [], p: [], r: [] }), false);
});

test('VOD index: categories, all, search by words (prefix matches first), case-insensitive', () => {
  const cat = { section: 'movie', categories: [], items: ['The Matrix', 'Matrix Reloaded', 'Amélie', 'Another Matrix Story', 'matrix'].map((n, i) => ({ id: String(i), name: n, categoryId: i % 2 ? 'b' : 'a', adult: false })) };
  const idx = createVodIndex(cat);
  assert.deepEqual(idx.byCategory('b'), [1, 3]);
  assert.deepEqual(idx.search('matrix', 10), [1, 4, 0, 3]);
  assert.deepEqual(idx.search('MATRIX story', 10), [3]);
  assert.deepEqual(idx.search('amé', 10), [2]);
  assert.deepEqual(idx.search('  ', 10), []);
  assert.equal(idx.search('matrix', 2).length, 2);
});

// ---------------------------------------------------------------- service

test('movies: import, persistence on a TV-like store (Unicode), reload after a restart, details, playback URL', async () => {
  const files = tvLikeFiles();
  const route = xtreamVodRoute();
  const e = setup(route, files);
  const id = (await e.playlists.add(XT)).playlist.id;
  assert.equal(e.vod.supported(id), true);
  assert.equal((await e.vod.load(id, 'movie')).status, 'missing');
  const r = await e.vod.refresh(id, 'movie').result;
  assert.deepEqual([r.ok, r.items, r.invalid, r.unchanged], [true, 6, 3, false], JSON.stringify(r)); // + 1 duplicate dropped
  const raw = await files.read('cat.' + id + '.movie.json');
  assert.equal(/[^\x00-\x7f]/.test(raw), false, 'stored as ASCII');
  // Fresh service over the same stores = app restart.
  const e2 = createVodService({ playlists: e.playlists, catalogue: e.catalogue, kv: e.kv, now: () => 1, log: e.log });
  const l = await e2.load(id, 'movie');
  assert.equal(l.status, 'ok');
  const names = l.catalogue.items.map((x) => x.name);
  assert.deepEqual(names, ['The Long Night (2019)', 'Amélie ✨ 🇫🇷', 'فيلم عربي', 'No Category', 'Lost Category', 'Adult title']);
  assert.equal(l.catalogue.categories.find((c) => c.id === '12').name, 'أفلام عربية');
  assert.equal(l.catalogue.items[4].categoryId, '_', 'unknown category → uncategorised');
  assert.equal(l.catalogue.items[5].adult, true);
  assert.equal(e2.state(id, 'movie').items, 6);
  // Details on demand, cached.
  const item = l.catalogue.items[0];
  const det = await e2.movieDetails(id, item);
  assert.equal(det.genre, 'Thriller');
  const calls = route.calls.length;
  await e2.movieDetails(id, item);
  assert.equal(route.calls.length, calls, 'details cached');
  assert.equal(await e2.movieDetails(id, l.catalogue.items[3]), null, 'unusable info → null');
  // Playback URL: /movie/<user>/<pass>/<id>.<ext>, built at play time.
  const src = await e2.resolve(id, e2.movieRef(id, item));
  assert.deepEqual([src.url, src.type, src.live], ['http://provider.example:8080/movie/demo_user/' + PASS + '/5001.mkv', 'mkv', false]);
  const noExt = e2.movieRef(id, l.catalogue.items[5]);
  assert.equal(noExt.ext, 'mp4', 'mp4 when the provider gives no extension');
  assert.equal(JSON.stringify(e.log.entries()).includes(PASS), false, 'no credentials in the log');
  assert.equal(raw.includes(PASS), false, 'no credentials in the catalogue');
});

test('series: import, seasons and episodes from get_series_info, episode URLs', async () => {
  const route = xtreamVodRoute();
  const e = setup(route);
  const id = (await e.playlists.add(XT)).playlist.id;
  const r = await e.vod.refresh(id, 'series').result;
  assert.deepEqual([r.ok, r.items, r.invalid], [true, 5, 1]);
  const l = await e.vod.load(id, 'series');
  const city = l.catalogue.items[0];
  assert.deepEqual([city.name, city.genre, city.year, city.rating], ['City Lights', 'Drama, Crime', 2018, 8.1]);
  assert.equal(l.catalogue.items[1].name, 'Bébé & Co 🧸');
  const s = await e.vod.seriesDetails(id, city);
  assert.deepEqual(s.seasons.map((x) => x.number), [1, 2]);
  const ep = s.seasons[0].episodes[0];
  assert.deepEqual(ep.streamRef, { kind: 'xtream', type: 'series', id: '9101', ext: 'mp4' });
  const src = await e.vod.resolve(id, ep.streamRef);
  assert.equal(src.url, 'http://provider.example:8080/series/demo_user/' + PASS + '/9101.mp4');
  assert.equal(await e.vod.seriesDetails(id, l.catalogue.items[4]), null, 'malformed series info');
  const empty = await e.vod.seriesDetails(id, l.catalogue.items[3]);
  assert.deepEqual(empty.seasons, [], 'a series without episodes');
  assert.equal(JSON.stringify(e.log.entries()).includes(PASS), false);
});

test('incremental updates, missing-file recovery, empty and malformed responses keep the stored list', async () => {
  let movies = MOVIES;
  let mode = 'ok';
  const route = xtreamVodRoute({
    get_vod_streams: () => (mode === 'ok' ? { status: 200, body: JSON.stringify(movies) } : mode === 'empty' ? { status: 200, body: '[]' }
      : mode === 'object' ? { status: 200, body: '{"error":"nope"}' } : mode === 'auth' ? { status: 200, body: '{"user_info":{"auth":0}}' }
        : mode === 'cut' ? { status: 200, body: JSON.stringify(movies).slice(0, 300) } : { fail: 'network' })
  });
  const files = tvLikeFiles();
  const e = setup(route, files);
  const id = (await e.playlists.add(XT)).playlist.id;
  assert.equal((await e.vod.refresh(id, 'movie').result).unchanged, false);
  assert.equal((await e.vod.refresh(id, 'movie').result).unchanged, true, 'same list: not rewritten');
  await files.remove('cat.' + id + '.movie.json');
  const again = await e.vod.refresh(id, 'movie').result;
  assert.deepEqual([again.ok, again.unchanged], [true, false], 'missing file rewritten although unchanged');
  movies = MOVIES.slice(0, 2);
  assert.equal((await e.vod.refresh(id, 'movie').result).items, 2, 'changed list rewritten');
  for (const [m, code] of [['empty', 'empty'], ['object', 'invalid-response'], ['auth', 'auth'], ['cut', 'invalid-response'], ['down', 'network']]) {
    mode = m;
    const r = await e.vod.refresh(id, 'movie').result;
    assert.deepEqual([r.ok, r.code], [false, code], m);
    const l = await e.vod.load(id, 'movie');
    assert.equal(l.status === 'ok' && l.catalogue.items.length, 2, m + ': stored list kept');
  }
});

test('M3U playlists are not supported; one refresh at a time; removing the playlist removes the state', async () => {
  const e = setup(xtreamVodRoute());
  const m3u = (await e.playlists.add({ name: 'M', kind: 'm3u', url: 'http://m.example/list.m3u' })).playlist.id;
  assert.equal(e.vod.supported(m3u), false);
  assert.equal((await e.vod.refresh(m3u, 'movie').result).code, 'not-supported');
  const id = (await e.playlists.add(XT)).playlist.id;
  const a = e.vod.refresh(id, 'movie');
  const b = await e.vod.refresh(id, 'series').result;
  assert.equal(b.code, 'busy');
  assert.equal((await a.result).ok, true);
  assert.ok(e.kv.names().includes('vod.' + id));
  await e.playlists.remove(id);
  assert.equal(e.kv.names().includes('vod.' + id), false);
  assert.equal((await e.vod.load(id, 'movie')).status, 'missing', 'catalogue files removed');
});

test('large catalogue: 50,000 movies import, store and load; search and category lists are fast', async () => {
  const big = manyMovies(50000, 200);
  const cats = [];
  for (let i = 0; i < 200; i++) cats.push({ category_id: String(i), category_name: 'Cat ' + i });
  const e = setup(xtreamVodRoute({
    get_vod_categories: () => ({ status: 200, body: JSON.stringify(cats) }),
    get_vod_streams: () => ({ status: 200, body: JSON.stringify(big), chunk: 262144 })
  }));
  const id = (await e.playlists.add(XT)).playlist.id;
  const t0 = Date.now();
  const r = await e.vod.refresh(id, 'movie').result;
  const importMs = Date.now() - t0;
  assert.deepEqual([r.ok, r.items], [true, 50000]);
  const e2 = createVodService({ playlists: e.playlists, catalogue: e.catalogue, kv: e.kv, now: () => 1, log: e.log });
  const t1 = Date.now();
  const l = await e2.load(id, 'movie');
  const loadMs = Date.now() - t1;
  assert.equal(l.catalogue.items.length, 50000);
  const t2 = Date.now();
  const idx = createVodIndex(l.catalogue);
  const byCat = idx.byCategory('7');
  const hits = idx.search('movie 4999', 2000);
  const searchMs = Date.now() - t2;
  assert.equal(byCat.length, 250);
  assert.ok(hits.length > 0 && l.catalogue.items[hits[0]].name.indexOf('Movie 4999') === 0);
  const st = e2.state(id, 'movie');
  const chars = (await e.catalogue.load(id, 'movie', isVodPayload)).chars;
  console.log('# 50,000 movies: import ' + importMs + ' ms, stored ' + (chars / 1e6).toFixed(2) + ' M chars, load+decode ' + loadMs + ' ms, index+category+search ' + searchMs + ' ms; state ' + st.items);
});
