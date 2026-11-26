// Live TV UI (Stage 5), driven by remote key codes through the real key router and screen router,
// against the real PlaylistService, EpgService and UserLists (memory stores, fake HTTP server),
// the fake playback engine and a fake DOM. Covers channel and category navigation, favourites,
// recently watched, search, channel details, previous/next channel, player state and errors,
// the system-keyboard (IME) strategy, and performance with 1,000 / 10,000 / 50,000 channels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRouter } from '../../src/navigation/router.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { registerPlaylistScreens } from '../../src/screens/playlist-screens.ts';
import { registerLiveScreens, textOpener } from '../../src/screens/live-screens.ts';
import { keyboardLayout, KEY_COLUMNS } from '../../src/screens/keyboard-overlay.ts';
import { IME_DONE, IME_CANCEL } from '../../src/screens/text-entry-overlay.ts';
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
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeServer } from '../fakes/fake-http-server.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';

const M3U = readFileSync(new URL('../fixtures/m3u/provider-extended.m3u', import.meta.url), 'utf8');
const GUIDE = readFileSync(new URL('../fixtures/xmltv/guide.xml', import.meta.url), 'utf8');
const KEY = { left: 37, up: 38, right: 39, down: 40, ok: 13, back: 10009, chUp: 427, chDown: 428, playPause: 10252 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(5);
  }
}

function makeM3u(n, groups) {
  const parts = ['#EXTM3U url-tvg="http://epg.example.org/guide.xml"\n'];
  for (let i = 0; i < n; i++) {
    parts.push('#EXTINF:-1 tvg-id="ch' + i + '" tvg-logo="http://logos.example.org/' + (i % 500) + '.png" group-title="Group ' + (i % groups) + '",Channel ' + i + '\nhttp://s.example/live/' + i + '.ts\n');
  }
  return parts.join('');
}

function makeGuide(channels, perChannel, base) {
  const parts = ['<?xml version="1.0"?><tv>'];
  const f = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').substring(0, 14) + ' +0000';
  for (let c = 0; c < channels; c++) {
    parts.push('<channel id="ch' + c + '"><display-name>Channel ' + c + '</display-name></channel>');
  }
  for (let c = 0; c < channels; c++) {
    for (let k = 0; k < perChannel; k++) {
      const s = base + (k - 2) * 3600000;
      parts.push('<programme start="' + f(s) + '" stop="' + f(s + 3600000) + '" channel="ch' + c + '"><title>Show ' + k + ' on ' + c + '</title><desc>Episode description ' + k + '</desc></programme>');
    }
  }
  parts.push('</tv>');
  return parts.join('');
}

