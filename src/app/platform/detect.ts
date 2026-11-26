import type { Platform, PlatformWindow } from './platform.ts';
import { createTizenPlatform } from './tizen-platform.ts';
import { createBrowserPlatform } from './browser-platform.ts';
import { createAndroidPlatform } from './android-platform.ts';

// CP1: __SS_PLATFORM__ is replaced at bundle time (scripts/build.mjs --platform). With 'all' (the
// default, today's bundle) every adapter is included and chosen at run time as before; with one
// platform the minifier drops the other branches, and their adapters with them.
export function detectPlatform(win: PlatformWindow): Platform {
  if ((__SS_PLATFORM__ === 'all' || __SS_PLATFORM__ === 'android') && win.ElitePlatform) {
    return createAndroidPlatform(win);
  }
  if (__SS_PLATFORM__ === 'all' || __SS_PLATFORM__ === 'tizen') {
    const t = win.tizen;
    if (t && t.application && t.systeminfo) {
      return createTizenPlatform(win);
    }
  }
  return createBrowserPlatform(win);
}
