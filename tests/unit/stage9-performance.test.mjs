// Stage 9: Global Search shows results progressively; the active playlist's decoded live catalogue
// is cached in memory (checksum-validated, released on switch/refresh/low memory); blocking file
// writes wait while the remote is in use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSearchScreen } from '../../src/screens/search-screen.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createInputQuiet } from '../../src/app/input-quiet.ts';
import { createTizenFileStore } from '../../src/app/platform/tizen-file-store.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { createFakeTizenFs } from '../fakes/fake-tizen.mjs';
import { createFakeClock, flush } from '../fakes/fake-clock.mjs';
import { xtreamVodRoute } from '../fakes/fake-xtream-vod.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(2);
  }
}

// ---------------------------------------------------------------- Global Search

/** A movie/series list whose search the test drives by hand (progress, result, failure). */
function fakeView(section, names) {
  const items = names.map((n, i) => ({ id: section + i, name: n, categoryId: '1', adult: false, year: 2000 + i }));
  const loaded = new Set();
  const searches = [];
  return {
    section, total: items.length, categories: [],
    all: () => ({ length: items.length, at: (i) => i }),
    byCategory: () => ({ length: 0, at: (i) => i }),
    item: (p) => (loaded.has(p) ? items[p] : null),
    failed: () => false,
    ensure: (ps) => { ps.forEach((p) => loaded.add(p)); return Promise.resolve(); },
    search(q, max, onProgress) {
      let resolve; let reject;
      const result = new Promise((a, b) => { resolve = a; reject = b; });
      const s = { q, max, onProgress, resolve, reject, cancelled: false };
      searches.push(s);
      return { result, cancel: () => { s.cancelled = true; } };
    },
    pagesInMemory: () => 0, timings: () => ({ maxReadMs: 0, maxDecodeMs: 0 }),
    searches
  };
}

function searchEnv(opts = {}) {
  const doc = createFakeDocument();
  const t = createTranslator('en');
  const kv = createKeyValueStore(createMemoryLocalStore(), createLogger(50));
  const channels = ['News One', 'Sports'].map((n, i) => ({ id: 'c' + i, num: i + 1, name: n, categoryId: 'k', adult: false, streamRef: { kind: 'url', url: 'http://x/' + i } }));
  let liveLoads = 0;
  let releaseLive = null;
  const playlists = {
    activeId: () => 'p1',
    get: () => ({ id: 'p1', name: 'Provider', kind: 'xtream' }),
    list: () => [{ id: 'p1', name: 'Provider', kind: 'xtream' }],
    loadLive: () => {
      liveLoads++;
      const v = { status: 'ok', catalogue: { categories: [], channels }, meta: {}, ms: 1 };
      return opts.slowLive ? new Promise((r) => { releaseLive = () => r(v); }) : Promise.resolve(v);
    }
  };
  const views = { movie: fakeView('movie', ['Night One', 'Night Two', 'The Night', 'Day']), series: fakeView('series', ['Night Show']) };
  const vod = {
    supported: () => true,
    state: () => ({ at: 1 }),
    load: (_p, sec) => (opts.loadFails === sec ? Promise.resolve({ status: 'error', message: 'x' }) : Promise.resolve({ status: 'ok', view: views[sec], ms: 1 }))
  };
  let textOpts = null;
  const nav = { isRegistered: () => true, push: () => true, resetTo: () => true, stack: () => ['search'] };
  const screen = createSearchScreen({ doc, t, playlists, vod, kv, openText: (_n, o) => { textOpts = o; } }, nav);
  const root = doc.createElement('div');
  screen.mount({ element: root, show() {}, hide() {}, remove() {} });
  function type(q) {
    // The keyboard opens from the query box; leave a result row first if focus moved there.
    screen.onKey({ key: 'up', repeat: false, heldMs: 0, code: 38 });
    screen.onKey({ key: 'up', repeat: false, heldMs: 0, code: 38 });
    screen.onKey({ key: 'ok', repeat: false, heldMs: 0, code: 13 });
    textOpts.onDone(q);
  }
  const rowEls = () => root.findAll('ss-srch__row');
  const rowLabels = () => rowEls().map((r) => r.findAll('ss-srch__label')[0].textContent);
  const titles = (i) => rowEls()[i].findAll('ss-srch__title').map((x) => x.textContent);
  const message = () => root.findAll('ss-srch__message')[0].textContent;
  return { screen, views, type, rowLabels, titles, message, liveLoads: () => liveLoads, releaseLive: () => releaseLive && releaseLive() };
}