async function setup(opts = {}) {
  const now = opts.now || Date.UTC(2025, 10, 23, 12, 15);
  const clockNow = () => now + (Date.now() - started);
  const started = Date.now();
  const local = createMemoryLocalStore();
  const files = createMemoryFileStore();
  const log = createLogger(2000);
  const kv = createKeyValueStore(local, log);
  const srv = createFakeServer((url) => {
    if (url.includes('xmltv.php') || url.includes('guide.xml')) return { status: 200, body: opts.guide || GUIDE, chunk: 1048576 };
    if (url.includes('.gz')) return { status: 404 };
    return { status: 200, body: opts.m3u || M3U, chunk: 1048576 };
  });
  const http = createHttpClient({ xhrFactory: srv.factory });
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
  const catalogue = createCatalogueStore(files, { budgetChars: 50000000, maxChars: 100000000 }, clockNow, log);
  const playlists = createPlaylistService({
    kv, catalogue, secrets: createSecretStore(createMemoryKeyStore()), http, now: clockNow, log: log.child('playlists'), timers,
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000 }
  });
  const epg = createEpgService({
    playlists, catalogue, http, now: clockNow, timers: { ...timers, now: clockNow }, log: log.child('epg'),
    limits: { maxChars: 100000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000, pastHours: 2, futureHours: 24, maxPerChannel: 300, maxTotal: 400000, staleMs: 12 * 3600000, defaultOffsetMin: 0 }
  });
  const lists = createUserLists(kv);
  const fe = createFakeEngine();
  const doc = createFakeDocument();
  const t = createTranslator('en');
  const router = createRouter(createDomHost(doc, doc.body), log.child('router'));
  const textInput = { active: false };
  const lifeCbs = [];
  const lifecycle = { on: (cb) => { lifeCbs.push(cb); return () => lifeCbs.splice(lifeCbs.indexOf(cb), 1); } };
  registerPlaylistScreens(router, { doc, playlists, t, now: clockNow, ...timers, openText: textOpener(!!opts.ime), live: true });
  registerLiveScreens(router, {
    doc, t, playlists, epg, lists, lifecycle, engine: fe.engine, textInput, preferIme: !!opts.ime, now: clockNow, ...timers, log,
    player: { bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 40, retryDelaysMs: [50, 50, 50] },
    preview: opts.preview ? { debounceMs: 60 } : null,
    parental: opts.parental || null
  });
  router.register('diagnostics', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
  let k = 0;
  const keyRouter = createKeyRouter({ now: () => (k += 200), throttleMs: 110, allowBrowserKeys: false, dispatch: (e) => router.handleKey(e), textInputActive: () => textInput.active });
  const ev = (code) => ({ keyCode: code, preventDefault() {} });
  function press(name, times = 1) {
    for (let i = 0; i < times; i++) {
      const code = typeof name === 'number' ? name : KEY[name];
      keyRouter.keyDown(ev(code));
      keyRouter.keyUp(ev(code));
    }
  }
  const layer = () => { const l = doc.body.childNodes.filter((n) => n.style.display !== 'none' && n.attributes && n.attributes['data-layer']); return l[l.length - 1]; };
  const focused = () => { const f = layer().findAll('is-focused'); return f.map((x) => x.textContent); };
  const pl = (await playlists.add({ name: 'Home', kind: 'm3u', url: 'https://secure.example.org/get.php?username=demo_user&password=demo_pass_9f3k' })).playlist;
  const imp = await playlists.refresh(pl.id).result;
  assert.equal(imp.ok, true, JSON.stringify(imp));
  return { router, press, layer, focused, doc, fe, lists, epg, playlists, pl, textInput, log, t, srv, lifeCbs, kv };
}

async function openLive(env) {
  env.router.push('live-tv', { playlistId: env.pl.id });
  await until(() => env.log.entries().some((e) => e.msg === 'live tv ready'), 30000, 'live tv ready');
  await until(() => /Guide (updated|update failed)|No guide/.test(env.layer().textContent) && !env.epg.status().refreshing, 30000, 'guide');
}

const rows = (env) => env.layer().findAll('ss-ch').filter((r) => r.style.display !== 'none');
const rowNames = (env) => rows(env).map((r) => r.findAll('ss-ch__name')[0].textContent);
const focusedRow = (env) => env.layer().findAll('ss-ch').find((r) => / is-focused/.test(r.className));
const focusedCat = (env) => env.layer().findAll('ss-cat').find((r) => / is-focused/.test(r.className));

test('Live TV: channel list, logos, current programme, channel details, channel navigation', async () => {
  const env = await setup();
  await openLive(env);
  const names = rowNames(env);
  assert.equal(names[0], 'News One HD');
  assert.equal(names.length, 8, 'Stage 7B.1: 8 rows of 100 in the channel panel');
  const first = rows(env)[0];
  assert.equal(first.findAll('ss-ch__logo')[0].attributes.src, 'http://logos.example.org/uk/news-one.png');
  assert.equal(first.findAll('ss-ch__now')[0].textContent, 'Midday "Special"', 'current programme from the EPG');
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'News One HD');
  await sleep(150);
  const info = env.layer().findAll('ss-live__info')[0].textContent;
  assert.match(info, /News One HD/);
  assert.match(info, /Channel 1 · UK \| News/);
  assert.match(info, /12:00|13:00/, 'local start time shown');
  assert.match(info, /Midday "Special"/);
  assert.match(info, /Raw <b>text<\/b> & more/, 'description as plain text');
  assert.match(info, /Afternoon Report/, 'next programme');
  env.press('down', 2);
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'Sport Max 1');
  env.press('up');
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'News Two');
  env.press('down', 30);
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'Grouped By EXTGRP', 'stops at the last channel');
  env.press('chUp');
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'News Two', 'CH+ pages up by 8 rows (Stage 7B.1)');
  env.press('chUp');
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'News One HD', 'CH+ stops at the first channel');
  await sleep(150);
  const news2 = (await env.playlists.loadLive(env.pl.id)).catalogue.channels.find((c) => c.name === 'News Two');
  assert.deepEqual(env.epg.nowNext(news2), { now: null, next: null });
  env.press('down');
  await sleep(150);
  assert.match(env.layer().findAll('ss-live__info')[0].textContent, /No guide information/, 'missing programme data');
});

