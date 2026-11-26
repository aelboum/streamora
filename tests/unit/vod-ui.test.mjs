// Stage 6 UI: Movies and Series screens, details, VOD player and controller, driven by remote key
// codes through the real key router and screen router, against the real PlaylistService,
// VodService and EpgService (memory stores, fake HTTP server with synthetic Xtream responses),
// the fake playback engine and a fake DOM. Includes a Live TV ↔ VOD regression on the shared engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/navigation/router.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { registerPlaylistScreens } from '../../src/screens/playlist-screens.ts';
import { registerLiveScreens, textOpener } from '../../src/screens/live-screens.ts';
import { registerVodScreens } from '../../src/screens/vod-screens.ts';
import { IME_DONE } from '../../src/screens/text-entry-overlay.ts';
import { formatTime, seekStep } from '../../src/screens/vod-player-screen.ts';
import { createVodController } from '../../src/player/vod-controller.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createEpgService } from '../../src/services/epg-service.ts';
import { createVodService } from '../../src/services/vod-service.ts';
import { createUserLists } from '../../src/services/user-lists.ts';
import { createProgressStore, progressKey } from '../../src/services/progress.ts';
import { createTrackPrefs, languageName, normLang, preferredChoices } from '../../src/services/track-prefs.ts';
import { subtitleLines } from '../../src/screens/vod-player-screen.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { xtreamVodRoute } from '../fakes/fake-xtream-vod.mjs';
import { createHomeScreen } from '../../src/screens/home-screen.ts';
import { createSearchScreen } from '../../src/screens/search-screen.ts';
import { createSettingsScreen } from '../../src/screens/settings-screen.ts';
import { createAboutScreen } from '../../src/screens/about-screen.ts';
import { createPinDialog } from '../../src/screens/pin-dialog.ts';
import { createParental } from '../../src/services/parental.ts';
import { createPinService } from '../../src/security/pin.ts';
import { createWebCrypto } from '../../src/app/platform/common.ts';
import { matchCategories } from '../../src/screens/find-category-sheet.ts';
import { createMyList } from '../../src/services/my-list.ts';
import { createCategoryPrefsStore } from '../../src/content/category-prefs.ts';

const KEY = { left: 37, up: 38, right: 39, down: 40, ok: 13, back: 10009, chUp: 427, chDown: 428, playPause: 10252, yellow: 405, green: 404,
  d0: 48, d1: 49, d2: 50, d3: 51, d4: 52, d5: 53, d6: 54, d7: 55, d8: 56, d9: 57 };
const PASS = 'demo_pass_9f3k';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(5);
  }
}

async function setup(opts = {}) {
  const log = createLogger(3000);
  const kv = createKeyValueStore(createMemoryLocalStore(), log);
  const route = xtreamVodRoute(opts.over || {});
  const srv = createFakeServer((url) => route.fn(url));
  const http = createHttpClient({ xhrFactory: srv.factory });
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
  const now = () => Date.now();
  const catalogue = createCatalogueStore(createMemoryFileStore(), { budgetChars: 50000000, maxChars: 100000000 }, now, log);
  const playlists = createPlaylistService({
    kv, catalogue, secrets: createSecretStore(createMemoryKeyStore()), http, now, log: log.child('playlists'), timers,
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000 }
  });
  const epg = createEpgService({
    playlists, catalogue, http, now, timers: { ...timers, now }, log: log.child('epg'),
    limits: { maxChars: 10000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000, pastHours: 2, futureHours: 24, maxPerChannel: 300, maxTotal: 100000, staleMs: 12 * 3600000, defaultOffsetMin: 0 }
  });
  const vod = createVodService({ playlists, catalogue, kv, now, log: log.child('vod') });
  const lists = createUserLists(kv);
  const progress = createProgressStore(kv, now);
  const trackPrefs = createTrackPrefs(kv);
  const pin = createPinService(createWebCrypto(globalThis.crypto), createMemoryKeyStore(), kv, { iterations: 600000, maxAttempts: 5, lockoutMs: 60000 }, now, log.child('parental'));
  await pin.load();
  const parental = createParental(pin, kv, now);
  const fe = createFakeEngine();
  const doc = createFakeDocument();
  const t = createTranslator('en');
  const router = createRouter(createDomHost(doc, doc.body), log.child('router'));
  const textInput = { active: false };
  const lifeCbs = [];
  const lifecycle = { on: (cb) => { lifeCbs.push(cb); return () => lifeCbs.splice(lifeCbs.indexOf(cb), 1); } };
  const openText = textOpener(true);
  registerPlaylistScreens(router, { doc, playlists, t, now, ...timers, openText, live: true, vod: true });
  registerLiveScreens(router, {
    doc, t, playlists, epg, lists, lifecycle, engine: fe.engine, textInput, preferIme: true, now, ...timers, log,
    player: { bufferSec: 2, prepareTimeoutMs: 15000, prepareStallMs: 0, zapDebounceMs: 40, retryDelaysMs: [50, 50, 50] }, parental
  });
  // Stage 11: My List only where a test asks for it (it adds a category row).
  const myList = opts.myList ? createMyList(kv, now) : null;
  // Stage 14: Manage categories only where a test asks for it (it adds a category row too).
  const catPrefs = opts.catPrefs ? createCategoryPrefsStore(kv) : null;
  registerVodScreens(router, { doc, t, playlists, vod, progress, trackPrefs, parental, myList, catPrefs, memoryMB: opts.memoryMB, minFreeMB: opts.memoryMB ? 150 : 0, lifecycle, engine: fe.engine, openText, now, ...timers, log, prepareTimeoutMs: 15000 });
  router.register('diagnostics', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
  router.register('home', (_p, nav) => createHomeScreen({ doc, t, playlists, vod, progress, parental, now, ...timers }, nav));
  router.register('pin-dialog', (pp, nav) => createPinDialog({ doc, t, parental, openText }, pp, nav));
  router.register('search', (_p, nav) => createSearchScreen({ doc, t, playlists, vod, kv, openText }, nav));
  const langCalls = [];
  router.register('settings', (_p, nav) => createSettingsScreen({
    doc, t, playlists, progress, trackPrefs, kv, parental, language: () => 'en', setLanguage: (l) => langCalls.push(l),
    about: () => [{ label: 'Version', value: '0.2.0' }]
  }, nav));
  router.register('about', (_p, nav) => createAboutScreen({ doc, t, lines: () => [{ label: 'Version', value: '0.2.0' }] }, nav));
  let k = 0;
  const keyRouter = createKeyRouter({ now: () => (k += 200), throttleMs: 110, allowBrowserKeys: false, dispatch: (e) => router.handleKey(e), textInputActive: () => textInput.active });
  const ev = (code) => ({ keyCode: code, preventDefault() {} });
  function press(name, times = 1) {
    for (let i = 0; i < times; i++) {
      keyRouter.keyDown(ev(KEY[name]));
      keyRouter.keyUp(ev(KEY[name]));
    }
  }
  const layer = () => { const l = doc.body.childNodes.filter((n) => n.style.display !== 'none' && n.attributes && n.attributes['data-layer']); return l[l.length - 1]; };
  const pl = (await playlists.add({ name: 'Provider', kind: 'xtream', server: 'provider.example:8080', username: 'demo_user', password: PASS })).playlist;
  playlists.setActive(pl.id);
  await playlists.refresh(pl.id).result;
  router.resetTo('playlists');
  return { router, press, layer, doc, fe, playlists, vod, pl, textInput, log, route, lifeCbs, srv, progress, kv, trackPrefs, langCalls, parental, pin, myList, catPrefs };
}

const top = (env) => env.router.stack().slice(-1)[0];
const buttons = (env) => env.layer().findAll('ss-button').map((b) => b.textContent);
const focusedButton = (env) => env.layer().findAll('ss-button').filter((b) => /is-focused/.test(b.className)).map((b) => b.textContent);
const cards = (env) => [].concat(...env.layer().findAll('ss-vod__row').filter((r) => r.style.display !== 'none').map((r) => r.findAll('ss-card'))).filter((c) => c.style.visibility !== 'hidden');
const cardTitles = (env) => cards(env).map((c) => c.findAll('ss-card__title')[0].textContent);
const focusedCard = (env) => cards(env).filter((c) => /is-focused/.test(c.className)).map((c) => c.findAll('ss-card__title')[0].textContent);
const focusedCat = (env) => env.layer().findAll('ss-cat').filter((c) => /is-focused/.test(c.className)).map((c) => c.findAll('ss-cat__name')[0].textContent);
const visibleCats = (env) => env.layer().findAll('ss-cat').filter((c) => c.style.display !== 'none').map((c) => c.findAll('ss-cat__name')[0].textContent);

async function openSection(env, label) {
  const i = buttons(env).indexOf(label);
  assert.ok(i >= 0, label + ' button present');
  if (!focusedButton(env).length) { env.press('up'); } // focus starts on the playlist list
  env.press('left', 6);
  env.press('right', i);
  env.press('ok');
  assert.equal(top(env), 'vod-browse');
  await until(() => env.log.entries().some((e) => e.msg === 'vod browse ready'), 20000, 'browse ready');
  await titlesShown(env);
}

/** Stage 6.1: titles arrive page by page after the index; wait until no visible card is a placeholder. */
async function titlesShown(env) {
  await until(() => { const t = cardTitles(env); return t.length > 0 && t.every((x) => x !== ''); }, 5000, 'titles shown');
}

test('Playlists screen: Movies and Series appear for an active Xtream playlist only', async () => {
  const env = await setup();
  assert.deepEqual(buttons(env).slice(0, 3), ['Live TV', 'Movies', 'Series']);
  const m3u = (await env.playlists.add({ name: 'M', kind: 'm3u', url: 'http://m.example/list.m3u' })).playlist;
  env.playlists.setActive(m3u.id);
  env.router.resetTo('playlists');
  assert.equal(buttons(env).indexOf('Movies'), -1, 'not for M3U playlists');
});