test('Stage 9 search: movies appear progressively while the scan runs, then the complete result; a slow list keeps "Searching…"', async () => {
  const e = searchEnv();
  e.type('night');
  await until(() => e.views.movie.searches.length === 1, 1000, 'movie scan started');
  assert.deepEqual(e.rowLabels(), [], 'no channel matches "night"');
  assert.equal(e.message(), 'Searching…');
  // First name page: two hits. They are shown although the scan (and the series) continue.
  e.views.movie.searches[0].onProgress([0, 1]);
  await until(() => e.rowLabels().length === 1, 1000, 'interim movie row');
  assert.deepEqual(e.rowLabels(), ['Movies · 2']);
  assert.deepEqual(e.titles(0), ['Night One', 'Night Two']);
  assert.equal(e.message(), 'Searching…', 'still searching');
  // The movie scan ends with three hits (prefix matches first, as before); the series list is slow.
  e.views.movie.searches[0].resolve([0, 1, 2]);
  await until(() => e.rowLabels()[0] === 'Movies · 3', 1000, 'final movie row');
  assert.equal(e.message(), 'Searching…', 'the slow series list keeps the search state');
  e.views.series.searches[0].resolve([0]);
  await until(() => e.rowLabels().length === 2, 1000, 'series row');
  assert.deepEqual(e.rowLabels(), ['Movies · 3', 'Series · 1']);
  assert.equal(e.message(), '');
});

test('Stage 9 search: channels do not wait for movies; no result and a failed list are told apart', async () => {
  const e = searchEnv();
  e.type('news');
  await until(() => e.rowLabels().length === 1, 1000, 'channel row');
  assert.deepEqual(e.rowLabels(), ['Channels · 1'], 'channels shown before the movie scan ends');
  assert.equal(e.message(), 'Searching…');
  e.views.movie.searches[0].resolve([]);
  e.views.series.searches[0].reject(new Error('page read failed'));
  await until(() => e.message() !== 'Searching…', 1000, 'done');
  assert.equal(e.message(), 'Series could not be searched.', 'a failed request is not "nothing found"');
  const e2 = searchEnv();
  e2.type('zzz');
  await until(() => e2.views.movie.searches.length === 1, 1000, 'scan');
  e2.views.movie.searches[0].resolve([]);
  e2.views.series.searches[0].resolve([]);
  await until(() => e2.message() !== 'Searching…', 1000, 'done');
  assert.equal(e2.message(), 'Nothing found for “zzz”.');
  const e3 = searchEnv({ loadFails: 'movie' });
  e3.type('night');
  await until(() => e3.views.series.searches.length === 1, 1000, 'series scan');
  e3.views.series.searches[0].resolve([0]);
  await until(() => e3.message() !== 'Searching…', 1000, 'done');
  assert.equal(e3.message(), 'Movies could not be searched.');
  assert.deepEqual(e3.rowLabels(), ['Series · 1']);
});