test('Live TV: category navigation, Back steps left then leaves', async () => {
  const env = await setup();
  env.router.resetTo('playlists');
  await openLive(env);
  env.press('back');
  assert.equal(focusedCat(env).findAll('ss-cat__name')[0].textContent, 'All channels');
  env.press('down');
  assert.equal(focusedCat(env).findAll('ss-cat__name')[0].textContent, 'UK | News');
  await sleep(200);
  assert.deepEqual(rowNames(env), ['News One HD', 'News Two'], 'list follows the focused category (debounced)');
  env.press('down');
  env.press('down');
  env.press('ok'); // NL | Kinderen -> channels immediately
  assert.deepEqual(rowNames(env), ['Kids Fun']);
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'Kids Fun');
  env.press('left');
  assert.ok(focusedCat(env));
  env.press('back');
  assert.deepEqual(env.router.stack(), ['playlists'], 'Back from the categories leaves Live TV');
});

test('Favourites and recently watched; player opens, zaps with CH+/CH−/↑/↓, records history', async () => {
  const env = await setup();
  await openLive(env);
  env.press('right'); // actions
  assert.deepEqual(env.focused().filter((x) => x === 'Watch'), ['Watch']);
  env.press('right');
  env.press('ok'); // Add to favourites
  assert.equal(rows(env)[0].findAll('ss-ch__fav')[0].textContent, '★');
  assert.deepEqual(env.lists.favourites(env.pl.id).length, 1);
  assert.match(env.layer().textContent, /Remove from favourites/);
  env.press('left');
  env.press('back');
  env.press('up', 2); // All -> Recent -> Favourites
  env.press('ok');
  assert.deepEqual(rowNames(env), ['News One HD']);
  env.press('ok'); // watch
  assert.deepEqual(env.router.stack().slice(-1), ['player']);
  await until(() => env.fe.loads().length === 1, 2000, 'load');
  assert.equal(env.fe.loads()[0].bufferSec, 2);
  assert.match(env.layer().textContent, /Loading…/);
  env.fe.prepared();
  env.fe.picture();
  await sleep(10);
  assert.equal(env.layer().findAll('ss-player__status')[0].textContent, '');
  assert.deepEqual(env.lists.recent(env.pl.id).length, 1, 'recently watched recorded when the picture starts');
  assert.ok(env.doc.body.className.includes('ss-playing'), 'page transparent for the video plane');
  env.press('back');
  assert.equal(env.router.stack().slice(-1)[0], 'live-tv');
  assert.equal(env.doc.body.className.includes('ss-playing'), false);
  env.press('back');
  env.press('down', 2); // Favourites -> Recent -> All
  env.press('ok');
  env.press('down');
  env.press('ok'); // play News Two from "All channels"
  await until(() => env.fe.loads().length === 2, 2000, 'second load');
  env.fe.prepared(); env.fe.picture();
  env.press('chUp');
  assert.match(env.layer().findAll('ss-banner__name')[0].textContent, /Sport Max 1/, 'banner updates immediately');
  env.press('up');
  env.press('down');
  env.press('chDown');
  assert.match(env.layer().findAll('ss-banner__name')[0].textContent, /News Two/);
  await until(() => env.fe.loads().length === 3, 2000, 'debounced zap');
  assert.match(env.fe.loads()[2].url, /\/live\/demo_user\/demo_pass_9f3k\/1002\.ts$/, 'zapped back to News Two once, after the debounce');
  env.fe.prepared(); env.fe.picture();
  env.press('playPause');
  assert.match(env.layer().textContent, /Paused/);
  env.press('playPause');
  env.press('down', 2);
  await until(() => env.fe.loads().length === 4, 2000, 'zap to the previous channel (wraps)');
  env.fe.failPrepare('connection');
  await sleep(10);
  assert.match(env.layer().textContent, /The channel can’t be reached\. Press OK to try again/);
  env.press('ok');
  await until(() => env.fe.loads().length === 5, 2000, 'retry');
  env.press('back');
  env.press('back');
  env.press('up');
  await sleep(200);
  assert.equal(focusedCat(env).findAll('ss-cat__name')[0].textContent, 'Recently watched');
  assert.ok(rowNames(env).length >= 2, 'recent list shows watched channels');
  // Home key while playing: suspend and restore.
  env.press('ok');
  env.press('ok');
  await until(() => env.fe.loads().length === 6, 2000, 'play from recent');
  env.fe.prepared(); env.fe.picture();
  env.lifeCbs.forEach((cb) => cb('hidden'));
  env.lifeCbs.forEach((cb) => cb('visible'));
  await until(() => env.fe.loads().length === 7, 2000, 'reopened after Home');
});

