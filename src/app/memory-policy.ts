// CP1: memory policy per platform (approved R0 decision 5).
// Samsung Tizen and Android report real free system memory (tizen.systeminfo, ActivityManager);
// there the existing floors apply unchanged: 150 MB for expensive work (live catalogue cache,
// sorting, category manager, search loading, write pressure) and 200 MB for guide downloads.
// Platforms without a memory API (browser now; webOS and Titan later) are "not measured": no
// floor is ever checked against a made-up number. They get fixed limits instead (bounded catalogue
// cache here; LRU caches and bounded loading in the adapters that need them). Diagnostics say
// "not measured" and show the limits, never an estimated free-memory figure.
import type { Platform } from './platform/platform.ts';

/** Expensive work stops below this much free memory (Stage 9/10/11/14 floor; your decision). */
export const WORK_FLOOR_MB = 150;
/** Guide (XMLTV) downloads stop below this (Stage 7E). */
export const GUIDE_FLOOR_MB = 200;
/** Live catalogue kept in memory after Live TV closes, on measured platforms (Stage 9). */
export const LIVE_CACHE_MAX_CHARS = 8000000;
/** Without a measurement the cache is kept only for smaller catalogues (≈ 25,000 channels). */
export const UNMEASURED_LIVE_CACHE_MAX_CHARS = 4000000;

export interface MemoryPolicy {
  /** True when freeMB() is a measurement of the device (Tizen, Android). */
  readonly measured: boolean;
  /** Free memory in MB as measured now; −1 when the platform cannot measure it (or the read failed). */
  freeMB(): number;
  /** Floor for expensive work and for guide downloads; 0 = not checked (not measured). */
  readonly workFloorMB: number;
  readonly guideFloorMB: number;
  /** Measured and below the work floor. Never true without a measurement. */
  low(): boolean;
  /** Bounded loading. */
  readonly liveCacheMaxChars: number;
  /** For diagnostics: "312 MB free (measured)" or "not measured; limits apply". */
  describe(): string;
}

export function isMeasuredPlatform(name: string): boolean {
  return name === 'tizen' || name === 'android';
}

export function createMemoryPolicy(platform: Pick<Platform, 'name' | 'memory'>): MemoryPolicy {
  const measured = isMeasuredPlatform(platform.name);
  function freeMB(): number {
    if (!measured) { return -1; }
    try {
      const mb = platform.memory().availableMB;
      return typeof mb === 'number' && mb >= 0 ? mb : -1;
    } catch (e) {
      return -1;
    }
  }
  return {
    measured: measured,
    freeMB: freeMB,
    workFloorMB: measured ? WORK_FLOOR_MB : 0,
    guideFloorMB: measured ? GUIDE_FLOOR_MB : 0,
    low: function () {
      const mb = freeMB();
      return measured && mb >= 0 && mb < WORK_FLOOR_MB;
    },
    liveCacheMaxChars: measured ? LIVE_CACHE_MAX_CHARS : UNMEASURED_LIVE_CACHE_MAX_CHARS,
    describe: function () {
      if (!measured) { return 'not measured; limits apply (live cache up to ' + UNMEASURED_LIVE_CACHE_MAX_CHARS + ' chars)'; }
      const mb = freeMB();
      return mb >= 0 ? mb + ' MB free (measured)' : 'measurement unavailable right now';
    }
  };
}
