// Tizen FileStore / KeyStore adapters against SIMULATED Tizen APIs (tests/fakes/fake-tizen.mjs).
// These verify the adapter logic only; TV behaviour must be confirmed on the device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTizenFileStore } from '../../src/app/platform/tizen-file-store.ts';
import { createTizenKeyStore } from '../../src/app/platform/tizen-key-store.ts';
import { createFakeTizenFs, createFakeKeyManager } from '../fakes/fake-tizen.mjs';

test('file store: write/read round trip across many chunks, atomic via moveTo', async () => {
  const fs = createFakeTizenFs();
  const store = createTizenFileStore(fs.api);
  const big = 'abcdefghij'.repeat(250000); // 2.5 M characters: several write and read chunks
  await store.write('cat.p1.live.json', big);
  assert.equal(fs.moveCalls(), 1);
  assert.equal(store.atomicReplace, true);
  assert.equal(await store.read('cat.p1.live.json'), big);
  assert.equal(fs.files.has(fs.root + '/cat.p1.live.json.tmp'), false, 'temp file moved away');
  await store.write('cat.p1.live.json', 'second');
  assert.equal(await store.read('cat.p1.live.json'), 'second');
});

test('file store: falls back to a direct write when moveTo fails, and says so', async () => {
  for (const opt of [{ moveToFails: true }, { moveToThrows: true }]) {
    const fs = createFakeTizenFs(opt);
    const store = createTizenFileStore(fs.api);
    await store.write('a.json', 'v1');
    assert.equal(await store.read('a.json'), 'v1');
    assert.equal(store.atomicReplace, false);
    assert.equal(fs.files.has(fs.root + '/a.json.tmp'), false, 'temp file cleaned up');
  }
});

test('file store: missing files, removal, listing, name validation', async () => {
  const fs = createFakeTizenFs();
  const store = createTizenFileStore(fs.api);
  assert.equal(await store.read('missing.json'), null);
  await store.remove('missing.json');
  await store.write('b.json', 'x');
  await store.write('a.json', 'y');
  assert.deepEqual(await store.list(), ['a.json', 'b.json']);
  await store.remove('a.json');
  assert.deepEqual(await store.list(), ['b.json']);
  await assert.rejects(store.read('../etc/passwd'));
  await assert.rejects(store.write('UPPER.json', 'x'));
  await assert.rejects(store.write('', 'x'));
});

test('key store: save/load/remove; overwrite works although the key manager refuses duplicates', async () => {
  const km = createFakeKeyManager();
  const keys = createTizenKeyStore(km.api);
  assert.equal(keys.persistent, true);
  assert.equal(await keys.load('ss_pl_a'), null);
  await keys.save('ss_pl_a', 'one');
  await keys.save('ss_pl_a', 'two');
  assert.equal(await keys.load('ss_pl_a'), 'two');
  await keys.remove('ss_pl_a');
  await keys.remove('ss_pl_a');
  assert.equal(await keys.load('ss_pl_a'), null);
  await assert.rejects(keys.save('bad alias!', 'x'));
});

test('key store: errors never contain the secret value', async () => {
  const km = createFakeKeyManager();
  km.api.saveData = (alias, raw, pw, ok, err) => setImmediate(() => err({ name: 'SecurityError', message: 'refused ' + raw }));
  const keys = createTizenKeyStore(km.api);
  await assert.rejects(keys.save('ss_pl_a', 'TOPSECRET'), (e) => {
    assert.doesNotMatch(e.message, /TOPSECRET/);
    return true;
  });
});
