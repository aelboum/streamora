// Playlist management UI (Stage 4B), driven only by remote-control key codes through the real
// key router and screen router, against the real PlaylistService (memory stores, fake HTTP server)
// and a fake DOM. Covers creation, editing, deletion, import progress and cancellation, the HTTP
// warning, error handling, remote navigation, focus indicators and credential hygiene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRouter } from '../../src/navigation/router.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { registerPlaylistScreens } from '../../src/screens/playlist-screens.ts';
import { keyboardLayout, KEY_COLUMNS } from '../../src/screens/keyboard-overlay.ts';
import { createTranslator, missingTranslations } from '../../src/i18n/strings.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeServer } from '../fakes/fake-http-server.mjs';

const m3u = (name) => readFileSync(new URL('../fixtures/m3u/' + name, import.meta.url), 'utf8');
const PASS = 'demo_pass_9f3k';
const KEY = { left: 37, up: 38, right: 39, down: 40, ok: 13, back: 10009 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, what) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(5);
  }
}

function bigPlaylist(n) {
  const parts = ['#EXTM3U\n'];
  for (let i = 0; i < n; i++) {
    parts.push('#EXTINF:-1 tvg-id="ch' + i + '" tvg-logo="http://logos.example.org/' + (i % 500) + '.png" group-title="Group ' + (i % 120) + '",Channel ' + i +
      '\nhttp://provider.example:8080/demo_user/' + PASS + '/' + (100000 + i) + '\n');
  }
  return parts.join('');
}

function setup(route) {
  const local = createMemoryLocalStore();
  const files = createMemoryFileStore();
  const keys = createMemoryKeyStore();
  const log = createLogger(2000);
  const kv = createKeyValueStore(local, log);
  const srv = createFakeServer((url, n) => route.fn(url, n));
  const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
  const svc = createPlaylistService({
    kv, catalogue: createCatalogueStore(files, { budgetChars: 5000000, maxChars: 20000000 }, Date.now, log),
    secrets: createSecretStore(keys), http: createHttpClient({ xhrFactory: srv.factory }), now: Date.now, log: log.child('playlists'),
    timers, retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 120000 }
  });
  const doc = createFakeDocument();
  const t = createTranslator('en');
  const router = createRouter(createDomHost(doc, doc.body), log.child('router'));
  router.register('diagnostics', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
  registerPlaylistScreens(router, { doc, playlists: svc, t, now: Date.now, ...timers });
  let exits = 0;
  router.setRootBackHandler(() => { exits++; });
  let clock = 0;
  const keyRouter = createKeyRouter({ now: () => (clock += 200), throttleMs: 110, allowBrowserKeys: false, dispatch: (e) => router.handleKey(e) });
  const ev = (code) => ({ keyCode: code, preventDefault() {} });
  function press(name, times = 1) {
    for (let i = 0; i < times; i++) {
      const code = typeof name === 'number' ? name : KEY[name];
      keyRouter.keyDown(ev(code));
      keyRouter.keyUp(ev(code));
    }
  }
  function layer() {
    const layers = doc.body.childNodes.filter((n) => n.style.display !== 'none');
    return layers[layers.length - 1];
  }
  function focusedText() {
    const f = layer().findAll('is-focused');
    return f.length ? f[f.length - 1].textContent : null;
  }
  const keyPos = () => Number(layer().findAll('is-focused')[0].attributes['data-key']);
  /** Moves the keyboard focus to a key with the arrow keys. */
  function goKey(target) {
    const tr = Math.floor(target / KEY_COLUMNS);
    while (Math.floor(keyPos() / KEY_COLUMNS) < tr) press('down');
    while (Math.floor(keyPos() / KEY_COLUMNS) > tr) press('up');
    while (keyPos() < target) press('right');
    while (keyPos() > target) press('left');
    assert.equal(keyPos(), target);
  }
  /** Types text on the on-screen keyboard (arrows + OK; digits via the remote digit keys), then Done. */
  function type(text, mode) {
    const kl = keyboardLayout(t, mode);
    const find = (s) => kl.findIndex((k) => k.action === 'char' && k.text === s);
    let i = 0;
    while (i < text.length) {
      const helper = ['https://', 'http://'].find((hh) => text.startsWith(hh, i) && find(hh) >= 0);
      if (helper) { goKey(find(helper)); press('ok'); i += helper.length; continue; }
      const ch = text.charAt(i);
      if (/[0-9]/.test(ch)) { press(48 + Number(ch)); i++; continue; }
      const k = ch === ' ' ? kl.findIndex((kk) => kk.action === 'space') : find(ch);
      assert.ok(k >= 0, 'key for ' + ch);
      goKey(k);
      press('ok');
      i++;
    }
    goKey(kl.findIndex((k) => k.action === 'done'));
    press('ok');
  }
  async function persisted() {
    const names = await files.list();
    return local.keys().map((k) => local.getItem(k)).join('\n') + names.map((n) => files.peek(n)).join('\n') + JSON.stringify(log.entries());
  }
  router.resetTo('playlists');
  return { svc, srv, doc, router, press, layer, focusedText, type, goKey, keyPos, log, files, keys, persisted, t, exits: () => exits };
}

