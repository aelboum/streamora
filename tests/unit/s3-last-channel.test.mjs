// S3: "Play last channel on app startup". Unit tests of the start-up decision (stubbed playlists,
// manual timers, recording UI) and integration through the real Live TV + player screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResumeLive, RESUME_DELAY_MS, RESUME_GUARD_KEY, RESUME_LOOP_MS, RESUME_PREF_KEY } from '../../src/services/resume-live.ts';
import { createKeyValueStore, KV_PREFIX } from '../../src/storage/kv-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createRouter } from '../../src/navigation/router.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { registerLiveScreens } from '../../src/screens/live-screens.ts';
import { createResumeToast } from '../../src/screens/resume-toast.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createEpgService } from '../../src/services/epg-service.ts';
import { createUserLists } from '../../src/services/user-lists.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';

const T0 = Date.UTC(2026, 10, 26, 18, 0);
const CATALOGUE = {
  categories: [{ id: 'news', name: 'News', count: 2, adult: false }, { id: 'xxx', name: 'Adults', count: 1, adult: true }],
  channels: [
    { id: 'c1', num: 1, name: 'News One', categoryId: 'news', adult: false },
    { id: 'c2', num: 2, name: 'News Two', categoryId: 'news', adult: false },
    { id: 'c9', num: 9, name: 'Late Night', categoryId: 'xxx', adult: true }
  ]
};