test('Stage 9 search: a newer query cancels the older scan, and late results of the older query are ignored', async () => {
  const e = searchEnv();
  e.type('night');
  await until(() => e.views.movie.searches.length === 1, 1000, 'first scan');
  const old = e.views.movie.searches[0];
  const oldSeries = e.views.series.searches[0];
  e.type('day');
  await until(() => e.views.movie.searches.length === 2, 1000, 'second scan');
  assert.equal(old.cancelled, true, 'the older movie scan is cancelled');
  assert.equal(oldSeries.cancelled, true, 'the older series scan is cancelled');
  e.views.movie.searches[1].resolve([3]);
  e.views.series.searches[1].resolve([]);
  await until(() => e.rowLabels()[0] === 'Movies · 1', 1000, 'second result');
  // The older query reports late: neither its progress nor its final result may overwrite "day".
  old.onProgress([0, 1]);
  old.resolve([0, 1, 2]);
  oldSeries.resolve([0]);
  await sleep(20);
  assert.deepEqual(e.rowLabels(), ['Movies · 1']);
  assert.deepEqual(e.titles(0), ['Day']);
});

test('Stage 9 search: the same query while still running is not started twice; stored lists are read once per screen', async () => {
  const e = searchEnv();
  e.type('night');
  await until(() => e.views.movie.searches.length === 1, 1000, 'scan');
  e.type('night');
  await sleep(10);
  assert.equal(e.views.movie.searches.length, 1, 'no duplicate scan');
  e.views.movie.searches[0].resolve([0]);
  e.views.series.searches[0].resolve([]);
  await until(() => e.message() === '', 1000, 'done');
  e.type('day');
  await until(() => e.views.movie.searches.length === 2, 1000, 'next query');
  assert.equal(e.liveLoads(), 1, 'the channel list is loaded once per screen');
});

// ---------------------------------------------------------------- Live TV cache

const LIVE_FIXTURE = readFileSync(new URL('../fixtures/xtream/live-streams.json', import.meta.url), 'utf8');

async function liveEnv(opts = {}) {
  const log = createLogger(3000);
  const kv = createKeyValueStore(createMemoryLocalStore(), log);
  const st = { fail: false, rename: false };
  const route = xtreamVodRoute({
    get_live_streams: () => {
      if (!st.rename) { return { status: 200, body: LIVE_FIXTURE }; }
      const list = JSON.parse(LIVE_FIXTURE);
      list[0].name = list[0].name + ' (new)';
      return { status: 200, body: JSON.stringify(list) };
    }
  });
  const srv = createFakeServer((url) => (st.fail ? { status: 500, body: 'down' } : route.fn(url)));
  const http = createHttpClient({ xhrFactory: srv.factory });
  const clock = createFakeClock();
  const catalogue = createCatalogueStore(createMemoryFileStore(), { budgetChars: 50000000, maxChars: 100000000 }, () => Date.now(), log);
  let liveReads = 0;
  const counted = Object.assign({}, catalogue, {
    load: (id, section, v) => { if (section === 'live') { liveReads++; } return catalogue.load(id, section, v); }
  });
  const mem = { mb: opts.mb === undefined ? 400 : opts.mb };
  // The cache's memory checks (checkMs 999) run on the fake clock; everything else on real timers.
  const timers = {
    setTimer: (fn, ms) => (ms === 999 ? { fake: clock.setTimer(fn, ms) } : setTimeout(fn, ms)),
    clearTimer: (h) => { if (h && h.fake) { clock.clearTimer(h.fake); } else { clearTimeout(h); } }
  };
  const playlists = createPlaylistService({
    kv, catalogue: counted, secrets: createSecretStore(createMemoryKeyStore()), http, now: () => Date.now(), log: log.child('playlists'), timers,
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000 },
    liveCache: opts.noCache ? undefined : { maxChars: opts.maxChars || 8000000, minFreeMB: 150, memoryMB: () => mem.mb, checkMs: 999 }
  });
  const a = (await playlists.add({ name: 'A', kind: 'xtream', server: 'provider.example:8080', username: 'demo_user', password: 'demo_pass_9f3k' })).playlist;
  playlists.setActive(a.id);
  const r = await playlists.refresh(a.id).result;
  assert.equal(r.ok, true, 'fixture import');
  return { playlists, a, log, clock, mem, st, liveReads: () => liveReads, catalogue };
}