const bodyText = (env) => env.doc.body.textContent;

test('translations: every string exists in English and Dutch', () => {
  assert.deepEqual(missingTranslations(), []);
  const nl = createTranslator('nl');
  assert.equal(nl('playlists.addM3u'), 'M3U-lijst toevoegen');
  assert.equal(nl('import.done', { channels: 5, categories: 2, s: 1 }), 'Bijgewerkt: 5 zenders in 2 categorieën (1 s).');
});

test('overview: empty state, remote navigation, one focus indicator, Back reaches the exit handler', () => {
  const env = setup({ fn: () => ({ status: 404 }) });
  assert.match(bodyText(env), /No playlists yet/);
  // Adding an account is on the home screen; this list has no Add buttons.
  assert.equal(/Add M3U playlist|Add Xtream account/.test(bodyText(env)), false);
  assert.equal(env.focusedText(), 'Diagnostics');
  env.press('right');
  assert.equal(env.focusedText(), 'Diagnostics', 'no wrap past the last item');
  env.press('down');
  assert.equal(env.focusedText(), 'Diagnostics', 'empty list: focus stays put');
  assert.equal(env.layer().findAll('is-focused').length, 1);
  env.press('back');
  assert.equal(env.exits(), 1);
  env.press('ok');
  assert.deepEqual(env.router.stack(), ['playlists', 'diagnostics']);
  env.press('back');
  assert.deepEqual(env.router.stack(), ['playlists']);
});

test('add M3U with the on-screen keyboard, HTTP warning, import, details; no credential exposed', async () => {
  const env = setup({ fn: () => ({ status: 200, body: m3u('provider-extended.m3u'), chunk: 300 }) });
  env.router.push('playlist-form', { mode: 'add-m3u' }); // home → Add account → M3U playlist
  assert.deepEqual(env.router.stack(), ['playlists', 'playlist-form']);
  env.press('ok'); // Name -> keyboard
  assert.equal(env.router.overlay(), 'keyboard');
  env.type('home tv', 'text');
  assert.equal(env.router.overlay(), null);
  env.press('down');
  env.press('ok'); // URL
  env.type('http://provider.example:8080/get.php?username=demo_user&password=' + PASS, 'url');
  const formText = env.layer().textContent;
  assert.match(formText, /home tv/);
  assert.match(formText, /password=•••/, 'credential part masked on the form');
  assert.equal(formText.includes(PASS), false);
  env.press('down', 3); // EPG, format, then buttons
  assert.equal(env.focusedText(), 'Save');
  env.press('ok');
  // A get.php link is an Xtream login: the form offers to add it as Xtream; this test keeps M3U.
  assert.equal(env.router.overlay(), 'confirm');
  assert.match(env.layer().textContent, /This is an Xtream link/);
  assert.equal(env.focusedText(), 'Add as Xtream account');
  env.press('right');
  assert.equal(env.focusedText(), 'Keep as M3U');
  env.press('ok');
  await until(() => env.router.overlay() === 'confirm', 2000, 'HTTP warning');
  assert.deepEqual(env.router.stack(), ['playlists', 'playlist-details']);
  assert.match(env.layer().textContent, /Unencrypted connection/);
  assert.equal(env.focusedText(), 'Cancel', 'safe choice focused first');
  env.press('right');
  env.press('ok'); // Continue
  assert.equal(env.router.overlay(), 'import-dialog');
  await until(() => /Updated: 10 channels in 8 categories/.test(env.layer().textContent), 10000, 'import result');
  assert.equal(env.focusedText(), 'Close', 'the new Close button is shown focused (phone taps rely on it)');
  env.press('ok'); // Close
  assert.equal(env.router.overlay(), null);
  await until(() => /Live channels/.test(bodyText(env)), 2000, 'details metadata');
  assert.match(bodyText(env), /http:\/\/provider\.example:8080/);
  assert.match(bodyText(env), /Movies \/ series entries/);
  assert.equal(bodyText(env).includes(PASS), false, 'password never rendered');
  assert.equal((await env.persisted()).includes(PASS), false, 'password not in localStorage, files or logs');
  env.press('back');
  assert.match(bodyText(env), /home tv/);
  assert.match(bodyText(env), /Active/);
  assert.equal(env.svc.needsCleartextNotice(env.svc.list()[0].id), false, 'warning acknowledged once');
});

