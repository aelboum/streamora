import type { Platform, PlatformWindow } from './platform.ts';
import { createTizenPlatform } from './tizen-platform.ts';
import { createBrowserPlatform } from './browser-platform.ts';

export function detectPlatform(win: PlatformWindow): Platform {
  const t = win.tizen;
  if (t && t.application && t.systeminfo) {
    return createTizenPlatform(win);
  }
  return createBrowserPlatform(win);
}
