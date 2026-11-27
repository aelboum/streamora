// DEV BUILDS ONLY. scripts/build.mjs replaces this module with dev-hooks.release.ts in
// release builds. Keep the exported signature identical to the release stub.
import type { Logger } from '../utils/log.ts';
import type { Platform } from '../app/platform/platform.ts';
import type { BuildInfo } from '../app/build-info.ts';
import { startLogSink } from './log-sink.ts';
import { runDeviceSelfTest } from './device-selftest.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import { createQrTestScreen, QR_TEST_SCREEN } from './qr-pairing/screen.ts';
import { testServerUrl } from './qr-pairing/protocol.ts';

export interface DevToolsContext {
  log: Logger;
  platform: Platform;
  build: BuildInfo;
  /** The started app, for UI self-tests (dev builds only). */
  app?: DevApp;
}

export function installDevTools(ctx: DevToolsContext): void {
  if (!ctx.build.devSinkUrl) {
    ctx.log.info('dev log sink not configured (set SS_DEV_SINK_URL at build time)');
    return;
  }
  registerQrPairingTest(ctx);
  const sink = startLogSink({ url: ctx.build.devSinkUrl, logger: ctx.log });
  if (sink.enabled) {
    ctx.log.info('dev log sink enabled', { build: ctx.build.mode, version: ctx.build.version });
    ctx.log.info('platform', { info: ctx.platform.info(), capabilities: ctx.platform.capabilities() });
    // Give start-up a moment, then exercise the platform adapters on the device.
    setTimeout(function () { runDeviceSelfTest(ctx.platform, ctx.log, ctx.build.devSinkUrl, ctx.app); }, 1500);
  }
}

/**
 * EXPERIMENTAL QR pairing UI test (docs/AI-02-QR-UI-TEST-REPORT.md): registers the test screen
 * when a dev log sink is configured (the test server runs on the same PC, port 8095) and the
 * platform has a cryptographic random source. Settings → AI Intelligence then shows the row
 * "Phone pairing test (experimental)". Release builds never contain this code.
 */
export function registerQrPairingTest(ctx: DevToolsContext): boolean {
  const server = testServerUrl(ctx.build.devSinkUrl);
  const c = (typeof window !== 'undefined' ? (window as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto : undefined);
  if (!server || !ctx.app || !c || !c.getRandomValues) {
    ctx.log.info('qr pairing test not available', { server: !!server, crypto: !!(c && c.getRandomValues) });
    return false;
  }
  const getRandom = c.getRandomValues.bind(c);
  ctx.app.started.router.register(QR_TEST_SCREEN, function (_p, nav) {
    return createQrTestScreen({
      doc: document, serverUrl: server, xhrFactory: ctx.platform.xhrFactory, now: function () { return Date.now(); },
      setTimer: function (fn, ms) { return setTimeout(fn, ms); }, clearTimer: function (h) { clearTimeout(h as number); },
      randomBytes: function (n) { const a = new Uint8Array(n); getRandom(a); return Array.prototype.slice.call(a) as number[]; }
    }, nav);
  });
  ctx.log.info('qr pairing test registered', { port: 8095 });
  return true;
}