test('Channel search with the app keyboard: name and number; no results; results open the player', async () => {
  const env = await setup();
  await openLive(env);
  env.press('back');
  env.press('up', 3);
  assert.equal(focusedCat(env).findAll('ss-cat__name')[0].textContent, 'Search');
  env.press('ok');
  assert.equal(env.router.overlay(), 'keyboard', 'no IME in this environment: app keyboard');
  const kl = keyboardLayout(env.t, 'text');
  const pos = () => Number(env.layer().findAll('is-focused')[0].attributes['data-key']);
  function goKey(target) {
    const tr = Math.floor(target / KEY_COLUMNS);
    while (Math.floor(pos() / KEY_COLUMNS) < tr) env.press('down');
    while (Math.floor(pos() / KEY_COLUMNS) > tr) env.press('up');
    while (pos() < target) env.press('right');
    while (pos() > target) env.press('left');
  }
  for (const c of 'sport') { goKey(kl.findIndex((x) => x.text === c)); env.press('ok'); }
  goKey(kl.findIndex((x) => x.action === 'done'));
  env.press('ok');
  assert.deepEqual(rowNames(env), ['Sport Max 1', 'Sport Max 2']);
  assert.match(focusedCat(env) ? '' : env.layer().textContent, /Search: “sport”/);
  assert.equal(focusedRow(env).findAll('ss-ch__name')[0].textContent, 'Sport Max 1', 'focus on the first result');
  env.press('back');
  env.press('ok'); // search again: number
  goKey(kl.findIndex((x) => x.action === 'clear')); env.press('ok');
  env.press(48 + 1); env.press(48 + 0); env.press(48 + 2); // remote digits "102"
  goKey(kl.findIndex((x) => x.action === 'done')); env.press('ok');
  assert.deepEqual(rowNames(env), ['News Two'], 'channel number search');
  env.press('back');
  env.press('ok');
  goKey(kl.findIndex((x) => x.action === 'clear')); env.press('ok');
  for (const c of 'zzz') { goKey(kl.findIndex((x) => x.text === c)); env.press('ok'); }
  goKey(kl.findIndex((x) => x.action === 'done')); env.press('ok');
  assert.deepEqual(rowNames(env), []);
  assert.match(env.layer().textContent, /No channel matches this search/);
});

