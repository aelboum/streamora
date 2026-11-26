// DI-1: playlist data integrity. Fault injection over the real app start-up (createAppContext) with
// one set of persistent fake stores shared by every "start" (an upgrade install keeps localStorage,
// files and the key store). Disposable fake data only; no network, no TV.
// Every scenario checks the playlist list AND the catalogue files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppContext } from '../../src/app/bootstrap.ts';
import { createWebCrypto } from '../../src/app/platform/common.ts';
import { BACKUP_FILE, BACKUP_KEEP_FILE } from '../../src/services/playlist-service.ts';
import { DIAG_FILE } from '../../src/storage/diag-log.ts';

const P = 'ss:v1:';
const LIST = P + 'playlists';
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 6; i++) { await tick(); } };

function device() {
  const ls = new Map();
  const files = new Map();
  const keys = new Map();
  const f = { readThrow: null, writeThrow: null, fileWriteFail: null, mem: 220, noLocal: false };
  const localStore = {
    getItem(k) { if (f.readThrow && f.readThrow(k)) { throw new Error('storage read failed'); } return ls.has(k) ? ls.get(k) : null; },
    setItem(k, v) { if (f.writeThrow && f.writeThrow(k)) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } ls.set(k, String(v)); },
    removeItem(k) { ls.delete(k); },
    keys() { return Array.from(ls.keys()); }
  };
  const fileStore = {
    atomicReplace: true,
    read: (n) => Promise.resolve(files.has(n) ? files.get(n) : null),
    write: (n, t) => (f.fileWriteFail && f.fileWriteFail(n) ? Promise.reject(new Error('disk')) : (files.set(n, t), Promise.resolve())),
    remove: (n) => { files.delete(n); return Promise.resolve(); },
    list: () => Promise.resolve(Array.from(files.keys()).sort())
  };
  const keyStore = {
    persistent: true,
    save: (a, v) => { keys.set(a, String(v)); return Promise.resolve(); },
    load: (a) => Promise.resolve(keys.has(a) ? keys.get(a) : null),
    remove: (a) => { keys.delete(a); return Promise.resolve(); }
  };
  return { ls, files, keys, f, localStore, fileStore, keyStore };
}

let clock = Date.parse('2026-11-24T09:48:41Z');
async function start(d) {
  const platform = {
    name: 'tizen',
    info: () => ({ name: 'tizen', platformVersion: '3.0', width: 1920, height: 1080, userAgent: 'test' }),
    capabilities: () => ({ appLifecycle: true, keyRegistration: true, avplay: false, fileStore: true, secureKeyStore: true, webCrypto: true }),
    memory: () => ({ availableMB: d.f.mem, totalMB: 1295 }),
    exit() {}, onVisibilityChange: () => () => {}, onNetworkChange: () => () => {},
    keys: { registerKeys: (n) => n.slice(), onKeyDown: () => () => {}, onKeyUp: () => () => {} },
    localStore: d.f.noLocal ? null : d.localStore,
    fileStore: d.fileStore,
    keyStore: d.keyStore,
    crypto: createWebCrypto(globalThis.crypto),
    xhrFactory: () => { throw new Error('no network in tests'); }
  };
  const ctx = createAppContext({
    platform, build: { mode: 'test', version: 'di1', devSinkUrl: '' },
    now: () => (clock += 1000), setTimer: () => 0, clearTimer: () => {}
  });
  await ctx.playlists.whenChecked();
  await settle();
  return ctx;
}

const XT = (name, host) => ({ kind: 'xtream', name, server: 'http://' + host + ':8080', username: 'u-' + name, password: 'p-secret-' + name });
const CAT = (id) => ['cat.' + id + '.meta.json', 'cat.' + id + '.live.json', 'cat.' + id + '.movie.json', 'cat.' + id + '.movie.g1-i0.json', 'cat.' + id + '.movie.g1-i1.json', 'cat.' + id + '.series.g1-i0.json'];

/** A device with the original playlist, its catalogue (6 files) and a verified backup. */
async function seeded() {
  const d = device();
  const ctx = await start(d);
  const r = await ctx.playlists.add(XT('Original', 'orig.invalid'));
  assert.equal(r.ok, true);
  for (const n of CAT(r.playlist.id)) { d.files.set(n, '{"t":1}'); }
  await settle();
  assert.ok(d.files.has(BACKUP_FILE), 'backup written after the save');
  return { d, id: r.playlist.id, raw: d.ls.get(LIST) };
}