test('Movies: first open downloads the list; categories, poster grid, navigation, search, details, play, Back', async () => {
  const env = await setup({ });
  await openSection(env, 'Movies');
  // Stage 6.1: titles are downloaded per category, so titles outside the listed categories (no or an
  // unknown category_id in the fixture) are not part of the list any more.
  assert.match(env.layer().textContent, /Updated .* · 4 titles/);
  assert.deepEqual(visibleCats(env).slice(0, 5), ['Search', 'Find a category', 'Update list', 'All movies', 'Action']);
  assert.deepEqual(cardTitles(env), ['The Long Night (2019)', 'Amélie ✨ 🇫🇷', 'فيلم عربي', 'Adult title']);
  assert.deepEqual(focusedCard(env), ['The Long Night (2019)'], 'first title focused');
  const first = cards(env)[0];
  assert.equal(first.findAll('ss-card__img')[0].attributes.src, 'http://img.example.org/posters/5001.jpg');
  const second = cards(env)[1];
  assert.equal(second.findAll('ss-card__img')[0].style.visibility, 'hidden', 'no poster: the title placeholder is shown');
  env.press('right', 2);
  assert.deepEqual(focusedCard(env), ['فيلم عربي']);
  env.press('down'); // a single row: stays
  assert.deepEqual(focusedCard(env), ['فيلم عربي']);
  env.press('left', 3); // to the categories
  assert.deepEqual(focusedCat(env), ['All movies']);
  env.press('down'); // Action
  await sleep(200);
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['The Long Night (2019)']);
  env.press('down'); // Comédie – Français
  await sleep(200);
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['Amélie ✨ 🇫🇷']);
  // Search with the system keyboard.
  env.press('up', 5);
  assert.deepEqual(focusedCat(env), ['Search']);
  env.press('ok');
  assert.equal(env.router.overlay(), 'text-entry');
  await sleep(5);
  const input = env.layer().findAll('ss-ime__input')[0];
  input.value = 'amé';
  input.dispatch('keydown', { keyCode: IME_DONE });
  await until(() => cardTitles(env).join() === 'Amélie ✨ 🇫🇷', 5000, 'search results');
  assert.deepEqual(focusedCard(env), ['Amélie ✨ 🇫🇷']);
  assert.match(env.layer().textContent, /Search: “amé”/);
  // Details of the first movie: back to All movies, open it.
  env.press('back');
  env.press('down', 3);
  await sleep(200);
  await titlesShown(env);
  env.press('right');
  env.press('ok');
  assert.equal(top(env), 'vod-details');
  await until(() => /Thriller/.test(env.layer().textContent), 5000, 'details');
  const text = env.layer().textContent;
  assert.match(text, /2019 · Thriller · 105 min · ★ 7\.4/);
  assert.match(text, /A long night in a small town/);
  assert.match(text, /Director: A\. Director/);
  assert.deepEqual(focusedButton(env), ['Play']);
  // Play: shared engine, AVPlay default buffering (0), movie URL built at play time.
  env.press('ok');
  assert.equal(top(env), 'vod-player');
  await sleep(10);
  const load = env.fe.loads()[0];
  assert.equal(load.url, 'http://provider.example:8080/movie/demo_user/' + PASS + '/5001.mkv');
  assert.equal(load.bufferSec, 0);
  assert.match(env.doc.body.className, /ss-playing/, 'page transparent for the video plane');
  env.fe.prepared();
  env.fe.picture();
  await sleep(5);
  assert.match(env.layer().textContent, /The Long Night \(2019\)/);
  env.press('ok'); // pause
  assert.ok(env.fe.calls.some((c) => c.op === 'pause'));
  assert.match(env.layer().textContent, /Paused/);
  env.press('playPause'); // resume
  assert.ok(env.fe.calls.some((c) => c.op === 'resume'));
  env.press('back');
  assert.equal(top(env), 'vod-details', 'Back returns to the details');
  assert.equal(env.fe.calls[env.fe.calls.length - 1].op, 'stop', 'playback stopped');
  assert.equal(/ss-playing/.test(env.doc.body.className), false);
  env.press('back');
  assert.equal(top(env), 'vod-browse');
  assert.deepEqual(focusedCard(env), ['The Long Night (2019)'], 'grid position kept');
  env.press('back');
  assert.equal(top(env), 'vod-browse', 'Back from the grid goes to the categories first');
  env.press('back');
  assert.equal(top(env), 'playlists');
  assert.equal(JSON.stringify(env.log.entries()).includes(PASS), false, 'no credentials logged');
});

test('Series: seasons and episodes, episode playback, failed series info with retry, empty series', async () => {
  const env = await setup();
  await openSection(env, 'Series');
  // Stage 6.1: 'All' follows the category order (Drama, then Kids).
  assert.deepEqual(cardTitles(env), ['City Lights', 'Array Seasons', 'Empty Show', 'Bad Info', 'Bébé & Co 🧸']);
  env.press('ok');
  assert.equal(top(env), 'vod-details');
  await until(() => /Season One/.test(env.layer().textContent), 5000, 'seasons');
  assert.match(env.layer().textContent, /2018 · Drama · ★ 8\.1/);
  const eps = () => env.layer().findAll('ss-ep').filter((r) => r.style.display !== 'none').map((r) => r.findAll('ss-ep__name')[0].textContent);
  assert.deepEqual(eps(env), ['1. Pilot 🎬', '2. Second']);
  env.press('down'); // Season Two
  assert.deepEqual(eps(env), ['1. S2 E1 – Début']);
  env.press('up');
  env.press('right'); // episodes
  env.press('down');
  assert.match(env.layer().textContent, /City Lights/);
  env.press('up');
  assert.match(env.layer().textContent, /It begins\./, 'focused episode description');
  env.press('ok');
  assert.equal(top(env), 'vod-player');
  await sleep(10);
  assert.equal(env.fe.loads().slice(-1)[0].url, 'http://provider.example:8080/series/demo_user/' + PASS + '/9101.mp4');
  assert.equal(env.layer().findAll('ss-vbar__title')[0].textContent, 'City Lights · S1 E1 · Pilot 🎬', 'Stage 7F: Series · S1 E3 · Episode title');
  assert.equal(env.layer().findAll('ss-vbar__clock').length, 0, 'Stage 7F: no time-of-day clock in the player');
  env.press('back');
  assert.equal(top(env), 'vod-details');
  env.press('back'); // episodes → seasons
  env.press('back'); // leave details
  assert.equal(top(env), 'vod-browse');
  // Bad Info: series info unusable → message and a retry entry.
  env.press('right', 3);
  env.press('ok');
  await until(() => /couldn’t be loaded/.test(env.layer().textContent), 5000, 'failed info');
  const before = env.route.calls.filter((c) => c === 'get_series_info').length;
  env.press('ok'); // retry (cached as unusable: no new request needed, message stays)
  await sleep(20);
  assert.ok(env.route.calls.filter((c) => c === 'get_series_info').length >= before);
  env.press('back');
  // Empty Show: no episodes.
  env.press('left');
  env.press('ok');
  await until(() => /no episodes/.test(env.layer().textContent), 5000, 'empty series');
});

test('VOD player: errors with retry, progress bar, Home suspend/restore', async () => {
  const env = await setup();
  await openSection(env, 'Movies');
  env.press('ok');
  env.press('ok'); // Play
  await sleep(10);
  env.fe.failPrepare('connection');
  await sleep(5);
  assert.match(env.layer().textContent, /The video can’t be reached\. Press OK to try again or Back to return\./);
  const n = env.fe.loads().length;
  env.press('ok');
  await sleep(10);
  assert.equal(env.fe.loads().length, n + 1, 'OK retries');
  env.fe.engine.timing = () => ({ positionMs: 61000, durationMs: 6300000 });
  env.fe.prepared();
  env.fe.picture();
  await sleep(1100); // one progress tick
  assert.equal(env.layer().findAll('ss-vbar__time--left')[0].textContent, '1:01 / 1:45:00', 'elapsed / total (Stage 7F)');
  assert.match(env.layer().textContent, /−1:43:59/, 'remaining (design 12)');
  env.lifeCbs.forEach((cb) => cb('hidden'));
  assert.ok(env.fe.calls.some((c) => c.op === 'suspend'), 'Home: AVPlay suspend');
  env.lifeCbs.forEach((cb) => cb('visible'));
  assert.ok(env.fe.calls.some((c) => c.op === 'restore'));
  env.press('back');
  assert.equal(top(env), 'vod-details');
  assert.equal(formatTime(3725000), '1:02:05');
  assert.equal(formatTime(59000), '0:59');
  assert.deepEqual([seekStep(0), seekStep(1600), seekStep(4200)], [10000, 30000, 60000], 'held seek accelerates');
});

test('VodController: watchdog, stale callbacks, ended, no engine, no source', async () => {
  const clock = createFakeClock();
  const fe = createFakeEngine();
  const tick = () => new Promise((r) => setImmediate(r));
  const mk = (engine, resolve) => createVodController({ engine, resolve: resolve || ((r) => Promise.resolve({ url: 'http://s.example/' + r.id + '.mp4', type: 'mp4', live: false })),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, prepareTimeoutMs: 15000, log: createLogger(100) });
  const c = mk(fe.engine);
  c.play({ kind: 'xtream', type: 'movie', id: '1', ext: 'mp4' });
  await tick();
  assert.equal(c.state().phase, 'loading');
  clock.advance(15000);
  assert.deepEqual([c.state().phase, c.state().error], ['error', 'timeout']);
  c.retry();
  await tick();
  const first = 0;
  c.play({ kind: 'xtream', type: 'movie', id: '2', ext: 'mp4' }); // a second title before the first answered
  await tick();
  fe.rejectLoad(first + 1, 'format'); // late failure of the abandoned load
  await tick();
  assert.equal(c.state().phase, 'loading', 'stale failure ignored');
  fe.prepared();
  fe.picture();
  assert.equal(c.state().phase, 'playing');
  fe.emit({ type: 'ended' });
  assert.equal(c.state().phase, 'ended');
  c.destroy();
  const none = mk(null);
  none.play({ kind: 'xtream', type: 'movie', id: '1' });
  assert.deepEqual([none.state().phase, none.state().error], ['error', 'unavailable']);
  const nosrc = mk(createFakeEngine().engine, () => Promise.resolve(null));
  nosrc.play({ kind: 'xtream', type: 'movie', id: '1' });
  await tick();
  assert.equal(nosrc.state().error, 'no-source');
});

