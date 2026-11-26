// Stage 11: My List store, movie sorting and next-episode rules (pure parts). The screen flows are
// in vod-ui.test.mjs ("Stage 11 …").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMyList, compactItem, MAX_MY_LIST, myListKey } from '../../src/services/my-list.ts';
import { sortPositions, nextSortMode, SORT_MODES, SORT_MAX } from '../../src/content/vod-sort.ts';
import { nextEpisode } from '../../src/content/next-episode.ts';
import { parseSeriesInfo } from '../../src/api/xtream/xtream-types.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createLogger } from '../../src/utils/log.ts';

const PA = 'pa1aaaaaaaa';
const PB = 'pb2bbbbbbbb';
const mv = (id, name, extra) => Object.assign({ id: String(id), name, categoryId: '10', adult: false }, extra || {});

function kvPair() {
  const local = createMemoryLocalStore();
  return { local, kv: createKeyValueStore(local, createLogger(20)) };
}

// ---------------------------------------------------------------- My List

test('Stage 11 My List: add, remove, toggle, no duplicates, movies and series kept apart', () => {
  const { kv } = kvPair();
  const ml = createMyList(kv, () => 1000);
  assert.equal(ml.toggle(PA, 'movie', mv(1, 'One')), 'added');
  assert.equal(ml.toggle(PA, 'movie', mv(2, 'Two')), 'added');
  assert.deepEqual(ml.list(PA, 'movie').map((e) => e.item.id), ['2', '1'], 'newest first');
  assert.equal(ml.has(PA, 'movie', '1'), true);
  assert.equal(ml.toggle(PA, 'movie', mv(1, 'One again')), 'removed', 'the same id toggles off: never a duplicate');
  assert.deepEqual(ml.list(PA, 'movie').map((e) => e.item.id), ['2']);
  assert.equal(ml.toggle(PA, 'series', mv(2, 'A series with the same id')), 'added');
  assert.equal(ml.has(PA, 'movie', '2') && ml.has(PA, 'series', '2'), true, 'a movie and a series with one id are separate');
  assert.equal(ml.remove(PA, 'series', '2'), true);
  assert.equal(ml.has(PA, 'series', '2'), false);
  assert.equal(ml.remove(PA, 'series', '2'), false, 'nothing to remove');
});

test('Stage 11 My List: persists across a restart; accounts are isolated; switching back restores the list', () => {
  const { local, kv } = kvPair();
  const ml = createMyList(kv, () => 1);
  ml.toggle(PA, 'movie', mv(5, 'Kept'));
  // "Restart": a new KV store and service over the same storage.
  const ml2 = createMyList(createKeyValueStore(local, createLogger(20)), () => 2);
  assert.deepEqual(ml2.list(PA, 'movie').map((e) => e.item.name), ['Kept']);
  assert.deepEqual(ml2.list(PB, 'movie'), [], 'another account sees nothing');
  ml2.toggle(PB, 'movie', mv(5, 'Same provider id, other account'));
  assert.equal(ml2.list(PA, 'movie')[0].item.name, 'Kept', 'the first account is untouched');
  assert.equal(ml2.list(PB, 'movie')[0].item.name, 'Same provider id, other account');
  ml2.clear(PB);
  assert.deepEqual(ml2.list(PB, 'movie'), []);
  assert.equal(ml2.list(PA, 'movie').length, 1, 'clearing one account keeps the other');
  assert.equal(myListKey('movie', PA), 'mylist.movie.' + PA);
  assert.equal(ml2.toggle('not a playlist id!', 'movie', mv(1, 'x')), 'error');
});

test('Stage 11 My List: only small fields are stored; bad ids refused; damaged data reads as empty', () => {
  const big = mv(7, 'Title', { poster: 'http://img.example/p.jpg', year: 2001, rating: 7.5, ext: 'mkv', genre: 'Drama', plot: 'x'.repeat(5000), cast: 'many' });
  const c = compactItem(big);
  assert.deepEqual(Object.keys(c).sort(), ['adult', 'categoryId', 'ext', 'genre', 'id', 'name', 'poster', 'rating', 'year']);
  assert.equal(compactItem(mv(8, 'x', { poster: 'javascript:alert(1)' })).poster, undefined, 'only http(s) posters');
  const { local, kv } = kvPair();
  const ml = createMyList(kv, () => 1);
  assert.equal(ml.toggle(PA, 'movie', mv('a b', 'bad id')), 'error');
  local.setItem('mylist.movie.' + PA, '{"garbage":');
  assert.deepEqual(ml.list(PA, 'movie'), [], 'damaged data reads as empty (no crash)');
});

