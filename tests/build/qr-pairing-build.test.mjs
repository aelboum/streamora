// EXPERIMENTAL QR pairing UI test: build compatibility and isolation.
// The dev bundle contains the test screen and the QR encoder and stays ES5 (Tizen 3.0); the
// release bundle contains none of it (dev-hooks.ts is swapped for the no-op release stub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../scripts/build.mjs';
import { checkEs5Bundle } from '../../scripts/lib/es5-bundle-check.mjs';

test('QR pairing test: in the dev bundle (ES5), absent from the release bundle', async () => {
  const dev = await build('dev', {});
  assert.equal(checkEs5Bundle(dev.js).ok, true, 'dev bundle with the QR encoder is ES5');
  assert.ok(dev.js.includes('qr-pairing-test'), 'dev bundle registers the test screen');
  assert.ok(dev.js.includes('NEVER ENTER A REAL API KEY'), 'dev bundle carries the warning');
  const rel = await build('release', {});
  assert.equal(checkEs5Bundle(rel.js).ok, true);
  // The implementation (screen, test-server calls) is absent from the release bundle; the QR
  // encoder itself is shared with the production phone-pairing screen (AI-02-PHONE-PAIRING.md).
  for (const marker of ['NEVER ENTER A REAL API KEY', '/api/tv/', 'Waiting for the phone', 'Pairing ID: ']) {
    assert.ok(dev.js.includes(marker), 'dev bundle contains: ' + marker);
    assert.equal(rel.js.includes(marker), false, 'release bundle must not contain: ' + marker);
  }
  // The production phone pairing (end-to-end encrypted, docs/AI-02-PHONE-PAIRING.md) is in the release bundle.
  for (const marker of ['ES-PAIR-1', 'https://pair.elitestreamplayer.com', '/v1/s/']) { assert.ok(rel.js.includes(marker), 'release bundle contains: ' + marker); }
  // Only the inert guard of the AI settings screen remains: it shows its row only when the screen
  // is registered, which only the dev hook does.
  assert.equal(rel.js.split('qr-pairing-test').length - 1, 2, 'release: just isRegistered + push in the guarded row');
});