test('Live TV regression: live → movie → live on the shared engine; live keeps its 2 s buffer', async () => {
  const env = await setup();
  env.press('up'); // from the playlist list to the buttons
  env.press('ok'); // Live TV (first button)
  assert.equal(top(env), 'live-tv');
  await until(() => env.log.entries().some((e) => e.msg === 'live tv ready'), 20000, 'live ready');
  env.press('right');
  env.press('ok'); // watch the first channel
  await sleep(20);
  assert.equal(top(env), 'player');
  assert.equal(env.fe.loads().slice(-1)[0].bufferSec, 2);
  assert.match(env.fe.loads().slice(-1)[0].url, /\/live\/demo_user\//);
  env.press('back');
  env.press('back');
  env.press('back');
  assert.equal(top(env), 'playlists');
  await openSection(env, 'Movies');
  env.press('ok');
  env.press('ok');
  await sleep(10);
  assert.equal(env.fe.loads().slice(-1)[0].bufferSec, 0);
  env.press('back');
  env.press('back');
  env.press('back');
  env.press('back');
  assert.equal(top(env), 'playlists');
  env.press('left', 5);
  env.press('ok');
  await until(() => env.log.entries().filter((e) => e.msg === 'live tv ready').length >= 2, 20000, 'live again');
  env.press('right');
  env.press('ok');
  await sleep(20);
  assert.equal(env.fe.loads().slice(-1)[0].bufferSec, 2, 'live after VOD: unchanged');
});

// ---------------------------------------------------------------- Stage 7B.1 (design implementation)

const tileOf = (env, id) => env.layer().findAll('ss-tile').filter((x) => x.attributes['data-tile'] === id)[0];
const barOf = (env, id) => env.layer().findAll('ss-bar__item').filter((x) => x.attributes['data-bar'] === id)[0];
const focusedTile = (env) => env.layer().findAll('ss-tile').filter((x) => /is-focused/.test(x.className)).map((x) => x.attributes['data-tile']);
const focusedBar = (env) => env.layer().findAll('ss-bar__item').filter((x) => /is-focused/.test(x.className)).map((x) => x.attributes['data-bar']);

test('Home hub (design 01): tiles, focus order, sections, Add account, bottom bar, Back', async () => {
  const env = await setup();
  env.router.resetTo('home');
  assert.equal(env.layer().findAll('ss-wordmark').length, 1, 'Home logo: the EliteStream wordmark image');
  assert.match(env.layer().textContent, /Provider/, 'provider chip shows the active account');
  assert.deepEqual(focusedTile(env), ['live'], 'default focus: Live TV');
  assert.equal(env.layer().findAll('is-focused').length, 1, 'one focus indicator');
  for (const id of ['live', 'movies', 'series', 'settings', 'add']) {
    assert.equal(/is-disabled/.test(tileOf(env, id).className), false, id + ' available');
  }
  assert.doesNotMatch(barOf(env, 'search').className, /is-disabled/, 'Stage 7B.2: global search available');
  env.press('right');
  assert.deepEqual(focusedTile(env), ['movies']);
  env.press('ok');
  assert.equal(top(env), 'vod-browse', 'Movies tile opens Movies');
  env.press('back'); // grid → categories
  env.press('back'); // leave
  assert.equal(top(env), 'home');
  assert.deepEqual(focusedTile(env), ['movies'], 'focus kept on return');
  env.press('right', 2);
  assert.deepEqual(focusedTile(env), ['settings']);
  env.press('right');
  assert.deepEqual(focusedTile(env), ['settings'], 'right edge: no wrap');
  env.press('down');
  assert.deepEqual(focusedTile(env), ['add'], '▼ from Settings → Add account');
  env.press('ok');
  assert.equal(env.router.overlay(), 'confirm');
  assert.deepEqual(env.layer().findAll('ss-button').map((b) => b.textContent), ['Xtream account', 'M3U playlist', 'Cancel']);
  env.press('back');
  assert.equal(env.router.overlay(), null);
  env.press('up');
  assert.deepEqual(focusedTile(env), ['settings']);
  env.press('ok');
  assert.equal(top(env), 'settings', 'Stage 7B.2: Settings opens the Settings screen');
  env.press('back');
  env.press('left', 3);
  assert.deepEqual(focusedTile(env), ['live']);
  env.press('down');
  assert.deepEqual(focusedBar(env), ['home'], '▼ from a tile → the bar item below');
  env.press('right');
  assert.deepEqual(focusedBar(env), ['search'], 'Stage 7B.2: Search is available');
  env.press('right');
  assert.deepEqual(focusedBar(env), ['favourites']);
  env.press('ok');
  assert.equal(top(env), 'live-tv', 'Favourites opens Live TV');
  await until(() => env.log.entries().some((e) => e.msg === 'live tv ready'), 20000, 'live ready');
  assert.match(env.layer().findAll('ss-cat').filter((x) => /is-selected|is-focused/.test(x.className)).map((x) => x.textContent).join(), /Favourites/, 'on the Favourites category');
  env.press('back');
  assert.equal(top(env), 'home');
});

test('Home hub: sections the account can’t provide are disabled and skipped', async () => {
  const env = await setup();
  const m3u = (await env.playlists.add({ name: 'M', kind: 'm3u', url: 'http://m.example/list.m3u' })).playlist;
  env.playlists.setActive(m3u.id);
  env.router.resetTo('home');
  assert.match(tileOf(env, 'movies').className, /is-disabled/);
  assert.match(tileOf(env, 'series').className, /is-disabled/);
  assert.match(tileOf(env, 'movies').textContent, /Needs an Xtream account/);
  env.press('right');
  assert.deepEqual(focusedTile(env), ['settings'], 'Movies and Series are skipped');
});

test('Rail: expands on focus, current section, switching resets the stack to Home + section', async () => {
  const env = await setup();
  env.router.resetTo('home');
  env.press('right');
  env.press('ok');
  await until(() => env.log.entries().some((e) => e.msg === 'vod browse ready'), 20000, 'browse ready');
  env.press('back'); // grid → categories
  env.press('left');
  const rail = env.layer().findAll('ss-rail')[0];
  assert.match(rail.className, /is-open/, 'rail expands while focused');
  assert.equal(rail.findAll('is-focused')[0].attributes['data-section'], 'movies', 'focus enters on the current section');
  env.press('down'); // Series (Search is disabled and skipped later)
  env.press('ok');
  assert.deepEqual(env.router.stack(), ['home', 'vod-browse'], 'stack reset to Home + Series');
  await until(() => /Series/.test(env.layer().findAll('ss-live__title')[0].textContent), 5000, 'series screen');
});

test('Large catalogue: category counter, CH paging, Yellow → Find a category, filter, pick', async () => {
  const env = await setup();
  await openSection(env, 'Movies');
  env.press('left'); // grid column 0 → categories (All movies)
  env.press('down'); // Action = first provider category
  assert.match(env.layer().findAll('ss-vod__catpos')[0].textContent, /Category 1 of \d+/);
  env.press('chUp');
  assert.deepEqual(focusedCat(env), ['Search'], 'CH▲ pages the category column (bounded)');
  env.press('chDown');
  assert.equal(focusedCat(env).length, 1);
  const panel = () => env.doc.body.findAll('ss-find')[0];
  env.press('yellow');
  assert.doesNotMatch(panel().className, /is-hidden/, 'Yellow opens Find a category');
  assert.match(panel().textContent, /type to filter/);
  assert.match(panel().findAll('ss-find__field')[0].className, /is-focused/, 'focus starts on the filter field');
  env.press('ok');
  assert.equal(env.router.overlay(), 'text-entry', 'the filter is typed in the text entry');
  assert.doesNotMatch(panel().className, /is-hidden/, 'the sheet stays visible under the keyboard');
  await sleep(5);
  const input = env.layer().findAll('ss-ime__input')[0];
  input.value = 'COM';
  input.dispatch('keydown', { keyCode: IME_DONE });
  await until(() => env.router.overlay() === null, 2000, 'keyboard closed');
  const rows = panel().findAll('ss-find__row').filter((r) => r.style.display !== 'none').map((r) => r.findAll('ss-find__name')[0].textContent);
  assert.ok(rows.length >= 1 && rows.every((n) => /com/i.test(n)), 'case-insensitive contains: ' + rows.join());
  assert.match(panel().findAll('ss-find__matches')[0].textContent, /matches/);
  env.press('ok');
  assert.match(panel().className, /is-hidden/, 'picking closes the sheet');
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['Amélie ✨ 🇫🇷'], 'the picked category is shown in the grid');
  assert.match(env.layer().findAll('is-selected').map((x) => x.textContent).join(), /Com/, 'selected tint on the shown category');
  assert.deepEqual(matchCategories(['Action', 'Comédie', 'Kids'], 'ID'), [2]);
  assert.deepEqual(matchCategories(['A', 'B'], ''), [0, 1], 'empty filter lists everything');
});

test('Cards keep one size in three states; failed update keeps the list and shows a toast', async () => {
  const over = {};
  const env = await setup({ over });
  await openSection(env, 'Movies');
  const c = cards(env);
  assert.equal(c[0].findAll('ss-card__img')[0].style.visibility, 'visible', 'poster state');
  assert.equal(c[1].findAll('ss-card__ph')[0].textContent, 'Amélie ✨ 🇫🇷', 'title-plate state: the plate carries the name');
  assert.equal(c[1].findAll('ss-card__img')[0].style.visibility, 'hidden');
  // A later update that fails (network) keeps the stored list and only shows the toast.
  over.get_vod_streams = () => ({ fail: 'network' });
  over.get_vod_categories = () => ({ fail: 'network' });
  env.press('left'); // grid column 0 → categories (All movies)
  env.press('up'); // Update list
  assert.deepEqual(focusedCat(env), ['Update list']);
  env.press('ok');
  assert.match(env.layer().findAll('ss-chip')[0].className, /^ss-chip$/, 'update chip shown while running');
  await until(() => !/is-hidden/.test(env.layer().findAll('ss-toast')[0].className), 20000, 'failure toast');
  assert.match(env.layer().findAll('ss-toast')[0].textContent, /Library update failed/);
  assert.match(env.layer().findAll('ss-toast')[0].textContent, /Nothing was lost/);
  assert.match(env.layer().findAll('ss-chip')[0].className, /is-hidden/, 'chip hidden after the update');
  assert.equal(cardTitles(env).length, 4, 'the previous list is still shown');
});

test('Progress store: 30 s minimum, 95 % = watched, newest first, capped, per account', () => {
  const kv = createKeyValueStore(createMemoryLocalStore(), createLogger(100));
  let n = 1000;
  const ps = createProgressStore(kv, () => (n += 1));
  const pid = 'ptest1';
  const item = { id: '1', name: 'A', poster: '', categoryIds: [] };
  const e = (id, pos, dur) => ({ key: progressKey('movie', id), section: 'movie', title: 'T' + id, sub: '', poster: '', ref: { kind: 'xtream', type: 'movie', id, ext: 'mp4' }, item, pos, dur, at: 0 });
  assert.equal(ps.save(pid, e('1', 20000, 6000000)), null, 'under 30 s: not stored');
  assert.equal(ps.list(pid).length, 0);
  assert.equal(ps.save(pid, e('1', 61000, 6000000)).pos, 61000);
  ps.save(pid, e('2', 90000, 6000000));
  assert.deepEqual(ps.list(pid).map((x) => x.key), ['m:2', 'm:1'], 'newest first');
  ps.save(pid, e('1', 5800000, 6000000));
  assert.deepEqual(ps.list(pid).map((x) => x.key), ['m:2'], 'finished title leaves the list');
  assert.equal(ps.isWatched(pid, 'm:1'), true);
  assert.equal(ps.isWatched(pid, 'm:2'), false);
  for (let i = 0; i < 60; i++) { ps.save(pid, e('x' + i, 60000, 6000000)); }
  assert.equal(ps.list(pid).length, 50, 'capped at 50');
  assert.equal(ps.list('pother').length, 0, 'per account');
  assert.equal(ps.save(pid, { ...e('1', 60000, 6000000), key: 'bad key' }), null, 'invalid key rejected');
  ps.clear(pid);
  assert.equal(ps.list(pid).length, 0);
  assert.equal(ps.isWatched(pid, 'm:1'), false);
});

