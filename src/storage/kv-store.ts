// Small-value storage on localStorage (settings, playlist definitions without secrets, user lists,
// parental policy). Keys are namespaced `ss:v1:<name>`; every value is an envelope
// {"v": schemaVersion, "d": data}. Writes never throw.
//
// DI-1 (data integrity): a read never deletes anything. read() reports exactly what it found
// (ok / missing / read-error / corrupt / malformed / unsupported / invalid) so a caller can tell an
// empty value from an unreadable one. get() keeps its "value or fallback" contract for small
// settings, but an unreadable stored value is copied to a quarantine key first and left in place.
// Quarantine keys: quarantine.<name> (the first bad value seen, never overwritten) and
// quarantine.<name>.2 (the latest different bad value). Logs carry the key name and a code only.
import type { LocalStore } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';

export const KV_PREFIX = 'ss:v1:';
const NAME_RE = /^[a-z][a-z0-9.\-_]{0,63}$/;
const QUARANTINE = 'quarantine.';

/** Upgrades data written with an older schema version; return undefined to discard it. */
export type Migration = (fromVersion: number, data: unknown) => unknown;

export type KvProblem = 'read-error' | 'corrupt' | 'malformed' | 'unsupported' | 'invalid';

/** DI-1: the outcome of a read. `raw` is the stored text (never log it: it may hold addresses). */
export type KvRead<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: KvProblem; raw: string | null };

/** DI-1: storage events for the persistent diagnostics log (key names and codes only). */
export type KvEventSink = (event: string, data: Record<string, unknown>) => void;

export interface KeyValueStore {
  /** Value or fallback. An unreadable stored value is quarantined and kept, never deleted. */
  get<T>(name: string, validate: (x: unknown) => x is T, fallback: T, schema?: number, migrate?: Migration): T;
  /** DI-1: reports exactly what is stored; never changes storage. */
  read<T>(name: string, validate: (x: unknown) => x is T, schema?: number, migrate?: Migration): KvRead<T>;
  /**
   * DI-1: copies an unreadable raw value to the quarantine keys. True when it is preserved there
   * (already or now); false when it could not be stored (the caller must then keep the original).
   */
  quarantine(name: string, raw: string, reason: KvProblem): boolean;
  /** DI-1: the first quarantined raw value of a key, or null. */
  quarantined(name: string): string | null;
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

export function createKeyValueStore(local: LocalStore, log?: Logger, onEvent?: KvEventSink): KeyValueStore {
  // Each problem is reported once per key and kind per session (get() runs often).
  const reported: Record<string, boolean> = {};
  function report(name: string, status: string): void {
    const k = name + '|' + status;
    if (reported[k]) { return; }
    reported[k] = true;
    if (log) { log.warn('kv: unreadable value kept', { name: name, status: status }); }
    if (onEvent) { onEvent('kv-unreadable', { key: name, status: status }); }
  }

  function getRaw(key: string): { ok: true; raw: string | null } | { ok: false } {
    try {
      return { ok: true, raw: local.getItem(key) };
    } catch (e) {
      return { ok: false };
    }
  }

  function read<T>(name: string, validate: (x: unknown) => x is T, schema?: number, migrate?: Migration): KvRead<T> {
    checkName(name);
    const want = schema || 1;
    const r = getRaw(KV_PREFIX + name);
    if (!r.ok) {
      return { status: 'read-error', raw: null };
    }
    const raw = r.raw;
    if (raw === null) {
      return { status: 'missing' };
    }
    let env: { v?: unknown; d?: unknown };
    try {
      env = JSON.parse(raw);
    } catch (e) {
      return { status: 'corrupt', raw: raw };
    }
    if (!env || typeof env !== 'object' || typeof env.v !== 'number') {
      return { status: 'malformed', raw: raw };
    }
    let data = env.d;
    if (env.v !== want) {
      let migrated: unknown;
      try {
        migrated = migrate && env.v < want ? migrate(env.v, data) : undefined;
      } catch (e) {
        migrated = undefined;
      }
      if (migrated === undefined) {
        return { status: 'unsupported', raw: raw };
      }
      data = migrated;
    }
    if (!validate(data)) {
      return { status: 'invalid', raw: raw };
    }
    return { status: 'ok', value: data as T };
  }

  function quarantine(name: string, raw: string, reason: KvProblem): boolean {
    checkName(name);
    const first = QUARANTINE + name;
    if (!NAME_RE.test(first + '.2')) {
      if (onEvent) { onEvent('quarantine-failed', { key: name, reason: reason, why: 'name' }); }
      return false;
    }
    const text = JSON.stringify({ v: 1, d: { reason: reason, raw: raw } });
    const have = getRaw(KV_PREFIX + first);
    if (!have.ok) {
      if (onEvent) { onEvent('quarantine-failed', { key: name, reason: reason, why: 'read' }); }
      return false;
    }
    if (have.raw === text) {
      return true; // already preserved: repeated start-ups do not touch the evidence
    }
    // The first bad value is never overwritten; a later, different one goes to the second slot.
    const target = have.raw === null ? first : first + '.2';
    if (target !== first) {
      const second = getRaw(KV_PREFIX + target);
      if (second.ok && second.raw === text) { return true; }
    }
    try {
      local.setItem(KV_PREFIX + target, text);
    } catch (e) {
      if (log) { log.error('kv: quarantine failed; value kept in place', { name: name, chars: text.length }); }
      if (onEvent) { onEvent('quarantine-failed', { key: name, reason: reason, why: 'write' }); }
      return false;
    }
    const slot = target === first ? 1 : 2;
    if (log) { log.warn('kv: unreadable value quarantined', { name: name, reason: reason, slot: slot }); }
    if (onEvent) { onEvent('quarantined', { key: name, reason: reason, slot: slot }); }
    return true;
  }

  return {
    read: read,
    quarantine: quarantine,

    quarantined: function (name) {
      checkName(name);
      const r = getRaw(KV_PREFIX + QUARANTINE + name);
      if (!r.ok || r.raw === null) { return null; }
      try {
        const env = JSON.parse(r.raw);
        return env && env.d && typeof env.d.raw === 'string' ? env.d.raw : null;
      } catch (e) {
        return null;
      }
    },

    get: function <T>(name: string, validate: (x: unknown) => x is T, fallback: T, schema?: number, migrate?: Migration): T {
      const r = read(name, validate, schema, migrate);
      if (r.status === 'ok') {
        return r.value;
      }
      if (r.status === 'missing') {
        return fallback;
      }
      report(name, r.status);
      if (r.raw !== null) {
        quarantine(name, r.raw, r.status);
      }
      return fallback;
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
        if (onEvent) { onEvent('kv-write-failed', { key: name, chars: text.length }); }
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
