// Stage 10: Live TV controls — channel-number entry (123 pad digits), previous channel (Blue /
// PreviousChannel), the channel list over the playing video (OK) — plus the Stage 10 Search memory
// corrections. UI tests drive the real key router, screen router, PlaylistService and the fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/navigation/router.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';
import { mapKeyCode } from '../../src/navigation/keys.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { registerLiveScreens } from '../../src/screens/live-screens.ts';
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
import { createNumberEntry, createZapHistory, parseChannelNumber, findByNumber, MAX_DIGITS } from '../../src/screens/live-controls.ts';
import { CHLIST_ROWS } from '../../src/screens/player-screen.ts';
import { createSearchScreen } from '../../src/screens/search-screen.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';

const KEY = { left: 37, up: 38, right: 39, down: 40, ok: 13, back: 10009, chUp: 427, chDown: 428, blue: 406, prevCh: 10190, chList: 10073 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(3);
  }
}

// ---------------------------------------------------------------- pure rules

test('Stage 10 keys: the 123-pad digits (48–57, physical remote) and the dedicated keys map; Blue stays Blue', () => {
  assert.deepEqual(mapKeyCode(48, false), { key: 'digit', digit: 0 });
  assert.deepEqual(mapKeyCode(57, false), { key: 'digit', digit: 9 });
  assert.deepEqual(mapKeyCode(406, false), { key: 'blue' });
  assert.deepEqual(mapKeyCode(10190, false), { key: 'prevChannel' });
  assert.deepEqual(mapKeyCode(10073, false), { key: 'channelList' });
});

test('Stage 10 number parsing: leading zeros ignored, 0 and over-long input are no channel', () => {
  assert.equal(parseChannelNumber('7'), 7);
  assert.equal(parseChannelNumber('007'), 7);
  assert.equal(parseChannelNumber('0'), 0);
  assert.equal(parseChannelNumber('000'), 0);
  assert.equal(parseChannelNumber('123456'), 123456);
  assert.equal(parseChannelNumber('1234567'), 0);
  assert.equal(parseChannelNumber(''), 0);
  assert.equal(parseChannelNumber('12a'), 0);
});

test('Stage 10 number entry: timeout after the last digit, OK at once, Back cancels, 6 digits commit, rapid digits extend', () => {
  const c = createFakeClock();
  const shown = [];
  const commits = [];
  const e = createNumberEntry({ timeoutMs: 2000, setTimer: c.setTimer, clearTimer: c.clearTimer, onChange: (t) => shown.push(t), onCommit: (n) => commits.push(n) });
  e.digit(1); c.advance(1500); e.digit(2); c.advance(1500);
  assert.deepEqual(commits, [], 'each digit restarts the 2 s wait');
  c.advance(600);
  assert.deepEqual(commits, [12]);
  assert.deepEqual(shown, ['1', '12', '']);
  e.digit(0); e.digit(0); e.digit(5);
  assert.equal(e.confirm(), true);
  assert.deepEqual(commits, [12, 5], 'OK tunes at once; leading zeros ignored');
  e.digit(9);
  assert.equal(e.cancel(), true);
  c.advance(5000);
  assert.deepEqual(commits, [12, 5], 'Back cancelled: nothing tuned');
  assert.equal(e.cancel(), false, 'nothing to cancel');
  assert.equal(e.confirm(), false, 'nothing to confirm');
  for (let i = 1; i <= MAX_DIGITS; i++) { e.digit(i % 10); }
  assert.deepEqual(commits, [12, 5, 123456], 'the sixth digit commits without waiting');
  e.digit(0);
  c.advance(2000);
  assert.deepEqual(commits, [12, 5, 123456, 0], '"0" alone is reported as no channel');
  e.digit(11); e.digit(-1); e.digit(1.5);
  assert.equal(e.active(), false, 'invalid digits are ignored');
  e.digit(3);
  e.destroy();
  c.advance(5000);
  assert.equal(commits.length, 4, 'destroy clears the pending timer');
  assert.equal(c.pending(), 0);
});