test('Player seek + resume: ◀▶ seek (held accelerates), progress saved, Resume / Play from start, ◀ restarts, Continue watching on Home', async () => {
  const env = await setup();
  await openSection(env, 'Movies');
  env.press('ok');
  assert.equal(top(env), 'vod-details');
  await until(() => buttons(env).length > 0, 5000, 'details');
  assert.deepEqual(buttons(env), ['Play'], 'no progress yet: Play only');
  env.press('ok');
  await sleep(10);
  let pos = 61000;
  env.fe.engine.timing = () => ({ positionMs: pos, durationMs: 6300000 });
  env.fe.prepared();
  env.fe.picture();
  await sleep(1100);
  assert.ok(!env.fe.calls.some((c) => c.op === 'seek'), 'no resume seek without a saved position');
  const seeks = () => env.fe.calls.filter((c) => c.op === 'seek').map((c) => c.ms);
  // Stage 7E: ◀▶ move a seek cursor; playback is untouched until OK; Back cancels.
  const cursor = () => env.layer().findAll('ss-vbar__cursor')[0];
  const bubble = () => env.layer().findAll('ss-vbar__bubble-time')[0].textContent;
  env.press('right');
  assert.doesNotMatch(cursor().className, /is-hidden/, 'the cursor appears');
  assert.match(bubble(), /^1:11 {2}\(\+0:10\)$/, 'target time and distance');
  assert.match(env.layer().textContent, /OK to jump · Back to cancel/);
  assert.match(env.layer().findAll('ss-vbar__time--left')[0].textContent, /1:01/, 'the playing position is not changed');
  await sleep(450);
  assert.deepEqual(seeks(), [], 'no engine seek before OK');
  env.press('ok');
  assert.deepEqual(env.fe.calls.filter((c) => c.op === 'pause'), [], 'OK on the cursor jumps, it does not pause');
  await sleep(450);
  assert.deepEqual(seeks(), [71000], 'OK = jump to the cursor (+10 s)');
  assert.match(cursor().className, /is-hidden/);
  pos = 71000; // the engine got there
  await sleep(1100);
  env.press('left');
  env.press('back');
  assert.equal(top(env), 'vod-player', 'Back cancels the cursor, the player stays');
  assert.match(cursor().className, /is-hidden/);
  await sleep(450);
  assert.deepEqual(seeks(), [71000], 'cancel = no seek');
  env.press('left');
  env.press('ok');
  await sleep(450);
  assert.equal(seeks().pop(), 61000, '◀ = −10 s from the playing position');
  pos = 61000;
  // Holding ▶ (fast repeats) moves the cursor; one seek on OK (AVPlay drops overlapping seeks).
  const before = seeks().length;
  env.press('right', 4);
  assert.match(bubble(), /^1:41/);
  env.press('ok');
  await sleep(450);
  assert.deepEqual(seeks().slice(before), [101000], '4 presses + OK → one seek to +40 s');
  assert.doesNotMatch(env.layer().textContent, /Skipping isn’t possible/);
  pos = 101000;
  await sleep(1100);
  // Down: button row (−10 · play/pause · +10); OK on the middle button pauses.
  env.press('down');
  env.press('ok');
  assert.ok(env.fe.calls.some((c) => c.op === 'pause'));
  env.press('right');
  env.press('ok');
  await sleep(450);
  assert.equal(seeks().pop(), 111000, '+10 s button');
  pos = 111000;
  await sleep(1100);
  pos = 4512000;
  await sleep(1100);
  env.press('back');
  assert.equal(top(env), 'vod-details');
  const saved = env.progress.list(env.pl.id)[0];
  assert.ok(saved, 'position saved on Back');
  const key = saved.key;
  assert.match(key, /^m:/);
  assert.equal(saved.pos, 4512000);
  assert.equal(JSON.stringify(saved).includes(PASS), false, 'no credentials in the progress entry');
  assert.deepEqual(buttons(env), ['Resume · 1:15:12', 'Play from start']);
  assert.deepEqual(focusedButton(env), ['Resume · 1:15:12']);
  // Resume: seeks to the saved position after the first picture; toast; ◀ starts over.
  env.press('ok');
  await sleep(10);
  env.fe.prepared();
  env.fe.picture();
  await sleep(5);
  assert.equal(env.fe.calls.filter((c) => c.op === 'seek').pop().ms, 4512000, 'resume seek');
  assert.match(env.layer().textContent, /Resuming at 1:15:12/);
  env.press('left');
  await sleep(450);
  assert.equal(env.fe.calls.filter((c) => c.op === 'seek').pop().ms, 0, '◀ during the toast restarts');
  assert.equal(env.layer().findAll('ss-toast')[0].className.includes('is-hidden'), true);
  pos = 0; // the engine got there
  await sleep(1100);
  pos = 4600000;
  await sleep(1100);
  env.press('back');
  // Play from start asks first (progress would be replaced).
  env.press('right');
  env.press('ok');
  assert.match(env.layer().textContent, /Play from start\?/);
  env.press('back');
  assert.equal(top(env), 'vod-details');
  // Home: Continue watching row with the movie; OK resumes.
  env.router.resetTo('home');
  await sleep(5);
  assert.match(env.layer().textContent, /Continue watching/);
  assert.ok(env.layer().textContent.includes(saved.title));
  assert.match(env.layer().findAll('ss-home')[0].className, /ss-home--cont/);
  assert.equal(env.layer().findAll('ss-cont__item')[0].className.includes('is-focused'), true, 'first card focused');
  const loads = env.fe.loads().length;
  env.press('ok');
  assert.equal(top(env), 'vod-player');
  await sleep(10);
  assert.equal(env.fe.loads().length, loads + 1);
  env.fe.prepared();
  env.fe.picture();
  await sleep(5);
  assert.equal(env.fe.calls.filter((c) => c.op === 'seek').pop().ms, 4600000, 'resumed from Home');
  // Watched to the end: leaves Continue watching.
  pos = 6300000;
  await sleep(1100);
  env.fe.emit({ type: 'ended' });
  await sleep(5);
  env.press('back');
  assert.equal(env.progress.get(env.pl.id, key), null);
  assert.equal(env.progress.isWatched(env.pl.id, key), true);
  assert.match(env.layer().findAll('ss-cont')[0].className, /is-hidden/, 'row hidden when nothing is unfinished');
  assert.doesNotMatch(env.layer().findAll('ss-home')[0].className, /ss-home--cont/);
});

test('Audio & subtitles: sheet lists real tracks, picks apply and are remembered, cues drawn as plain lines', async () => {
  assert.deepEqual([normLang('dut'), normLang('EN'), normLang('ger'), normLang('pt-BR')], ['nld', 'eng', 'deu', 'por']);
  // Stage 7E: names in the UI language (English by default, Dutch for the Dutch UI).
  assert.deepEqual([languageName('dut'), languageName('xyz'), languageName('und'), languageName('')], ['Dutch', 'XYZ', '', '']);
  assert.equal(languageName('dut', 'nl'), 'Nederlands');
  assert.deepEqual(subtitleLines('<i>Line one</i>\r\n{\\an8}Line two\n\n'), ['Line one', 'Line two']);
  assert.deepEqual(preferredChoices([{ kind: 'text', id: 4, language: 'dut', label: '', selected: false }], { audio: '', text: 'nld' }), [{ kind: 'text', id: 4 }]);
  const env = await setup();
  await openSection(env, 'Movies');
  env.press('ok');
  env.press('ok'); // Play
  await sleep(10);
  env.fe.prepared();
  env.fe.picture();
  env.fe.setTracks([
    { kind: 'audio', id: 1, language: 'eng', label: '5.1', selected: true },
    { kind: 'audio', id: 2, language: 'dut', label: 'Stereo' },
    { kind: 'text', id: 3, language: 'nld' }
  ]);
  await sleep(5);
  assert.ok(!env.fe.calls.some((c) => c.op === 'track'), 'no preference yet: nothing switched, subtitles stay off');
  env.fe.emit({ type: 'subtitle', text: '<i>Line one</i>\nLine two' });
  assert.deepEqual(env.layer().findAll('ss-subs__line').map((l) => l.textContent), ['Line one', 'Line two']);
  env.fe.emit({ type: 'subtitle', text: '' });
  assert.equal(env.layer().findAll('ss-subs__line').length, 0);
  // [CC] is the 4th button: ▼ to the row (play/pause), ▶ ▶ to it, OK opens the sheet.
  env.press('down');
  env.press('right', 2);
  env.press('ok');
  const sheet = env.layer().findAll('ss-tracks')[0];
  assert.doesNotMatch(sheet.className, /is-hidden/);
  const rows = () => env.layer().findAll('ss-tracks__row');
  assert.deepEqual(rows().map((r) => r.findAll('ss-tracks__name')[0].textContent), ['English · 5.1', 'Dutch · Stereo', 'Off', 'Dutch']);
  assert.deepEqual(rows().map((r) => /is-selected/.test(r.className)), [true, false, true, false]);
  assert.match(rows()[0].className, /is-focused/, 'focus starts on the current audio track');
  env.press('down', 3);
  env.press('ok');
  assert.deepEqual(env.fe.calls.filter((c) => c.op === 'track').pop(), { op: 'track', kind: 'text', id: 3 });
  assert.equal(env.trackPrefs.get().text, 'nld', 'subtitle language remembered');
  assert.deepEqual(rows().map((r) => /is-selected/.test(r.className)), [true, false, false, true]);
  env.press('up', 2);
  env.press('ok');
  assert.deepEqual(env.fe.calls.filter((c) => c.op === 'track').pop(), { op: 'track', kind: 'audio', id: 2 });
  assert.equal(env.trackPrefs.get().audio, 'nld');
  env.press('back');
  assert.equal(top(env), 'vod-player', 'Back closes the sheet first');
  assert.match(sheet.className, /is-hidden/);
  env.press('back');
  assert.equal(top(env), 'vod-details');
  // Next title start: the remembered languages are applied once the tracks are known.
  env.press('ok');
  await sleep(10);
  env.fe.prepared();
  env.fe.picture();
  const before = env.fe.calls.filter((c) => c.op === 'track').length;
  env.fe.setTracks([
    { kind: 'audio', id: 7, language: 'en', selected: true },
    { kind: 'audio', id: 8, language: 'nl' },
    { kind: 'text', id: 9, language: 'dut' }
  ]);
  await sleep(5);
  assert.deepEqual(env.fe.calls.filter((c) => c.op === 'track').slice(before), [{ op: 'track', kind: 'audio', id: 8 }, { op: 'track', kind: 'text', id: 9 }]);
  env.press('back');
  // A title without tracks says so instead of offering fake choices.
  env.press('ok');
  await sleep(10);
  env.fe.prepared();
  env.fe.picture();
  env.fe.setTracks([]);
  await sleep(5);
  env.press('down');
  env.press('right', 2);
  env.press('ok');
  assert.match(env.layer().findAll('ss-tracks')[0].textContent, /no other audio or subtitle tracks/);
  assert.equal(rows().length, 0);
  env.press('back');
  env.press('back');
  assert.equal(top(env), 'vod-details');
});

async function typeSearch(env, q) {
  env.press('ok');
  assert.equal(env.router.overlay(), 'text-entry');
  await sleep(5);
  const input = env.layer().findAll('ss-ime__input')[0];
  input.value = q;
  input.dispatch('keydown', { keyCode: IME_DONE });
}
const srchRows = (env) => env.layer().findAll('ss-srch__row').map((r) => r.findAll('ss-srch__label')[0].textContent);
const srchTitles = (env, i) => env.layer().findAll('ss-srch__row')[i].findAll('ss-srch__title').map((x) => x.textContent);