test('add Xtream: password masked while typing and on the form; https server shows no warning', async () => {
  const env = setup({ fn: () => ({ status: 404 }) });
  env.router.push('playlist-form', { mode: 'add-xtream' }); // home → Add account → Xtream account
  assert.match(bodyText(env), /Add Xtream account/);
  env.press('ok'); env.type('xt', 'text');
  env.press('down'); env.press('ok'); env.type('https://panel.example.org', 'url');
  env.press('down'); env.press('ok'); env.type('demo_user', 'text');
  env.press('down'); env.press('ok');
  env.goKey(keyboardLayout(env.t, 'secret').findIndex((k) => k.text === 'p'));
  env.press('ok');
  env.press('left');
  env.press('ok'); // "po" (o is left of p)
  assert.match(env.layer().textContent, /••▏/, 'secret value shown as dots while typing');
  assert.equal(env.layer().textContent.includes('po▏'), false);
  env.type('', 'secret');
  assert.match(env.layer().textContent, /Password••/, 'form shows dots for the password');
  env.press('down', 3);
  env.press('ok'); // Save
  await until(() => env.router.stack()[1] === 'playlist-details', 2000, 'details');
  await until(() => env.router.overlay() === 'import-dialog', 2000, 'import without a warning');
  await until(() => /The update failed/.test(env.layer().textContent), 5000, 'error shown');
  assert.match(env.layer().textContent, /server answered with an error/);
  assert.match(await env.keys.load('ss_pl_' + env.svc.list()[0].id), /"username":"demo_user","password":"po"/);
});

test('edit: credentials are never pre-filled; changing only the name keeps the secret; validation errors shown', async () => {
  const env = setup({ fn: () => ({ status: 404 }) });
  const r = await env.svc.add({ name: 'Old', kind: 'xtream', server: 'http://panel.example:8080', username: 'demo_user', password: PASS });
  env.router.push('playlist-details', { id: r.playlist.id });
  env.press('right');
  env.press('ok'); // Edit
  assert.deepEqual(env.router.stack(), ['playlists', 'playlist-details', 'playlist-form']);
  const text = env.layer().textContent;
  assert.match(text, /Edit playlist/);
  assert.match(text, /UsernameUnchanged/);
  assert.match(text, /PasswordUnchanged/);
  assert.equal(text.includes('demo_user'), false);
  env.press('ok'); // Name -> keyboard pre-filled with the name (not a credential)
  assert.match(env.layer().textContent, /Old▏/);
  env.type('x', 'text');
  env.press('down', 6); // name, server, username, password, EPG, format -> Save
  assert.equal(env.focusedText(), 'Save');
  env.press('ok');
  await until(() => env.router.stack().length === 2, 2000, 'back to details');
  assert.equal(env.svc.get(r.playlist.id).name, 'Oldx');
  assert.match(await env.keys.load('ss_pl_' + r.playlist.id), new RegExp(PASS), 'secret untouched');
  // Clear the name with the Delete key: the service refuses and the message is shown.
  env.press('ok');
  env.press('ok');
  env.goKey(10); // Delete
  env.press('ok', 4);
  env.type('', 'text');
  env.press('down', 6);
  env.press('ok');
  await until(() => /Enter a name/.test(env.layer().textContent), 2000, 'validation message');
  assert.equal(env.svc.get(r.playlist.id).name, 'Oldx');
});