const ids = (l) => l.catalogue.channels.map((c) => c.id).join(',');

test('Stage 9 cache: the first open reads the channel file; later opens reuse it with the same order and categories', async () => {
  const e = await liveEnv();
  const l1 = await e.playlists.loadLive(e.a.id);
  assert.equal(l1.status, 'ok');
  assert.equal(!!l1.cached, false);
  assert.equal(e.liveReads(), 1);
  const l2 = await e.playlists.loadLive(e.a.id);
  assert.equal(l2.cached, true, 'second open served from memory');
  assert.equal(e.liveReads(), 1, 'no second channel-file read');
  assert.equal(ids(l2), ids(l1), 'channel order unchanged');
  assert.deepEqual(l2.catalogue.categories.map((c) => c.id), l1.catalogue.categories.map((c) => c.id));
  const info = e.playlists.liveCacheInfo();
  assert.equal(info.playlistId, e.a.id);
  assert.equal(info.hits, 1);
  assert.ok(info.chars > 0);
  // Two screens loading at the same time (Live TV and Search) share one read.
  e.playlists.releaseLiveCache('test');
  const [x, y] = await Promise.all([e.playlists.loadLive(e.a.id), e.playlists.loadLive(e.a.id)]);
  assert.equal(x, y);
  assert.equal(e.liveReads(), 2);
  e.playlists.releaseLiveCache('end');
});

test('Stage 9 cache: switching or removing the account drops it; another account is never served from it', async () => {
  const e = await liveEnv();
  await e.playlists.loadLive(e.a.id);
  const b = (await e.playlists.add({ name: 'B', kind: 'xtream', server: 'provider.example:8080', username: 'demo_user', password: 'demo_pass_9f3k' })).playlist;
  await e.playlists.refresh(b.id).result;
  assert.equal(e.playlists.liveCacheInfo().playlistId, e.a.id);
  e.playlists.setActive(b.id);
  assert.equal(e.playlists.liveCacheInfo().playlistId, null, 'account switch releases the cache');
  assert.equal(e.playlists.liveCacheInfo().lastRelease, 'account-switch');
  const lb = await e.playlists.loadLive(b.id);
  assert.equal(!!lb.cached, false);
  assert.equal(e.playlists.liveCacheInfo().playlistId, b.id);
  // Loading a non-active account (A) neither replaces nor fills the cache.
  const la = await e.playlists.loadLive(e.a.id);
  assert.equal(!!la.cached, false);
  assert.equal(e.playlists.liveCacheInfo().playlistId, b.id);
  await e.playlists.remove(b.id);
  assert.equal(e.playlists.liveCacheInfo().playlistId, null, 'removal releases it');
});

test('Stage 9 cache: a refresh that changes the list replaces it; unchanged and failed refreshes keep the safe copy', async () => {
  const e = await liveEnv();
  await e.playlists.loadLive(e.a.id);
  const r1 = await e.playlists.refresh(e.a.id).result;
  assert.equal(r1.ok && r1.unchanged, true, 'unchanged refresh');
  assert.equal((await e.playlists.loadLive(e.a.id)).cached, true, 'same files: the cached copy stays');
  e.st.fail = true;
  const r2 = await e.playlists.refresh(e.a.id).result;
  e.st.fail = false;
  assert.equal(r2.ok, false, 'failed refresh');
  const l2 = await e.playlists.loadLive(e.a.id);
  assert.equal(l2.status, 'ok');
  assert.equal(l2.cached, true, 'the stored list is untouched, so the cached copy is still right');
  const before = ids(l2);
  e.st.rename = true;
  const r3 = await e.playlists.refresh(e.a.id).result;
  assert.equal(r3.ok && !r3.unchanged, true, 'changed refresh');
  assert.equal(e.playlists.liveCacheInfo().lastRelease, 'refreshed');
  const l3 = await e.playlists.loadLive(e.a.id);
  assert.equal(!!l3.cached, false, 'read again from the new file');
  assert.match(l3.catalogue.channels[0].name, /\(new\)$/);
  assert.equal(ids(l3), before, 'order unchanged');
  e.playlists.releaseLiveCache('end');
});