test('Search: channels, movies and series from stored lists, adult left out, recent searches, OK plays / opens Details', async () => {
  const env = await setup();
  await openSection(env, 'Movies'); // downloads the movie list (series stay not downloaded)
  env.router.resetTo('home');
  env.router.push('search');
  assert.equal(top(env), 'search');
  assert.match(env.layer().textContent, /Search channels, movies and series/);
  await typeSearch(env, 'news');
  await until(() => srchRows(env).length > 0, 5000, 'search rows');
  assert.match(srchRows(env)[0], /^Channels · \d+$/);
  assert.ok(srchTitles(env, 0).includes('News One HD'));
  assert.match(env.layer().textContent, /Series aren’t downloaded yet/, 'a list never opened is reported, not searched');
  assert.equal(env.layer().findAll('ss-srch__card')[0].className.includes('is-focused'), true, 'focus moves to the first result');
  env.press('ok');
  assert.equal(top(env), 'player', 'a channel result plays');
  env.press('back');
  assert.equal(top(env), 'search');
  // Movies row; OK opens Details.
  env.press('up');
  await typeSearch(env, 'night');
  await until(() => srchRows(env).some((r) => /^Movies/.test(r)), 5000, 'movie row');
  const mi = srchRows(env).findIndex((r) => /^Movies/.test(r));
  assert.ok(srchTitles(env, mi).includes('The Long Night (2019)'));
  env.press('down', mi);
  env.press('ok');
  assert.equal(top(env), 'vod-details');
  env.press('back');
  // Adult titles never appear in global search.
  env.press('up', 3);
  await typeSearch(env, 'adult');
  await until(() => /Nothing found for “adult”/.test(env.layer().textContent), 5000, 'no adult results');
  // Empty query: recent searches as chips; OK on a chip searches again.
  await typeSearch(env, '');
  const chips = () => env.layer().findAll('ss-srch__chip').map((c) => c.textContent);
  assert.deepEqual(chips(), ['adult', 'night', 'news']);
  env.press('down');
  env.press('right');
  env.press('ok');
  await until(() => srchRows(env).some((r) => /^Movies/.test(r)), 5000, 'chip re-runs night');
  assert.deepEqual(env.kv.get('search.recent', Array.isArray, []).slice(0, 2), ['night', 'adult']);
  assert.equal(JSON.stringify(env.log.entries()).includes(PASS), false, 'no credentials logged');
});

test('Search and Settings sections: reachable from Home and the rail', async () => {
  const env = await setup();
  env.router.resetTo('home');
  const bar = () => env.layer().findAll('ss-bar__item');
  const search = bar().find((b) => b.attributes['data-bar'] === 'search');
  assert.equal(search.className.includes('is-disabled'), false, 'Search is no longer greyed out');
  env.press('down');
  env.press('right');
  env.press('ok');
  assert.equal(top(env), 'search');
  env.press('back');
  assert.equal(top(env), 'home');
  // Settings tile opens the Settings screen (the account list is one row inside it).
  env.press('up');
  env.press('right', 3);
  env.press('ok');
  assert.equal(top(env), 'settings');
});

test('Settings: accounts, language, playback languages, clear history (confirmed), about', async () => {
  const env = await setup();
  env.router.resetTo('home');
  env.router.push('settings');
  const rowIds = () => env.layer().findAll('ss-set__row').map((r) => r.attributes['data-row']);
  const focused = () => env.layer().findAll('ss-set__row').filter((r) => /is-focused/.test(r.className)).map((r) => r.attributes['data-row'])[0];
  const value = (id) => env.layer().findAll('ss-set__row').find((r) => r.attributes['data-row'] === id).findAll('ss-set__value')[0].textContent;
  assert.deepEqual(rowIds().slice(0, 6), ['accounts', 'lang-en', 'lang-nl', 'audio', 'subs', 'pin-set']);
  assert.equal(focused(), 'accounts');
  assert.match(value('accounts'), /^Provider · 1 in total$/);
  env.press('ok');
  assert.equal(top(env), 'playlists');
  env.press('back');
  assert.equal(top(env), 'settings');
  assert.equal(value('lang-en'), '✓');
  env.press('down', 2);
  env.press('ok');
  assert.deepEqual(env.langCalls, ['nl']);
  // Playback: OK steps through the languages.
  env.press('down');
  assert.equal(focused(), 'audio');
  assert.equal(value('audio'), 'As the stream sets it');
  env.press('ok');
  assert.equal(env.trackPrefs.get().audio, 'eng');
  assert.equal(value('audio'), 'English');
  env.press('down');
  env.press('ok', 2);
  assert.equal(env.trackPrefs.get().text, 'nld');
  assert.equal(value('subs'), 'Dutch');
  // Clear viewing history: asks first; Clear removes Continue watching.
  const item = { id: '5001', name: 'The Long Night (2019)', categoryId: '10', adult: false };
  env.progress.save(env.pl.id, { key: 'm:5001', section: 'movie', title: item.name, sub: '', poster: '', ref: { kind: 'xtream', type: 'movie', id: '5001', ext: 'mkv' }, item, pos: 600000, dur: 6000000, at: 0 });
  env.router.resetTo('home');
  env.router.push('settings');
  env.press('down', 6);
  assert.equal(value('clear-progress'), '1 unfinished');
  assert.equal(focused(), 'clear-progress');
  env.press('ok');
  assert.equal(env.router.overlay(), 'confirm');
  assert.match(env.layer().textContent, /Clear viewing history\?/);
  env.press('ok');
  assert.equal(env.progress.list(env.pl.id).length, 0);
  assert.equal(value('clear-progress'), '0 unfinished');
  // S1 (intended change, was "About rows are information only: ▼ skips them"): About is one
  // focusable row showing the version; OK opens the read-only About screen; Back returns to it.
  env.press('down', 2);
  assert.equal(focused(), 'about');
  assert.equal(value('about'), '0.2.0');
  env.press('ok');
  assert.equal(top(env), 'about');
  assert.match(env.layer().textContent, /Version0\.2\.0/);
  env.press('down');
  env.press('ok');
  assert.equal(top(env), 'about', 'nothing on the About screen reacts to ▼ / OK');
  env.press('back');
  assert.equal(top(env), 'settings');
  assert.equal(focused(), 'about', 'focus restored on the About row');
  env.press('down');
  assert.equal(focused(), 'diagnostics');
});

function typePin(env, digits) {
  for (const c of digits) { env.press('d' + c); }
  env.press('ok');
}
const pinText = (env) => env.layer().textContent;

test('Parental PIN: set up in Settings (twice + recovery code), locks adult movies and channels, wrong PIN counted, unlock, relock', async () => {
  const env = await setup();
  env.router.resetTo('home');
  env.router.push('settings');
  const focusRow = (id) => { for (let i = 0; i < 20; i++) { const f = env.layer().findAll('ss-set__row').filter((r) => /is-focused/.test(r.className))[0]; if (f && f.attributes['data-row'] === id) return; env.press('down'); } throw new Error('row ' + id); };
  const value = (id) => env.layer().findAll('ss-set__row').find((r) => r.attributes['data-row'] === id).findAll('ss-set__value')[0].textContent;
  focusRow('pin-set');
  env.press('ok');
  assert.equal(env.router.overlay(), 'pin-dialog');
  assert.match(pinText(env), /Choose a PIN/);
  assert.equal(env.layer().findAll('ss-pin__cell').length, 8, '8 cells (6–8 digits)');
  typePin(env, '12345');
  assert.match(pinText(env), /6 to 8 digits/, 'too short refused');
  typePin(env, '123456');
  assert.match(pinText(env), /Enter the PIN again/);
  typePin(env, '654321');
  assert.match(pinText(env), /The two PINs were different/);
  typePin(env, '123456');
  // Same PIN twice, entered with the on-screen pad this time (remote without number keys).
  const padKey = (k) => { const keys = env.layer().findAll('ss-pin__key'); const want = keys.findIndex((x) => x.attributes['data-key'] === k); const at = keys.findIndex((x) => /is-focused/.test(x.className)); const dr = Math.floor(want / 3) - Math.floor(at / 3); const dc = want % 3 - at % 3; env.press(dr > 0 ? 'down' : 'up', Math.abs(dr)); env.press(dc > 0 ? 'right' : 'left', Math.abs(dc)); env.press('ok'); };
  for (const c of '123456') { padKey(c); }
  padKey('ok');
  await until(() => /Your recovery code/.test(pinText(env)), 20000, 'recovery code');
  const code = env.layer().findAll('ss-pin__code')[0].textContent;
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(JSON.stringify(env.log.entries()).includes('123456'), false, 'PIN never logged');
  assert.equal(JSON.stringify(env.log.entries()).includes(code.replace(/-/g, '')), false, 'recovery code never logged');
  env.press('ok'); // I wrote it down
  assert.equal(env.router.overlay(), null);
  assert.equal(value('lock-adult'), 'On');
  assert.equal(env.parental.locked(), true);
  // Movies: the adult category is locked; its title is hidden in All movies.
  env.router.resetTo('playlists');
  await openSection(env, 'Movies');
  for (let i = 0; i < 6 && !focusedCat(env).length; i++) { env.press('left'); }
  assert.ok(!cardTitles(env).includes('Adult title'), 'adult title hidden in the mixed list');
  for (let i = 0; i < 15 && !/XXX/.test(focusedCat(env).join()); i++) { env.press('down'); }
  assert.match(focusedCat(env).join(), /XXX/);
  await sleep(200);
  assert.match(env.layer().textContent, /Locked by the parental PIN/);
  assert.deepEqual(cardTitles(env), []);
  env.press('ok');
  assert.equal(env.router.overlay(), 'pin-dialog');
  assert.match(pinText(env), /Enter PIN/);
  typePin(env, '000000');
  await until(() => /Wrong PIN\. 4 attempts left\./.test(pinText(env)), 20000, 'wrong pin');
  typePin(env, '123456');
  await until(() => env.router.overlay() === null, 20000, 'unlocked');
  assert.equal(env.parental.locked(), false);
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['Adult title'], 'category open after the PIN');
  // Locking again from Settings.
  env.router.resetTo('home');
  env.router.push('settings');
  focusRow('pin-relock');
  env.press('ok');
  assert.equal(env.parental.locked(), true);
  // Live TV: the adult channel is left out of All channels while locked.
  env.router.resetTo('home');
  env.router.push('live-tv', { playlistId: env.pl.id });
  await until(() => env.log.entries().some((e) => e.msg === 'live tv ready'), 20000, 'live ready');
  assert.doesNotMatch(env.layer().textContent, /Late Night/);
  env.press('back');
  for (let i = 0; i < 15 && !/XXX/.test(focusedCat(env).join()); i++) { env.press('down'); }
  await sleep(200);
  assert.match(env.layer().textContent, /Locked by the parental PIN/);
  env.press('ok');
  assert.equal(env.router.overlay(), 'pin-dialog');
  env.press('back');
  assert.equal(env.router.overlay(), null, 'Back cancels');
  assert.equal(env.parental.locked(), true);
  // Turning the lock off needs the PIN.
  env.router.resetTo('home');
  env.router.push('settings');
  focusRow('lock-adult');
  env.press('ok');
  assert.equal(env.router.overlay(), 'pin-dialog');
  typePin(env, '123456');
  await until(() => env.router.overlay() === null, 20000, 'lock off');
  assert.equal(value('lock-adult'), 'Off');
  assert.equal(env.parental.locked(), false);
});

