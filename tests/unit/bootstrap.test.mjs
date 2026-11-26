// Application bootstrap, lifecycle and error boundary, run with the platform double and a fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppContext, startApp } from '../../src/app/bootstrap.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { installErrorBoundary, toAppError } from '../../src/app/errors.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakePlatform } from '../fakes/fake-platform.mjs';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { KV_PREFIX } from '../../src/storage/kv-store.ts';

const BUILD = { mode: 'test', version: '0.0.0-test', devSinkUrl: '' };

function boot(fp) {
  const clock = createFakeClock();
  const ctx = createAppContext({ platform: fp.platform, build: BUILD, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { ctx, clock };
}

test('context: all services present on a capable platform', () => {
  const fp = createFakePlatform();
  const { ctx } = boot(fp);
  assert.ok(ctx.catalogue && ctx.secrets && ctx.pin && ctx.http && ctx.kv && ctx.lifecycle && ctx.playlists);
  assert.equal(ctx.config.player.liveBufferSec, 2);
  assert.deepEqual(ctx.warnings, ['secure key store is session-only: credentials are forgotten on restart', 'video playback unavailable on this platform']);
  assert.ok(ctx.epg && ctx.lists, 'Stage 5 services present');
  assert.equal(ctx.engine, null, 'no engine factory in the test platform');
});

test('context: missing capabilities disable features instead of degrading security', () => {
  const fp = createFakePlatform({ fileStore: null, keyStore: null, crypto: null, localStore: null });
  const { ctx } = boot(fp);
  assert.equal(ctx.catalogue, null);
  assert.equal(ctx.secrets, null, 'no plaintext credential fallback');
  assert.equal(ctx.pin, null, 'no JS PBKDF2 fallback');
  assert.equal(ctx.playlists, null, 'no playlist service without secure credential storage');
  assert.equal(ctx.warnings.length, 6);
  assert.equal(ctx.epg, null, 'no EPG service without playlists');
  assert.ok(ctx.log.entries().some((e) => e.level === 'warn' && /parental PIN disabled/.test(e.msg)));
});

test('context: stored configuration is loaded and invalid values reported', () => {
  const fp = createFakePlatform();
  fp.platform.localStore.setItem(KV_PREFIX + 'config', JSON.stringify({ v: 1, d: { ui: { theme: 'light' }, player: { liveBufferSec: 0 } } }));
  const { ctx } = boot(fp);
  assert.equal(ctx.config.ui.theme, 'light');
  assert.equal(ctx.config.player.liveBufferSec, 2);
  assert.ok(ctx.warnings.some((w) => /liveBufferSec/.test(w)));
});

test('start: keys registered, root screen mounted, Back opens exit dialog, No closes it', () => {
  const fp = createFakePlatform();
  const { ctx, clock } = boot(fp);
  const doc = createFakeDocument();
  const app = startApp(ctx, createDomHost(doc, doc.body), doc, clock.now);
  assert.ok(app.registeredKeys.includes('ChannelUp'));
  assert.deepEqual(app.router.stack(), ['home'], 'Stage 7B.1: the Home hub is the root screen');
  assert.equal(doc.body.childNodes.length, 1);
  assert.match(doc.body.textContent, /ELITE/);
  assert.match(doc.body.textContent, /Add account/);
  assert.match(doc.body.textContent, /Settings/);
  // Without secure storage there is no playlist service: the diagnostics screen is the root.
  const bare = createFakePlatform({ fileStore: null });
  const b = boot(bare);
  const doc2 = createFakeDocument();
  assert.deepEqual(startApp(b.ctx, createDomHost(doc2, doc2.body), doc2, b.clock.now).router.stack(), ['diagnostics']);
  assert.match(doc2.body.textContent, /Secure key store/);

  assert.equal(fp.press(10009), true, 'Back is default-prevented');
  assert.equal(app.router.overlay(), 'exit-dialog');
  const focused = doc.body.findAll('is-focused');
  assert.equal(focused.length, 2, 'one focused button per layer');
  assert.equal(focused[1].textContent, 'No', 'safe default');
  fp.press(13); // OK on "No"
  assert.equal(app.router.overlay(), null);
  assert.equal(fp.state.exited, 0);
});

test('start: exit path notifies the lifecycle and exits the platform', () => {
  const fp = createFakePlatform();
  const { ctx, clock } = boot(fp);
  const doc = createFakeDocument();
  const events = [];
  ctx.lifecycle.on((e) => events.push(e));
  startApp(ctx, createDomHost(doc, doc.body), doc, clock.now);
  fp.press(10009);
  fp.press(39); // to "Yes, exit"
  fp.press(13);
  assert.equal(fp.state.exited, 1);
  assert.deepEqual(events, ['exiting']);
});

test('lifecycle: visibility and network changes become events; dispose detaches', () => {
  const fp = createFakePlatform();
  const { ctx } = boot(fp);
  const events = [];
  ctx.lifecycle.on((e) => events.push(e));
  fp.setVisible(false);
  fp.setVisible(false);
  fp.setVisible(true);
  fp.setOnline(false);
  fp.setOnline(true);
  assert.deepEqual(events, ['hidden', 'visible', 'offline', 'online']);
  assert.equal(ctx.lifecycle.visible(), true);
  ctx.lifecycle.dispose();
  fp.setVisible(false);
  assert.equal(events.length, 4);
});

test('error boundary: uncaught errors and rejections are logged (redacted) and the handler is restored', () => {
  const log = createLogger();
  const seen = [];
  const listeners = {};
  const target = {
    onerror: null,
    addEventListener: (t, cb) => { listeners[t] = cb; },
    removeEventListener: (t) => { delete listeners[t]; }
  };
  const off = installErrorBoundary(target, log, (e) => seen.push(e));
  assert.equal(target.onerror('boom', 'app.js', 1, 1, new Error('GET http://h/live/u/p/1.ts failed')), false);
  listeners.unhandledrejection({ reason: new Error('rejected') });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].userMessage, 'Something went wrong.');
  assert.doesNotMatch(JSON.stringify(log.entries()), /\/u\/p\//);
  off();
  assert.equal(target.onerror, null);
  assert.equal(listeners.unhandledrejection, undefined);
  assert.equal(toAppError('x', 'network').kind, 'network');
});

test('Settings: language switches at once (screens rebuilt in Dutch) and is kept for the next start', () => {
  const fp = createFakePlatform();
  const { ctx, clock } = boot(fp);
  const doc = createFakeDocument();
  const app = startApp(ctx, createDomHost(doc, doc.body), doc, clock.now, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  assert.ok(app.router.push('settings'));
  const rows = () => doc.body.findAll('ss-set__row');
  assert.equal(rows()[0].attributes['data-row'], 'accounts');
  // ▼ ▼ to "Nederlands", OK.
  app.router.handleKey({ key: 'down', repeat: false, heldMs: 0, code: 40 });
  app.router.handleKey({ key: 'down', repeat: false, heldMs: 0, code: 40 });
  app.router.handleKey({ key: 'ok', repeat: false, heldMs: 0, code: 13 });
  assert.deepEqual(app.router.stack(), ['home', 'settings'], 'rebuilt: Home + Settings');
  assert.match(doc.body.textContent, /Instellingen/);
  assert.match(doc.body.textContent, /Taal/);
  assert.equal(ctx.kv.get('config', (x) => typeof x === 'object', null).ui.language, 'nl');
  const again = boot(fp);
  assert.equal(again.ctx.config.ui.language, 'nl', 'next start uses the stored language');
});