const catCount = (d, id) => Array.from(d.files.keys()).filter((n) => n.indexOf('cat.' + id + '.') === 0).length;
const storedIds = (d) => { try { return JSON.parse(d.ls.get(LIST)).d.map((p) => p.id); } catch (e) { return null; } };

function assertIntact(d, ctx, id, label) {
  assert.ok(storedIds(d) && storedIds(d).includes(id), label + ': original still stored');
  assert.equal(catCount(d, id), 6, label + ': catalogue intact (6/6)');
  if (ctx) { assert.ok(ctx.playlists.list().some((p) => p.id === id), label + ': original visible'); }
  assert.ok(Array.from(d.keys.keys()).some((k) => k.indexOf(id) >= 0), label + ': login kept');
}

// ------------------------------------------------------------------ the incident

test('S5b: list reads fail at two starts, add attempted: refused, original and catalogue survive', async () => {
  const { d, id, raw } = await seeded();
  d.f.readThrow = (k) => k === LIST;
  const a = await start(d); // "production start" with an unreadable list
  assert.equal(a.playlists.storageState().status, 'protected');
  assert.equal(a.playlists.storageState().problem, 'read-error');
  const rep = await a.playlists.recover();
  assert.equal(rep.cleanupSkipped, true, 'cleanup skipped');
  assert.equal(catCount(d, id), 6);
  const b = await start(d); // "CP1 start", still unreadable; the user tries to add
  const add = await b.playlists.add(XT('New', 'new.invalid'));
  assert.deepEqual([add.ok, add.code], [false, 'storage-protected']);
  assert.equal(d.ls.get(LIST), raw, 'no overwrite of the stored list');
  assert.equal((await b.playlists.recover()).cleanupSkipped, true);
  d.f.readThrow = null;
  const c = await start(d);
  assert.equal(c.playlists.storageState().status, 'ok');
  assertIntact(d, c, id, 'after reads recover');
  assert.equal(c.playlists.activeId(), id, 'active selection kept');
  assert.equal(c.playlists.list().length, 1, 'no replacement entry was created');
});

test('S5c: list read fails at one start only, add attempted: refused, cleanup skipped, all kept', async () => {
  const { d, id, raw } = await seeded();
  await start(d); // normal start
  d.f.readThrow = (k) => k === LIST;
  const b = await start(d);
  assert.equal((await b.playlists.recover()).cleanupSkipped, true);
  const add = await b.playlists.add(XT('New', 'new.invalid'));
  assert.equal(add.code, 'storage-protected');
  assert.equal(d.ls.get(LIST), raw);
  assert.equal(catCount(d, id), 6);
  d.f.readThrow = null;
  assertIntact(d, await start(d), id, 'S5c');
});

test('S6a: truncated JSON: kept and quarantined, protected, restore from the backup', async () => {
  const { d, id, raw } = await seeded();
  const torn = raw.slice(0, Math.floor(raw.length / 2));
  d.ls.set(LIST, torn);
  const a = await start(d);
  const s = a.playlists.storageState();
  assert.deepEqual([s.status, s.problem, s.preserved, s.canRestore, s.backupEntries], ['protected', 'corrupt', true, true, 1]);
  assert.equal(d.ls.get(LIST), torn, 'damaged value left in place');
  assert.equal(a.kv.quarantined('playlists'), torn, 'and preserved in quarantine');
  assert.equal(a.playlists.list().length, 0);
  assert.equal((await a.playlists.recover()).cleanupSkipped, true);
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  assert.equal(catCount(d, id), 6, 'catalogue kept while protected');
  const r = await a.playlists.restoreBackup();
  assert.deepEqual([r.ok, r.code, r.entries], [true, 'restored', 1]);
  assert.equal(a.playlists.storageState().status, 'ok');
  assert.ok(d.files.has(BACKUP_KEEP_FILE), 'backup preserved once before the decision');
  assert.equal(a.kv.quarantined('playlists'), torn, 'quarantine kept after the restore');
  assertIntact(d, await start(d), id, 'after restore');
});

test('S6b: broken wrapper: protected (malformed), nothing deleted, list not replaced', async () => {
  const { d, id } = await seeded();
  const bad = JSON.stringify({ d: JSON.parse(d.ls.get(LIST)).d });
  d.ls.set(LIST, bad);
  const a = await start(d);
  assert.equal(a.playlists.storageState().problem, 'malformed');
  await a.playlists.recover();
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  assert.equal(d.ls.get(LIST), bad);
  assert.equal(catCount(d, id), 6);
  assert.equal(a.kv.quarantined('playlists'), bad);
});

