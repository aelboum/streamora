import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretStore, secretAlias } from '../../src/storage/secret-store.ts';
import { createTizenKeyStore } from '../../src/app/platform/tizen-key-store.ts';
import { createMemoryKeyStore } from '../../src/app/platform/memory-stores.ts';
import { createFakeKeyManager } from '../fakes/fake-tizen.mjs';

test('credentials are stored only in the key store, under a per-playlist alias', async () => {
  const km = createFakeKeyManager();
  const secrets = createSecretStore(createTizenKeyStore(km.api));
  await secrets.put('pl1', { kind: 'xtream', username: 'alice', password: 'p@ss w0rd' });
  assert.deepEqual([...km.data.keys()], ['ss_pl_pl1']);
  assert.deepEqual(await secrets.get('pl1'), { kind: 'xtream', username: 'alice', password: 'p@ss w0rd' });
  await secrets.put('pl1', { kind: 'm3u', url: 'http://h.example/get.php?username=a&password=b' });
  assert.deepEqual(await secrets.get('pl1'), { kind: 'm3u', url: 'http://h.example/get.php?username=a&password=b' });
  await secrets.remove('pl1');
  assert.equal(await secrets.get('pl1'), null);
  assert.equal(km.data.size, 0);
});

test('invalid secrets and ids are refused without echoing values', async () => {
  const secrets = createSecretStore(createMemoryKeyStore());
  for (const bad of [
    { kind: 'xtream', username: '', password: 'x' },
    { kind: 'xtream', username: 'a', password: 'line\nbreak' },
    { kind: 'xtream', username: 'a'.repeat(300), password: 'x' },
    { kind: 'm3u', url: '' },
    { kind: 'other' },
    null
  ]) {
    await assert.rejects(secrets.put('pl1', bad), (e) => /invalid credentials/.test(e.message));
  }
  await assert.rejects(secrets.put('../x', { kind: 'm3u', url: 'http://a' }));
  assert.throws(() => secretAlias('UP'));
});

test('unreadable stored values resolve null; key-store failures are generic', async () => {
  const keys = createMemoryKeyStore();
  const secrets = createSecretStore(keys);
  await keys.save('ss_pl_pl1', '{not json');
  assert.equal(await secrets.get('pl1'), null);
  await keys.save('ss_pl_pl1', JSON.stringify({ kind: 'xtream', username: 'a' }));
  assert.equal(await secrets.get('pl1'), null);
  const failing = createSecretStore({ persistent: true, save: () => Promise.reject(new Error('value=hunter2')), load: () => Promise.reject(new Error('x')), remove: () => Promise.resolve() });
  await assert.rejects(failing.put('pl1', { kind: 'xtream', username: 'u', password: 'hunter2' }), (e) => {
    assert.equal(e.message, 'credentials could not be stored');
    return true;
  });
  await assert.rejects(failing.get('pl1'), /could not be read/);
});

test('memory key store reports itself as non-persistent', () => {
  assert.equal(createSecretStore(createMemoryKeyStore()).persistent, false);
});
