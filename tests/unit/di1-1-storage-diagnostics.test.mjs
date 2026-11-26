// DI-1.1: read-only storage diagnostics (Settings → Diagnostics). Real start-up and screen, fake
// stores that count every write. Disposable fake data only; no network, no TV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppContext, startApp } from '../../src/app/bootstrap.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { createMemoryFileStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { BACKUP_FILE } from '../../src/services/playlist-service.ts';
import { createFakePlatform } from '../fakes/fake-platform.mjs';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';

const LIST = 'ss:v1:playlists';
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) { await tick(); } };
const SECRET = { host: 'secret-host.invalid', user: 'user-xyz', pass: 'pass-123-secret' };

/** Persistent stores shared by every start; every write and removal is counted. */
function stores() {
  const ls = createMemoryLocalStore();
  const fs = createMemoryFileStore();
  const c = { lsWrites: 0, fsWrites: 0, failRead: null };
  const localStore = {
    getItem: (k) => ls.getItem(k),
    setItem: (k, v) => { c.lsWrites++; ls.setItem(k, v); },
    removeItem: (k) => { c.lsWrites++; ls.removeItem(k); },
    keys: () => ls.keys()
  };
  const fileStore = {
    atomicReplace: true,
    read: (n) => (c.failRead && c.failRead(n) ? Promise.reject(new Error('io error')) : fs.read(n)),
    write: (n, t) => { c.fsWrites++; return fs.write(n, t); },
    remove: (n) => { c.fsWrites++; return fs.remove(n); },
    list: () => fs.list()
  };
  return { ls, fs, c, localStore, fileStore };
}