test('Keyboard strategy: Samsung IME preferred, Back closes the IME first, Done/Cancel keys, password input, fallback keeps the text', async () => {
  const env = await setup({ ime: true });
  await openLive(env);
  env.press('back');
  env.press('up', 3);
  env.press('ok'); // Search -> system keyboard dialog
  assert.equal(env.router.overlay(), 'text-entry');
  await sleep(5);
  const input = env.layer().findAll('ss-ime__input')[0];
  assert.equal(input.attributes.type, 'text');
  assert.equal(env.doc.activeElement, input, 'input focused: the TV raises its keyboard');
  assert.equal(env.textInput.active, true);
  env.press('down');
  env.press('ok');
  assert.equal(env.router.overlay(), 'text-entry', 'arrows and OK go to the IME, not the app');
  env.press('back');
  assert.equal(env.textInput.active, false, 'first Back closes the IME only');
  assert.equal(env.router.overlay(), 'text-entry');
  assert.deepEqual(env.focused(), ['Done']);
  env.press('up');
  env.press('ok'); // field -> type again
  assert.equal(env.textInput.active, true);
  input.value = 'kids';
  input.dispatch('keydown', { keyCode: IME_DONE });
  assert.equal(env.router.overlay(), null);
  assert.deepEqual(rowNames(env), ['Kids Fun']);
  assert.equal(input.value, '', 'field cleared after use');
  // IME Cancel key, then the app keyboard fallback keeps what was typed.
  env.press('back');
  env.press('ok');
  await sleep(5);
  const input2 = env.layer().findAll('ss-ime__input')[0];
  input2.value = 'spo';
  input2.dispatch('keydown', { keyCode: IME_CANCEL });
  assert.equal(env.textInput.active, false);
  env.press('right');
  assert.deepEqual(env.focused(), ['On-screen keyboard']);
  env.press('ok');
  assert.equal(env.router.overlay(), 'keyboard');
  assert.match(env.layer().textContent, /spo▏/, 'fallback starts with the text typed so far');
  env.press('back');
  assert.equal(env.router.overlay(), null);
  // Password fields in the playlist form use a masked input; Back twice cancels without saving.
  env.router.resetTo('playlists');
  env.router.push('playlist-form', { mode: 'add-xtream' });
  env.press('down', 3);
  env.press('ok');
  await sleep(5);
  const pw = env.layer().findAll('ss-ime__input')[0];
  assert.equal(pw.attributes.type, 'password');
  assert.equal(pw.attributes.autocomplete, 'off');
  pw.value = 'secret1';
  env.press('back'); // close the IME; focus on Done
  // Show / Hide: the password is visible only on request.
  env.press('right');
  assert.deepEqual(env.focused(), ['Show']);
  env.press('ok');
  assert.equal(pw.attributes.type, 'text', 'Show reveals the password');
  assert.deepEqual(env.focused(), ['Hide']);
  env.press('ok');
  assert.equal(pw.attributes.type, 'password', 'Hide masks it again');
  env.press('ok'); // show again, then cancel: closing hides it again
  assert.equal(pw.attributes.type, 'text');
  env.press('back');
  assert.equal(env.router.overlay(), null);
  assert.equal(pw.attributes.type, 'password', 'closing the dialog hides the password again');
  assert.equal(pw.value, '', 'cancelled password cleared');
  assert.match(env.layer().textContent, /PasswordNot set/);
  assert.equal(JSON.stringify(env.log.entries()).includes('secret1'), false);
});

for (const n of [1000, 10000, 50000]) {
  test('performance with ' + n.toLocaleString('en') + ' channels: render, category switch, navigation, search, EPG', async () => {
    const heap0 = process.memoryUsage().heapUsed;
    const env = await setup({ m3u: makeM3u(n, 100), guide: makeGuide(Math.min(n, 2000), 26, Date.UTC(2025, 10, 23, 12, 15)) });
    const t0 = Date.now();
    env.router.push('live-tv', { playlistId: env.pl.id });
    await until(() => env.log.entries().some((e) => e.msg === 'live tv ready'), 60000, 'ready');
    const readyMs = Date.now() - t0;
    const guideT0 = Date.now();
    await until(() => env.epg.status().state === 'ready' && !env.epg.status().refreshing, 120000, 'guide');
    const guideMs = Date.now() - guideT0;
    const screen = env.layer();
    assert.equal(screen.findAll('ss-ch').length, 8, 'pooled rows: DOM size independent of the channel count');
    assert.equal(screen.findAll('is-focused').length, 1, 'one focus indicator');
    let m = Date.now();
    env.press('down', 200);
    const navMs = (Date.now() - m) / 200;
    env.press('back');
    m = Date.now();
    env.press('down');
    await until(() => rowNames(env)[1] === 'Channel 100', 2000, 'category switch: ' + JSON.stringify(rowNames(env).slice(0, 3)) + ' ' + (focusedCat(env) ? focusedCat(env).textContent : 'no cat focus'));
    const catMs = Date.now() - m - 150; // minus the 150 ms debounce
    assert.equal(env.layer().findAll('is-focused').length, 1, 'only the category is focused after the switch');
    env.press('up', 4);
    env.press('ok');
    const kl = keyboardLayout(env.t, 'text');
    const pos = () => Number(env.layer().findAll('is-focused')[0].attributes['data-key']);
    const goKey = (target) => { while (Math.floor(pos() / KEY_COLUMNS) < Math.floor(target / KEY_COLUMNS)) env.press('down'); while (pos() < target) env.press('right'); while (pos() > target) env.press('left'); };
    env.press(48 + 9); env.press(48 + 9);
    m = Date.now();
    goKey(kl.findIndex((x) => x.action === 'done')); env.press('ok');
    const searchMs = Date.now() - m;
    assert.ok(rowNames(env).length > 0);
    const heapMb = Math.round((process.memoryUsage().heapUsed - heap0) / 1048576);
    console.log('live ui [W] ' + n + ' channels: ready ' + readyMs + ' ms, guide refresh ' + guideMs + ' ms (' + env.epg.status().programmes + ' programmes), ' +
      'key ' + navMs.toFixed(2) + ' ms/press, category switch ' + catMs + ' ms, search ' + searchMs + ' ms, heap +' + heapMb + ' MB');
    assert.ok(navMs < 20, 'navigation handled in < 20 ms per key press');
  });
}

