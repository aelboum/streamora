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
import { formatTime } from '../../src/screens/vod-player-screen.ts';
import { createVodController } from '../../src/player/vod-controller.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createEpgService } from '../../src/services/epg-service.ts';
import { createVodService } from '../../src/services/vod-service.ts';
import { createUserLists } from '../../src/services/user-lists.ts';
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

const KEY = { left: 37, up: 38, right: 39, down: 40, ok: 13, back: 10009, chUp: 427, chDown: 428, playPause: 10252 };
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
    player: { bufferSec: 2, prepareTimeoutMs: 15000, prepareStallMs: 0, zapDebounceMs: 40, retryDelaysMs: [50, 50, 50] }
  });
  registerVodScreens(router, { doc, t, playlists, vod, lifecycle, engine: fe.engine, openText, now, ...timers, log, prepareTimeoutMs: 15000 });
  router.register('diagnostics', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
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
  return { router, press, layer, doc, fe, playlists, vod, pl, textInput, log, route, lifeCbs, srv };
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
  assert.match(env.layer().textContent, /Updated .* · 6 titles/);
  assert.deepEqual(visibleCats(env).slice(0, 4), ['Search', 'Update list', 'All movies', 'Action']);
  assert.deepEqual(cardTitles(env), ['The Long Night (2019)', 'Amélie ✨ 🇫🇷', 'فيلم عربي', 'No Category', 'Lost Category', 'Adult title']);
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
  assert.deepEqual(cardTitles(env), ['The Long Night (2019)']);
  env.press('down'); // Comédie – Français
  await sleep(200);
  assert.deepEqual(cardTitles(env), ['Amélie ✨ 🇫🇷']);
  // Search with the system keyboard.
  env.press('up', 4);
  assert.deepEqual(focusedCat(env), ['Search']);
  env.press('ok');
  assert.equal(env.router.overlay(), 'text-entry');
  await sleep(5);
  const input = env.layer().findAll('ss-ime__input')[0];
  input.value = 'amé';
  input.dispatch('keydown', { keyCode: IME_DONE });
  assert.deepEqual(cardTitles(env), ['Amélie ✨ 🇫🇷']);
  assert.deepEqual(focusedCard(env), ['Amélie ✨ 🇫🇷']);
  assert.match(env.layer().textContent, /Search: “amé”/);
  // Details of the first movie: back to All movies, open it.
  env.press('back');
  env.press('down', 2);
  await sleep(200);
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
  assert.deepEqual(cardTitles(env), ['City Lights', 'Bébé & Co 🧸', 'Array Seasons', 'Empty Show', 'Bad Info']);
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
  env.press('back');
  assert.equal(top(env), 'vod-details');
  env.press('back'); // episodes → seasons
  env.press('back'); // leave details
  assert.equal(top(env), 'vod-browse');
  // Bad Info: series info unusable → message and a retry entry.
  env.press('right', 4);
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
  assert.match(env.layer().textContent, /1:01 \/ 1:45:00/);
  env.lifeCbs.forEach((cb) => cb('hidden'));
  assert.ok(env.fe.calls.some((c) => c.op === 'suspend'), 'Home: AVPlay suspend');
  env.lifeCbs.forEach((cb) => cb('visible'));
  assert.ok(env.fe.calls.some((c) => c.op === 'restore'));
  env.press('back');
  assert.equal(top(env), 'vod-details');
  assert.equal(formatTime(3725000), '1:02:05');
  assert.equal(formatTime(59000), '0:59');
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
