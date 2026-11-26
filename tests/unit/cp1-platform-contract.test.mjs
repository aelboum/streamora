// CP1 (cross-platform): platform contract hardening. Per-platform key tables (Samsung unchanged),
// engine capabilities, the memory policy (measured floors vs limits), the IndexedDB FileStore,
// session-only logins where no secure store exists (R0 decision 4) with the sign-in-again prompt,
// and the widened platform-isolation rule. Build-time platform selection is in tests/build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapKeyCode } from '../../src/navigation/keys.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';
import { DEFAULT_CAPABILITIES, engineCapabilities } from '../../src/player/engine.ts';
import { createAvplayEngine } from '../../src/player/avplay-engine.ts';
import { createMemoryPolicy, GUIDE_FLOOR_MB, LIVE_CACHE_MAX_CHARS, UNMEASURED_LIVE_CACHE_MAX_CHARS, WORK_FLOOR_MB } from '../../src/app/memory-policy.ts';
import { createIdbFileStore } from '../../src/app/platform/idb-file-store.ts';
import { androidApiLevel, createAndroidPlatform } from '../../src/app/platform/android-platform.ts';
import { createMemoryKeyStore } from '../../src/app/platform/memory-stores.ts';
import { createAppContext, startApp } from '../../src/app/bootstrap.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { checkSource } from '../../scripts/lib/compat-rules.mjs';
import { createFakeIndexedDB } from '../fakes/fake-indexeddb.mjs';
import { createFakePlatform } from '../fakes/fake-platform.mjs';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) { for (let i = 0; i < n; i++) { await tick(); } }
const BUILD = { mode: 'test', version: '0', devSinkUrl: '' };

// ---------------------------------------------------------------- keys

// The Samsung table as it was before CP1 (keys.ts CODES), code → key.
const SAMSUNG = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 10009: 'back', 427: 'chUp', 428: 'chDown',
  403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 415: 'play', 19: 'pause', 10252: 'playPause',
  413: 'stop', 412: 'rewind', 417: 'fastForward', 457: 'info', 458: 'guide', 10190: 'prevChannel', 10073: 'channelList'
};
const PROBE_CODES = [8, 27, 33, 34, 179, 461, 1, 999, 10000].concat(Object.keys(SAMSUNG).map(Number));

test('CP1 keys: Samsung (and Android, same native codes) map exactly as before; no platform = Samsung', () => {
  for (const platform of [undefined, 'tizen', 'android']) {
    for (const code of PROBE_CODES) {
      const m = mapKeyCode(code, false, platform);
      assert.deepEqual(m, SAMSUNG[code] ? { key: SAMSUNG[code] } : null, platform + ' ' + code);
    }
    for (let d = 0; d <= 9; d++) { assert.deepEqual(mapKeyCode(48 + d, false, platform), { key: 'digit', digit: d }); }
  }
  // Browser development keys only when allowed, as before.
  assert.deepEqual(mapKeyCode(27, true, 'browser'), { key: 'back' });
  assert.deepEqual(mapKeyCode(33, true), { key: 'chUp' });
  assert.equal(mapKeyCode(27, false, 'browser'), null);
});

test('CP1 keys: webOS (Back 461) and Titan OS (Back 8/461, CH 33/34, Play/Pause 179) tables', () => {
  assert.deepEqual(mapKeyCode(461, false, 'webos'), { key: 'back' });
  assert.equal(mapKeyCode(10009, false, 'webos'), null, 'Samsung Back is not a webOS key');
  assert.deepEqual(mapKeyCode(33, false, 'webos'), { key: 'chUp' });
  assert.deepEqual(mapKeyCode(406, false, 'webos'), { key: 'blue' });
  assert.deepEqual(mapKeyCode(8, false, 'titan'), { key: 'back' }, 'Philips');
  assert.deepEqual(mapKeyCode(461, false, 'titan'), { key: 'back' }, 'JVC');
  assert.deepEqual(mapKeyCode(34, false, 'titan'), { key: 'chDown' });
  assert.deepEqual(mapKeyCode(179, false, 'titan'), { key: 'playPause' });
  assert.deepEqual(mapKeyCode(53, false, 'titan'), { key: 'digit', digit: 5 });
  // The key router passes the platform through.
  const got = [];
  let t = 0;
  const kr = createKeyRouter({ now: () => (t += 500), throttleMs: 110, allowBrowserKeys: false, platform: 'webos', dispatch: (e) => { got.push(e.key); return true; } });
  kr.keyDown({ keyCode: 461, preventDefault() {} });
  kr.keyDown({ keyCode: 10009, preventDefault() {} });
  assert.deepEqual(got, ['back']);
});