test('remove: confirmation defaults to Cancel; Remove deletes definition, secret and files', async () => {
  const env = setup({ fn: () => ({ status: 200, body: m3u('provider-extended.m3u') }) });
  const r = await env.svc.add({ name: 'Gone', kind: 'm3u', url: 'https://secure.example.org/get.php?username=demo_user&password=' + PASS });
  await env.svc.refresh(r.playlist.id).result;
  assert.equal((await env.files.list()).length, 2);
  env.router.push('playlist-details', { id: r.playlist.id });
  env.press('right', 3);
  assert.equal(env.focusedText(), 'Remove');
  env.press('ok');
  assert.equal(env.router.overlay(), 'confirm');
  assert.match(env.layer().textContent, /Remove “Gone”\?/);
  env.press('ok'); // Cancel (default)
  assert.equal(env.svc.list().length, 1);
  env.press('ok'); // Remove again
  env.press('right');
  env.press('ok'); // confirm
  await until(() => env.router.stack().length === 1, 2000, 'back to overview');
  assert.equal(env.svc.list().length, 0);
  assert.deepEqual(await env.files.list(), []);
  assert.equal(await env.keys.load('ss_pl_' + r.playlist.id), null);
  assert.match(bodyText(env), /No playlists yet/);
});

test('HTTP warning: Cancel starts nothing; https playlists never show it', async () => {
  const env = setup({ fn: () => ({ status: 200, body: m3u('provider-extended.m3u') }) });
  const hp = await env.svc.add({ name: 'H', kind: 'm3u', url: 'http://provider.example:8080/list.m3u' });
  env.router.push('playlist-details', { id: hp.playlist.id });
  env.press('ok'); // Update now
  assert.equal(env.router.overlay(), 'confirm');
  env.press('ok'); // Cancel
  assert.equal(env.router.overlay(), null);
  await sleep(20);
  assert.equal(env.srv.requests.length, 0, 'no request before the user accepts');
  assert.equal(env.svc.needsCleartextNotice(hp.playlist.id), true);
  env.press('back');
  const s = await env.svc.add({ name: 'S', kind: 'm3u', url: 'https://secure.example.org/list.m3u' });
  env.router.push('playlist-details', { id: s.playlist.id });
  env.press('ok');
  assert.equal(env.router.overlay(), 'import-dialog');
});

test('import errors are shown in plain language with Try again; retry runs again', async () => {
  const route = { fn: () => ({ fail: 'network' }) };
  const env = setup(route);
  const r = await env.svc.add({ name: 'E', kind: 'm3u', url: 'https://secure.example.org/list.m3u' });
  env.router.push('playlist-details', { id: r.playlist.id });
  env.press('ok');
  await until(() => /The update failed/.test(env.layer().textContent), 5000, 'network error');
  assert.match(env.layer().textContent, /can’t be reached/);
  route.fn = () => ({ status: 200, body: '<html>login</html>' });
  env.press('right');
  assert.equal(env.focusedText(), 'Try again');
  env.press('ok');
  await until(() => /didn’t return an M3U playlist/.test(env.layer().textContent), 5000, 'not-playlist error');
  route.fn = () => ({ status: 200, body: m3u('provider-extended.m3u') });
  env.press('right');
  env.press('ok');
  await until(() => /Updated: 10 channels/.test(env.layer().textContent), 5000, 'success after retry');
  env.press('ok');
  await until(() => /Live channels/.test(bodyText(env)), 2000, 'details updated');
});