/** Stubbed world for the start-up decision; every field can be changed per test. */
function world(over = {}) {
  const local = createMemoryLocalStore();
  const kv = createKeyValueStore(local);
  const w = {
    state: 'ok', active: 'p1', def: { id: 'p1', kind: 'xtream', name: 'Mine' }, creds: true, importing: null, load: 'ok',
    recent: ['c2'], locked: false, memLow: false, now: T0, top: 'home', overlay: null,
    toasts: [], closed: 0, opened: [], timers: [], cleared: 0, loads: 0, ...over
  };
  const playlists = {
    whenChecked: () => Promise.resolve(w.state === 'ok' ? { status: 'ok' } : { status: 'protected', problem: 'corrupt' }),
    storageState: () => (w.state === 'ok' ? { status: 'ok' } : { status: 'protected' }),
    activeId: () => w.active,
    get: (id) => (id === w.active ? w.def : null),
    importing: () => w.importing,
    hasCredentials: () => Promise.resolve(w.creds),
    loadLive: () => { w.loads++; return Promise.resolve(w.load === 'ok' ? { status: 'ok', catalogue: CATALOGUE, meta: {}, ms: 1 } : { status: 'missing' }); }
  };
  const resume = createResumeLive({
    kv, playlists, lists: { recent: () => w.recent.slice() }, parental: { locked: () => w.locked },
    memoryLow: () => w.memLow, hasPlayer: over.hasPlayer !== undefined ? over.hasPlayer : true,
    now: () => w.now, setTimer: (fn, ms) => { w.timers.push({ fn, ms }); return w.timers.length; }, clearTimer: () => { w.cleared++; },
    log: createLogger(200), text: (n) => ({ title: 'Resuming ' + n + '…', body: 'Press any key to cancel.' }), rootScreen: 'home',
    ui: {
      top: () => w.top, overlay: () => w.overlay,
      openToast: (title, body, cancel) => { w.toasts.push({ title, cancel }); w.overlay = 'resume-toast'; },
      closeToast: () => { w.closed++; if (w.overlay === 'resume-toast') { w.overlay = null; } },
      openLive: (pid, ch) => { w.opened.push([pid, ch]); }
    }
  });
  return { w, kv, local, resume };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

async function runAndFire(x) {
  const p = x.resume.run();
  await flush(); await flush();
  if (x.w.timers.length) { x.w.timers[0].fn(); }
  return p;
}

test('off by default: nothing happens; the setting persists across restarts (new app session)', async () => {
  const x = world();
  assert.equal(x.resume.enabled(), false);
  assert.equal(await x.resume.run(), 'off');
  assert.equal(x.w.toasts.length + x.w.opened.length + x.w.loads, 0, 'no toast, no Live TV, no catalogue load');
  x.resume.setEnabled(true);
  assert.equal(x.local.getItem(KV_PREFIX + RESUME_PREF_KEY), '{"v":1,"d":true}');
  const again = createResumeLive({ kv: x.kv, playlists: {}, lists: {}, parental: null, memoryLow: () => false, hasPlayer: true, now: () => T0, setTimer: () => 0, clearTimer: () => {}, log: createLogger(10), text: () => ({ title: '', body: '' }), rootScreen: 'home', ui: {} });
  assert.equal(again.enabled(), true, 'still on after a restart');
});

test('success: waits for storage validation, shows "Resuming …", then opens Live TV with the last pictured channel', async () => {
  const x = world();
  x.resume.setEnabled(true);
  const p = x.resume.run();
  await flush(); await flush();
  assert.equal(x.w.toasts.length, 1);
  assert.equal(x.w.toasts[0].title, 'Resuming News Two…', 'recent[0] = the last channel that showed a picture');
  assert.equal(x.w.timers[0].ms, RESUME_DELAY_MS);
  assert.equal(x.w.opened.length, 0, 'nothing plays during the message');
  x.w.timers[0].fn();
  assert.equal(await p, 'started');
  assert.deepEqual(x.w.opened, [['p1', 'c2']]);
  assert.equal(x.w.closed, 1, 'message closed');
  assert.ok(x.local.getItem(KV_PREFIX + RESUME_GUARD_KEY), 'attempt recorded for the restart-loop guard');
  assert.equal(await x.resume.run(), 'done', 'only once per app session');
  assert.equal(x.w.opened.length, 1);
});

test('cancellation: any key during the message cancels; nothing opens and the timer is cleared', async () => {
  const x = world();
  x.resume.setEnabled(true);
  const p = x.resume.run();
  await flush(); await flush();
  x.w.toasts[0].cancel();
  assert.equal(await p, 'cancelled');
  assert.equal(x.w.cleared, 1);
  x.w.timers[0].fn(); // a late timer does nothing
  assert.equal(x.w.opened.length, 0);
  assert.equal(await x.resume.run(), 'done', 'no second attempt after a cancel');
});

test('never while playlists are protected', async () => {
  const x = world({ state: 'protected' });
  x.resume.setEnabled(true);
  assert.equal(await runAndFire(x), 'storage');
  assert.equal(x.w.loads + x.w.toasts.length + x.w.opened.length, 0, 'no catalogue load, no message, no playback');
});

test('parental control: an adult channel is never auto-played while locked (and no PIN is asked)', async () => {
  const x = world({ recent: ['c9'], locked: true });
  x.resume.setEnabled(true);
  assert.equal(await runAndFire(x), 'parental');
  assert.equal(x.w.toasts.length + x.w.opened.length, 0);
  const y = world({ recent: ['c9'], locked: false });
  y.resume.setEnabled(true);
  assert.equal(await runAndFire(y), 'started', 'unlocked (or no PIN set): allowed');
});

test('memory: no attempt below the floor (checked before and after loading the channel list)', async () => {
  const x = world({ memLow: true });
  x.resume.setEnabled(true);
  assert.equal(await runAndFire(x), 'memory');
  assert.equal(x.w.loads, 0);
  const y = world();
  y.resume.setEnabled(true);
  const p = y.resume.run();
  y.w.memLow = true; // drops while the list loads
  await flush(); await flush();
  assert.equal(await p, 'memory');
  assert.equal(y.w.toasts.length, 0);
});

test('missing or invalid channel and other unmet conditions stop safely', async () => {
  for (const [over, want] of [[{ recent: [] }, 'no-channel'], [{ recent: ['gone'] }, 'missing-channel'], [{ load: 'missing' }, 'load-failed'],
    [{ active: null }, 'no-playlist'], [{ creds: false }, 'no-credentials'], [{ importing: 'p1' }, 'importing'], [{ hasPlayer: false }, 'no-player']]) {
    const x = world(over);
    x.resume.setEnabled(true);
    assert.equal(await runAndFire(x), want, JSON.stringify(over));
    assert.equal(x.w.opened.length, 0);
  }
});

test('the user is busy: another screen or a dialog blocks it; moving away during the message too', async () => {
  for (const over of [{ top: 'settings' }, { overlay: 'confirm' }]) {
    const x = world(over);
    x.resume.setEnabled(true);
    assert.equal(await runAndFire(x), 'busy-ui', JSON.stringify(over));
  }
  const y = world();
  y.resume.setEnabled(true);
  const p = y.resume.run();
  await flush(); await flush();
  y.w.top = 'live-tv';
  y.w.timers[0].fn();
  assert.equal(await p, 'moved');
  assert.equal(y.w.opened.length, 0);
});

test('restart-loop guard: no new attempt within the loop window after the previous one', async () => {
  const x = world();
  x.resume.setEnabled(true);
  assert.equal(await runAndFire(x), 'started');
  const mark = JSON.parse(x.local.getItem(KV_PREFIX + RESUME_GUARD_KEY)).d;
  const restart = (now) => { const y = world({ now }); y.kv.set(RESUME_PREF_KEY, true); y.kv.set(RESUME_GUARD_KEY, mark); return y; };
  assert.equal(await runAndFire(restart(T0 + 20000)), 'loop-guard', 'crash during playback, restart 20 s later');
  assert.equal(await runAndFire(restart(T0 + RESUME_LOOP_MS - 1)), 'loop-guard');
  assert.equal(await runAndFire(restart(T0 - 5000)), 'loop-guard', 'clock went back a little: still guarded');
  assert.equal(await runAndFire(restart(T0 + RESUME_LOOP_MS + 1)), 'started', 'a normal later start works again');
  assert.equal(await runAndFire(restart(T0 - 10 * RESUME_LOOP_MS)), 'started', 'clock went back a lot: the old mark is not usable');
});

test('writes nothing but its own two keys (setting, loop guard); never the playlist list', async () => {
  const x = world();
  const writes = [];
  const set = x.local.setItem.bind(x.local);
  x.local.setItem = (k, v) => { writes.push(k); set(k, v); };
  x.resume.setEnabled(true);
  await runAndFire(x);
  assert.deepEqual(writes.sort(), [KV_PREFIX + RESUME_PREF_KEY, KV_PREFIX + RESUME_GUARD_KEY].sort());
});

test('the "Resuming …" overlay: every key (Back included) cancels', () => {
  let n = 0;
  const doc = createFakeDocument();
  const s = createResumeToast(doc, { title: 'Resuming News Two…', body: 'Press any key to cancel.', cancel: () => { n++; } }, {});
  const layer = { element: doc.createElement('div') };
  s.mount(layer);
  assert.match(layer.element.textContent, /Resuming News Two…Press any key to cancel\./);
  assert.equal(s.onKey({ key: 'ok' }), true);
  assert.equal(s.onKey({ key: 'chUp' }), true);
  assert.equal(s.onBack(), true);
  assert.equal(n, 3);
});

// ------------------------------------------------------------------ real Live TV + player screens

const M3U = readFileSync(new URL('../fixtures/m3u/provider-extended.m3u', import.meta.url), 'utf8');
const KEY = { ok: 13, back: 10009, chUp: 427, chDown: 428 };
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) { throw new Error('timeout: ' + what); } await new Promise((r) => setTimeout(r, 10)); }
}

