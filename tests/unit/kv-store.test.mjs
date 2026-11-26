import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyValueStore, KV_PREFIX } from '../../src/storage/kv-store.ts';
import { createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createLogger } from '../../src/utils/log.ts';

const isObj = (x) => !!x && typeof x === 'object';

test('round trip with versioned envelope under the namespace', () => {
  const local = createMemoryLocalStore();
  const kv = createKeyValueStore(local);
  assert.equal(kv.set('settings', { theme: 'dark' }), true);
  assert.equal(local.getItem(KV_PREFIX + 'settings'), '{"v":1,"d":{"theme":"dark"}}');
  assert.deepEqual(kv.get('settings', isObj, null), { theme: 'dark' });
});

// DI-1 contract change: unreadable values still fall back, but are no longer deleted. They stay in
// place and are copied to quarantine.<name> (this test asserted the deletion before DI-1).
test('missing, corrupt, malformed and invalid values fall back and are kept (DI-1: quarantined, never deleted)', () => {
  const local = createMemoryLocalStore();
  const log = createLogger();
  const kv = createKeyValueStore(local, log);
  assert.equal(kv.get('nothing', isObj, 'fb'), 'fb');
  local.setItem(KV_PREFIX + 'a', '{broken');
  assert.equal(kv.get('a', isObj, 'fb'), 'fb');
  assert.equal(local.getItem(KV_PREFIX + 'a'), '{broken', 'original kept');
  assert.equal(kv.quarantined('a'), '{broken', 'and preserved in quarantine');
  local.setItem(KV_PREFIX + 'b', '[1,2]');
  assert.equal(kv.get('b', isObj, 'fb'), 'fb');
  assert.equal(local.getItem(KV_PREFIX + 'b'), '[1,2]');
  local.setItem(KV_PREFIX + 'c', '{"v":1,"d":"string"}');
  assert.equal(kv.get('c', isObj, 'fb'), 'fb');
  assert.equal(local.getItem(KV_PREFIX + 'c'), '{"v":1,"d":"string"}');
  assert.ok(log.entries().filter((e) => e.level === 'warn').length >= 3);
});

test('schema versions: migration applied; a missing migration falls back and keeps the value (DI-1)', () => {
  const local = createMemoryLocalStore();
  const kv = createKeyValueStore(local);
  kv.set('list', ['a'], 1);
  const migrated = kv.get('list', (x) => isObj(x) && Array.isArray(x.items), { items: [] }, 2, (from, d) => (from === 1 ? { items: d } : undefined));
  assert.deepEqual(migrated, { items: ['a'] });
  kv.set('old', 'x', 1);
  assert.equal(kv.get('old', () => true, 'fb', 3), 'fb');
  assert.equal(local.getItem(KV_PREFIX + 'old'), '{"v":1,"d":"x"}', 'kept (DI-1)');
  assert.equal(kv.read('old', () => true, 3).status, 'unsupported');
});

test('quota errors are reported as false, never thrown', () => {
  const local = createMemoryLocalStore({ quotaChars: 50 });
  const log = createLogger();
  const kv = createKeyValueStore(local, log);
  assert.equal(kv.set('small', 1), true);
  assert.equal(kv.set('big', 'x'.repeat(100)), false);
  assert.equal(log.entries().some((e) => e.level === 'error' && e.err && e.err.name === 'QuotaExceededError'), true);
});

test('names() and clearAll() touch only ScreenShelf keys; bad names rejected', () => {
  const local = createMemoryLocalStore();
  local.setItem('other-app', 'keep');
  const kv = createKeyValueStore(local);
  kv.set('a', 1);
  kv.set('b.c', 2);
  assert.deepEqual(kv.names(), ['a', 'b.c']);
  kv.clearAll();
  assert.deepEqual(kv.names(), []);
  assert.equal(local.getItem('other-app'), 'keep');
  assert.throws(() => kv.set('../x', 1));
  assert.throws(() => kv.get('Bad Name', () => true, 0));
});
