// Entry point bundled into dist/<mode>/app.js. All logic lives in bootstrap.ts (tested on Windows);
// this file only wires the real window, document and timers.
import { buildInfo } from './build-info.ts';
import { detectPlatform } from './platform/detect.ts';
import type { PlatformWindow } from './platform/platform.ts';
import { createAppContext, startApp } from './bootstrap.ts';
import { createDomHost } from './dom-host.ts';
import { installErrorBoundary } from './errors.ts';
import type { ErrorTarget } from './errors.ts';
import { clear } from '../utils/dom.ts';
// In release builds scripts/build.mjs swaps this module for dev-hooks.release.ts (a no-op).
import { installDevTools } from '../dev/dev-hooks.ts';
import { createAvplayEngine } from '../player/avplay-engine.ts';
import type { AvplayHost } from '../player/avplay-engine.ts';

function showFatal(message: string): void {
  const el = document.getElementById('ss-boot-status');
  if (el) {
    el.className = 'ss-boot-status ss-status--error';
    el.textContent = 'ScreenShelf could not start: ' + message;
  }
}

function start(): void {
  const root = document.getElementById('ss-root');
  if (!root) {
    showFatal('missing #ss-root element');
    return;
  }
  try {
    const build = buildInfo();
    const platform = detectPlatform(window as unknown as PlatformWindow);
    const now = function () { return Date.now(); };
    const ctx = createAppContext({
      platform: platform,
      build: build,
      now: now,
      setTimer: function (fn, ms) { return setTimeout(fn, ms); },
      clearTimer: function (h) { clearTimeout(h as number); },
      engineFactory: function (log) { return createAvplayEngine(window as unknown as AvplayHost, log); }
    });
    installErrorBoundary(window as unknown as ErrorTarget, ctx.log.child('global'), function () { /* logged; UI keeps running */ });
    clear(root);
    const started = startApp(ctx, createDomHost(document, root), document, now);
    installDevTools({ log: ctx.log, platform: platform, build: build, app: { ctx: ctx, started: started, root: root } });
  } catch (e) {
    showFatal(e instanceof Error ? e.message : String(e));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
