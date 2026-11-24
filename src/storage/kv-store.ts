// Small-value storage on localStorage (settings, playlist definitions without secrets, user lists,
// parental policy). Keys are namespaced `ss:v1:<name>`; every value is an envelope
// {"v": schemaVersion, "d": data}. Reads validate and fall back; writes never throw.
import type { LocalStore } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';

export const KV_PREFIX = 'ss:v1:';
const NAME_RE = /^[a-z][a-z0-9.\-_]{0,63}$/;

/** Upgrades data written with an older schema version; return undefined to discard it. */
export type Migration = (fromVersion: number, data: unknown) => unknown;

export interface KeyValueStore {
  get<T>(name: string, validate: (x: unknown) => x is T, fallback: T, schema?: number, migrate?: Migration): T;
  /** False when the value could not be stored (quota, serialisation); the error is logged. */
  set(name: string, value: unknown, schema?: number): boolean;
  remove(name: string): void;
  /** Names (without prefix) currently stored by this app. */
  names(): string[];
  /** Removes every ScreenShelf key. */
  clearAll(): void;
}

function checkName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error('invalid storage key name');
  }
}

export function createKeyValueStore(local: LocalStore, log?: Logger): KeyValueStore {
  return {
    get: function <T>(name: string, validate: (x: unknown) => x is T, fallback: T, schema?: number, migrate?: Migration): T {
      checkName(name);
      const want = schema || 1;
      const raw = local.getItem(KV_PREFIX + name);
      if (raw === null) {
        return fallback;
      }
      let env: { v?: unknown; d?: unknown };
      try {
        env = JSON.parse(raw);
      } catch (e) {
        if (log) { log.warn('kv: corrupt value discarded', { name: name }); }
        local.removeItem(KV_PREFIX + name);
        return fallback;
      }
      if (!env || typeof env !== 'object' || typeof env.v !== 'number') {
        if (log) { log.warn('kv: malformed envelope discarded', { name: name }); }
        local.removeItem(KV_PREFIX + name);
        return fallback;
      }
      let data = env.d;
      if (env.v !== want) {
        data = migrate && env.v < want ? migrate(env.v, data) : undefined;
        if (data === undefined) {
          if (log) { log.info('kv: outdated value reset', { name: name, from: env.v, to: want }); }
          local.removeItem(KV_PREFIX + name);
          return fallback;
        }
      }
      if (!validate(data)) {
        if (log) { log.warn('kv: invalid value discarded', { name: name }); }
        local.removeItem(KV_PREFIX + name);
        return fallback;
      }
      return data;
    },
    set: function (name, value, schema) {
      checkName(name);
      let text: string;
      try {
        text = JSON.stringify({ v: schema || 1, d: value });
      } catch (e) {
        if (log) { log.error('kv: value not serialisable', { name: name }, e); }
        return false;
      }
      if (text === undefined) {
        return false;
      }
      try {
        local.setItem(KV_PREFIX + name, text);
        return true;
      } catch (e) {
        if (log) { log.error('kv: write failed', { name: name, chars: text.length }, e); }
        return false;
      }
    },
    remove: function (name) {
      checkName(name);
      local.removeItem(KV_PREFIX + name);
    },
    names: function () {
      const out: string[] = [];
      const keys = local.keys();
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(KV_PREFIX) === 0) {
          out.push(keys[i].substring(KV_PREFIX.length));
        }
      }
      return out.sort();
    },
    clearAll: function () {
      const keys = local.keys();
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(KV_PREFIX) === 0) {
          local.removeItem(keys[i]);
        }
      }
    }
  };
}