test('Stage 9 cache: a channel file changed behind its back is never served from memory (checksum check)', async () => {
  const e = await liveEnv();
  await e.playlists.loadLive(e.a.id);
  const meta = await e.catalogue.load(e.a.id, 'meta', (x) => !!x);
  await e.catalogue.save(e.a.id, 'meta', Object.assign({}, meta.data, { liveHash: 'deadbeef' }));
  const l = await e.playlists.loadLive(e.a.id);
  assert.notEqual(l.cached, true);
  assert.equal(l.status, 'inconsistent', 'the stored files disagree: reported as before, never the old copy');
  assert.equal(e.playlists.liveCacheInfo().playlistId, null);
});

test('Stage 9 cache: memory budget — not kept when memory is low or the file too large; released when memory falls', async () => {
  const low = await liveEnv({ mb: 120 });
  await low.playlists.loadLive(low.a.id);
  assert.equal(low.playlists.liveCacheInfo().playlistId, null, 'below 150 MB free nothing is kept');
  assert.equal((await low.playlists.loadLive(low.a.id)).cached, undefined);
  const big = await liveEnv({ maxChars: 100 });
  await big.playlists.loadLive(big.a.id);
  assert.equal(big.playlists.liveCacheInfo().playlistId, null, 'a file above the size budget is not kept');
  const e = await liveEnv();
  await e.playlists.loadLive(e.a.id);
  assert.equal(e.playlists.liveCacheInfo().playlistId, e.a.id);
  e.clock.advance(999);
  assert.equal(e.playlists.liveCacheInfo().playlistId, e.a.id, 'enough memory: kept');
  e.mem.mb = 140;
  e.clock.advance(999);
  assert.equal(e.playlists.liveCacheInfo().playlistId, null, 'released when free memory fell below the floor');
  assert.equal(e.playlists.liveCacheInfo().lastRelease, 'low-memory');
  assert.equal(e.clock.pending(), 0, 'no memory timer left running');
  // Without the option the service behaves as before (no cache, every open reads the file).
  const off = await liveEnv({ noCache: true });
  await off.playlists.loadLive(off.a.id);
  await off.playlists.loadLive(off.a.id);
  assert.equal(off.liveReads(), 2);
});

// ---------------------------------------------------------------- catalogue updates (write gate)

test('Stage 9 write gate: runs at once when idle; waits while keys are pressed; capped; released under memory pressure', async () => {
  const c = createFakeClock();
  let pressure = false;
  const q = createInputQuiet({ now: c.now, setTimer: c.setTimer, quietMs: 1500, maxWaitMs: 5000, pressure: () => pressure });
  let went = 0;
  await q.wait();
  assert.equal(q.stats().waited, 0, 'no key pressed: no wait');
  q.note();
  q.wait().then(() => { went++; });
  for (let i = 0; i < 6; i++) { c.advance(400); await flush(); q.note(); } // keys every 0.4 s for 2.4 s
  assert.equal(went, 0, 'held back while the remote is in use');
  c.advance(1500); await flush();
  assert.equal(went, 1, 'runs once the remote was quiet for 1.5 s');
  q.note();
  q.wait().then(() => { went++; });
  for (let i = 0; i < 14; i++) { c.advance(400); await flush(); q.note(); }
  assert.equal(went, 2, 'continuous key presses: released after the 5 s cap');
  assert.equal(q.stats().capped, 1);
  q.note();
  q.wait().then(() => { went++; });
  pressure = true;
  c.advance(500); await flush(); // next check (at most every 0.5 s), long before quiet or the cap
  assert.equal(went, 3, 'low memory: not held back');
  assert.equal(q.stats().pressured, 1);
});

