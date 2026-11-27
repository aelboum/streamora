// Configuration management. Defaults come from the probe measurements (docs/PROBE2-REPORT.md)
// and ARCHITECTURE.md rev 3. Stored overrides (KV key "config") are validated field by field;
// values outside the allowed range fall back to the default and are reported as warnings.
// Security floors cannot be lowered by configuration (PIN iterations >= 600,000, Stage 4B P1).
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { LogLevel } from '../utils/log.ts';

export interface AppConfig {
  network: {
    requestTimeoutMs: number;
    streamIdleTimeoutMs: number;
    streamTotalTimeoutMs: number;
    maxResponseChars: number;
    /** Largest playlist download (characters). 50 MB parsed in about 3 s on the TV [M]. */
    maxPlaylistChars: number;
    retryAttempts: number;
  };
  storage: {
    /** About 3 s to read at 1.5 MB/s [M]. */
    sectionBudgetChars: number;
    sectionMaxChars: number;
  };
  security: {
    pinIterations: number;
    pinMaxAttempts: number;
    pinLockoutMs: number;
  };
  player: {
    /** 2 s buffer: 3.85 s zap, stable; 1 s unstable [M]. */
    liveBufferSec: number;
    prepareTimeoutMs: number;
    /** Reopen once when AVPlay has not prepared this long after its first buffering report; 0 = off (Stage 5.1). */
    prepareStallMs: number;
    zapDebounceMs: number;
    /** Stage 10: a typed channel number is tuned this long after its last digit. */
    numberEntryMs: number;
  };
  ui: {
    keyRepeatThrottleMs: number;
    language: 'en' | 'nl' | 'fr' | 'es' | 'de';
    theme: 'dark' | 'light';
    /** 'auto' = Samsung IME where available, app keyboard otherwise; 'app' = always the app keyboard. */
    keyboard: 'auto' | 'app';
  };
  epg: {
    pastHours: number;
    futureHours: number;
    staleHours: number;
    maxPerChannel: number;
    maxProgrammes: number;
    /** Offset (minutes) for XMLTV times without one. */
    defaultOffsetMin: number;
    /** Largest compressed (.gz) guide download, in megabytes; the decompressed guide is limited by network.maxPlaylistChars. */
    maxGzipMB: number;
  };
  logging: {
    level: LogLevel;
    capacity: number;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  network: {
    requestTimeoutMs: 15000,
    streamIdleTimeoutMs: 20000,
    streamTotalTimeoutMs: 300000,
    maxResponseChars: 2000000,
    maxPlaylistChars: 100000000,
    retryAttempts: 3
  },
  storage: { sectionBudgetChars: 5000000, sectionMaxChars: 20000000 },
  security: { pinIterations: 600000, pinMaxAttempts: 5, pinLockoutMs: 60000 },
  player: { liveBufferSec: 2, prepareTimeoutMs: 15000, prepareStallMs: 3000, zapDebounceMs: 400, numberEntryMs: 2000 },
  ui: { keyRepeatThrottleMs: 110, language: 'en', theme: 'dark', keyboard: 'auto' },
  epg: { pastHours: 2, futureHours: 24, staleHours: 12, maxPerChannel: 300, maxProgrammes: 400000, defaultOffsetMin: 0, maxGzipMB: 30 },
  logging: { level: 'info', capacity: 200 }
};

type NumRule = [number, number];
const NUMBER_RULES: Record<string, Record<string, NumRule>> = {
  network: {
    requestTimeoutMs: [1000, 120000], streamIdleTimeoutMs: [1000, 120000], streamTotalTimeoutMs: [10000, 1200000],
    maxResponseChars: [10000, 20000000], maxPlaylistChars: [100000, 200000000], retryAttempts: [1, 5]
  },
  storage: { sectionBudgetChars: [100000, 50000000], sectionMaxChars: [100000, 100000000] },
  security: { pinIterations: [600000, 2000000], pinMaxAttempts: [3, 10], pinLockoutMs: [10000, 3600000] },
  player: { liveBufferSec: [1, 10], prepareTimeoutMs: [5000, 60000], prepareStallMs: [0, 15000], zapDebounceMs: [0, 2000], numberEntryMs: [500, 10000] },
  ui: { keyRepeatThrottleMs: [50, 500] },
  epg: { pastHours: [0, 24], futureHours: [6, 168], staleHours: [1, 72], maxPerChannel: [20, 2000], maxProgrammes: [1000, 2000000], defaultOffsetMin: [-840, 840], maxGzipMB: [1, 60] },
  logging: { capacity: [50, 2000] }
};
const ENUM_RULES: Record<string, Record<string, string[]>> = {
  ui: { language: ['en', 'nl', 'fr', 'es', 'de'], theme: ['dark', 'light'], keyboard: ['auto', 'app'] },
  logging: { level: ['debug', 'info', 'warn', 'error'] }
};

export interface ConfigLoad {
  config: AppConfig;
  warnings: string[];
}

function cloneDefaults(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/** Applies an override object onto the defaults. Unknown sections/fields are ignored with a warning. */
export function resolveConfig(override: unknown): ConfigLoad {
  const cfg = cloneDefaults() as unknown as Record<string, Record<string, unknown>>;
  const warnings: string[] = [];
  if (override === null || override === undefined) {
    return { config: cfg as unknown as AppConfig, warnings: warnings };
  }
  if (typeof override !== 'object') {
    warnings.push('config override is not an object');
    return { config: cfg as unknown as AppConfig, warnings: warnings };
  }
  const src = override as Record<string, unknown>;
  for (const section in src) {
    if (!Object.prototype.hasOwnProperty.call(src, section)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cfg, section)) {
      warnings.push('unknown section ' + section);
      continue;
    }
    const fields = src[section];
    if (!fields || typeof fields !== 'object') {
      warnings.push('section ' + section + ' is not an object');
      continue;
    }
    const f = fields as Record<string, unknown>;
    for (const key in f) {
      if (!Object.prototype.hasOwnProperty.call(f, key)) {
        continue;
      }
      const nr = NUMBER_RULES[section] && NUMBER_RULES[section][key];
      const er = ENUM_RULES[section] && ENUM_RULES[section][key];
      const v = f[key];
      if (nr) {
        if (typeof v === 'number' && isFinite(v) && v >= nr[0] && v <= nr[1]) {
          cfg[section][key] = Math.floor(v);
        } else {
          warnings.push(section + '.' + key + ' out of range; using default');
        }
      } else if (er) {
        if (typeof v === 'string' && er.indexOf(v) >= 0) {
          cfg[section][key] = v;
        } else {
          warnings.push(section + '.' + key + ' invalid; using default');
        }
      } else {
        warnings.push('unknown setting ' + section + '.' + key);
      }
    }
  }
  const c = cfg as unknown as AppConfig;
  if (c.storage.sectionBudgetChars > c.storage.sectionMaxChars) {
    c.storage.sectionBudgetChars = c.storage.sectionMaxChars;
    warnings.push('storage.sectionBudgetChars capped at sectionMaxChars');
  }
  return { config: c, warnings: warnings };
}

export function loadConfig(kv: KeyValueStore): ConfigLoad {
  const override = kv.get<unknown>('config', function (x): x is unknown { return typeof x === 'object'; }, null);
  return resolveConfig(override);
}

/** Validates and stores an override; returns the warnings it would produce (nothing is stored if any). */
export function saveConfigOverride(kv: KeyValueStore, override: Record<string, unknown>): string[] {
  const r = resolveConfig(override);
  if (r.warnings.length === 0) {
    kv.set('config', override);
  }
  return r.warnings;
}