test('S6c: one entry with an invalid server: the valid one stays usable, the invalid one is preserved', async () => {
  const { d, id } = await seeded();
  const ctx = await start(d);
  const second = (await ctx.playlists.add(XT('Second', 'second.invalid'))).playlist.id;
  for (const n of CAT(second)) { d.files.set(n, '{}'); }
  const env = JSON.parse(d.ls.get(LIST));
  env.d[0].server = 'http://orig.invalid:8080/broken/path';
  const bad = JSON.stringify(env);
  d.ls.set(LIST, bad);
  const a = await start(d);
  const s = a.playlists.storageState();
  assert.deepEqual([s.problem, s.validEntries, s.invalidEntries, s.preserved], ['partial', 1, 1, true]);
  assert.deepEqual(a.playlists.list().map((p) => p.id), [second], 'valid entry still visible');
  assert.equal((await a.playlists.recover()).cleanupSkipped, true);
  assert.equal(catCount(d, id), 6, 'catalogue of the invalid entry kept');
  assert.equal(catCount(d, second), 6);
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  await assert.rejects(a.playlists.remove(second), /protected/);
  assert.equal(catCount(d, second), 6, 'refused removal deleted nothing');
  assert.equal(d.ls.get(LIST), bad, 'stored list untouched');
  const c = await a.playlists.continueWithoutRestore();
  assert.deepEqual([c.ok, c.entries], [true, 1]);
  assert.equal(a.kv.quarantined('playlists'), bad, 'original raw list preserved for recovery');
  await a.playlists.recover();
  assert.equal(catCount(d, id), 6, 'invalid entry\'s files never deleted (owner uncertain)');
  assert.ok(d.files.has(BACKUP_KEEP_FILE), 'old backup preserved');
});

test('S6d: invalid nullable data (epgUrl null) on the only entry: protected, not an empty list; restore works', async () => {
  const { d, id } = await seeded();
  const env = JSON.parse(d.ls.get(LIST));
  env.d[0].epgUrl = null;
  d.ls.set(LIST, JSON.stringify(env));
  const a = await start(d);
  const s = a.playlists.storageState();
  assert.deepEqual([s.status, s.problem, s.validEntries, s.invalidEntries, s.canRestore], ['protected', 'partial', 0, 1, true]);
  assert.equal((await a.playlists.recover()).cleanupSkipped, true);
  assert.equal(catCount(d, id), 6);
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  assert.equal((await a.playlists.restoreBackup()).ok, true);
  assertIntact(d, await start(d), id, 'S6d after restore');
});

test('S6e: localStorage wiped, backup present: missing-with-backup, nothing deleted, restore works', async () => {
  const { d, id } = await seeded();
  d.ls.clear();
  const a = await start(d);
  const s = a.playlists.storageState();
  assert.deepEqual([s.status, s.problem, s.canRestore], ['protected', 'missing-with-backup', true]);
  assert.equal(a.playlists.list().length, 0);
  assert.equal((await a.playlists.recover()).cleanupSkipped, true);
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  assert.equal(d.ls.has(LIST), false, 'no replacement list was created');
  assert.equal(catCount(d, id), 6);
  assert.equal((await a.playlists.restoreBackup()).ok, true);
  assert.equal(a.playlists.activeId(), id, 'active selection restored');
  assertIntact(d, await start(d), id, 'S6e after restore');
});

test('S6e: localStorage wiped and no backup (upgrade from c0adf0b): catalogue files keep it protected', async () => {
  const { d, id } = await seeded();
  d.ls.clear();
  d.files.delete(BACKUP_FILE);
  const a = await start(d);
  assert.equal(a.playlists.storageState().problem, 'missing-with-data');
  assert.equal((await a.playlists.recover()).cleanupSkipped, true);
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  assert.equal(catCount(d, id), 6);
  const c = await a.playlists.continueWithoutRestore();
  assert.equal(c.ok, true, 'user decision: carry on');
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).ok, true);
  await a.playlists.recover();
  assert.equal(catCount(d, id), 6, 'files of the lost playlist are never deleted automatically');
});