async function liveEnv(opts = {}) {
  const local = createMemoryLocalStore();
  const files = createMemoryFileStore();
  const log = createLogger(2000);
  const kv = createKeyValueStore(local, log);
  const srv = createFakeServer((url) => (url.includes('xmltv') || url.includes('.gz') || url.includes('guide') ? { status: 404 } : { status: 200, body: M3U, chunk: 1048576 }));
  const http = createHttpClient({ xhrFactory: srv.factory });
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
  const now = () => Date.UTC(2025, 10, 23, 12, 15);
  const catalogue = createCatalogueStore(files, { budgetChars: 50000000, maxChars: 100000000 }, now, log);
  const playlists = createPlaylistService({
    kv, catalogue, secrets: createSecretStore(createMemoryKeyStore()), http, now, log: log.child('playlists'), timers,
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000 }
  });
  const epg = createEpgService({
    playlists, catalogue, http, now, timers: { ...timers, now }, log: log.child('epg'),
    limits: { maxChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000, pastHours: 2, futureHours: 24, maxPerChannel: 300, maxTotal: 400000, staleMs: 12 * 3600000, defaultOffsetMin: 0 }
  });
  const lists = createUserLists(kv);
  const fe = createFakeEngine();
  const doc = createFakeDocument();
  const t = createTranslator('en');
  const router = createRouter(createDomHost(doc, doc.body), log.child('router'));
  const pinOpened = [];
  router.register('pin-dialog', () => { pinOpened.push(1); return { mount() {}, onShow() {}, onHide() {}, onKey: () => true, onBack: () => false, destroy() {} }; });
  registerLiveScreens(router, {
    doc, t, playlists, epg, lists, lifecycle: { on: () => () => {} }, engine: fe.engine, textInput: { active: false }, preferIme: false, now, ...timers, log,
    player: { bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 40, retryDelaysMs: [30, 30] },
    preview: null, parental: opts.parental || null
  });
  let k = 0;
  const keyRouter = createKeyRouter({ now: () => (k += 200), throttleMs: 110, allowBrowserKeys: false, dispatch: (e) => router.handleKey(e), textInputActive: () => false });
  const press = (name) => { const ev = { keyCode: KEY[name], preventDefault() {} }; keyRouter.keyDown(ev); keyRouter.keyUp(ev); };
  const pl = (await playlists.add({ name: 'Home', kind: 'm3u', url: 'https://secure.example.org/get.php?username=demo_user&password=demo_pass_9f3k' })).playlist;
  assert.equal((await playlists.refresh(pl.id).result).ok, true);
  const cat = (await playlists.loadLive(pl.id)).catalogue;
  const byName = (n) => cat.channels.find((c) => c.name === n);
  const layer = () => { const l = doc.body.childNodes.filter((n) => n.style.display !== 'none' && n.attributes && n.attributes['data-layer']); return l[l.length - 1]; };
  return { router, press, fe, pl, byName, log, pinOpened, layer, lists };
}