test('Stage 9 write gate in the Tizen file store: nothing blocking runs until the gate opens; the result is complete and atomic', async () => {
  const fs = createFakeTizenFs();
  const store = createTizenFileStore(fs.api);
  await store.write('cat.p1.live.json', 'old');
  let open = null;
  let asked = 0;
  store.setWriteGate(() => { asked++; return new Promise((r) => { open = r; }); });
  const big = 'x'.repeat(250000); // 3 write chunks
  let done = false;
  const w = store.write('cat.p1.live.json', big).then(() => { done = true; });
  await sleep(10);
  assert.equal(asked, 1);
  assert.equal(done, false);
  assert.equal(await store.read('cat.p1.live.json'), 'old', 'an interrupted (held) update leaves the old file readable');
  while (!done) { if (open) { const o = open; open = null; o(); } await sleep(2); }
  await w;
  assert.ok(asked >= 5, 'asked before delete, create, every chunk and the move (' + asked + ')');
  assert.equal(await store.read('cat.p1.live.json'), big, 'complete content');
  assert.equal(fs.files.has(fs.root + '/cat.p1.live.json.tmp'), false, 'no temp file left');
  // A failing gate never blocks or breaks a write (error recovery).
  store.setWriteGate(() => Promise.reject(new Error('gate broke')));
  await store.write('b.json', 'ok');
  assert.equal(await store.read('b.json'), 'ok');
  store.setWriteGate(null);
  await store.write('b.json', 'plain');
  assert.equal(await store.read('b.json'), 'plain', 'without a gate: the old behaviour');
});

test('Stage 9 catalogue update: with keys pressed, no file is written; once quiet the stored data is complete and identical', async () => {
  const fs = createFakeTizenFs();
  const store = createTizenFileStore(fs.api);
  const c = createFakeClock();
  const q = createInputQuiet({ now: c.now, setTimer: c.setTimer, quietMs: 1500, maxWaitMs: 5000 });
  store.setWriteGate(q.wait);
  const cat = createCatalogueStore(store, { budgetChars: 50000000, maxChars: 100000000 }, c.now, createLogger(100));
  const payload = { v: 1, rows: Array.from({ length: 3000 }, (_, i) => ['id' + i, 'Name ' + i]) };
  q.note();
  let saved = null;
  cat.save('p1', 'live', payload).then((r) => { saved = r; });
  for (let i = 0; i < 3; i++) { // 1.2 s of key presses
    await sleep(2); c.advance(400); await flush(); q.note();
    assert.equal(fs.files.size, 0, 'no blocking write while the user is pressing keys');
  }
  for (let i = 0; i < 300 && !saved; i++) { c.advance(500); await flush(); await sleep(1); }
  assert.ok(saved && saved.ok, 'the update completes once the remote is quiet');
  const back = await cat.load('p1', 'live', (x) => !!x);
  assert.equal(back.status, 'ok');
  assert.deepEqual(back.data, payload, 'consistent data, no duplicate rows');
});

test('Stage 9 search (TV pass 2): a slow channel list does not hold back movie results', async () => {
  const e = searchEnv({ slowLive: true });
  e.type('news night');
  await until(() => e.views.movie.searches.length === 1, 1000, 'movie scan starts before the channel list is ready');
  e.views.movie.searches[0].onProgress([0]);
  await until(() => e.rowLabels().length === 1, 1000, 'movie row');
  assert.deepEqual(e.rowLabels(), ['Movies · 1']);
  assert.equal(e.message(), 'Searching…', 'channels still loading');
  e.views.movie.searches[0].resolve([0]);
  e.views.series.searches[0].resolve([]);
  await sleep(10);
  assert.equal(e.message(), 'Searching…');
  e.releaseLive();
  await until(() => e.message() !== 'Searching…', 1000, 'done');
  assert.deepEqual(e.rowLabels(), ['Movies · 1']);
});