test('Parental PIN: Forgot PIN with the recovery code removes the PIN; Remove PIN needs the PIN', async () => {
  const env = await setup();
  const r = await env.pin.setPin(null, '24681357');
  assert.ok(r.ok && r.recoveryCode);
  assert.equal(env.parental.locked(), true);
  env.router.resetTo('home');
  env.router.push('settings');
  const ids = () => env.layer().findAll('ss-set__row').map((x) => x.attributes['data-row']);
  assert.ok(ids().includes('lock-adult') && ids().includes('pin-change'));
  env.router.openOverlay('pin-dialog', { mode: 'verify' });
  env.press('down', 4); // pad → buttons: Forgot PIN?
  env.press('ok');
  assert.equal(env.router.overlay(), 'text-entry');
  await sleep(5);
  const input = env.layer().findAll('ss-ime__input')[0];
  input.value = r.recoveryCode.toLowerCase().replace(/(.{4})/g, '$1-');
  input.dispatch('keydown', { keyCode: IME_DONE });
  await until(() => env.router.overlay() === 'confirm', 20000, 'reset result');
  assert.match(env.layer().textContent, /PIN removed/);
  env.press('ok');
  assert.equal(env.pin.hasPin(), false);
  assert.equal(env.parental.locked(), false);
  // Remove PIN: needs the current PIN.
  await env.pin.setPin(null, '11223344');
  env.router.openOverlay('pin-dialog', { mode: 'remove' });
  assert.match(env.layer().textContent, /Enter your current PIN/);
  typePin(env, '11223344');
  await until(() => env.router.overlay() === null, 20000, 'removed');
  assert.equal(env.pin.hasPin(), false);
});

test('TV guide: grid of the Live TV list, programme cells, ◀▶ programmes, ▲▼ channels, no invented data, OK watches', async () => {
  const env = await setup();
  env.router.resetTo('home');
  env.router.push('live-tv', { playlistId: env.pl.id });
  await until(() => env.log.entries().some((e) => e.msg === 'live tv ready'), 20000, 'live ready');
  env.press('green');
  assert.equal(top(env), 'tv-guide');
  const rows = () => env.layer().findAll('ss-guide__row');
  assert.ok(rows().length > 0 && rows().length <= 6);
  assert.match(env.layer().textContent, /No programme information/, 'channels without data say so');
  assert.equal(env.layer().findAll('ss-guide__mark').length, 6, 'ruler every 30 min (2 h 45)');
  env.press('down');
  assert.match(rows()[1].className, /is-current/);
  env.press('ok');
  assert.equal(top(env), 'player', 'OK watches the channel');
  env.press('back');
  assert.equal(top(env), 'tv-guide');
  env.press('back');
  assert.equal(top(env), 'live-tv');
});

test('TV guide grid with data: cells placed by time, focus follows programmes, window scrolls, short EPG for rows on screen', async () => {
  const { createTvGuideScreen, PX_PER_MIN } = await import('../../src/screens/tv-guide-screen.ts');
  const { createChannelIndex } = await import('../../src/content/channel-index.ts');
  const log = createLogger(500);
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), log.child('router'));
  const H = 3600000;
  const base = new Date(2026, 10, 24, 20, 10, 0).getTime(); // 20:10
  const now = () => base;
  const mk = (id, num, name) => ({ id, num, name, categoryId: '1', adult: false, streamRef: { kind: 'url', url: 'http://x/' + id } });
  const chans = [mk('a', 1, 'One'), mk('b', 2, 'Two'), mk('c', 3, 'Three')];
  const idx = createChannelIndex({ categories: [{ id: '1', name: 'All', section: 'live', count: 3, adult: false }], channels: chans });
  const at = (hh, mm) => new Date(2026, 10, 24, hh, mm, 0).getTime();
  const data = {
    a: [{ start: at(19, 0), end: at(20, 30), title: 'Evening News', desc: 'The day in review.' }, { start: at(20, 30), end: at(21, 0), title: 'Weather' }, { start: at(21, 0), end: at(23, 0), title: 'Late Movie' }],
    b: []
  };
  let shortCalls = 0;
  const epg = {
    status: () => ({ state: 'ready', playlistId: 'p1', builtAt: 0, channels: 2, programmes: 3, refreshing: false, shortEpg: true }),
    load: () => Promise.resolve(),
    programmes: (c, from, to) => (data[c.id] || []).filter((p) => p.end > from && p.start < to),
    shortEpg: (c) => { shortCalls++; return Promise.resolve(c.id === 'c' ? [{ start: at(20, 0), end: at(21, 0), title: 'Short EPG Show' }] : []); }
  };
  router.register('tv-guide', (p, nav) => createTvGuideScreen({ doc, t: createTranslator('en'), epg, now, setTimer: () => 0, clearTimer: () => {} }, p, nav));
  router.register('player', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
  router.resetTo('tv-guide', { playlistId: 'p1', index: idx, list: [0, 1, 2], pos: 0 });
  const key = (k) => router.handleKey({ key: k, repeat: false, heldMs: 0, code: 0 });
  await new Promise((r) => setTimeout(r, 5));
  const txt = () => doc.body.textContent;
  assert.match(txt(), /Evening News/);
  assert.match(txt(), /19:00 – 20:30 · now/, 'info panel: focused programme on air now');
  assert.match(txt(), /The day in review\./);
  // Window starts at 19:30 (current half hour − 30 min): Evening News is clipped at 0, Weather at 60 min.
  const cells = doc.body.findAll('ss-guide__row')[0].findAll('ss-guide__cell');
  assert.equal(cells[0].style.left, '0px');
  assert.equal(cells[1].style.left, (60 * PX_PER_MIN) + 'px');
  assert.equal(cells[1].style.width, (30 * PX_PER_MIN - 6) + 'px');
  assert.equal(doc.body.findAll('ss-guide__mark')[0].textContent, '19:30');
  assert.match(doc.body.findAll('ss-guide__row')[1].textContent, /No programme information/, 'no invented data');
  assert.match(doc.body.findAll('ss-guide__row')[2].textContent, /Short EPG Show/, 'short EPG used for a row on screen');
  assert.equal(shortCalls, 2);
  key('right');
  assert.match(doc.body.findAll('ss-guide__cell').filter((c) => /is-focused/.test(c.className))[0].textContent, /Weather/);
  key('right');
  assert.match(txt(), /Late Movie/);
  key('right');
  key('right');
  assert.notEqual(doc.body.findAll('ss-guide__mark')[0].textContent, '19:30', 'window scrolled forward');
  key('left');
  key('left');
  key('left');
  assert.match(doc.body.findAll('ss-guide__cell').filter((c) => /is-focused/.test(c.className))[0].textContent, /Weather|Evening News/);
  key('down');
  key('down');
  assert.match(doc.body.findAll('ss-guide__row')[2].className, /is-current/);
  key('ok');
  assert.deepEqual(router.stack(), ['tv-guide', 'player']);
});

test('Not seekable (TV finding): toast once, ±10 disabled, no further seeks; failed resume says it plays from the start', async () => {
  const env = await setup();
  await openSection(env, 'Movies');
  env.press('ok');
  await until(() => buttons(env).length > 0, 5000, 'details');
  env.press('ok');
  await sleep(10);
  env.fe.engine.timing = () => ({ positionMs: 61000, durationMs: 6300000 });
  env.fe.prepared();
  env.fe.picture();
  await sleep(1100);
  env.press('right');
  env.press('ok');
  const seeks = () => env.fe.calls.filter((c) => c.op === 'seek').length;
  await sleep(450);
  assert.equal(seeks(), 1);
  env.fe.failSeek();
  await sleep(5);
  assert.match(env.layer().textContent, /Skipping isn’t possible for this video/);
  env.press('right');
  env.press('left');
  assert.match(env.layer().findAll('ss-vbar__cursor')[0].className, /is-hidden/, 'no cursor on a title that cannot seek');
  await sleep(450);
  assert.equal(seeks(), 1, 'no more seek attempts on this title');
  env.press('down');
  const btns = env.layer().findAll('ss-vbar__button');
  assert.match(btns[0].className, /is-disabled/);
  assert.doesNotMatch(btns[3].className, /is-disabled/, 'CC stays available');
  // CC still opens the Audio & subtitles panel on a title that cannot seek.
  env.fe.setTracks([{ kind: 'audio', id: 1, language: 'eng', selected: true }, { kind: 'text', id: 3, language: 'nld' }]);
  env.press('right', 2);
  env.press('ok');
  assert.doesNotMatch(env.layer().findAll('ss-tracks')[0].className, /is-hidden/);
  assert.equal(env.layer().findAll('ss-tracks__row').length, 3, 'audio + Off + one subtitle track');
  env.press('back');
  env.press('left', 2);
  assert.match(btns[2].className, /is-disabled/);
  assert.doesNotMatch(btns[1].className, /is-disabled/, 'play/pause still works');
  env.press('back');
  // Resume that cannot be applied: the title starts at 0 and the toast says so.
  const item = { id: '5001', name: 'The Long Night (2019)', categoryId: '10', adult: false };
  env.router.resetTo('home');
  env.router.push('vod-player', { playlistId: env.pl.id, ref: { kind: 'xtream', type: 'movie', id: '5001', ext: 'mkv' }, title: 'T', startMs: 4512000,
    progress: { key: 'm:5001', section: 'movie', title: item.name, sub: '', poster: '', item } });
  await sleep(10);
  env.fe.prepared();
  env.fe.failSeek(); // AVPlay: the seek before play timed out
  env.fe.picture();
  await sleep(5);
  assert.match(env.layer().textContent, /Can’t continue where you stopped/);
  assert.doesNotMatch(env.layer().textContent, /Resuming at/);
  env.press('back');
});

// ---------------------------------------------------------------- Stage 7F: controls hide after 3 s
const barHidden = (env) => /is-hidden/.test(env.layer().findAll('ss-vbar')[0].className);
async function startMovie(env) {
  await openSection(env, 'Movies');
  env.press('ok');
  env.press('ok'); // Play
  await sleep(10);
  const t0 = Date.now();
  // Position advances every tick, as on the TV (every 1 s update used to restart the hide timer).
  env.fe.engine.timing = () => ({ positionMs: 60000 + (Date.now() - t0), durationMs: 6300000 });
  env.fe.prepared();
  env.fe.picture();
}

test('Stage 7F controls: title + bar hide 3 s after playback starts although the position ticks; a key brings them back; ◀▶ cursor keeps them', async () => {
  const env = await setup();
  await startMovie(env);
  assert.equal(barHidden(env), false, 'shown at the start');
  await sleep(1500);
  assert.equal(barHidden(env), false, 'still shown after 1.5 s');
  await sleep(1900);
  assert.equal(barHidden(env), true, 'hidden ~3 s after the picture while position updates keep arriving');
  env.press('right'); // seek cursor
  assert.equal(barHidden(env), false, 'a key shows the controls at once');
  await sleep(3400);
  assert.equal(barHidden(env), false, 'kept while the seek cursor is shown');
  env.press('back'); // cancel the cursor
  assert.equal(barHidden(env), false);
  await sleep(1800);
  env.press('up'); // any key resets the timer
  await sleep(1800);
  assert.equal(barHidden(env), false, 'timer restarted by the last key');
  await sleep(1600);
  assert.equal(barHidden(env), true, 'hidden 3 s after the last key');
  env.press('back');
});

