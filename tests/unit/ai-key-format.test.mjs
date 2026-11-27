// AI-02: Gemini key formats. Standard keys ("AIza…") and AI Studio auth keys ("AQ.…", created by
// default since 2026-05-28) are accepted, sent the same way and hidden in logs. Made-up keys only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiAdapter } from '../../src/ai/gemini-provider.ts';
import { privacyViolation } from '../../src/ai/ai-manager.ts';
import { redactString, REDACTED } from '../../src/utils/redact.ts';

const AQ_KEY = 'AQ.Ab' + 'c'.repeat(20) + '.' + 'D-e_'.repeat(6) + 'xyz'; // 53 characters
const AIZA_KEY = 'AIza' + 'S'.repeat(35);

test('Gemini key format: AIza and AQ. keys accepted, others refused', () => {
  const a = createGeminiAdapter({ request() { throw new Error('no network'); } }, { timeoutMs: 1000, maxResponseChars: 1000 });
  assert.equal(AQ_KEY.length, 53);
  assert.equal(a.validKey(AIZA_KEY), true);
  assert.equal(a.validKey(AQ_KEY), true);
  assert.equal(a.validKey('AQ.short'), false);
  assert.equal(a.validKey('AQ.has space' + 'x'.repeat(20)), false);
  assert.equal(a.validKey('AQ.has/slash' + 'x'.repeat(20)), false);
  assert.equal(a.validKey('AIza.dot' + 'x'.repeat(30)), false, 'dots only in AQ. keys');
  assert.equal(a.validKey('https://example.com/' + 'x'.repeat(20)), false);
});

test('Gemini key format: AQ. keys are hidden in logs and blocked in prompts', () => {
  const r = redactString('key=' + AQ_KEY + ' and ' + AQ_KEY);
  assert.equal(r.indexOf('AQ.Ab'), -1, r);
  assert.ok(r.indexOf(REDACTED) >= 0);
  assert.equal(redactString('plain AQ. text').indexOf(REDACTED), -1, 'short AQ. text is left alone');
  assert.equal(privacyViolation('my key is ' + AQ_KEY), true);
  assert.equal(privacyViolation('a film about AQ. levels'), false);
});