test('Stage 10 history: only started channels; alternates; the same channel is never its own previous; per playlist', () => {
  const h = createZapHistory();
  assert.equal(h.previous('p1'), '');
  h.tuned('p1', 'a');
  assert.equal(h.previous('p1'), '');
  h.tuned('p1', 'b');
  assert.equal(h.previous('p1'), 'a');
  h.tuned('p1', 'b'); // reconnect / retry of the same channel
  assert.equal(h.previous('p1'), 'a');
  h.tuned('p1', 'a'); // previous pressed: a plays again
  assert.equal(h.previous('p1'), 'b', 'repeated presses alternate');
  assert.equal(h.previous('p2'), '', 'another account never sees this history');
  h.tuned('p2', 'x');
  assert.equal(h.previous('p1'), '', 'switching account starts a new history');
  assert.equal(h.current('p2'), 'x');
  h.clear();
  assert.equal(h.current('p2'), '');
});

test('Stage 10 number lookup: first match in list order for duplicates; −1 when absent; rebuilt for another list', () => {
  const ch = [{ num: 5 }, { num: 7 }, { num: 5 }, { num: 9 }];
  const memo = { list: null, map: null };
  const all = [0, 1, 2, 3];
  assert.equal(findByNumber(ch, all, 5, memo), 0);
  assert.equal(findByNumber(ch, all, 9, memo), 3);
  assert.equal(findByNumber(ch, all, 8, memo), -1);
  assert.equal(findByNumber(ch, all, 0, memo), -1);
  const sub = [2, 3];
  assert.equal(findByNumber(ch, sub, 5, memo), 0, 'positions are within the given list');
  assert.equal(memo.list, sub);
});

// ---------------------------------------------------------------- player UI

function makeM3u(n) {
  const parts = ['#EXTM3U\n'];
  for (let i = 0; i < n; i++) {
    // Channel numbers 1..n; channel 40 repeats number 12 (a duplicate the first match must win over).
    const chno = i === 39 ? 12 : i + 1;
    parts.push('#EXTINF:-1 tvg-chno="' + chno + '" group-title="Group ' + (i % 3) + '",Channel ' + (i + 1) + '\nhttp://s.example/live/' + (i + 1) + '.ts\n');
  }
  return parts.join('');
}