test('Stage 11 My List: a storage failure is reported, not thrown, and the list stays as it was', () => {
  let fail = false;
  const store = createMemoryLocalStore();
  const failing = {
    getItem: (k) => store.getItem(k), removeItem: (k) => store.removeItem(k), keys: () => store.keys(),
    setItem: (k, v) => { if (fail) { throw new Error('QuotaExceededError'); } store.setItem(k, v); }
  };
  const ml = createMyList(createKeyValueStore(failing, createLogger(20)), () => 1);
  assert.equal(ml.toggle(PA, 'movie', mv(1, 'One')), 'added');
  fail = true;
  assert.equal(ml.toggle(PA, 'movie', mv(2, 'Two')), 'error');
  assert.equal(ml.toggle(PA, 'movie', mv(1, 'One')), 'error', 'removing fails too');
  fail = false;
  assert.deepEqual(ml.list(PA, 'movie').map((e) => e.item.id), ['1'], 'unchanged after the failures');
  assert.equal(ml.toggle(PA, 'movie', mv(2, 'Two')), 'added', 'works again once storage recovers');
});

test('Stage 11 My List: a large list (500 titles) stays fast; the 501st is refused as full', () => {
  const { kv } = kvPair();
  const ml = createMyList(kv, () => 1);
  const t0 = Date.now();
  for (let i = 0; i < MAX_MY_LIST; i++) {
    assert.equal(ml.toggle(PA, 'movie', mv(10000 + i, 'Movie ' + i, { poster: 'http://img.example/p/' + i + '.jpg', year: 1990 + (i % 30) })), 'added');
  }
  assert.equal(ml.toggle(PA, 'movie', mv(99999, 'One too many')), 'full');
  assert.equal(ml.list(PA, 'movie').length, MAX_MY_LIST);
  const t1 = Date.now();
  for (let i = 0; i < 200; i++) { ml.has(PA, 'movie', String(10000 + i)); }
  assert.ok(Date.now() - t1 < 2000, '200 lookups in ' + (Date.now() - t1) + ' ms');
  assert.ok(t1 - t0 < 20000, '500 adds in ' + (t1 - t0) + ' ms');
  const chars = JSON.stringify(ml.list(PA, 'movie')).length;
  assert.ok(chars < 100000, 'stored size ' + chars + ' characters for 500 titles');
});

// ---------------------------------------------------------------- sorting

const P = [100, 101, 102, 103, 104, 105];
const N = ['Zulu (2001)', 'alpha', 'Mike (1999)', 'Bravo (2010)', '', 'Alpha (2005)'];
const Y = [2001, 0, 1999, 2010, 0, 2005];