test('Stage 7F controls: kept while paused and while the Audio & subtitles sheet is open; resume and close restart the 3 s timer', async () => {
  const env = await setup();
  await startMovie(env);
  env.press('ok'); // pause (scrubber zone)
  await sleep(20);
  await sleep(3400);
  assert.equal(barHidden(env), false, 'kept while paused');
  env.press('ok'); // resume
  await sleep(20);
  env.fe.emit({ type: 'playing' });
  await sleep(3400);
  assert.equal(barHidden(env), true, 'hidden 3 s after resuming');
  env.press('down'); // controls were hidden: the first key only shows them
  env.press('down'); // buttons
  env.press('right');
  env.press('right'); // [CC]
  env.press('ok'); // open the sheet
  assert.equal(env.layer().findAll('ss-tracks')[0].className, 'ss-tracks');
  await sleep(3400);
  assert.equal(barHidden(env), false, 'kept while the sheet is open');
  env.press('back'); // close the sheet
  await sleep(3400);
  assert.equal(barHidden(env), true, 'hidden 3 s after the sheet closed');
  env.press('back');
});

// ---------------------------------------------------------------- Stage 11: My List, sorting, next episode

const SORT_LIST = [
  { name: 'Zulu (2001)', stream_id: 6101, category_id: '10', container_extension: 'mp4' },
  { name: 'alpha', stream_id: 6102, category_id: '10', container_extension: 'mp4' },
  { name: 'Mike (1999)', stream_id: 6103, category_id: '10', container_extension: 'mp4' },
  { name: 'Bravo (2010)', stream_id: 6104, category_id: '10', container_extension: 'mp4' },
  { name: 'Echo', stream_id: 6105, category_id: '10', container_extension: 'mp4' },
  { name: 'Alpha (2005)', stream_id: 6106, category_id: '10', container_extension: 'mp4' },
  { name: 'Other', stream_id: 6201, category_id: 11, container_extension: 'mp4' }
];
function sortRoute(url) {
  const m = /[?&]category_id=([^&]+)/.exec(url);
  const list = m ? SORT_LIST.filter((x) => String(x.category_id) === decodeURIComponent(m[1])) : SORT_LIST;
  return { status: 200, body: JSON.stringify(list) };
}

test('Stage 11 My List: add and remove a movie and a series in Details; My List category; restart; per account', async () => {
  const env = await setup({ myList: true });
  await openSection(env, 'Movies');
  assert.deepEqual(visibleCats(env).slice(0, 6), ['Search', 'Find a category', 'Update list', 'All movies', 'My List', 'Action']);
  env.press('ok'); // the focused first title
  assert.equal(top(env), 'vod-details');
  await sleep(20);
  assert.deepEqual(buttons(env), ['Play', 'Add to My List']);
  env.press('right');
  env.press('ok');
  assert.deepEqual(buttons(env), ['Play', 'Remove from My List'], 'the button says the title is saved');
  assert.match(env.layer().textContent, /Added to My List\./);
  env.press('ok'); // again: no duplicate, it toggles off
  assert.deepEqual(buttons(env), ['Play', 'Add to My List']);
  env.press('ok');
  assert.equal(env.myList.list(env.pl.id, 'movie').length, 1, 'stored once');
  env.press('back');
  assert.equal(top(env), 'vod-browse');
  env.press('left'); // grid → categories
  env.press('down'); // My List
  await sleep(250);
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['The Long Night (2019)']);
  assert.match(visibleCats(env)[4], /My List/);
  env.press('ok'); // into the grid
  env.press('ok'); // the saved title opens its normal Details
  assert.equal(top(env), 'vod-details');
  await sleep(20);
  env.press('right');
  env.press('ok'); // remove
  env.press('back');
  await sleep(20);
  assert.match(env.layer().textContent, /Nothing saved yet/, 'My List refreshed when coming back');
  // A restart: a new store over the same settings storage still has the saved entries.
  env.myList.toggle(env.pl.id, 'movie', { id: '5002', name: 'Amélie', categoryId: '11', adult: false, plot: 'not stored' });
  const again = createMyList(env.kv, Date.now);
  assert.deepEqual(again.list(env.pl.id, 'movie').map((e) => e.item.id), ['5002']);
  assert.equal('plot' in again.list(env.pl.id, 'movie')[0].item, false, 'only the small card fields are stored');
  // Another account: its own empty lists; the same provider id there is a different entry.
  const other = (await env.playlists.add({ name: 'Second', kind: 'xtream', server: 'provider.example:8080', username: 'demo_user', password: PASS })).playlist;
  assert.deepEqual(env.myList.list(other.id, 'movie'), []);
  env.myList.toggle(other.id, 'movie', { id: '5002', name: 'Amélie', categoryId: '11', adult: false });
  assert.equal(env.myList.list(env.pl.id, 'movie').length, 1, 'the first account is unchanged');
  await env.playlists.remove(other.id);
  assert.deepEqual(env.myList.list(other.id, 'movie'), [], 'removing an account removes its My List');
  assert.equal(env.myList.list(env.pl.id, 'movie').length, 1, '…and only its own');
  // Series: My List button above the seasons.
  env.router.resetTo('playlists');
  await openSection(env, 'Series');
  env.press('ok'); // City Lights
  await until(() => /Season One/.test(env.layer().textContent), 5000, 'seasons');
  env.press('up'); // seasons → My List button
  assert.deepEqual(buttons(env), ['Add to My List']);
  env.press('ok');
  assert.deepEqual(buttons(env), ['Remove from My List']);
  assert.deepEqual(env.myList.list(env.pl.id, 'series').map((e) => e.item.name), ['City Lights']);
  env.press('down');
  await sleep(10);
  assert.match(env.layer().textContent, /Pilot/, 'back to the seasons and episodes');
});

test('Stage 11 sorting: the Sort button above the grid sorts the category on screen; stable ties; kept after Details; not on All', async () => {
  const env = await setup({ over: { get_vod_streams: sortRoute } });
  await openSection(env, 'Movies');
  const sortText = () => env.layer().findAll('ss-vod__sortbtn')[0].textContent;
  assert.equal(sortText(), 'Sort: Provider order');
  env.press('left');
  env.press('down'); // Action
  await sleep(250);
  await titlesShown(env);
  const provider = ['Zulu (2001)', 'alpha', 'Mike (1999)', 'Bravo (2010)', 'Echo', 'Alpha (2005)'];
  assert.deepEqual(cardTitles(env), provider, 'provider order by default');
  env.press('right'); // into the grid
  env.press('up'); // ▲ from the first row: the Sort button
  assert.match(env.layer().findAll('ss-vod__sortbtn')[0].className, /is-focused/);
  const orders = [
    ['Sort: Title A–Z', ['alpha', 'Alpha (2005)', 'Bravo (2010)', 'Echo', 'Mike (1999)', 'Zulu (2001)']],
    ['Sort: Title Z–A', ['Zulu (2001)', 'Mike (1999)', 'Echo', 'Bravo (2010)', 'Alpha (2005)', 'alpha']],
    ['Sort: Newest first', ['Bravo (2010)', 'Alpha (2005)', 'Zulu (2001)', 'Mike (1999)', 'alpha', 'Echo']],
    ['Sort: Oldest first', ['Mike (1999)', 'Zulu (2001)', 'Alpha (2005)', 'Bravo (2010)', 'alpha', 'Echo']],
    ['Sort: Provider order', provider]
  ];
  for (const [label, want] of orders) {
    env.press('ok');
    assert.equal(sortText(), label);
    await until(() => cardTitles(env).join('|') === want.join('|'), 3000, label);
  }
  env.press('ok'); env.press('ok'); env.press('ok'); // A–Z, Z–A, Newest
  await until(() => cardTitles(env)[0] === 'Bravo (2010)', 3000, 'newest');
  env.press('down'); // back into the grid
  env.press('ok');
  assert.equal(top(env), 'vod-details');
  env.press('back');
  assert.deepEqual(cardTitles(env), orders[2][1], 'order kept after Details');
  assert.equal(sortText(), 'Sort: Newest first');
  // All movies is not sorted (your decision: categories only): provider order and a note.
  env.press('left'); // the category column (Action)
  env.press('up'); // All movies
  await sleep(250);
  await titlesShown(env);
  env.press('right');
  env.press('up'); // Sort
  env.press('ok'); // Oldest first
  assert.match(env.layer().textContent, /Shown in provider order/);
  assert.match(env.layer().textContent, /up to 5,000 titles|up to 5000 titles|up to 5.000 titles/);
});

test('Stage 11 next episode: prompt after a normal end only; next in season, then next season; cancel; Continue watching', async () => {
  const env = await setup();
  await openSection(env, 'Series');
  env.press('ok'); // City Lights
  await until(() => /Season One/.test(env.layer().textContent), 5000, 'seasons');
  env.press('right'); // episodes: Pilot
  env.press('ok');
  assert.equal(top(env), 'vod-player');
  await sleep(10);
  env.fe.engine.timing = () => ({ positionMs: 60000, durationMs: 2640000 });
  env.fe.prepared(); env.fe.picture();
  await sleep(1100); // the player reads the duration on its 1 s tick
  const prompt = () => env.layer().findAll('ss-nextep')[0];
  assert.match(prompt().className, /is-hidden/, 'no prompt while playing far from the end');
  env.fe.engine.timing = () => ({ positionMs: 2640000, durationMs: 2640000 });
  env.fe.emit({ type: 'ended' });
  await sleep(10);
  assert.doesNotMatch(prompt().className, /is-hidden/, 'prompt after the episode ended');
  assert.match(prompt().textContent, /Next episode.*S1 E2 · Second/);
  env.fe.emit({ type: 'ended' }); // a repeated end event
  await sleep(10);
  assert.equal(env.layer().findAll('ss-nextep').length, 1);
  const loads = env.fe.loads().length;
  env.press('ok'); // Play next
  await until(() => env.fe.loads().length === loads + 1, 2000, 'next episode load');
  assert.match(env.fe.loads().slice(-1)[0].url, /\/series\/demo_user\/[^/]+\/9102\.mp4$/);
  assert.match(prompt().className, /is-hidden/);
  assert.match(env.layer().findAll('ss-vbar__title')[0].textContent, /City Lights · S1 E2 · Second/);
  assert.equal(env.progress.isWatched(env.pl.id, 'e:9101'), true, 'the finished episode is marked watched');
  env.fe.prepared(); env.fe.picture();
  env.fe.engine.timing = () => ({ positionMs: 600000, durationMs: 2640000 });
  await sleep(1100); // one player tick reads the position
  env.press('back'); // leave mid-episode: no prompt, progress saved for Continue watching
  assert.equal(top(env), 'vod-details');
  assert.deepEqual(env.progress.list(env.pl.id).map((e) => e.key), ['e:9102'], 'Continue watching has the next episode');
  // The last episode of season 1 → the first of season 2; Cancel keeps playback where it is.
  env.press('down'); // Second
  env.press('ok');
  await sleep(10);
  env.fe.engine.timing = () => ({ positionMs: 2640000, durationMs: 2640000 });
  env.fe.prepared(); env.fe.picture();
  env.fe.emit({ type: 'ended' });
  await sleep(10);
  assert.match(prompt().textContent, /S2 E1 · S2 E1 – Début/, 'continues into the next season');
  const l2 = env.fe.loads().length;
  env.press('right'); // Cancel
  env.press('ok');
  await sleep(20);
  assert.match(prompt().className, /is-hidden/);
  assert.equal(env.fe.loads().length, l2, 'cancel: nothing started');
  env.press('back');
  assert.equal(top(env), 'vod-details');
});

