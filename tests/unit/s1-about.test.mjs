// S1: Settings → "About EliteStream" opens a read-only About screen (real start-up and router).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppContext, startApp } from '../../src/app/bootstrap.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { createFakePlatform } from '../fakes/fake-platform.mjs';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { missingTranslations } from '../../src/i18n/strings.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 6; i++) { await tick(); } };

async function boot(lang) {
  const fp = createFakePlatform();
  if (lang) { fp.platform.localStore.setItem('ss:v1:config', JSON.stringify({ v: 1, d: { ui: { language: lang } } })); }
  const clk = createFakeClock();
  const ctx = createAppContext({ platform: fp.platform, build: { mode: 'release', version: '0.2.0', devSinkUrl: '' }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  await ctx.playlists.whenChecked();
  const doc = createFakeDocument();
  const app = startApp(ctx, createDomHost(doc, doc.body), doc, clk.now);
  await settle();
  // Count every write from here on: the About screen must not cause any.
  const ls = fp.platform.localStore;
  const writes = { n: 0 };
  const set = ls.setItem.bind(ls);
  const rem = ls.removeItem.bind(ls);
  ls.setItem = (k, v) => { writes.n++; set(k, v); };
  ls.removeItem = (k) => { writes.n++; rem(k); };
  return { fp, ctx, doc, app, writes };
}

const layerText = (env) => {
  const layers = env.doc.body.childNodes.filter((n) => n.style.display !== 'none' && n.attributes && n.attributes['data-layer']);
  return layers[layers.length - 1].textContent;
};
const focusedRow = (env) => env.doc.body.findAll('ss-set__row').filter((r) => /is-focused/.test(r.className)).map((r) => r.attributes['data-row'])[0];

async function toAboutRow(env) {
  env.app.router.push('settings');
  await settle();
  for (let i = 0; i < 40 && focusedRow(env) !== 'about'; i++) { env.fp.press(40); }
  assert.equal(focusedRow(env), 'about', 'the About row is focusable with ▼');
}

test('S1: Settings shows one "About EliteStream" row (version as value) instead of the information rows', async () => {
  const env = await boot();
  await toAboutRow(env);
  const ids = env.doc.body.findAll('ss-set__row').map((r) => r.attributes['data-row']);
  assert.ok(ids.includes('about'));
  assert.equal(ids.filter((i) => /^about-/.test(i)).length, 0, 'old information rows gone');
  assert.match(layerText(env), /About EliteStream0\.2\.0/);
  assert.ok(ids.indexOf('diagnostics') === ids.indexOf('about') + 1, 'Diagnostics stays right after About');
});

test('S1: OK opens the About screen with version, platform, screen, storage and licences; Back returns to the row', async () => {
  const env = await boot();
  await toAboutRow(env);
  env.fp.press(13);
  await settle();
  assert.deepEqual(env.app.router.stack().slice(-1), ['about']);
  const text = layerText(env);
  for (const re of [/Version0\.2\.0/, /Platformtizen 3\.0/, /Screen1920 × 1080/, /Storage/, /FontsBarlow/, /SIL Open Font License 1\.1/, /Apache License 2\.0/, /Press Back to return to Settings/]) {
    assert.match(text, re);
  }
  env.fp.press(40); env.fp.press(13); env.fp.press(37); env.fp.press(39);
  assert.deepEqual(env.app.router.stack().slice(-1), ['about'], 'keys other than Back do nothing');
  env.fp.press(10009);
  await settle();
  assert.deepEqual(env.app.router.stack().slice(-1), ['settings']);
  assert.equal(focusedRow(env), 'about', 'focus back on the About row');
  assert.equal(env.writes.n, 0, 'opening About writes nothing');
});

test('S1: Dutch labels; no missing translations', async () => {
  const env = await boot('nl');
  await toAboutRow(env);
  assert.match(layerText(env), /Over EliteStream0\.2\.0/);
  env.fp.press(13);
  await settle();
  const text = layerText(env);
  assert.match(text, /Versie0\.2\.0/);
  assert.match(text, /Lettertypen/);
  assert.match(text, /Apache-licentie 2\.0/);
  assert.match(text, /Druk op Terug/);
  assert.deepEqual(missingTranslations(), []);
});

test('S1: the About screen is one small panel inside the 1080 px frame (no scrolling needed)', async () => {
  const env = await boot();
  await toAboutRow(env);
  env.fp.press(13);
  await settle();
  const shell = env.doc.body.findAll('ss-about')[0];
  assert.deepEqual(shell.childNodes.map((n) => n.className), ['ss-header', 'ss-panel ss-about__panel', 'ss-about__hint']);
  const rows = env.doc.body.findAll('ss-about__list')[0].childNodes.length / 2;
  assert.equal(rows, 5, 'version, platform, screen, storage, fonts');
});