test('integration: the channel opens in its own category through the normal path; CH+ stays in that category', async () => {
  const env = await liveEnv();
  const sport1 = env.byName('Sport Max 1');
  env.router.push('live-tv', { playlistId: env.pl.id, resume: { channelId: sport1.id } });
  await until(() => env.router.stack().slice(-1)[0] === 'player', 5000, 'player opened');
  await until(() => env.fe.loads().length === 1, 2000, 'first load');
  const first = env.fe.loads()[0].url;
  env.press('chUp');
  await until(() => env.fe.loads().length === 2, 2000, 'CH+');
  env.press('chUp');
  await until(() => env.fe.loads().length === 3, 2000, 'CH+ again');
  const urls = env.fe.loads().map((l) => l.url);
  assert.notEqual(urls[1], first);
  assert.equal(urls[2], first, 'two channels in "UK | Sports": CH+ twice wraps back within the category');
  env.press('back');
  await until(() => env.router.stack().slice(-1)[0] === 'live-tv', 2000, 'back to Live TV');
  assert.match(env.layer().textContent, /UK \| Sports/, 'the restored category is shown');
});

test('integration: a missing channel is not opened (note shown, normal Live TV list, no playback)', async () => {
  const env = await liveEnv();
  env.router.push('live-tv', { playlistId: env.pl.id, resume: { channelId: 'no-such-channel' } });
  await until(() => env.log.entries().some((e) => e.msg === 'resume: channel not opened'), 5000, 'resume handled');
  assert.equal(env.router.stack().slice(-1)[0], 'live-tv');
  assert.equal(env.fe.loads().length, 0);
  assert.match(env.layer().textContent, /The last channel could not be opened\./);
});