test('S6e: localStorage unavailable: protected, no add to a temporary list, data kept for the next start', async () => {
  const { d, id } = await seeded();
  d.f.noLocal = true;
  const a = await start(d);
  assert.equal(a.playlists.storageState().problem, 'no-local-storage');
  assert.equal(a.playlists.storageState().canContinue, false);
  assert.equal((await a.playlists.recover()).cleanupSkipped, true);
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  assert.equal(catCount(d, id), 6);
  d.f.noLocal = false;
  assertIntact(d, await start(d), id, 'storage back');
});

// ------------------------------------------------------------------ further failure modes

test('quota exceeded / failed primary write: the add fails (not reported as success), original intact', async () => {
  const { d, id, raw } = await seeded();
  d.f.writeThrow = (k) => k === LIST;
  const a = await start(d);
  const add = await a.playlists.add(XT('New', 'new.invalid'));
  assert.deepEqual([add.ok, add.code], [false, 'storage']);
  assert.equal(d.ls.get(LIST), raw);
  assert.equal(Array.from(d.keys.keys()).length, 1, 'the new login was rolled back');
  d.f.writeThrow = null;
  assertIntact(d, await start(d), id, 'quota');
});

test('failed quarantine: the damaged value stays in place and no recovery choice may overwrite it', async () => {
  const { d, id } = await seeded();
  d.ls.set(LIST, '{"v":1,"d":[{"id":');
  d.f.writeThrow = (k) => k.indexOf(P + 'quarantine.') === 0;
  const a = await start(d);
  const s = a.playlists.storageState();
  assert.deepEqual([s.problem, s.preserved, s.canRestore, s.canContinue], ['corrupt', false, false, false]);
  assert.equal((await a.playlists.continueWithoutRestore()).code, 'not-preserved');
  assert.equal((await a.playlists.restoreBackup()).code, 'not-preserved');
  assert.equal(d.ls.get(LIST), '{"v":1,"d":[{"id":', 'original kept untouched');
  await a.playlists.recover();
  assert.equal(catCount(d, id), 6);
  assert.ok(a.diag.entries().some((e) => e.e === 'quarantine-failed'));
});

test('failed backup writes never affect the primary list; no backup means no restore offer', async () => {
  const d = device();
  d.f.fileWriteFail = (n) => n === BACKUP_FILE;
  const ctx = await start(d);
  const r = await ctx.playlists.add(XT('Original', 'orig.invalid'));
  assert.equal(r.ok, true, 'primary save succeeds');
  for (const n of CAT(r.playlist.id)) { d.files.set(n, '{}'); }
  await settle();
  assert.equal(d.files.has(BACKUP_FILE), false);
  assert.ok(ctx.diag.entries().some((e) => e.e === 'backup-failed'));
  d.ls.set(LIST, 'garbage');
  const a = await start(d);
  const s = a.playlists.storageState();
  assert.deepEqual([s.problem, s.canRestore, s.canContinue], ['corrupt', false, true]);
  await a.playlists.recover();
  assert.equal(catCount(d, r.playlist.id), 6);
});

test('a damaged backup is never used and never replaced by damaged data', async () => {
  const { d, id } = await seeded();
  const good = d.files.get(BACKUP_FILE);
  d.files.set(BACKUP_FILE, good.slice(0, good.length - 5));
  d.ls.set(LIST, 'garbage');
  const a = await start(d);
  const s = a.playlists.storageState();
  assert.deepEqual([s.problem, s.canRestore, s.backupEntries], ['corrupt', false, -1]);
  assert.equal(d.files.get(BACKUP_FILE), good.slice(0, good.length - 5), 'protected state writes no backup');
  assert.ok(a.diag.entries().some((e) => e.e === 'backup-invalid'));
  assert.equal(catCount(d, id), 6);
});

test('interrupted write (torn value) at repeated starts: evidence kept, nothing deleted, quarantine stable', async () => {
  const { d, id } = await seeded();
  d.ls.set(LIST, '{"v":1,"d":[{"id":"pm');
  for (let i = 0; i < 3; i++) {
    const c = await start(d);
    assert.equal(c.playlists.storageState().status, 'protected');
    assert.equal((await c.playlists.recover()).cleanupSkipped, true);
  }
  assert.equal(d.ls.get(LIST), '{"v":1,"d":[{"id":"pm');
  assert.equal(d.ls.has(P + 'quarantine.playlists.2'), false, 'one quarantine copy, not one per start');
  assert.equal(catCount(d, id), 6);
});