// ---------------------------------------------------------------- engine capabilities

test('CP1 capabilities: AVPlay reports today\'s behaviour; engines without capabilities() get safe defaults', () => {
  const av = { open() {}, close() {}, stop() {}, setListener() {}, setDisplayRect() {}, prepareAsync() {}, play() {}, getState: () => 'NONE' };
  const eng = createAvplayEngine({ webapis: { avplay: av }, document: createFakeDocument() });
  assert.deepEqual(engineCapabilities(eng), { multiDecoder: false, trackSwitching: true, embeddedSubtitles: true, bufferControl: true, maxTracks: 32 });
  const fe = createFakeEngine();
  const c = engineCapabilities(fe.engine);
  assert.equal(c.multiDecoder, false, 'never assumed');
  assert.equal(c.bufferControl, true);
  assert.deepEqual(engineCapabilities(null), { multiDecoder: false, trackSwitching: false, embeddedSubtitles: false, bufferControl: true, maxTracks: 0 });
  const broken = { capabilities() { throw new Error('x'); } };
  assert.equal(engineCapabilities(broken).multiDecoder, DEFAULT_CAPABILITIES.multiDecoder, 'a throwing engine falls back');
});

// ---------------------------------------------------------------- memory policy

test('CP1 memory: Tizen and Android are measured with the unchanged 150 / 200 MB floors', () => {
  let free = 300;
  for (const name of ['tizen', 'android']) {
    const m = createMemoryPolicy({ name, memory: () => ({ availableMB: free, totalMB: 1300 }) });
    assert.equal(m.measured, true);
    assert.equal(m.workFloorMB, 150);
    assert.equal(m.guideFloorMB, 200);
    assert.equal(WORK_FLOOR_MB, 150);
    assert.equal(GUIDE_FLOOR_MB, 200);
    assert.equal(m.liveCacheMaxChars, LIVE_CACHE_MAX_CHARS);
    free = 300;
    assert.equal(m.freeMB(), 300);
    assert.equal(m.low(), false);
    free = 149;
    assert.equal(m.low(), true);
    free = 150;
    assert.equal(m.low(), false, 'the floor itself is not low (same rule as before)');
    free = -1;
    assert.equal(m.low(), false, 'unknown is not low');
    assert.match(m.describe(), /unavailable/);
    free = 300;
    assert.match(m.describe(), /300 MB free \(measured\)/);
  }
  const throwing = createMemoryPolicy({ name: 'tizen', memory: () => { throw new Error('systeminfo'); } });
  assert.equal(throwing.freeMB(), -1);
  assert.equal(throwing.low(), false);
});

test('CP1 memory: without a memory API nothing is presented as measured; limits apply instead', () => {
  const m = createMemoryPolicy({ name: 'browser', memory: () => ({ availableMB: 500, totalMB: 1000 }) });
  assert.equal(m.measured, false);
  assert.equal(m.freeMB(), -1, 'a value the platform made up is never passed on');
  assert.equal(m.workFloorMB, 0);
  assert.equal(m.guideFloorMB, 0);
  assert.equal(m.low(), false);
  assert.equal(m.liveCacheMaxChars, UNMEASURED_LIVE_CACHE_MAX_CHARS);
  assert.ok(UNMEASURED_LIVE_CACHE_MAX_CHARS < LIVE_CACHE_MAX_CHARS);
  assert.match(m.describe(), /^not measured; limits apply/);
});