// ---------------------------------------------------------------- Stage 7E: mini live preview
const FULL_RECT = [0, 0, 1920, 1080];
const htmlPlaying = (env) => / ?ss-playing/.test(env.doc.body.className) && / ?ss-playing/.test(env.doc.documentElement.className);
const slot = (env) => env.layer().findAll('ss-preview')[0];
const ground = (env) => env.layer().findAll('ss-ground')[0];

test('Stage 7E preview: the focused channel plays in the slot after the focus rests; picture makes the slot a hole', async () => {
  const env = await setup({ preview: true });
  await openLive(env);
  assert.ok(slot(env), 'preview slot in the details column');
  assert.equal(env.layer().findAll('ss-info__logo').length, 0, 'the logo moved into the slot');
  await until(() => env.fe.loads().length === 1, 2000, 'preview load');
  assert.equal(env.fe.loads()[0].bufferSec, 2);
  const r = env.fe.rects[env.fe.rects.length - 1];
  assert.deepEqual([r[2], r[3]], [556, 313], 'video rectangle = slot');
  assert.equal(htmlPlaying(env), true, 'page transparent while the preview is active');
  assert.doesNotMatch(ground(env).className, /is-hidden/, 'ground strips repaint the background around the slot');
  assert.match(slot(env).textContent, /Loading preview/);
  env.fe.prepared();
  env.fe.picture();
  await sleep(10);
  assert.match(slot(env).className, /is-live/);
  assert.equal(env.lists.recent(env.pl.id).length, 0, 'a preview is not "recently watched"');
});

test('Stage 7E preview: rapid ↑↓ opens only the channel the focus rests on; every change stops the old stream first', async () => {
  const env = await setup({ preview: true });
  await openLive(env);
  await until(() => env.fe.loads().length === 1, 2000, 'first preview');
  env.fe.prepared();
  env.fe.picture();
  const before = env.fe.calls.length;
  env.press('down', 4);
  await sleep(400);
  const after = env.fe.calls.slice(before);
  assert.equal(after.filter((c) => c.op === 'load').length, 1, 'one load for 4 fast moves');
  assert.equal(after[0].op, 'stop', 'old stream stopped before the next one opens');
  assert.equal(env.fe.pendingUrl(), env.fe.loads()[1].url, 'the open load is the rested-on channel');
  assert.notEqual(env.fe.loads()[1].url, env.fe.loads()[0].url);
});