async function start(s) {
  const fp = createFakePlatform({ localStore: s.localStore, fileStore: s.fileStore });
  const clk = createFakeClock();
  const ctx = createAppContext({ platform: fp.platform, build: { mode: 'test', version: 'di11', devSinkUrl: '' }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  await ctx.playlists.whenChecked();
  await settle();
  return { ctx, fp, clk };
}

async function seeded() {
  const s = stores();
  const { ctx } = await start(s);
  const r = await ctx.playlists.add({ kind: 'xtream', name: 'Mine', server: 'http://' + SECRET.host + ':8080', username: SECRET.user, password: SECRET.pass });
  assert.equal(r.ok, true);
  await settle();
  return { s, id: r.playlist.id };
}

function readScreen(doc) {
  const pairs = {};
  for (const dl of doc.body.findAll('ss-details')) {
    const kids = dl.childNodes;
    for (let i = 0; i + 1 < kids.length; i += 2) { pairs[kids[i].textContent] = kids[i + 1].textContent; }
  }
  const rows = doc.body.findAll('ss-log__line').map((n) => n.textContent);
  return { pairs, rows, text: doc.body.textContent };
}

/** Opens Settings → Diagnostics and returns a reader for its label → value pairs, rows and text. */
async function openDiagnostics(env) {
  const doc = createFakeDocument();
  const app = startApp(env.ctx, createDomHost(doc, doc.body), doc, env.clk.now);
  await settle();
  app.router.push('settings');
  await settle();
  for (let i = 0; i < 40 && !/Diagnostics/.test(doc.body.textContent); i++) { env.fp.press(40); } // scroll down the list
  assert.match(doc.body.textContent, /Diagnostics/, 'reachable from Settings');
  app.router.push('diagnostics');
  await settle();
  return { doc, app, read: () => readScreen(doc) };
}

async function pressRefresh(env, screen) {
  env.fp.press(13); // OK on the focused first button: Refresh
  await settle();
  return screen.read();
}

test('1. a valid backup is shown as valid, with its validated count and a passed integrity check', async () => {
  const { s } = await seeded();
  const env = await start(s);
  const v = (await openDiagnostics(env)).read();
  assert.equal(v.pairs['Storage state'], 'Healthy');
  assert.equal(v.pairs['Backup'], 'Valid');
  assert.equal(v.pairs['Playlists in the validated backup'], '1');
  assert.equal(v.pairs['Backup integrity check'], 'Passed (count and checksum match)');
  assert.notEqual(v.pairs['Last successful backup'], 'UNKNOWN', 'time of the backup-written event');
});

test('2. a missing backup is shown as missing (no count, no checksum claimed)', async () => {
  const { s } = await seeded();
  const env = await start(s);
  await s.fs.remove(BACKUP_FILE); // after start-up (which would rewrite it), before opening the screen
  const v = (await openDiagnostics(env)).read();
  assert.equal(v.pairs['Backup'], 'Missing');
  assert.equal(v.pairs['Playlists in the validated backup'], 'UNKNOWN');
  assert.equal(v.pairs['Backup integrity check'], 'UNKNOWN');
});

test('3. a corrupt backup is never shown as valid', async () => {
  const { s } = await seeded();
  const env = await start(s);
  const good = await s.fs.read(BACKUP_FILE);
  await s.fs.write(BACKUP_FILE, good.replace('"count":1', '"count":2')); // count no longer matches
  let v = (await openDiagnostics(env)).read();
  assert.equal(v.pairs['Backup'], 'Invalid');
  assert.equal(v.pairs['Backup integrity check'], 'FAILED');
  assert.equal(v.pairs['Playlists in the validated backup'], 'UNKNOWN');
  await s.fs.write(BACKUP_FILE, good.slice(0, good.length - 7)); // truncated
  v = (await openDiagnostics(env)).read();
  assert.equal(v.pairs['Backup'], 'Invalid');
  assert.doesNotMatch(v.text, /Passed \(count and checksum match\)/);
});

test('4. an unreadable backup is shown as unreadable, integrity UNKNOWN', async () => {
  const { s } = await seeded();
  const env = await start(s);
  s.c.failRead = (n) => n === BACKUP_FILE;
  const v = (await openDiagnostics(env)).read();
  assert.equal(v.pairs['Backup'], 'Unreadable');
  assert.equal(v.pairs['Backup integrity check'], 'UNKNOWN');
  assert.equal(v.pairs['Playlists in the validated backup'], 'UNKNOWN');
});

test('5. the playlist count comes from validated data only', async () => {
  const { s } = await seeded();
  const env = await start(s);
  const second = await env.ctx.playlists.add({ kind: 'xtream', name: 'Two', server: 'http://two.invalid:8080', username: 'a', password: 'b' });
  assert.equal(second.ok, true);
  await settle();
  // One of the two entries becomes invalid: only the valid one is counted.
  const e = JSON.parse(s.ls.getItem(LIST));
  e.d[0].server = 'not a server';
  s.ls.setItem(LIST, JSON.stringify(e));
  let v = (await openDiagnostics(await start(s))).read();
  assert.equal(v.pairs['Playlists in the validated list'], '1');
  assert.equal(v.pairs['Storage state'], 'Protected (partial)');
  // An unreadable list: no count is claimed.
  s.ls.setItem(LIST, '{"v":1,"d":[{"id":"pm');
  v = (await openDiagnostics(await start(s))).read();
  assert.equal(v.pairs['Playlists in the validated list'], 'UNKNOWN');
  assert.equal(v.pairs['Storage state'], 'Protected (corrupt)');
});

test('6. storage events are listed (newest first) without sensitive information', async () => {
  const { s } = await seeded();
  s.ls.setItem(LIST, 'garbage');
  const env = await start(s);
  await env.ctx.playlists.recover();
  const v = (await openDiagnostics(env)).read();
  const events = v.rows.filter((r) => /^\d{4}-\d\d-\d\d \d\d:\d\d  /.test(r));
  assert.ok(events.length >= 3, 'events shown with date and time');
  assert.ok(events.some((r) => /  pl-protected  /.test(r)));
  assert.ok(events.some((r) => /  backup-written  /.test(r)));
  assert.match(v.text, /Recent storage events \(\d+\)/);
  for (const secret of [SECRET.host, SECRET.user, SECRET.pass, 'http', 'garbage']) {
    assert.equal(v.text.includes(secret), false, 'not on screen: ' + secret);
  }
  assert.ok(events.length <= 60);
});

test('7 + 8. opening and refreshing the screen writes nothing and triggers no recovery or cleanup', async () => {
  // Healthy device with a leftover temp file: start-up cleanup would delete it if it ran again.
  const { s, id } = await seeded();
  const env = await start(s);
  await s.fs.write('cat.' + id + '.live.json.tmp', 'half');
  const before = { ls: s.c.lsWrites, fs: s.c.fsWrites, diag: env.ctx.diag.entries().length, list: s.ls.getItem(LIST), files: (await s.fs.list()).join(',') };
  const screen = await openDiagnostics(env);
  await pressRefresh(env, screen);
  await pressRefresh(env, screen);
  assert.equal(s.c.lsWrites, before.ls, 'no localStorage write or removal');
  assert.equal(s.c.fsWrites, before.fs, 'no file write or removal (no backup, no cleanup, no diagnostics write)');
  assert.equal(env.ctx.diag.entries().length, before.diag, 'no event recorded by viewing');
  assert.equal(s.ls.getItem(LIST), before.list);
  assert.equal((await s.fs.list()).join(','), before.files, 'temp file still there: cleanup did not run');

  // Protected device: viewing does not quarantine, restore, continue or clean up.
  s.ls.setItem(LIST, '{"v":1,"d":[');
  const p = await start(s);
  const state0 = JSON.stringify(p.ctx.playlists.storageState());
  const b2 = { ls: s.c.lsWrites, fs: s.c.fsWrites, diag: p.ctx.diag.entries().length, files: (await s.fs.list()).join(',') };
  const sc2 = await openDiagnostics(p);
  const v = await pressRefresh(p, sc2);
  assert.equal(v.pairs['Storage state'], 'Protected (corrupt)');
  assert.equal(s.c.lsWrites, b2.ls);
  assert.equal(s.c.fsWrites, b2.fs);
  assert.equal(p.ctx.diag.entries().length, b2.diag);
  assert.equal((await s.fs.list()).join(','), b2.files);
  assert.equal(JSON.stringify(p.ctx.playlists.storageState()), state0, 'still protected: no recovery happened');
  assert.equal(s.ls.getItem(LIST), '{"v":1,"d":[', 'damaged value untouched');
});

test('read errors are reported as unavailable, never as healthy', async () => {
  const { s } = await seeded();
  const orig = s.localStore.getItem;
  s.localStore.getItem = (k) => { if (k === LIST) { throw new Error('read failed'); } return orig(k); };
  const v = (await openDiagnostics(await start(s))).read();
  assert.equal(v.pairs['Storage state'], 'Unavailable (read-error)');
  assert.equal(v.pairs['Playlists in the validated list'], 'UNKNOWN');
});

test('layout (TV fix): actions first, playlist storage before the platform facts, the rest scrolls with ▲▼', async () => {
  const { s } = await seeded();
  const env = await start(s);
  const sc = await openDiagnostics(env);
  const shell = sc.doc.body.findAll('ss-shell')[0];
  const order = shell.childNodes.map((n) => n.className);
  assert.deepEqual(order, ['ss-header', 'ss-diag-actions', 'ss-diag-scroll'], 'buttons above the scrolling area');
  const inner = sc.doc.body.findAll('ss-diag-scroll__inner')[0];
  const first = inner.childNodes[0];
  assert.equal(first.className, 'ss-diag-top');
  assert.match(first.textContent, /^Playlist storage/, 'storage is the first thing in the content');
  assert.match(first.textContent, /BackupValid/);
  const plat = inner.childNodes[1].textContent;
  assert.match(plat, /Platform/, 'platform facts after it');
  // ▼ scrolls the content (sizes as a TV would report them), ▲ returns; never past the ends.
  const viewport = sc.doc.body.findAll('ss-diag-scroll')[0];
  viewport.offsetHeight = 820;
  inner.offsetHeight = 2000;
  const before = s.c.lsWrites + s.c.fsWrites;
  env.fp.press(40);
  assert.equal(inner.style.top, '-300px');
  for (let i = 0; i < 10; i++) { env.fp.press(40); }
  assert.equal(inner.style.top, '-1180px', 'stops at the end');
  for (let i = 0; i < 10; i++) { env.fp.press(38); }
  assert.equal(inner.style.top, '0px', 'back at the top');
  assert.equal(s.c.lsWrites + s.c.fsWrites, before, 'scrolling writes nothing');
});
