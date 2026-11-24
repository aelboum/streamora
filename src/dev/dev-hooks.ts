// DEV BUILDS ONLY. scripts/build.mjs replaces this module with dev-hooks.release.ts in
// release builds. Keep the exported signature identical to the release stub.
import type { Logger } from '../utils/log.ts';
import type { Platform } from '../app/platform/platform.ts';
import type { BuildInfo } from '../app/build-info.ts';
import { startLogSink } from './log-sink.ts';
import { runDeviceSelfTest } from './device-selftest.ts';
import type { DevApp } from './device-selftest-stage4b.ts';

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
  const sink = startLogSink({ url: ctx.build.devSinkUrl, logger: ctx.log });
  if (sink.enabled) {
    ctx.log.info('dev log sink enabled', { build: ctx.build.mode, version: ctx.build.version });
    ctx.log.info('platform', { info: ctx.platform.info(), capabilities: ctx.platform.capabilities() });
    // Give start-up a moment, then exercise the platform adapters on the device.
    setTimeout(function () { runDeviceSelfTest(ctx.platform, ctx.log, ctx.build.devSinkUrl, ctx.app); }, 1500);
  }
}
