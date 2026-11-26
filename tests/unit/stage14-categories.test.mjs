// Stage 14: category management — hide/show and reorder provider categories per account and type,
// restore defaults, persistence, provider changes, storage failures, the 150 MB guard. Pure rules
// (content/category-prefs.ts) and Live TV UI driven by the real key router, screen router,
// PlaylistService and fake engine. Movies/Series UI tests are in vod-ui.test.mjs (Stage 14 part).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/navigation/router.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { registerLiveScreens } from '../../src/screens/live-screens.ts';
import { createConfirmDialog } from '../../src/screens/confirm-dialog.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createEpgService } from '../../src/services/epg-service.ts';
import { createUserLists } from '../../src/services/user-lists.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import {
  arrange, createCategoryEditor, createCategoryPrefsStore, emptyPrefs, isCategoryPrefs, mergeOrder, prefsKey, MAX_PREF_IDS
} from '../../src/content/category-prefs.ts';
import { createChannelIndex } from '../../src/content/channel-index.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';

const cat = (id, name, count = 1) => ({ id, name: name || 'Cat ' + id, section: 'live', count, adult: false });
const ids = (provider, order) => order.map((i) => provider[i].id);

// ---------------------------------------------------------------- pure rules

test('Stage 14 order: provider order by default; saved order kept; new categories after their provider predecessor; removed ids kept', () => {
  const P = [cat('a'), cat('b'), cat('c'), cat('d')];
  assert.deepEqual(mergeOrder(P, []), ['a', 'b', 'c', 'd']);
  assert.deepEqual(mergeOrder(P, ['d', 'c', 'b', 'a']), ['d', 'c', 'b', 'a']);
  // The provider adds "x" after "b" and "y" first; the user's order of the others is untouched.
  const P2 = [cat('y'), cat('a'), cat('b'), cat('x'), cat('c'), cat('d')];
  assert.deepEqual(mergeOrder(P2, ['d', 'c', 'b', 'a']), ['y', 'd', 'c', 'b', 'x', 'a']);
  // The provider drops "c" (or fails to return it for a while): its saved place is kept for later.
  const P3 = [cat('a'), cat('b'), cat('d')];
  assert.deepEqual(mergeOrder(P3, ['d', 'c', 'b', 'a']), ['d', 'c', 'b', 'a']);
  assert.deepEqual(ids(P3, arrange(P3, { order: ['d', 'c', 'b', 'a'], hidden: [] })), ['d', 'b', 'a'], 'unknown ids are skipped when listing');
  assert.deepEqual(ids(P, arrange(P, { order: ['d', 'c', 'b', 'a'], hidden: [] })), ['d', 'c', 'b', 'a'], '…and come back in their place');
  assert.deepEqual(ids(P, arrange(P, { order: [], hidden: [] })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(arrange([], { order: ['d'], hidden: ['d'] }), [], 'a provider returning nothing lists nothing and changes nothing');
  assert.deepEqual(mergeOrder([cat('a'), cat('a'), cat('b')], ['b', 'b', 'a']), ['b', 'a'], 'duplicate ids once');
});

test('Stage 14 arrange: hidden left out, by id (duplicate names told apart); default prefs = provider order; no category copies', () => {
  const P = [cat('1', 'News'), cat('2', 'Sport'), cat('3', 'News'), cat('4', 'Kids')];
  const frozen = JSON.stringify(P);
  assert.deepEqual(arrange(P, emptyPrefs()), [0, 1, 2, 3]);
  assert.deepEqual(arrange(P, { order: [], hidden: ['3'] }), [0, 1, 3], 'only the second "News" is hidden');
  assert.deepEqual(arrange(P, { order: ['4', '3', '2', '1'], hidden: ['2'] }), [3, 2, 0]);
  assert.deepEqual(arrange(P, { order: ['4', '3', '2', '1'], hidden: ['2'] }, true), [3, 2, 1, 0], 'manager view keeps hidden ones');
  assert.equal(JSON.stringify(P), frozen, 'the provider categories are never changed');
  // A duplicated provider id lists every provider entry with it, once in the user's order.
  const D = [cat('a'), cat('b'), cat('a')];
  assert.deepEqual(arrange(D, { order: ['b', 'a'], hidden: [] }), [1, 0, 2]);
});

test('Stage 14 editor: hide, show, move up/down repeatedly, saved position restored on show, back to defaults, unknown ids kept', () => {
  const P = [cat('a'), cat('b'), cat('c'), cat('empty', 'Empty', 0), cat('d')];
  const listed = [0, 1, 2, 4]; // categories with content
  const ed = createCategoryEditor(P, listed, emptyPrefs());
  const rows = (e) => Array.from({ length: e.size() }, (_, i) => P[e.row(i).index].id + (e.row(i).hidden ? '-' : ''));
  assert.deepEqual(rows(ed), ['a', 'b', 'c', 'd'], 'empty categories are not listed');
  assert.equal(ed.isDefault(), true);
  assert.deepEqual(ed.prefs(), { order: [], hidden: [] });
  ed.toggle(1);
  assert.deepEqual(rows(ed), ['a', 'b-', 'c', 'd']);
  assert.equal(ed.hiddenCount(), 1);
  assert.deepEqual(ed.prefs(), { order: [], hidden: ['b'] }, 'hiding alone stores no order');
  let at = ed.move(3, -1); // d up three times
  at = ed.move(at, -1);
  at = ed.move(at, -1);
  assert.equal(at, 0);
  assert.equal(ed.move(0, -1), 0, 'cannot move above the first');
  assert.equal(ed.move(3, 1), 3, 'cannot move below the last');
  assert.deepEqual(rows(ed), ['d', 'a', 'b-', 'c']);
  assert.equal(ed.move(1, 1), 2); // a down past the hidden b: hidden ones keep their relative place
  assert.deepEqual(rows(ed), ['d', 'b-', 'a', 'c']);
  ed.toggle(1); // show b again: in its saved place
  assert.deepEqual(rows(ed), ['d', 'b', 'a', 'c']);
  const p = ed.prefs();
  assert.deepEqual(p.hidden, []);
  assert.deepEqual(p.order, ['d', 'b', 'a', 'empty', 'c'], 'the empty category keeps a place for when it gets content');
  // Moving back to the provider order stores no order.
  const ed2 = createCategoryEditor(P, listed, p);
  ed2.move(0, 1); ed2.move(1, 1); ed2.move(2, 1); ed2.move(1, -1);
  assert.deepEqual(rows(ed2), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ed2.prefs(), { order: [], hidden: [] });
  assert.equal(ed2.isDefault(), true);
  // Saved ids the provider no longer returns stay in the stored prefs.
  const ed3 = createCategoryEditor([cat('a'), cat('d')], [0, 1], { order: ['d', 'gone', 'a'], hidden: ['gone2'] });
  ed3.move(1, -1);
  assert.deepEqual(ed3.prefs(), { order: ['a', 'gone', 'd'], hidden: ['gone2'] });
  assert.equal(ed3.isDefault(), false, 'a hidden id of a removed category still counts (Restore defaults clears it)');
});

test('Stage 14 store: per account and type, restart, reset, account removal, invalid data, storage failure, size cap', () => {
  const local = createMemoryLocalStore();
  const kv = createKeyValueStore(local, createLogger(50));
  const s = createCategoryPrefsStore(kv);
  assert.deepEqual(s.get('pl1', 'live'), emptyPrefs());
  assert.equal(s.set('pl1', 'live', { order: ['b', 'a'], hidden: ['c'] }), true);
  assert.equal(s.set('pl1', 'movie', { order: [], hidden: ['10'] }), true);
  assert.equal(s.set('pl2', 'live', { order: [], hidden: ['x'] }), true);
  const again = createCategoryPrefsStore(createKeyValueStore(local, createLogger(50))); // app restart
  assert.deepEqual(again.get('pl1', 'live'), { order: ['b', 'a'], hidden: ['c'] });
  assert.deepEqual(again.get('pl1', 'movie'), { order: [], hidden: ['10'] });
  assert.deepEqual(again.get('pl1', 'series'), emptyPrefs(), 'types are separate');
  assert.deepEqual(again.get('pl2', 'live'), { order: [], hidden: ['x'] }, 'accounts are separate');
  const g = again.get('pl1', 'live');
  g.hidden.push('mutated');
  assert.deepEqual(again.get('pl1', 'live').hidden, ['c'], 'callers get copies');
  assert.equal(s.set('pl1', 'movie', emptyPrefs()), true);
  assert.equal(kv.names().indexOf(prefsKey('movie', 'pl1')), -1, 'default prefs remove the key');
  s.reset('pl1', 'live');
  assert.deepEqual(s.get('pl1', 'live'), emptyPrefs());
  assert.deepEqual(s.get('pl2', 'live'), { order: [], hidden: ['x'] }, 'reset touches one account and type');
  s.clear('pl2');
  assert.deepEqual(kv.names().filter((n) => n.indexOf('catprefs.') === 0), []);
  assert.equal(s.set('../evil', 'live', { order: [], hidden: ['x'] }), false, 'invalid account id');
  kv.set(prefsKey('live', 'pl1'), { order: 'nope', hidden: [] });
  assert.deepEqual(s.get('pl1', 'live'), emptyPrefs(), 'invalid stored data falls back to defaults');
  assert.equal(isCategoryPrefs({ order: [1], hidden: [] }), false);
  assert.equal(isCategoryPrefs({ order: new Array(MAX_PREF_IDS + 1).fill('a'), hidden: [] }), false);
  // Storage failure (quota): set reports false, nothing throws.
  const full = createMemoryLocalStore();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  const sf = createCategoryPrefsStore(createKeyValueStore(full, createLogger(50)));
  assert.equal(sf.set('pl1', 'live', { order: [], hidden: ['a'] }), false);
  assert.deepEqual(sf.get('pl1', 'live'), emptyPrefs());
  // Cap: ids of removed categories are dropped first; current ones always stay.
  const many = Array.from({ length: MAX_PREF_IDS }, (_, i) => 'old' + i);
  const ed = createCategoryEditor([cat('a'), cat('b')], [0, 1], { order: many, hidden: [] });
  ed.move(1, -1);
  const p = ed.prefs();
  assert.equal(p.order.length, MAX_PREF_IDS);
  assert.ok(p.order.indexOf('a') >= 0 && p.order.indexOf('b') >= 0);
});

test('Stage 14 performance: 400 categories over a 22,000-channel index arrange in a few ms without touching channels', () => {
  const categories = [];
  const channels = [];
  for (let c = 0; c < 400; c++) { categories.push(cat('c' + c, 'Category ' + c, 55)); }
  for (let i = 0; i < 22000; i++) { channels.push({ id: 's' + i, num: i + 1, name: 'Channel ' + i, categoryId: 'c' + (i % 400), adult: false, streamRef: { kind: 'url', url: 'http://s.example/' + i } }); }
  const idx = createChannelIndex({ categories, channels });
  const order = categories.map((c) => c.id).reverse();
  const hidden = categories.filter((_, i) => i % 3 === 0).map((c) => c.id);
  const t0 = process.hrtime.bigint();
  let out;
  for (let r = 0; r < 20; r++) { out = arrange(idx.categories, { order, hidden }); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  assert.equal(out.length, 400 - hidden.length);
  assert.ok(ms < 20, 'arrange ' + ms.toFixed(2) + ' ms');
  assert.equal(idx.channels, channels, 'same channel array');
  assert.equal(idx.categories, categories, 'same category array');
  assert.equal(idx.byCategory('c5').length, 55, 'category lists unchanged');
  const ed = createCategoryEditor(idx.categories, categories.map((_, i) => i), { order, hidden });
  const t1 = process.hrtime.bigint();
  let at = 399;
  for (let m = 0; m < 399; m++) { at = ed.move(at, -1); }
  const mv = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(at, 0);
  assert.ok(mv < 50, '399 moves ' + mv.toFixed(2) + ' ms');
});

// ---------------------------------------------------------------- Live TV UI

const KEY = { left: 37, up: 38, right: 39, down: 40, ok: 13, back: 10009, chUp: 427, chDown: 428 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(3);
  }
}

function makeM3u(n) {
  const parts = ['#EXTM3U\n'];
  for (let i = 0; i < n; i++) {
    parts.push('#EXTINF:-1 tvg-chno="' + (i + 1) + '" group-title="Group ' + (i % 3) + '",Channel ' + (i + 1) + '\nhttp://s.example/live/' + (i + 1) + '.ts\n');
  }
  return parts.join('');
}

async function setup(opts = {}) {
  const log = createLogger(3000);
  const kv = createKeyValueStore(createMemoryLocalStore(), log);
  const m3u = makeM3u(30);
  const srv = createFakeServer(() => ({ status: 200, body: m3u, chunk: 1048576 }));
  const http = createHttpClient({ xhrFactory: srv.factory });
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
  const now = () => Date.now();
  const catalogue = createCatalogueStore(createMemoryFileStore(), { budgetChars: 50000000, maxChars: 100000000 }, now, log);
  const playlists = createPlaylistService({
    kv, catalogue, secrets: createSecretStore(createMemoryKeyStore()), http, now, log: log.child('playlists'), timers,
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 20000000, maxPlaylistChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000 }
  });
  const epg = createEpgService({
    playlists, catalogue, http, now, timers: { ...timers, now }, log: log.child('epg'),
    limits: { maxChars: 1000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000, pastHours: 2, futureHours: 24, maxPerChannel: 300, maxTotal: 1000, staleMs: 12 * 3600000, defaultOffsetMin: 0 }
  });
  const lists = createUserLists(kv);
  const fe = createFakeEngine();
  const doc = createFakeDocument();
  const t = createTranslator('en');
  const router = createRouter(createDomHost(doc, doc.body), log.child('router'));
  const real = createCategoryPrefsStore(kv);
  const catPrefs = opts.failWrites ? { get: real.get, reset: real.reset, clear: real.clear, set: () => false } : real;
  registerLiveScreens(router, {
    doc, t, playlists, epg, lists, lifecycle: { on: () => () => {} }, engine: fe.engine, textInput: { active: false }, preferIme: false, now, ...timers, log,
    player: { bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 30, retryDelaysMs: [], numberEntryMs: 60 },
    catPrefs, memoryMB: opts.memoryMB || (() => 400), minFreeMB: 150
  });
  router.register('confirm', (p, nav) => createConfirmDialog(doc, p, nav));
  let k = 0;
  const keyRouter = createKeyRouter({ now: () => (k += 200), throttleMs: 110, allowBrowserKeys: false, dispatch: (e) => router.handleKey(e) });
  const ev = (code) => ({ keyCode: code, preventDefault() {} });
  function press(name, times = 1) {
    for (let i = 0; i < times; i++) {
      const code = typeof name === 'number' ? name : KEY[name];
      keyRouter.keyDown(ev(code));
      keyRouter.keyUp(ev(code));
    }
  }
  const layer = () => { const l = doc.body.childNodes.filter((x) => x.style.display !== 'none' && x.attributes && x.attributes['data-layer']); return l[l.length - 1]; };
  const pl = (await playlists.add({ name: 'Home', kind: 'm3u', url: 'https://secure.example.org/list.m3u' })).playlist;
  playlists.setActive(pl.id);
  const imp = await playlists.refresh(pl.id).result;
  assert.equal(imp.ok, true, JSON.stringify(imp));
  return { router, press, layer, doc, fe, playlists, pl, log, kv, catPrefs: real };
}

async function openLive(env, reset) {
  const n = env.log.entries().filter((e) => e.msg === 'live tv ready').length;
  if (reset) { env.router.resetTo('live-tv', { playlistId: env.pl.id }); } else { env.router.push('live-tv', { playlistId: env.pl.id }); }
  await until(() => env.log.entries().filter((e) => e.msg === 'live tv ready').length > n, 20000, 'live tv ready');
}
const catNames = (env) => env.layer().findAll('ss-cat').filter((c) => c.style.display !== 'none').map((c) => c.findAll('ss-cat__name')[0].textContent);
const catCounts = (env) => env.layer().findAll('ss-cat').filter((c) => c.style.display !== 'none').map((c) => c.findAll('ss-cat__count')[0].textContent);
const sheet = (env) => env.layer().findAll('ss-catman')[0];
const sheetOpen = (env) => !!sheet(env) && !/is-hidden/.test(sheet(env).className);
const sheetRows = (env) => sheet(env).findAll('ss-catman__row').filter((r) => r.style.display !== 'none')
  .map((r) => r.findAll('ss-catman__name')[0].textContent + (/is-off/.test(r.className) ? ' [hidden]' : ''));
const chanNames = (env) => env.layer().findAll('ss-ch').filter((c) => c.style.display !== 'none').map((c) => c.findAll('ss-ch__name')[0].textContent);
const top = (env) => env.router.stack().slice(-1)[0];
const lastLoad = (env) => env.fe.loads().slice(-1)[0].url;

test('Stage 14 Live TV: Manage categories row; hide, move, saved at once; column updated; All, zapping, number entry unchanged; restart', async () => {
  const env = await setup();
  await openLive(env);
  assert.deepEqual(catNames(env), ['Search', 'Favourites', 'Recently watched', 'All channels', 'Manage categories', 'Group 0', 'Group 1', 'Group 2']);
  env.press('left'); // channels → categories (All channels)
  env.press('down'); // Manage categories
  await sleep(200);
  assert.equal(chanNames(env)[0], 'Channel 1', 'focusing the row does not change the channel list');
  env.press('ok');
  assert.equal(sheetOpen(env), true);
  assert.match(sheet(env).textContent, /Live TV · 3 categories · 0 hidden/);
  assert.deepEqual(sheetRows(env), ['Group 0', 'Group 1', 'Group 2']);
  env.press('ok'); // hide Group 0
  assert.deepEqual(sheetRows(env), ['Group 0 [hidden]', 'Group 1', 'Group 2']);
  assert.match(sheet(env).textContent, /Saved/);
  assert.match(sheet(env).textContent, /1 hidden/);
  assert.deepEqual(env.catPrefs.get(env.pl.id, 'live').order, []);
  assert.equal(env.catPrefs.get(env.pl.id, 'live').hidden.length, 1, 'stored at once (id, not name)');
  env.press('down'); // Group 1
  env.press('right'); // pick up
  assert.match(sheet(env).textContent, /OK or ◄: place here/);
  env.press('down'); // below Group 2
  assert.deepEqual(sheetRows(env), ['Group 0 [hidden]', 'Group 2', '⇅  Group 1']);
  env.press('ok'); // put down: saved
  assert.equal(env.catPrefs.get(env.pl.id, 'live').order.length, 3);
  env.press('back'); // close
  assert.equal(sheetOpen(env), false);
  assert.deepEqual(catNames(env), ['Search', 'Favourites', 'Recently watched', 'All channels', 'Manage categories', 'Group 2', 'Group 1']);
  assert.equal(catCounts(env)[3], '30', 'All channels still counts every channel');
  env.press('down'); // Group 2
  await until(() => chanNames(env)[0] === 'Channel 3', 2000, 'group 2 channels');
  env.press('ok'); // into the channels
  env.press('ok'); // play Channel 3
  await until(() => top(env) === 'player' && env.fe.loads().length >= 1, 2000, 'player');
  env.fe.prepared(); env.fe.picture();
  assert.match(lastLoad(env), /\/3\.ts$/);
  env.press('chUp'); // zapping stays inside the shown category
  await until(() => /\/6\.ts$/.test(lastLoad(env)), 2000, 'zap to 6');
  env.fe.prepared(); env.fe.picture();
  env.press(49); // "1": Channel 1 is in the hidden Group 0 — number entry still finds it
  await until(() => /\/1\.ts$/.test(lastLoad(env)), 3000, 'number entry to 1');
  env.fe.prepared(); env.fe.picture();
  env.press('back');
  assert.equal(top(env), 'live-tv');
  // Restart: a new Live TV screen reads the stored prefs.
  await openLive(env, true);
  assert.deepEqual(catNames(env).slice(4), ['Manage categories', 'Group 2', 'Group 1']);
  env.fe.engine.stop();
});

test('Stage 14 Live TV: hiding the shown category falls back to All; Restore defaults asks first; Cancel keeps; account removal clears', async () => {
  const env = await setup();
  await openLive(env);
  env.press('left');
  env.press('down', 2); // Group 0 (shown after the 150 ms rest)
  await until(() => chanNames(env)[0] === 'Channel 1' && chanNames(env)[1] === 'Channel 4', 2000, 'group 0 shown');
  env.press('up'); // Manage categories
  env.press('ok');
  env.press('ok'); // hide Group 0 (the shown one)
  env.press('back');
  assert.deepEqual(catNames(env).slice(4), ['Manage categories', 'Group 1', 'Group 2']);
  await until(() => chanNames(env)[1] === 'Channel 2', 2000, 'All channels shown');
  assert.match(env.layer().findAll('ss-cat').filter((c) => /is-focused/.test(c.className))[0].textContent, /Manage categories/, 'focus back on the row');
  env.press('ok'); // open again
  env.press('up'); // Restore defaults
  assert.match(sheet(env).textContent, /OK: provider order, all categories shown/);
  env.press('ok');
  assert.match(env.layer().textContent, /Restore defaults\?/);
  env.press('ok'); // Cancel (first, focused)
  assert.equal(sheetOpen(env), true);
  assert.equal(env.catPrefs.get(env.pl.id, 'live').hidden.length, 1, 'Cancel changed nothing');
  env.press('ok'); // ask again
  env.press('right');
  env.press('ok'); // Restore
  assert.equal(sheetOpen(env), true);
  assert.deepEqual(sheetRows(env), ['Group 0', 'Group 1', 'Group 2']);
  assert.equal(env.kv.names().filter((n) => n.indexOf('catprefs.') === 0).length, 0, 'the key is removed');
  env.press('ok'); // OK on Restore defaults with nothing to restore: no dialog
  assert.doesNotMatch(env.layer().textContent, /Restore defaults\?/);
  env.press('down');
  env.press('ok'); // hide Group 0 again
  env.press('back');
  assert.deepEqual(catNames(env).slice(4), ['Manage categories', 'Group 1', 'Group 2']);
  // A second account has its own (default) categories; removing the first removes only its prefs.
  const other = (await env.playlists.add({ name: 'Other', kind: 'm3u', url: 'https://other.example.org/list.m3u' })).playlist;
  assert.deepEqual(env.catPrefs.get(other.id, 'live'), emptyPrefs());
  env.catPrefs.set(other.id, 'live', { order: [], hidden: ['zz'] });
  await env.playlists.remove(env.pl.id);
  assert.deepEqual(env.catPrefs.get(env.pl.id, 'live'), emptyPrefs());
  assert.deepEqual(env.catPrefs.get(other.id, 'live').hidden, ['zz']);
  env.fe.engine.stop();
});

test('Stage 14 Live TV: below 150 MB the manager does not open (message, retry later); storage failure says Not saved and keeps the change for the session', async () => {
  let free = 120;
  const env = await setup({ memoryMB: () => free });
  await openLive(env);
  env.press('left');
  env.press('down');
  env.press('ok');
  assert.equal(sheetOpen(env), false);
  assert.match(env.layer().textContent, /Not enough free memory to manage categories/);
  assert.ok(env.log.entries().some((e) => e.msg === 'categories: manager not opened, memory low'));
  free = 300;
  env.press('ok');
  assert.equal(sheetOpen(env), true, 'retry once memory is back');
  env.press('back');
  assert.equal(sheetOpen(env), false);

  const env2 = await setup({ failWrites: true });
  await openLive(env2);
  env2.press('left');
  env2.press('down');
  env2.press('ok');
  env2.press('ok'); // hide Group 0: not stored
  assert.match(sheet(env2).textContent, /Not saved: the TV storage is full/);
  env2.press('back');
  assert.deepEqual(catNames(env2).slice(4), ['Manage categories', 'Group 1', 'Group 2'], 'applies until the app closes');
  assert.deepEqual(env2.catPrefs.get(env2.pl.id, 'live'), emptyPrefs());
  env.fe.engine.stop();
  env2.fe.engine.stop();
});

test('Stage 14 Live TV: a category passed on the way (or left within 150 ms) is not shown afterwards', async () => {
  const env = await setup();
  await openLive(env);
  env.press('left'); // All channels
  env.press('down', 2); // over Manage categories to Group 0 …
  env.press('up', 2); // … and straight back to All channels
  await sleep(300);
  assert.equal(chanNames(env)[1], 'Channel 2', 'All channels stays shown');
  env.press('down', 3); // Manage, Group 0, Group 1: only the last one rested
  await until(() => chanNames(env)[0] === 'Channel 2' && chanNames(env)[1] === 'Channel 5', 2000, 'group 1');
  await sleep(200);
  assert.equal(chanNames(env)[1], 'Channel 5');
  env.fe.engine.stop();
});