test('read error, then storage readable again: recheckStorage recovers without any loss', async () => {
  const { d, id } = await seeded();
  d.f.readThrow = (k) => k === LIST;
  const a = await start(d);
  assert.equal(a.playlists.storageState().problem, 'read-error');
  assert.equal(a.playlists.storageState().canContinue, false, 'no decision possible on an unread value');
  d.f.readThrow = null;
  assert.equal((await a.playlists.recheckStorage()).status, 'ok');
  assert.equal(a.playlists.activeId(), id);
  assertIntact(d, a, id, 'recheck');
});

test('list becomes unreadable while the app runs: writes refused, last list stays on screen', async () => {
  const { d, id, raw } = await seeded();
  const a = await start(d);
  assert.equal(a.playlists.list().length, 1);
  d.f.readThrow = (k) => k === LIST;
  assert.equal((await a.playlists.add(XT('New', 'new.invalid'))).code, 'storage-protected');
  assert.deepEqual(a.playlists.list().map((p) => p.id), [id], 'not shown as empty');
  assert.equal(a.playlists.setActive(id), false, 'no setting change while protected');
  d.f.readThrow = null;
  assert.equal(d.ls.get(LIST), raw);
  assert.equal(catCount(d, id), 6);
});

test('low-memory start, invalid active id, missing login, interrupted import: list and catalogue kept', async () => {
  const { d, id } = await seeded();
  d.f.mem = 120;
  assertIntact(d, await start(d), id, 'low memory');
  d.f.mem = 220;
  d.ls.set(P + 'playlists.active', JSON.stringify({ v: 1, d: 'BAD ID!' }));
  const b = await start(d);
  assert.equal(b.playlists.activeId(), null);
  assert.equal(b.playlists.storageState().status, 'ok', 'a bad active id does not lock the list');
  assertIntact(d, b, id, 'bad active id');
  assert.equal(d.ls.get(P + 'playlists.active'), JSON.stringify({ v: 1, d: 'BAD ID!' }), 'kept, not deleted');
  const login = Array.from(d.keys.entries());
  d.keys.clear();
  const c = await start(d);
  assert.equal(Array.from(d.keys.keys()).some((k) => k.indexOf(id) >= 0), false, 'login missing'); // portable: no CP1-only API
  assert.equal(c.playlists.list().length, 1);
  assert.equal(catCount(d, id), 6);
  for (const [k, v] of login) { d.keys.set(k, v); }
  d.ls.set(P + 'import.journal', JSON.stringify({ v: 1, d: { id: id, startedAt: clock } }));
  d.files.set('cat.' + id + '.live.json.tmp', 'half');
  const e = await start(d); // the app's own start-up recover() handles the journal and temp file
  assert.equal(d.files.has('cat.' + id + '.live.json.tmp'), false, 'only the temp file goes');
  assert.deepEqual(await e.playlists.recover(), { interrupted: null, removedFiles: 0 }, 'already handled at start-up');
  assert.equal(e.playlists.get(id).lastStatus.code, 'interrupted');
  assertIntact(d, e, id, 'interrupted import');
});

// ------------------------------------------------------------------ genuine cases still work

test('first installation: no list, no backup, no files: verified empty, add works, backup written', async () => {
  const d = device();
  const a = await start(d);
  assert.equal(a.playlists.storageState().status, 'ok');
  assert.equal((await a.playlists.recover()).cleanupSkipped, undefined);
  const r = await a.playlists.add(XT('First', 'first.invalid'));
  assert.equal(r.ok, true);
  await settle();
  assert.ok(d.files.has(BACKUP_FILE));
});

test('genuine deletion: files removed, tombstoned leftovers cleaned later, an empty list is explicit', async () => {
  const { d, id } = await seeded();
  const a = await start(d);
  const keep = (await a.playlists.add(XT('Keep', 'keep.invalid'))).playlist.id;
  for (const n of CAT(keep)) { d.files.set(n, '{}'); }
  await a.playlists.remove(id);
  assert.equal(catCount(d, id), 0, 'removed playlist\'s files deleted');
  assert.deepEqual(storedIds(d), [keep]);
  d.files.set('cat.' + id + '.epg.json', 'leftover'); // a file the removal missed
  d.files.set('cat.pzzzzzzzz01.live.json', 'unknown owner');
  await (await start(d)).playlists.recover();
  assert.equal(catCount(d, id), 0, 'tombstoned leftover cleaned');
  assert.ok(d.files.has('cat.pzzzzzzzz01.live.json'), 'unknown owner kept');
  assert.equal(catCount(d, keep), 6);
  const b = await start(d);
  await b.playlists.remove(keep);
  assert.equal(d.ls.get(LIST), JSON.stringify({ v: 1, d: [] }), 'explicit empty list, not a missing key');
  const c = await start(d);
  assert.equal(c.playlists.storageState().status, 'ok', 'user-emptied list is not mistaken for a loss');
});