test('integration: an adult channel while locked is not opened and no PIN dialog appears', async () => {
  const env = await liveEnv({ parental: { locked: () => true, lockAdult: () => true, available: () => true, hasPin: () => true } });
  const adult = env.byName('Late Night 1');
  assert.equal(adult.adult, true, 'fixture channel is adult');
  env.router.push('live-tv', { playlistId: env.pl.id, resume: { channelId: adult.id } });
  await until(() => env.log.entries().some((e) => e.msg === 'resume: channel not opened'), 5000, 'resume handled');
  assert.equal(env.pinOpened.length, 0, 'no PIN prompt at start-up');
  assert.equal(env.fe.loads().length, 0);
  assert.equal(env.router.stack().slice(-1)[0], 'live-tv');
});

test('integration: a playback failure ends in the normal player error, with no extra automatic attempt', async () => {
  const env = await liveEnv();
  const sport2 = env.byName('Sport Max 2');
  env.router.push('live-tv', { playlistId: env.pl.id, resume: { channelId: sport2.id } });
  await until(() => env.fe.loads().length === 1, 5000, 'load');
  env.fe.failPrepare('connection');
  await until(() => /can’t be reached\. Press OK to try again/.test(env.layer().textContent), 2000, 'normal player error');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(env.fe.loads().length, 1, 'no automatic re-attempt (the user decides: OK retries, Back leaves)');
  assert.equal(env.lists.recent(env.pl.id).length, 0, 'no picture → not recorded as the last channel');
  env.press('back');
  await until(() => env.router.stack().slice(-1)[0] === 'live-tv', 2000, 'back to the normal interface');
});

test('real start-up: Settings toggle (off by default, persists); with it off the start-up is unchanged', async () => {
  const { createAppContext, startApp } = await import('../../src/app/bootstrap.ts');
  const { createFakePlatform } = await import('../fakes/fake-platform.mjs');
  const { createFakeClock } = await import('../fakes/fake-clock.mjs');
  const fp = createFakePlatform();
  const boot = () => {
    const clk = createFakeClock();
    const ctx = createAppContext({ platform: fp.platform, build: { mode: 'release', version: '0.2.0', devSinkUrl: '' }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer, engineFactory: () => createFakeEngine().engine });
    const doc = createFakeDocument();
    const app = startApp(ctx, createDomHost(doc, doc.body), doc, clk.now);
    return { ctx, doc, app, clk };
  };
  const a = boot();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(a.app.router.stack(), ['home'], 'default start-up: Home');
  assert.equal(a.app.router.overlay(), null, 'no "Resuming" message when the option is off');
  a.app.router.push('settings');
  const row = () => a.doc.body.findAll('ss-set__row').find((r) => r.attributes['data-row'] === 'resume-last');
  assert.ok(row(), 'the option is offered where Live TV can play');
  assert.match(row().textContent, /Play last channel on app startupOff/);
  for (let i = 0; i < 10 && !/is-focused/.test(row().className); i++) { fp.press(40); }
  fp.press(13);
  assert.match(row().textContent, /On$/);
  const b = boot(); // a new app session on the same storage
  b.app.router.push('settings');
  assert.match(b.doc.body.findAll('ss-set__row').find((r) => r.attributes['data-row'] === 'resume-last').textContent, /On$/, 'persists across restarts');
});
