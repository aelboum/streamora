import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveConfig, loadConfig, saveConfigOverride } from '../../src/app/config.ts';
import { createKeyValueStore, KV_PREFIX } from '../../src/storage/kv-store.ts';
import { createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';

test('defaults follow the probe measurements', () => {
  const c = resolveConfig(null);
  assert.deepEqual(c.warnings, []);
  assert.equal(c.config.player.liveBufferSec, 2);
  assert.equal(c.config.security.pinIterations, 600000, 'Stage 4B P1');
  assert.equal(c.config.storage.sectionBudgetChars, 5000000);
  assert.equal(c.config.ui.keyRepeatThrottleMs, 110);
  c.config.player.liveBufferSec = 9;
  assert.equal(DEFAULT_CONFIG.player.liveBufferSec, 2, 'defaults are not mutated');
});

test('valid overrides apply; invalid ones fall back with warnings', () => {
  const c = resolveConfig({
    player: { liveBufferSec: 3, prepareTimeoutMs: 999999 },
    ui: { language: 'nl', theme: 'neon' },
    security: { pinIterations: 100000 },
    bogus: { a: 1 },
    network: { unknownField: 1, retryAttempts: '3' }
  });
  assert.equal(c.config.player.liveBufferSec, 3);
  assert.equal(c.config.player.prepareTimeoutMs, 15000);
  assert.equal(c.config.ui.language, 'nl');
  assert.equal(c.config.ui.theme, 'dark');
  assert.equal(c.config.security.pinIterations, 600000, 'security floor holds: 100,000 is below the Stage 4B minimum');
  assert.equal(c.config.network.retryAttempts, 3);
  assert.equal(c.warnings.length, 6);
});

test('non-object overrides are ignored with a warning', () => {
  assert.equal(resolveConfig('x').warnings.length, 1);
  assert.equal(resolveConfig({ player: 5 }).warnings.length, 1);
});

test('budget is capped at the hard limit', () => {
  const c = resolveConfig({ storage: { sectionBudgetChars: 9000000, sectionMaxChars: 1000000 } });
  assert.equal(c.config.storage.sectionBudgetChars, 1000000);
});

test('loading from storage and saving validated overrides', () => {
  const local = createMemoryLocalStore();
  const kv = createKeyValueStore(local);
  assert.deepEqual(loadConfig(kv).config, DEFAULT_CONFIG);
  assert.deepEqual(saveConfigOverride(kv, { ui: { theme: 'light' } }), []);
  assert.equal(loadConfig(kv).config.ui.theme, 'light');
  const warnings = saveConfigOverride(kv, { ui: { theme: 'pink' } });
  assert.equal(warnings.length, 1);
  assert.equal(loadConfig(kv).config.ui.theme, 'light', 'invalid override not stored');
  local.setItem(KV_PREFIX + 'config', '{corrupt');
  assert.deepEqual(loadConfig(kv).config, DEFAULT_CONFIG);
});