test('50,000-channel import: progress updates, UI stays responsive, cancellation keeps the previous list', async () => {
  const big = bigPlaylist(50000);
  // Parsing inside a single XHR event would block the UI for the whole list; the slicer must break it up.
  const route = { fn: () => ({ status: 200, body: big, chunk: big.length }) }; // worst case: the whole list in one progress event
  const env = setup(route);
  const r = await env.svc.add({ name: 'Big', kind: 'm3u', url: 'https://secure.example.org/get.php?username=demo_user&password=' + PASS });
  env.router.push('playlist-details', { id: r.playlist.id });

  // Event-loop lag probe: how late does a 10 ms timer fire while the import runs?
  let maxLag = 0;
  let last = Date.now();
  const probe = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 10); last = n; }, 10);

  const t0 = Date.now();
  env.press('ok'); // Update now (https: no warning)
  await until(() => /Reading playlist: [0-9.]+ MB, [1-9]/.test(env.layer().textContent), 20000, 'progress text');
  const progressText = env.layer().textContent;
  assert.equal(env.focusedText(), 'Cancel update', 'focus on Cancel while running');
  await until(() => /Updated: 50000 channels/.test(env.layer().textContent), 60000, 'import done');
  const importMs = Date.now() - t0;
  const lagFull = maxLag;
  env.press('ok'); // Close

  // Second run with a changed list, cancelled once progress is visible.
  maxLag = 0;
  route.fn = () => ({ status: 200, body: big.replace(',Channel 1\n', ',Channel One\n'), chunk: 65536 });
  env.press('ok');
  await until(() => /Reading playlist: [0-9.]+ MB, [1-9]/.test(env.layer().textContent), 20000, 'progress (2nd run)');
  const tCancel = Date.now();
  env.press('back'); // Back = cancel while running
  assert.equal(env.router.overlay(), 'import-dialog', 'dialog stays to show the outcome');
  await until(() => /Update cancelled/.test(env.layer().textContent), 5000, 'cancelled');
  const cancelMs = Date.now() - tCancel;
  clearInterval(probe);
  env.press('ok');
  const l = await env.svc.loadLive(r.playlist.id);
  assert.equal(l.status, 'ok');
  assert.equal(l.catalogue.channels.length, 50000, 'the completed list is kept after the cancelled run');
  assert.equal(l.catalogue.channels[1].name, 'Channel 1', 'cancelled changes were not saved');
  assert.equal(env.svc.importing(), null);
  assert.match(progressText, /Reading playlist: \d+\.\d MB, \d+ channels/);
  console.log('ui import [W]: 50,000 channels in ' + importMs + ' ms; max event-loop lag ' + lagFull + ' ms (full run), ' + maxLag +
    ' ms (cancel run); cancel acknowledged in ' + cancelMs + ' ms; heap ' + Math.round(process.memoryUsage().heapUsed / 1048576) + ' MB');
  assert.ok(lagFull < 150, 'parsing is time-sliced: the event loop is never blocked for long (' + lagFull + ' ms)');
});

test('CP2 F12: an unexpected save failure shows the storage message instead of staying on "Saving…"', async () => {
  const env = setup({ fn: () => ({ status: 404 }) });
  env.svc.add = () => Promise.reject(new TypeError('Cannot read properties of undefined (reading \u0027length\u0027)'));
  env.router.push('playlist-form', { mode: 'add-xtream' }); // home → Add account → Xtream account
  assert.match(bodyText(env), /Add Xtream account/);
  env.press('down', 6);
  assert.equal(env.focusedText(), 'Save');
  env.press('ok'); // Save
  await until(() => /couldn’t be saved on this TV/.test(env.layer().textContent), 2000, 'storage message');
  assert.equal(env.layer().textContent.includes('Saving…'), false, 'no longer stuck on Saving…');
  assert.equal(env.layer().textContent.includes('reading'), false, 'no technical error details shown');
  assert.equal(env.router.stack().length, 2, 'the form stays open so the user can retry or cancel');
});

test('import errors show the HTTP status number, never any other part of the message', async () => {
  const { httpStatusSuffix } = await import('../../src/screens/format.ts');
  assert.equal(httpStatusSuffix('http', 'HTTP 512'), ' (HTTP 512)');
  assert.equal(httpStatusSuffix('auth', 'HTTP 403'), ' (HTTP 403)');
  assert.equal(httpStatusSuffix('network', 'HTTP 500'), '');
  assert.equal(httpStatusSuffix('http', 'HTTP 404 http://h/get.php?password=secret'), '');
  assert.equal(httpStatusSuffix('http', undefined), '');
});
