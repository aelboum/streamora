// AI-02 (multi-provider): Settings → AI Intelligence through the real start-up, router and key
// handling, with the fake Gemini API as the platform's XHR. Checks: off by default, nothing sent at
// start-up; sections present; planned providers shown as "Planned" and never focusable; the
// EliteStream AI service shown as not available (no service deployed); consent per party with
// Cancel focused; own Gemini key entered masked, stored, never displayed; connection test; model
// list; task routing offers only capable implemented providers; fallback rows; clean logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppContext, startApp } from '../../src/app/bootstrap.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { missingTranslations } from '../../src/i18n/strings.ts';
import { IME_DONE } from '../../src/screens/text-entry-overlay.ts';
import { createFakePlatform } from '../fakes/fake-platform.mjs';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { createFakeGemini, FAKE_KEY, header } from '../fakes/fake-gemini.mjs';

const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) { await tick(); } };

async function boot() {
  const gem = createFakeGemini();
  const fp = createFakePlatform({ xhrFactory: gem.factory });
  const clk = createFakeClock();
  const ctx = createAppContext({ platform: fp.platform, build: { mode: 'release', version: '0.3.4', devSinkUrl: '' }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  await ctx.playlists.whenChecked();
  const doc = createFakeDocument();
  const app = startApp(ctx, createDomHost(doc, doc.body), doc, clk.now);
  await settle();
  return { gem, fp, ctx, doc, app };
}

const visibleLayers = (env) => env.doc.body.childNodes.filter((n) => n.style.display !== 'none' && n.attributes && n.attributes['data-layer']);
const layerText = (env) => { const l = visibleLayers(env); return l[l.length - 1].textContent; };
const screenRows = (env) => {
  const l = visibleLayers(env);
  for (let i = l.length - 1; i >= 0; i--) { const rows = l[i].findAll('ss-set__row'); if (rows.length) { return rows; } }
  return [];
};
const focusedRow = (env) => screenRows(env).filter((r) => /is-focused/.test(r.className)).map((r) => r.attributes['data-row'])[0];
const rowEl = (env, id) => screenRows(env).filter((x) => x.attributes['data-row'] === id)[0];
const rowValue = (env, id) => { const r = rowEl(env, id); return r ? r.findAll('ss-set__value')[0].textContent : null; };
const focusedButton = (env) => env.doc.body.findAll('ss-button').filter((b) => /is-focused/.test(b.className)).map((b) => b.textContent)[0];
async function focusRow(env, id) {
  for (let i = 0; i < 80 && focusedRow(env) !== id; i++) { env.fp.press(40); }
  if (focusedRow(env) !== id) { for (let i = 0; i < 80 && focusedRow(env) !== id; i++) { env.fp.press(38); } }
  assert.equal(focusedRow(env), id, id + ' is focusable');
}
/** Scrolls until the row is on screen (info rows are not focusable; move focus past them). */
async function seeRow(env, id) {
  for (let i = 0; i < 80 && !rowEl(env, id); i++) { env.fp.press(40); }
  for (let i = 0; i < 80 && !rowEl(env, id); i++) { env.fp.press(38); }
  assert.ok(rowEl(env, id), id + ' visible');
}

test('AI UI: Settings row opens AI Intelligence; off by default; providers listed honestly; nothing sent', async () => {
  const env = await boot();
  env.app.router.push('settings');
  await settle();
  assert.ok(screenRows(env).some((r) => r.attributes['data-row'] === 'accounts'), 'existing Settings rows kept');
  await focusRow(env, 'ai');
  env.fp.press(13);
  await settle();
  assert.equal(env.app.router.stack().slice(-1)[0], 'ai-settings');
  assert.match(layerText(env), /AI Intelligence/);
  assert.equal(rowValue(env, 'ai-enabled'), 'Off');
  assert.equal(rowValue(env, 'ai-consent-google'), 'Off');
  assert.equal(rowValue(env, 'ai-consent-elitestream'), 'Off');
  await seeRow(env, 'ai-prov-gateway');
  assert.equal(rowValue(env, 'ai-prov-gateway'), 'Not available in this version', 'no service deployed: not presented as working');
  for (const p of ['openai', 'anthropic', 'azure', 'elevenlabs', 'openai-compatible', 'self-hosted']) {
    await seeRow(env, 'ai-prov-' + p);
    assert.equal(rowValue(env, 'ai-prov-' + p), 'Planned');
    assert.match(rowEl(env, 'ai-prov-' + p).className, /is-info/, p + ' is not selectable');
  }
  assert.equal(env.gem.requests.length, 0, 'no AI request');
  assert.deepEqual(missingTranslations(), [], 'every AI string exists in English and Dutch');
  env.fp.press(10009);
  await settle();
  assert.equal(env.app.router.stack().slice(-1)[0], 'settings');
});

test('AI UI: consent (Cancel first), own key masked and never shown, test, models, task routing, fallback, clean logs', async () => {
  const env = await boot();
  env.app.router.push('ai-settings');
  await settle();
  // Consent for Google: asks first, Cancel focused.
  await focusRow(env, 'ai-consent-google');
  env.fp.press(13);
  assert.equal(focusedButton(env), 'Cancel', 'OK alone never grants consent');
  env.fp.press(13);
  await settle();
  assert.equal(rowValue(env, 'ai-consent-google'), 'Off');
  env.fp.press(13); env.fp.press(39);
  assert.equal(focusedButton(env), 'Allow');
  env.fp.press(13);
  await settle();
  assert.equal(rowValue(env, 'ai-consent-google'), 'On');
  // Own Gemini key through the system keyboard.
  await focusRow(env, 'ai-key-gemini');
  env.fp.press(13);
  await settle();
  const input = env.doc.body.findAll('ss-ime__input')[0];
  assert.equal(input.attributes.type, 'password');
  input.value = 'not valid key!';
  input.dispatch('keydown', { keyCode: IME_DONE });
  await settle();
  assert.match(layerText(env), /does not look like an API key/);
  env.fp.press(13);
  await settle();
  const input2 = env.doc.body.findAll('ss-ime__input')[0];
  input2.value = FAKE_KEY;
  input2.dispatch('keydown', { keyCode: IME_DONE });
  await settle();
  assert.equal(await env.ctx.platform.keyStore.load('ai_key_gemini'), FAKE_KEY);
  assert.equal(env.doc.body.textContent.includes(FAKE_KEY), false, 'never displayed');
  // Connection test.
  await focusRow(env, 'ai-test-gemini');
  env.fp.press(13);
  await settle(12);
  assert.match(rowValue(env, 'ai-prov-gemini') || '', /^OK · gemini-3\.5-flash-lite · \d+ ms$/);
  assert.match(layerText(env), /2 models are available/);
  assert.ok(env.gem.requests.every((r) => !r.url.includes(FAKE_KEY) && header(r, 'x-goog-api-key') === FAKE_KEY));
  // Models are loaded: routing now offers Gemini for a text task, not for an audio task.
  await focusRow(env, 'ai-route-epg.summary');
  assert.equal(rowValue(env, 'ai-route-epg.summary'), 'Not set');
  env.fp.press(13);
  await settle();
  assert.equal(rowValue(env, 'ai-route-epg.summary'), 'Google Gemini · Automatic');
  env.fp.press(13);
  await settle();
  assert.equal(rowValue(env, 'ai-route-epg.summary'), 'Google Gemini · gemini-3.5-flash-lite');
  await focusRow(env, 'ai-route-subtitle.generate');
  env.fp.press(13);
  await settle();
  assert.equal(rowValue(env, 'ai-route-subtitle.generate'), 'Not set', 'no implemented provider can transcribe audio: nothing offered');
  assert.match(layerText(env), /No provider can do this yet/);
  // Fallback switch reveals fallback rows.
  assert.equal(rowEl(env, 'ai-fallback-epg.summary'), undefined);
  await focusRow(env, 'ai-fallback');
  env.fp.press(13);
  await settle();
  assert.equal(rowValue(env, 'ai-fallback'), 'On');
  await seeRow(env, 'ai-fallback-epg.summary');
  // Budget cycles.
  await focusRow(env, 'ai-budget-requests');
  const before = rowValue(env, 'ai-budget-requests');
  env.fp.press(13);
  await settle();
  assert.notEqual(rowValue(env, 'ai-budget-requests'), before);
  // Remove key: Cancel first.
  await focusRow(env, 'ai-key-remove-gemini');
  env.fp.press(13);
  assert.equal(focusedButton(env), 'Cancel');
  env.fp.press(39); env.fp.press(13);
  await settle();
  assert.equal(await env.ctx.platform.keyStore.load('ai_key_gemini'), null);
  assert.equal(JSON.stringify(env.ctx.log.entries()).includes(FAKE_KEY), false, 'key never logged');
  assert.equal(env.ctx.ai.settings.get().enabled, false, 'master switch untouched by tests and routing');
});