async function setup(n = 60) {
  const log = createLogger(3000);
  const kv = createKeyValueStore(createMemoryLocalStore(), log);
  const m3u = makeM3u(n);
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
  const lifecycle = { on: () => () => {} };
  registerLiveScreens(router, {
    doc, t, playlists, epg, lists, lifecycle, engine: fe.engine, textInput: { active: false }, preferIme: false, now, ...timers, log,
    player: { bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 30, retryDelaysMs: [], numberEntryMs: 60 }
  });
  router.register('diagnostics', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
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
  function digits(s) { for (const ch of s) { press(48 + Number(ch)); } }
  const layer = () => { const l = doc.body.childNodes.filter((x) => x.style.display !== 'none' && x.attributes && x.attributes['data-layer']); return l[l.length - 1]; };
  const pl = (await playlists.add({ name: 'Home', kind: 'm3u', url: 'https://secure.example.org/get.php?username=demo_user&password=demo_pass_9f3k' })).playlist;
  playlists.setActive(pl.id);
  const imp = await playlists.refresh(pl.id).result;
  assert.equal(imp.ok, true, JSON.stringify(imp));
  return { router, press, digits, layer, doc, fe, lists, playlists, pl, log };
}

/** Opens Live TV and plays the first channel of "All channels". */
async function play(env) {
  env.router.push('live-tv', { playlistId: env.pl.id });
  await until(() => env.log.entries().some((e) => e.msg === 'live tv ready'), 20000, 'live tv ready');
  env.press('ok'); // the focused first channel plays
  await until(() => env.router.stack().slice(-1)[0] === 'player' && env.fe.loads().length >= 1, 2000, 'player');
  started(env);
}
function started(env) { env.fe.prepared(); env.fe.picture(); }
const bannerName = (env) => env.layer().findAll('ss-banner__name')[0].textContent;
const numBox = (env) => env.layer().findAll('ss-numentry')[0];
const chPanel = (env) => env.layer().findAll('ss-chlist')[0];
const loadedNum = (env) => Number((/\/(\d+)\.ts$/.exec(env.fe.loads().slice(-1)[0].url) || [])[1]);

test('Stage 10 player: a typed number tunes after the timeout or on OK; unknown numbers and Back change nothing', async () => {
  const env = await setup();
  await play(env);
  const first = env.fe.loads().length;
  env.digits('12');
  assert.equal(numBox(env).textContent, '12_');
  assert.ok(!/is-hidden/.test(numBox(env).className));
  await until(() => env.fe.loads().length === first + 1, 2000, 'tuned after the timeout');
  assert.equal(loadedNum(env), 12, 'channel number 12 (the first match; a later duplicate 12 exists)');
  assert.equal(bannerName(env), 'Channel 12');
  assert.match(numBox(env).className, /is-hidden/, 'entry cleared after tuning');
  started(env);
  env.digits('7');
  env.press('ok');
  await until(() => env.fe.loads().length === first + 2, 2000, 'OK tunes at once');
  assert.equal(loadedNum(env), 7);
  started(env);
  env.digits('999');
  env.press('ok');
  await sleep(50);
  assert.equal(env.fe.loads().length, first + 2, 'unknown number: no tune');
  assert.equal(numBox(env).textContent, 'No channel 999');
  env.digits('5');
  env.press('back');
  await sleep(120);
  assert.equal(env.fe.loads().length, first + 2, 'Back cancelled the entry');
  assert.equal(env.router.stack().slice(-1)[0], 'player', 'Back with an entry open does not leave the player');
  env.digits('007');
  env.press('ok');
  await sleep(60);
  assert.equal(env.fe.loads().length, first + 2, '"007" = channel 7, which is already playing: no restart');
});

test('Stage 10 previous channel: Blue alternates between the last two started channels; a failed tune is not remembered', async () => {
  const env = await setup();
  await play(env); // channel 1
  env.press('blue');
  assert.equal(numBox(env).textContent, 'No previous channel yet');
  env.digits('20'); env.press('ok');
  await until(() => loadedNum(env) === 20, 2000, 'channel 20');
  started(env);
  const n0 = env.fe.loads().length;
  env.press('blue');
  await until(() => env.fe.loads().length === n0 + 1, 2000, 'previous');
  assert.equal(loadedNum(env), 1);
  started(env);
  env.press('blue');
  await until(() => env.fe.loads().length === n0 + 2, 2000, 'previous again');
  assert.equal(loadedNum(env), 20, 'repeated presses alternate');
  started(env);
  // A channel that fails to start never becomes "previous".
  env.digits('30'); env.press('ok');
  await until(() => loadedNum(env) === 30, 2000, 'channel 30');
  env.fe.failPrepare('connection');
  await sleep(10);
  env.press('blue');
  await until(() => loadedNum(env) === 1, 2000, 'previous after a failure');
  // The PreviousChannel key (should a remote send it) does the same.
  started(env);
  env.press('prevCh');
  await until(() => loadedNum(env) === 20, 2000, 'PreviousChannel key');
});

test('Stage 10 channel list over the video: OK opens it without restarting playback; moves, selects, Back closes; pooled rows', async () => {
  const env = await setup();
  await play(env);
  const loads = env.fe.loads().length;
  const stops = env.fe.calls.filter((c) => c.op === 'stop').length;
  env.press('ok');
  assert.ok(!/is-hidden/.test(chPanel(env).className), 'list open');
  assert.equal(env.fe.loads().length, loads, 'no new load: the video keeps playing');
  assert.equal(env.fe.calls.filter((c) => c.op === 'stop').length, stops, 'not stopped');
  const shownRows = () => env.layer().findAll('ss-chlist__row').filter((r) => r.style.display !== 'none');
  assert.equal(shownRows().length, CHLIST_ROWS);
  assert.match(env.layer().findAll('ss-chlist__title')[0].textContent, /Channels\s+1 \/ 60/);
  assert.equal(env.layer().findAll('is-current').length, 1, 'the playing channel is marked');
  env.press('down', 3);
  env.press('chUp'); // pages inside the list, does not zap
  assert.equal(env.fe.loads().length, loads, 'keys inside the list never zap behind it');
  env.press('chDown');
  assert.match(env.layer().findAll('ss-chlist__title')[0].textContent, /Channels\s+10 \/ 60/);
  env.press('ok');
  assert.match(chPanel(env).className, /is-hidden/, 'selecting closes the list');
  await until(() => env.fe.loads().length === loads + 1, 2000, 'selected channel');
  assert.equal(loadedNum(env), 10);
  started(env);
  // Back closes without changing the channel; a second Back leaves the player as before.
  env.press('ok');
  env.press('down');
  env.press('back');
  assert.match(chPanel(env).className, /is-hidden/);
  assert.equal(env.router.stack().slice(-1)[0], 'player');
  await sleep(60);
  assert.equal(env.fe.loads().length, loads + 1, 'Back changed nothing');
  // Repeated open/close: same DOM rows, no loads.
  const nodes = env.layer().findAll('ss-chlist__row').length;
  for (let i = 0; i < 25; i++) { env.press('ok'); env.press('back'); }
  assert.equal(env.layer().findAll('ss-chlist__row').length, nodes, 'no DOM growth');
  assert.equal(env.fe.loads().length, loads + 1);
  // Digits while the list is open: the number is tuned and the list closes.
  env.press('ok');
  env.digits('33'); env.press('ok');
  await until(() => loadedNum(env) === 33, 2000, 'number from the list');
  assert.match(chPanel(env).className, /is-hidden/);
  started(env);
  // Blue while the list is open: previous channel, list closed.
  env.press('ok');
  env.press('blue');
  await until(() => loadedNum(env) === 10, 2000, 'previous from the list');
  assert.match(chPanel(env).className, /is-hidden/);
  env.press('back');
  assert.equal(env.router.stack().slice(-1)[0], 'live-tv', 'Back leaves the player when nothing is open');
});

test('Stage 10 key conflicts: OK on an error still retries; ←/→ still show the banner; CH± still zap when no list is open', async () => {
  const env = await setup();
  await play(env);
  env.press('chUp');
  await until(() => loadedNum(env) === 2, 2000, 'zap');
  env.fe.failPrepare('connection');
  await sleep(10);
  const n = env.fe.loads().length;
  env.press('ok');
  await until(() => env.fe.loads().length === n + 1, 2000, 'retry');
  assert.match(chPanel(env).className, /is-hidden/, 'no list on an error');
  started(env);
  await sleep(10);
  env.press('right');
  assert.ok(!/is-hidden/.test(env.layer().findAll('ss-banner')[0].className), 'banner shown');
});

test('Stage 10 performance: the list over a 22,000-channel playlist opens and moves with 9 pooled rows', async () => {
  const env = await setup(22000);
  await play(env);
  const t0 = Date.now();
  env.press('ok');
  const openMs = Date.now() - t0;
  assert.equal(env.layer().findAll('ss-chlist__row').length, CHLIST_ROWS, 'only the pooled rows exist');
  const t1 = Date.now();
  for (let i = 0; i < 300; i++) { env.press('chDown'); }
  const moveMs = Date.now() - t1;
  assert.match(env.layer().findAll('ss-chlist__title')[0].textContent, /2701 \/ 22000/);
  assert.ok(openMs < 200, 'opened in ' + openMs + ' ms');
  assert.ok(moveMs < 1500, '300 pages in ' + moveMs + ' ms');
  const t2 = Date.now();
  env.press('back');
  env.digits('21999'); env.press('ok');
  await until(() => loadedNum(env) === 21999, 3000, 'far number');
  assert.ok(Date.now() - t2 < 1000, 'number lookup over 22,000 channels');
});

test('Stage 10 cleanup: leaving the player with a number half-typed tunes nothing later', async () => {
  const env = await setup();
  await play(env);
  env.digits('4');
  const n = env.fe.loads().length;
  env.router.resetTo('live-tv', { playlistId: env.pl.id });
  await sleep(150);
  assert.equal(env.fe.loads().length, n, 'no tune after the screen was destroyed');
});

test('Stage 10 account switch: the previous channel of one account is never offered in another', async () => {
  const env = await setup();
  await play(env);
  env.digits('5'); env.press('ok');
  await until(() => loadedNum(env) === 5, 2000, 'channel 5');
  started(env);
  env.press('back');
  const other = (await env.playlists.add({ name: 'Other', kind: 'm3u', url: 'https://other.example.org/get.php?username=demo_user&password=demo_pass_9f3k' })).playlist;
  await env.playlists.refresh(other.id).result;
  env.playlists.setActive(other.id);
  env.router.resetTo('live-tv', { playlistId: other.id });
  await until(() => env.log.entries().filter((e) => e.msg === 'live tv ready').length >= 2, 20000, 'other live tv');
  env.press('ok');
  await until(() => env.router.stack().slice(-1)[0] === 'player' && env.fe.loads().length === 3, 2000, 'player of the other account');
  started(env);
  const n = env.fe.loads().length;
  env.press('blue');
  await sleep(60);
  assert.equal(env.fe.loads().length, n, 'no previous channel from the first account');
  assert.equal(numBox(env).textContent, 'No previous channel yet');
});

// ---------------------------------------------------------------- Search memory corrections

function searchEnv(mb) {
  const doc = createFakeDocument();
  const t = createTranslator('en');
  const kv = createKeyValueStore(createMemoryLocalStore(), createLogger(50));
  const order = [];
  let releaseLive = null;
  const channels = [{ id: 'c0', num: 1, name: 'Night News', categoryId: 'k', adult: false, streamRef: { kind: 'url', url: 'http://x/0' } }];
  const playlists = {
    activeId: () => 'p1', get: () => ({ id: 'p1', name: 'P', kind: 'xtream' }), list: () => [],
    loadLive: () => { order.push('live:start'); return new Promise((r) => { releaseLive = () => { order.push('live:end'); r({ status: 'ok', catalogue: { categories: [], channels }, meta: {}, ms: 1 }); }; }); }
  };
  const ensures = [];
  const searches = [];
  const view = (sec) => ({
    section: sec, total: 3, categories: [], all: () => ({ length: 3, at: (i) => i }), byCategory: () => ({ length: 0, at: (i) => i }),
    item: (p) => ({ id: sec + p, name: 'Night ' + p, categoryId: '1', adult: false }), failed: () => false,
    ensure: (ps) => { ensures.push(sec + ':' + ps.join(',')); return Promise.resolve(); },
    search(q, max, onProgress) {
      let resolve; const result = new Promise((a) => { resolve = a; });
      const s = { q, resolve, onProgress, cancelled: false }; searches.push(s);
      return { result, cancel: () => { s.cancelled = true; } };
    },
    pagesInMemory: () => 0, timings: () => ({ maxReadMs: 0, maxDecodeMs: 0 })
  });
  const vod = { supported: () => true, state: () => ({ at: 1 }), load: (_p, sec) => { order.push(sec + ':load'); return Promise.resolve({ status: 'ok', view: view(sec), ms: 1 }); } };
  let textOpts = null;
  const nav = { isRegistered: () => true, push: () => true, resetTo: () => true, stack: () => ['search'] };
  const screen = createSearchScreen({ doc, t, playlists, vod, kv, openText: (_n, o) => { textOpts = o; }, memoryMB: () => mb, minFreeMB: 150 }, nav);
  const root = doc.createElement('div');
  screen.mount({ element: root, show() {}, hide() {}, remove() {} });
  function type(q) {
    screen.onKey({ key: 'up', repeat: false, heldMs: 0, code: 38 });
    screen.onKey({ key: 'up', repeat: false, heldMs: 0, code: 38 });
    screen.onKey({ key: 'ok', repeat: false, heldMs: 0, code: 13 });
    textOpts.onDone(q);
  }
  return { screen, type, order, releaseLive: () => releaseLive && releaseLive(), ensures, searches };
}

test('Stage 10 Search audit: below the 150 MB floor the three lists load one after another, never together', async () => {
  const low = searchEnv(120);
  low.type('night');
  await sleep(20);
  assert.deepEqual(low.order, ['live:start'], 'movies wait while the channel list loads');
  low.releaseLive();
  await until(() => low.order.length === 4, 1000, 'sequential loads');
  assert.deepEqual(low.order, ['live:start', 'live:end', 'movie:load', 'series:load']);
  const ok = searchEnv(300);
  ok.type('night');
  await sleep(20);
  assert.deepEqual(ok.order, ['live:start', 'movie:load', 'series:load'], 'enough memory: in parallel, as before');
  ok.releaseLive();
});

test('Stage 10 Search audit: a replaced query reads no title pages for its final result; destroy stops everything', async () => {
  const e = searchEnv(300);
  e.type('night');
  e.releaseLive();
  await until(() => e.searches.length === 2, 1000, 'scans');
  e.type('day');
  await until(() => e.searches.length === 4, 1000, 'new scans');
  const before = e.ensures.length;
  e.searches[0].resolve([0, 1, 2]); // the old movie scan finishes late
  e.searches[1].resolve([0]);
  await sleep(20);
  assert.equal(e.ensures.length, before, 'no page reads for the replaced query');
  assert.equal(e.searches[0].cancelled && e.searches[1].cancelled, true);
  e.screen.destroy();
  assert.equal(e.searches[2].cancelled && e.searches[3].cancelled, true, 'leaving Search cancels its scans');
});