test('Stage 11 sorting: the four orders; empty titles and unknown years last; ties keep provider order', () => {
  const by = (mode) => sortPositions(P, N, Y, mode).map((p) => P.indexOf(p));
  assert.deepEqual(by('provider'), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(by('titleAsc'), [1, 5, 3, 2, 0, 4], 'A–Z, case-insensitive, empty title last');
  assert.deepEqual(by('titleDesc'), [0, 2, 3, 5, 1, 4], 'Z–A, empty title still last');
  assert.deepEqual(by('yearDesc'), [3, 5, 0, 2, 1, 4], 'newest first, no year last in provider order');
  assert.deepEqual(by('yearAsc'), [2, 0, 5, 3, 1, 4], 'oldest first, no year last in provider order');
  const dupN = ['Same', 'Same', 'Same'];
  assert.deepEqual(sortPositions([7, 8, 9], dupN, [2000, 2000, 2000], 'titleAsc'), [7, 8, 9], 'duplicate titles keep provider order');
  assert.deepEqual(sortPositions([7, 8, 9], dupN, [2000, 2000, 2000], 'yearDesc'), [7, 8, 9]);
  const copy = P.slice(0);
  sortPositions(P, N, Y, 'titleAsc');
  assert.deepEqual(P, copy, 'the input (stored order) is not changed');
  assert.deepEqual(SORT_MODES.map(nextSortMode), ['titleAsc', 'titleDesc', 'yearDesc', 'yearAsc', 'provider']);
});

test('Stage 11 sorting: a full-size category (5,000 titles) sorts quickly', () => {
  const pos = []; const names = []; const years = [];
  for (let i = 0; i < SORT_MAX; i++) { pos.push(i * 3); names.push('Title ' + ((i * 7919) % SORT_MAX)); years.push(i % 9 === 0 ? 0 : 1950 + (i % 70)); }
  for (const m of ['titleAsc', 'titleDesc', 'yearDesc', 'yearAsc']) {
    const t0 = Date.now();
    const out = sortPositions(pos, names, years, m);
    assert.equal(out.length, SORT_MAX);
    assert.ok(Date.now() - t0 < 1000, m + ' in ' + (Date.now() - t0) + ' ms');
  }
});

// ---------------------------------------------------------------- next episode

const ep = (id, season, episode, exact = true) => ({ id: String(id), season, episode, exact, title: 'E' + id, plot: '', durationSec: null, image: '', streamRef: { kind: 'xtream', type: 'series', id: String(id) } });
const seasons = (...lists) => lists.map((eps, i) => ({ number: eps.length ? eps[0].season : i, name: '', cover: '', episodes: eps }));

test('Stage 11 next episode: same season, gaps, the next season, the last episode, catalogue order not trusted', () => {
  const s = seasons([ep(3, 1, 3), ep(1, 1, 1), ep(2, 1, 2), ep(6, 1, 6)], [ep(21, 2, 1), ep(22, 2, 2)]);
  assert.equal(nextEpisode(s, '1').episode.id, '2', 'catalogue order 3,1,2 is ignored: numbers decide');
  assert.equal(nextEpisode(s, '3').episode.id, '6', 'a gap (4, 5 missing) is fine');
  assert.equal(nextEpisode(s, '6').episode.id, '21', 'last of season 1 → first of season 2');
  assert.deepEqual(nextEpisode(s, '22'), { none: 'last' });
  assert.deepEqual(nextEpisode(s, 'zzz'), { none: 'unknown' }, 'an episode of another series is never matched');
  const g = seasons([ep(1, 1, 1)], [ep(31, 3, 2), ep(30, 3, 1)]);
  assert.equal(nextEpisode(g, '1').episode.id, '30', 'season numbers with a gap (1 → 3)');
});

test('Stage 11 next episode: specials, filled-in numbers and duplicates never pick a next episode', () => {
  const sp = seasons([ep(0, 0, 1), ep(99, 0, 2)], [ep(1, 1, 1), ep(2, 1, 2)]);
  assert.deepEqual(nextEpisode(sp, '0'), { none: 'special' }, 'not continued from a special');
  assert.deepEqual(nextEpisode(sp, '2'), { none: 'last' }, 'and never into the specials');
  const filled = seasons([ep(1, 1, 1), ep(2, 1, 2, false)]);
  assert.deepEqual(nextEpisode(filled, '1'), { none: 'last' }, 'a candidate with filled-in numbers is not used');
  assert.deepEqual(nextEpisode(filled, '2'), { none: 'unknown' }, 'the current episode needs stated numbers');
  assert.deepEqual(nextEpisode(seasons([ep(1, 1, 1), ep(2, 1, 2), ep(3, 1, 2)]), '1'), { none: 'ambiguous' }, 'two episodes numbered 2');
  assert.deepEqual(nextEpisode(seasons([ep(1, 1, 1), ep(4, 1, 1), ep(2, 1, 2)]), '1'), { none: 'ambiguous' }, 'the current number is duplicated');
  assert.deepEqual(nextEpisode(seasons([ep(1, 1, 1), ep(1, 1, 2)]), '1'), { none: 'ambiguous' }, 'the same episode id twice');
});

test('Stage 11 episode parsing: numbers are "stated" only when the provider gave them', () => {
  const r = parseSeriesInfo({
    episodes: {
      1: [{ id: 11, episode_num: 1, title: 'a' }, { id: 12, title: 'no number' }],
      2: [{ id: 21, episode_num: '1', season: '2' }]
    }
  }, 'S');
  const all = [];
  r.seasons.forEach((s) => s.episodes.forEach((e) => all.push(e)));
  const byId = (id) => all.find((e) => e.id === String(id));
  assert.equal(byId(11).exact, true, 'season from the numeric key, episode stated');
  assert.equal(byId(12).exact, false, 'episode number filled in from the position');
  assert.equal(byId(21).exact, true);
  const arr = parseSeriesInfo({ episodes: [{ id: 31, episode_num: 1 }, { id: 32, episode_num: 2, season: 1 }] }, 'S');
  const a = [];
  arr.seasons.forEach((s) => s.episodes.forEach((e) => a.push(e)));
  assert.equal(a.find((e) => e.id === '31').exact, false, 'no season anywhere: the default season 1 is not stated');
  assert.equal(a.find((e) => e.id === '32').exact, true);
});