test('Stage 7E preview: OK hands the decoder to the full-screen player; Back resumes the preview; leaving releases everything', async () => {
  const env = await setup({ preview: true });
  await openLive(env);
  await until(() => env.fe.loads().length === 1, 2000, 'preview');
  env.fe.prepared();
  env.fe.picture();
  env.press('ok');
  assert.deepEqual(env.router.stack().slice(-1), ['player']);
  assert.deepEqual(env.fe.rects[env.fe.rects.length - 1], FULL_RECT, 'full-screen rectangle restored before the player opens');
  await until(() => env.fe.loads().length === 2, 2000, 'player load');
  env.fe.prepared();
  env.fe.picture();
  await sleep(20);
  assert.equal(env.fe.loads().length, 2, 'the stopped preview does not react to the player picture');
  assert.equal(env.lists.recent(env.pl.id).length, 1, 'the player records history');
  env.press('back');
  assert.deepEqual(env.router.stack().slice(-1), ['live-tv']);
  await until(() => env.fe.loads().length === 3, 2000, 'preview again');
  env.fe.prepared();
  env.fe.picture();
  await sleep(10);
  assert.match(slot(env).className, /is-live/);
  env.press('back'); // channels -> categories: the preview keeps playing
  assert.match(slot(env).className, /is-live/);
  env.router.push('diagnostics'); // another screen on top (Live TV is the root here, Back cannot leave)
  assert.deepEqual(env.fe.rects[env.fe.rects.length - 1], FULL_RECT);
  assert.equal(htmlPlaying(env), false, 'page opaque again');
  assert.equal(env.fe.calls[env.fe.calls.length - 1].op, 'stop', 'decoder released');
});

test('Stage 7E preview: a failed channel shows "Preview not available" and is not retried', async () => {
  const env = await setup({ preview: true });
  await openLive(env);
  await until(() => env.fe.loads().length === 1, 2000, 'preview');
  env.fe.failPrepare('connection');
  await sleep(300);
  assert.equal(env.fe.loads().length, 1, 'no reconnect loop while browsing');
  assert.match(slot(env).textContent, /Preview not available/);
  assert.equal(htmlPlaying(env), false, 'page opaque again after the failure');
});

test('Stage 7E preview: without the option the Live TV screen is unchanged (logo in the details, no playback while browsing)', async () => {
  const env = await setup();
  await openLive(env);
  await sleep(300);
  assert.equal(env.fe.loads().length, 0);
  assert.equal(env.layer().findAll('ss-preview').length, 0);
});

// ---------------------------------------------------------------- Stage 7F: no logo over the picture
const logoEl = (env) => slot(env).findAll('ss-preview__logo')[0];

test('Stage 7F preview: the logo disappears when the picture starts and stays hidden on re-renders; failure brings logo + message back', async () => {
  const env = await setup({ preview: true });
  await openLive(env);
  await until(() => env.fe.loads().length === 1, 2000, 'preview');
  assert.doesNotMatch(slot(env).className, /is-live/, 'loading: logo shown');
  assert.match(slot(env).textContent, /Loading preview/);
  assert.equal(logoEl(env).style.visibility || '', '', 'no inline visibility (it used to beat the is-live rule)');
  env.fe.prepared();
  env.fe.picture();
  await sleep(10);
  assert.match(slot(env).className, /is-live/, 'picture: logo and note hidden by the is-live class');
  // Re-render while live (focus to the actions and back re-renders the details).
  env.press('right');
  env.press('left');
  await sleep(200);
  assert.match(slot(env).className, /is-live/, 'still live after re-renders: no stale logo over the picture');
  assert.equal(logoEl(env).style.visibility || '', '');
  // Next channel: the old picture stops, the new logo shows until its picture starts.
  env.press('down');
  await sleep(200); // details re-render 120 ms after the focus move
  assert.doesNotMatch(slot(env).className, /is-live/, 'new channel: logo, not the old picture');
  await until(() => env.fe.loads().length === 2, 2000, 'next preview');
  env.fe.failPrepare('connection');
  await sleep(20);
  assert.doesNotMatch(slot(env).className, /is-live/);
  assert.match(slot(env).textContent, /Preview not available/, 'failure: logo + message');
});

test('Stage 7F preview: a channel without a logo gets the no-logo class (empty box, no broken image)', async () => {
  const m3u = '#EXTM3U\n#EXTINF:-1 tvg-id="a" group-title="G",No Logo One\nhttp://s.example/live/1.ts\n#EXTINF:-1 tvg-id="b" group-title="G",No Logo Two\nhttp://s.example/live/2.ts\n';
  const env = await setup({ preview: true, m3u });
  await openLive(env);
  await until(() => env.fe.loads().length === 1, 2000, 'preview');
  assert.match(slot(env).className, /no-logo/);
  env.fe.prepared();
  env.fe.picture();
  await sleep(10);
  assert.match(slot(env).className, /is-live/);
});
