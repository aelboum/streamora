// CP2 F11: Android WebView hands a Java `null` String from a @JavascriptInterface method to
// JavaScript as `undefined`. Found on the Philips QM164E (Android 7.1.2, WebView 119): adding the
// first playlist failed with "Cannot read properties of undefined (reading 'length')" because the
// missing backup file was read as `undefined`. These fakes return `undefined` exactly like the
// real bridge, and the real PlaylistService runs on top of the Android file and key stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeFileStore, bridgeKeyStore, bridgeString } from '../../src/app/platform/android-platform.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createLogger } from '../../src/utils/log.ts';

/** Fake ElitePlatform with the real WebView null-to-undefined behaviour. */
export function webViewBridge() {
  const files = new Map();
  const keys = new Map();
  return {
    files, keys,
    version: () => 'Android 7.1.2 (API 25)', deviceType: () => 'tv', availableMemoryMB: () => 300, totalMemoryMB: () => 1563, exit() {},
    fileRead: (n) => (files.has(n) ? files.get(n) : undefined),
    fileWrite: (n, t) => { files.set(n, t); return true; },
    fileRemove: (n) => { files.delete(n); return true; },
    fileList: () => JSON.stringify(Array.from(files.keys())),
    keySave: (a, v) => { keys.set(a, v); return true; },
    keyLoad: (a) => (keys.has(a) ? keys.get(a) : undefined),
    keyRemove: (a) => { keys.delete(a); return true; }
  };
}

export function androidService(files, keyStore) {
  const log = createLogger(500);
  const kv = createKeyValueStore(createMemoryLocalStore(), log);
  return createPlaylistService({
    kv, files,
    catalogue: createCatalogueStore(files, { budgetChars: 1000000, maxChars: 2000000 }, Date.now, log),
    secrets: createSecretStore(keyStore),
    http: { request: () => Promise.reject(new Error('no network in this test')) },
    now: Date.now, log: log.child('playlists'),
    timers: { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) },
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 1000, maxResponseChars: 100000, maxPlaylistChars: 100000, idleTimeoutMs: 1000, totalTimeoutMs: 5000 }
  });
}

test('CP2 F11: bridgeString keeps strings and turns undefined/null/other values into null', () => {
  assert.equal(bridgeString('abc'), 'abc');
  assert.equal(bridgeString(''), '');
  assert.equal(bridgeString(undefined), null);
  assert.equal(bridgeString(null), null);
  assert.equal(bridgeString(42), null);
});

test('CP2 F11: Android file store read and key store load return null (not undefined) for absent entries', async () => {
  const b = webViewBridge();
  const fs = bridgeFileStore(b);
  assert.equal(await fs.read('missing.json'), null);
  await fs.write('present.json', '{"a":1}');
  assert.equal(await fs.read('present.json'), '{"a":1}');
  assert.deepEqual(await fs.list(), ['present.json']);
  const ks = bridgeKeyStore(b);
  assert.equal(await ks.load('ss_pl_absent'), null);
  await ks.save('ss_pl_x', 'v');
  assert.equal(await ks.load('ss_pl_x'), 'v');
  const broken = Object.assign(webViewBridge(), { fileRead: () => { throw new Error('io'); } });
  await assert.rejects(bridgeFileStore(broken).read('x.json'), /io/);
});

test('CP2 F11: the first Xtream playlist can be added on a fresh Android install (no backup file yet)', async () => {
  const b = webViewBridge();
  const svc = androidService(bridgeFileStore(b), bridgeKeyStore(b));
  const r = await svc.add({ name: 'tv', kind: 'xtream', server: 'http://prov.example:8080', username: 'demo_user', password: 'pw-SECRET-9' });
  assert.equal(r.ok, true, 'add succeeds: ' + JSON.stringify(r));
  assert.equal(svc.list().length, 1);
  assert.equal(svc.list()[0].name, 'tv');
  assert.match(await bridgeKeyStore(b).load('ss_pl_' + r.playlist.id), /"password":"pw-SECRET-9"/, 'login stored in the key store');
  assert.equal(JSON.stringify(svc.list()).includes('pw-SECRET-9'), false, 'no password in the playlist definition');
});