test('PIN-reset wipe (removeAll): refused while protected; works when verified', async () => {
  const { d, id } = await seeded();
  d.ls.set(LIST, 'garbage');
  const a = await start(d);
  await assert.rejects(a.playlists.removeAll(), /protected/);
  assert.equal(catCount(d, id), 6);
  assert.equal(d.ls.get(LIST), 'garbage');
  assert.equal((await a.playlists.restoreBackup()).ok, true);
  await a.playlists.removeAll();
  assert.equal(catCount(d, id), 0);
  assert.equal(d.ls.get(LIST), JSON.stringify({ v: 1, d: [] }));
  assert.equal((await start(d)).playlists.storageState().status, 'ok');
});

// ------------------------------------------------------------------ diagnostics

test('persistent diagnostics: survive a restart, bounded, no secrets or addresses', async () => {
  const { d } = await seeded();
  d.ls.set(LIST, 'garbage');
  const a = await start(d);
  await a.playlists.recover();
  await a.playlists.add(XT('New', 'new.invalid'));
  await a.diag.flush();
  assert.ok(d.files.has(DIAG_FILE), 'written to the file store');
  const b = await start(d);
  const codes = b.diag.entries().map((e) => e.e);
  for (const c of ['quarantined', 'pl-protected', 'cleanup-skipped', 'pl-write-refused']) {
    assert.ok(codes.includes(c), 'kept across restart: ' + c);
  }
  for (let i = 0; i < 100; i++) { b.diag.record('noise', { count: i }); }
  await b.diag.flush();
  assert.ok(b.diag.entries().length <= 60, 'bounded');
  const text = d.files.get(DIAG_FILE) + JSON.stringify(a.diag.entries());
  for (const s of ['orig.invalid', 'new.invalid', 'http', 'p-secret', 'u-Original', 'u-New', 'garbage']) {
    assert.equal(text.includes(s), false, 'not in the diagnostics: ' + s);
  }
  b.diag.record('x', { code: 'http://host:1/a?b=c', id: 'pabc01', key: 'user name' });
  assert.deepEqual(b.diag.entries().pop().d, { id: 'pabc01' }, 'only short codes pass the filter');
});

// ------------------------------------------------------------------ user-facing behaviour

test('Home: a protected list shows the recovery dialog, no "Add account" start and no empty-account state', async () => {
  const { startApp } = await import('../../src/app/bootstrap.ts');
  const { createDomHost } = await import('../../src/app/dom-host.ts');
  const { createFakePlatform } = await import('../fakes/fake-platform.mjs');
  const { createFakeDocument } = await import('../fakes/fake-dom.mjs');
  const { createFakeClock } = await import('../fakes/fake-clock.mjs');
  const fp = createFakePlatform();
  fp.platform.localStore.setItem(LIST, '{"v":1,"d":[{"id":"pm'); // torn write
  const clk = createFakeClock();
  const ctx = createAppContext({ platform: fp.platform, build: { mode: 'test', version: 'di1', devSinkUrl: '' }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  const doc = createFakeDocument();
  startApp(ctx, createDomHost(doc, doc.body), doc, clk.now);
  await ctx.playlists.whenChecked();
  await settle();
  const text = doc.body.textContent;
  assert.match(text, /Your playlists are protected/);
  assert.match(text, /Nothing has been deleted/);
  assert.match(text, /The saved list is damaged/);
  assert.match(text, /Playlists protected/, 'chip: not "No account"');
  assert.match(text, /Paused while playlists are protected/, 'Add tile disabled');
  assert.match(text, /Try again/);
  assert.match(text, /Continue without/);
  assert.doesNotMatch(text, /Restore backup/, 'no backup: no restore offer');
  assert.equal(fp.platform.localStore.getItem(LIST), '{"v":1,"d":[{"id":"pm', 'nothing written');
});