test('Stage 11 next episode: never on Back, on an error, after the last episode or with filled-in numbers', async () => {
  const env = await setup();
  await openSection(env, 'Series');
  env.press('ok'); // City Lights
  await until(() => /Season One/.test(env.layer().textContent), 5000, 'seasons');
  env.press('right');
  env.press('ok'); // Pilot
  await sleep(10);
  env.fe.prepared(); env.fe.picture();
  const loads = env.fe.loads().length;
  env.press('back'); // Back near the end: the player is gone, an end event afterwards does nothing
  env.fe.emit({ type: 'ended' });
  await sleep(10);
  assert.equal(top(env), 'vod-details');
  assert.equal(env.fe.loads().length, loads);
  // Stream failure: the error state, no prompt.
  env.press('ok');
  await sleep(10);
  env.fe.failPrepare('connection');
  await sleep(10);
  assert.match(env.layer().findAll('ss-nextep')[0].className, /is-hidden/);
  env.press('back');
  // Last episode (S2 E1): no next one.
  env.press('left'); env.press('down'); // Season Two
  env.press('right');
  env.press('ok');
  await sleep(10);
  env.fe.engine.timing = () => ({ positionMs: 2700000, durationMs: 2700000 });
  env.fe.prepared(); env.fe.picture();
  env.fe.emit({ type: 'ended' });
  await sleep(10);
  assert.match(env.layer().findAll('ss-nextep')[0].className, /is-hidden/, 'no prompt after the last episode');
  env.press('back'); // close the player (its 1 s tick would keep the test process alive)
});

test('Stage 11 (TV fixes): the prompt appears 2 min before the end while playing; unused grid cards show no old posters', async () => {
  const env = await setup({ myList: true });
  await openSection(env, 'Series');
  env.press('ok'); // City Lights
  await until(() => /Season One/.test(env.layer().textContent), 5000, 'seasons');
  env.press('right');
  env.press('ok'); // Pilot
  await sleep(10);
  env.fe.engine.timing = () => ({ positionMs: 2000000, durationMs: 2640000 }); // 10:40 left
  env.fe.prepared(); env.fe.picture();
  await sleep(1100);
  const prompt = () => env.layer().findAll('ss-nextep')[0];
  assert.match(prompt().className, /is-hidden/, 'not yet: more than 2 minutes left');
  env.fe.engine.timing = () => ({ positionMs: 2540000, durationMs: 2640000 }); // 1:40 left
  await sleep(1100);
  assert.doesNotMatch(prompt().className, /is-hidden/, 'shown 2 minutes before the end');
  assert.equal(env.fe.calls.filter((c) => c.op === 'pause').length, 0, 'the episode keeps playing behind it');
  env.press('right'); env.press('ok'); // Cancel
  assert.match(prompt().className, /is-hidden/);
  env.fe.emit({ type: 'ended' });
  await sleep(20);
  assert.match(prompt().className, /is-hidden/, 'cancelled: not shown again at the end');
  env.press('back');
  env.press('back');
  // My List with one saved title right after "All movies": the other four cards of the row are empty.
  env.router.resetTo('playlists');
  await openSection(env, 'Movies');
  env.myList.toggle(env.pl.id, 'movie', { id: '5002', name: 'Amélie', categoryId: '11', adult: false });
  env.press('left');
  env.press('down'); // My List
  await sleep(250);
  const row = env.layer().findAll('ss-vod__row')[0];
  const cardsInRow = row.findAll('ss-card');
  assert.equal(cardsInRow[0].style.visibility, 'visible');
  for (let i = 1; i < cardsInRow.length; i++) {
    assert.equal(cardsInRow[i].style.visibility, 'hidden');
    assert.equal(cardsInRow[i].findAll('ss-card__img')[0].style.visibility, 'hidden', 'no poster left over from All movies');
    assert.equal(cardsInRow[i].findAll('ss-card__img')[0].attributes.src, undefined);
  }
});

test('Stage 11 (TV memory): below the 150 MB floor no sort is started; the provider order stays and a note says why', async () => {
  let mb = 120;
  const env = await setup({ over: { get_vod_streams: sortRoute }, memoryMB: () => mb });
  await openSection(env, 'Movies');
  env.press('left');
  env.press('down'); // Action
  await sleep(250);
  await titlesShown(env);
  env.press('right');
  env.press('up'); // Sort
  env.press('ok'); // Title A–Z requested
  await sleep(100);
  assert.deepEqual(cardTitles(env), ['Zulu (2001)', 'alpha', 'Mike (1999)', 'Bravo (2010)', 'Echo', 'Alpha (2005)'], 'not sorted');
  assert.match(env.layer().textContent, /Not sorted right now/);
  mb = 300;
  env.press('ok'); env.press('ok'); env.press('ok'); env.press('ok'); env.press('ok'); // around to Title A–Z again
  await until(() => cardTitles(env)[0] === 'alpha', 3000, 'sorted once memory is back');
});

test('Stage 11 (your request): series have the same Sort button; the series My List button sits in the text like on movies', async () => {
  const env = await setup({ myList: true });
  await openSection(env, 'Series');
  const sortBtn = () => env.layer().findAll('ss-vod__sortbtn')[0];
  assert.doesNotMatch(sortBtn().className, /is-hidden/, 'shown for series');
  env.press('left');
  env.press('down', 2); // My List, then Drama
  await sleep(250);
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['City Lights', 'Array Seasons', 'Empty Show', 'Bad Info']);
  env.press('right');
  env.press('up'); // the Sort button
  env.press('ok'); // Title A–Z
  await until(() => cardTitles(env).join('|') === 'Array Seasons|Bad Info|City Lights|Empty Show', 3000, 'series A–Z');
  assert.equal(sortBtn().textContent, 'Sort: Title A–Z');
  // Details: the My List button is in the text column (no separate column under the poster).
  env.press('down');
  env.press('right', 2); // City Lights
  env.press('ok');
  await until(() => /Season One/.test(env.layer().textContent), 5000, 'seasons');
  const actions = env.layer().findAll('ss-details__actions')[0];
  assert.ok(actions, 'actions box present');
  assert.equal(env.layer().findAll('ss-details__artcol').length, 0, 'no under-poster column any more');
  assert.match(env.layer().findAll('ss-details__top')[0].className, /has-actions/);
  env.press('up');
  env.press('ok');
  assert.deepEqual(buttons(env), ['Remove from My List']);
  assert.doesNotMatch(env.layer().findAll('ss-details__note')[0].textContent, /Added to My List/, 'series: the label shows the state, no extra line');
});

// ---------------------------------------------------------------- Stage 14: category management

test('Stage 14 Movies: Manage categories; hide and move; All, My List, sorting and Find keep working; restart; Series separate', async () => {
  const env = await setup({ myList: true, catPrefs: true, over: { get_vod_streams: sortRoute } });
  await openSection(env, 'Movies');
  assert.deepEqual(visibleCats(env).slice(0, 8), ['Search', 'Find a category', 'Update list', 'All movies', 'My List', 'Manage categories', 'Action', 'Comédie – Français']);
  const sheetEl = () => env.layer().findAll('ss-catman')[0];
  const sheetRows = () => sheetEl().findAll('ss-catman__row').filter((r) => r.style.display !== 'none')
    .map((r) => r.findAll('ss-catman__name')[0].textContent + (/is-off/.test(r.className) ? ' [hidden]' : ''));
  env.press('left'); // grid → All movies
  env.press('down', 2); // My List, Manage categories
  env.press('ok');
  assert.doesNotMatch(sheetEl().className, /is-hidden/);
  assert.match(sheetEl().textContent, /Movies · 2 categories · 0 hidden/);
  assert.deepEqual(sheetRows(), ['Action', 'Comédie – Français'], 'only categories with titles; special rows are not listed');
  env.press('ok'); // hide Action
  env.press('down');
  env.press('right'); // pick up Comédie
  env.press('up'); // above Action
  env.press('ok'); // put down
  assert.deepEqual(sheetRows(), ['Comédie – Français', 'Action [hidden]']);
  env.press('back');
  assert.match(sheetEl().className, /is-hidden/);
  assert.deepEqual(visibleCats(env).slice(5), ['Manage categories', 'Comédie – Français']);
  const saved = env.catPrefs.get(env.pl.id, 'movie');
  assert.deepEqual(saved.hidden, ['10']);
  assert.deepEqual(saved.order.slice(0, 2), ['11', '10']);
  // All movies still has the hidden category's titles (your decision: category column only).
  env.press('up', 2);
  await sleep(250);
  await titlesShown(env);
  assert.ok(cardTitles(env).indexOf('Zulu (2001)') >= 0);
  // My List keeps a title whose category is hidden.
  env.myList.toggle(env.pl.id, 'movie', { id: '6101', name: 'Zulu (2001)', categoryId: '10', adult: false });
  env.press('down'); // My List
  await sleep(250);
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['Zulu (2001)']);
  // Sorting inside a visible category.
  env.press('down', 2); // Manage categories, Comédie
  await sleep(250);
  await titlesShown(env);
  assert.deepEqual(cardTitles(env), ['Other']);
  env.press('right');
  env.press('up'); // Sort button
  env.press('ok');
  assert.equal(env.layer().findAll('ss-vod__sortbtn')[0].textContent, 'Sort: Title A–Z');
  // Find a category lists the shown categories.
  env.press('yellow');
  assert.deepEqual(env.layer().findAll('ss-find__row').filter((r) => r.style.display !== 'none').map((r) => r.findAll('ss-find__name')[0].textContent), ['Comédie – Français']);
  env.press('back');
  // Restart: a new store over the same settings storage.
  assert.deepEqual(createCategoryPrefsStore(env.kv).get(env.pl.id, 'movie').hidden, ['10']);
  // Series: its own (default) categories and prefs.
  env.router.resetTo('playlists');
  await openSection(env, 'Series');
  const cats = visibleCats(env);
  const at = cats.indexOf('Manage categories');
  assert.ok(at > 3, 'Series has the row too');
  const firstSeriesCat = cats[at + 1];
  env.press('left');
  env.press('down', at - 3);
  env.press('ok');
  assert.match(sheetEl().textContent, /^Manage categoriesSeries · /);
  env.press('ok'); // hide the first series category
  env.press('back');
  assert.equal(visibleCats(env).indexOf(firstSeriesCat), -1);
  assert.equal(env.catPrefs.get(env.pl.id, 'series').hidden.length, 1);
  assert.deepEqual(env.catPrefs.get(env.pl.id, 'movie').hidden, ['10'], 'movie prefs untouched');
  // A series still opens with its episodes from All series.
  env.press('up', at - 3); // All series
  await sleep(250);
  await titlesShown(env);
  env.press('ok'); // into the grid
  env.press('ok'); // City Lights
  await until(() => /Season One/.test(env.layer().textContent), 5000, 'seasons');
});