test('CP1 memory: the app context uses the policy (Samsung floors unchanged)', () => {
  const clock = createFakeClock();
  const fp = createFakePlatform();
  fp.platform.name = 'tizen';
  const ctx = createAppContext({ platform: fp.platform, build: BUILD, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.equal(ctx.memory.measured, true);
  assert.equal(ctx.memory.workFloorMB, 150);
  assert.equal(ctx.memory.freeMB(), 220, 'the fake platform reports 220 MB');
});

// ---------------------------------------------------------------- IndexedDB FileStore

test('CP1 IndexedDB FileStore: read/write/remove/list, sorted, missing = null, names checked, no getAllKeys', async () => {
  const idb = createFakeIndexedDB();
  const fs = createIdbFileStore(idb.factory, 'screenshelf');
  assert.equal(fs.atomicReplace, true);
  assert.equal(await fs.read('cat.pl1.live.json'), null);
  await fs.write('cat.pl1.live.json', '{"a":1}');
  await fs.write('b.json', 'x');
  assert.equal(await fs.read('cat.pl1.live.json'), '{"a":1}');
  await fs.write('cat.pl1.live.json', '{"a":2}');
  assert.equal(await fs.read('cat.pl1.live.json'), '{"a":2}', 'replaced');
  assert.deepEqual(await fs.list(), ['b.json', 'cat.pl1.live.json']);
  await fs.remove('b.json');
  await fs.remove('never.json');
  assert.deepEqual(await fs.list(), ['cat.pl1.live.json']);
  await assert.rejects(fs.read('../evil'));
  await assert.rejects(fs.write('Bad Name', 'x'));
  assert.equal(idb.stats.opens, 1, 'one open for all calls');
  idb.sw.noKeyCursor = true; // only openCursor (older engines)
  assert.deepEqual(await fs.list(), ['cat.pl1.live.json']);
  // Persistence: a new store over the same database sees the data.
  const again = createIdbFileStore(idb.factory, 'screenshelf');
  assert.equal(await again.read('cat.pl1.live.json'), '{"a":2}');
});

test('CP1 IndexedDB FileStore: a failed write (quota) keeps the old text; errors never carry content; failed open retried', async () => {
  const idb = createFakeIndexedDB();
  const fs = createIdbFileStore(idb.factory, 'db');
  await fs.write('a.json', 'old');
  idb.sw.failWrites = true;
  await assert.rejects(fs.write('a.json', 'secret-new-content'), (e) => e.message === 'storage write failed');
  idb.sw.failWrites = false;
  assert.equal(await fs.read('a.json'), 'old', 'atomic: all or nothing');
  const idb2 = createFakeIndexedDB();
  idb2.sw.failOpen = true;
  const fs2 = createIdbFileStore(idb2.factory, 'db');
  await assert.rejects(fs2.read('a.json'), (e) => e.message === 'storage unavailable');
  idb2.sw.failOpen = false;
  assert.equal(await fs2.read('a.json'), null, 'opened on the next call');
  const idb3 = createFakeIndexedDB();
  idb3.sw.blockOpen = true;
  await assert.rejects(createIdbFileStore(idb3.factory, 'db').list(), (e) => e.message === 'storage blocked');
});

// ---------------------------------------------------------------- credentials (R0 decision 4)

test('CP1 Android: Keystore from API 23; before that session-only logins (never stored)', async () => {
  assert.equal(androidApiLevel('Android 9 (API 28)'), 28);
  assert.equal(androidApiLevel('Android 5.1 (API 22)'), 22);
  assert.equal(androidApiLevel('weird'), 0);
  function platform(version) {
    const saved = [];
    const bridge = {
      version: () => version, deviceType: () => 'tv', availableMemoryMB: () => 400, totalMemoryMB: () => 2000, exit() {},
      fileRead: () => null, fileWrite: () => true, fileRemove: () => true, fileList: () => '[]',
      keySave: (a) => { saved.push(a); return true; }, keyLoad: () => null, keyRemove: () => true
    };
    const doc = createFakeDocument();
    const win = { ElitePlatform: bridge, document: doc, innerWidth: 1920, innerHeight: 1080, navigator: { userAgent: 'test' }, crypto: globalThis.crypto, addEventListener() {}, removeEventListener() {} };
    return { p: createAndroidPlatform(win), saved };
  }
  const modern = platform('Android 9 (API 28)');
  assert.equal(modern.p.capabilities().secureKeyStore, true);
  assert.equal(modern.p.keyStore.persistent, true);
  const old = platform('Android 5.1 (API 22)');
  assert.equal(old.p.capabilities().secureKeyStore, false);
  assert.equal(old.p.keyStore.persistent, false);
  await old.p.keyStore.save('ss_pl_abc', 'pw');
  assert.deepEqual(old.saved, [], 'nothing reaches the native store before Android 6.0');
});

function bootApp(keyStore) {
  const clock = createFakeClock();
  const fp = createFakePlatform(keyStore ? { keyStore } : {});
  const ctx = createAppContext({ platform: fp.platform, build: BUILD, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { fp, ctx, clock };
}

test('CP1 session-only logins: kept for the session, gone after a restart, no plaintext in settings storage', async () => {
  const a = bootApp(null); // fake platform: in-memory key store (persistent: false)
  assert.equal(a.ctx.playlists.credentialsPersistent(), false);
  const add = await a.ctx.playlists.add({ name: 'Prov', kind: 'xtream', server: 'http://prov.example:8080', username: 'user_77', password: 'pw-SECRET-9' });
  assert.equal(add.ok, true, JSON.stringify(add));
  const id = add.playlist.id;
  assert.equal(await a.ctx.playlists.hasCredentials(id), true, 'kept for this session');
  const local = a.fp.platform.localStore;
  for (const k of local.keys()) {
    const v = local.getItem(k) || '';
    assert.equal(v.indexOf('pw-SECRET-9'), -1, 'password never in localStorage: ' + k);
    assert.equal(v.indexOf('user_77'), -1, 'username never in localStorage: ' + k);
  }
  // Restart: same settings storage, a fresh session key store.
  const b = createAppContext({ platform: Object.assign({}, a.fp.platform, { keyStore: createMemoryKeyStore() }), build: BUILD, now: a.clock.now, setTimer: a.clock.setTimer, clearTimer: a.clock.clearTimer });
  assert.equal(b.playlists.get(id).name, 'Prov', 'the playlist itself is kept');
  assert.equal(await b.playlists.hasCredentials(id), false, 'the login is not');
  const r = await b.playlists.refresh(id).result;
  assert.equal(r.code, 'no-credentials');
  // A persistent (secure) store: no session mode.
  const persistent = Object.assign(createMemoryKeyStore(), { persistent: true });
  assert.equal(bootApp(persistent).ctx.playlists.credentialsPersistent(), true);
});

test('CP1 sign-in prompt: once per app run on Home when the login is gone; Later closes; Sign in opens the form with the notice', async () => {
  const a = bootApp(null);
  const add = await a.ctx.playlists.add({ name: 'Prov', kind: 'xtream', server: 'http://prov.example:8080', username: 'u', password: 'p' });
  const id = add.playlist.id;
  a.ctx.playlists.setActive(id);
  await a.ctx.secrets.remove(id); // as after a restart
  const doc = createFakeDocument();
  const app = startApp(a.ctx, createDomHost(doc, doc.body), doc, a.clock.now);
  await settle();
  assert.match(doc.body.textContent, /Sign in again/);
  assert.match(doc.body.textContent, /does not keep the login of “Prov”/);
  a.fp.press(13); // OK on "Later" (first, focused)
  await settle();
  assert.doesNotMatch(doc.body.textContent, /Sign in again/);
  app.router.push('settings');
  app.router.pop();
  await settle();
  assert.doesNotMatch(doc.body.textContent, /Sign in again/, 'asked once per app run');
  app.destroy && app.destroy();
  // A new app run asks again; "Sign in" opens the edit form with the session notice.
  const doc2 = createFakeDocument();
  const b = bootApp(null);
  const add2 = await b.ctx.playlists.add({ name: 'Prov2', kind: 'xtream', server: 'http://prov.example:8080', username: 'u', password: 'p' });
  b.ctx.playlists.setActive(add2.playlist.id);
  await b.ctx.secrets.remove(add2.playlist.id);
  const app2 = startApp(b.ctx, createDomHost(doc2, doc2.body), doc2, b.clock.now);
  await settle();
  assert.match(doc2.body.textContent, /Sign in again/);
  b.fp.press(39); // → "Sign in"
  b.fp.press(13);
  await settle();
  assert.equal(app2.router.stack().slice(-1)[0], 'playlist-form');
  assert.match(doc2.body.textContent, /no secure password storage: the login is kept only until the app closes/);
});

test('CP1 sign-in prompt: never shown with a secure store (Samsung keymanager, Android 6+)', async () => {
  const persistent = Object.assign(createMemoryKeyStore(), { persistent: true });
  const a = bootApp(persistent);
  const add = await a.ctx.playlists.add({ name: 'Prov', kind: 'xtream', server: 'http://prov.example:8080', username: 'u', password: 'p' });
  a.ctx.playlists.setActive(add.playlist.id);
  await a.ctx.secrets.remove(add.playlist.id);
  const doc = createFakeDocument();
  startApp(a.ctx, createDomHost(doc, doc.body), doc, a.clock.now);
  await settle();
  assert.doesNotMatch(doc.body.textContent, /Sign in again/);
  assert.doesNotMatch(doc.body.textContent, /no secure password storage/);
});

// ---------------------------------------------------------------- platform isolation

test('CP1 isolation: every platform global stays in src/app/platform/', () => {
  const globals = ['tizen.application', 'webapis.avplay', 'indexedDB.open("x", 1)', 'window.ElitePlatform', 'PalmSystem.identifier', 'webOS.platform', 'TitanSDK.deviceInfo', 'window.indexedDB'];
  for (const g of globals) {
    const outside = checkSource('export const x = ' + g + ';\n', 'src/services/x.ts');
    assert.ok(outside.some((f) => f.rule === 'boundary/platform'), g + ' outside the platform folder');
    const inside = checkSource('export const x = ' + g + ';\n', 'src/app/platform/x.ts');
    assert.deepEqual(inside.filter((f) => f.rule === 'boundary/platform'), [], g + ' inside');
  }
  assert.deepEqual(checkSource('export const x = win.webOS;\n', 'src/screens/x.ts').filter((f) => f.rule === 'boundary/platform'), [], 'member of another object is fine');
});
