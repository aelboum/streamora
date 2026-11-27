// AICacheManager (AI-02): caches AI answers to save quota. One file in the platform file store,
// `ai-cache.json` (separate from the playlist catalogue `cat.*` files, which it never touches; the
// DI-1 catalogue cleanup only removes `cat.*` files of removed playlists).
//   - keys are hashes of (namespace, model, request); the request text itself is not stored;
//   - values are answer strings with an expiry; least recently used entries go first when
//     maxEntries or maxChars is reached;
//   - loaded lazily on first use; saved with a short delay (one write for a burst of answers);
//   - an unreadable cache file is ignored and replaced on the next save (it holds no user data
//     that cannot be fetched again). Clear removes the file.
// Without a file store the cache lives in memory for the session only.
import type { FileStore } from '../app/platform/platform.ts';

export const AI_CACHE_FILE = 'ai-cache.json';

export interface AiCacheLimits {
  maxEntries: number;
  maxChars: number;
  defaultTtlMs: number;
  saveDelayMs: number;
}

export interface AiCacheStats { entries: number; chars: number; persistent: boolean }

export interface AiCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  clear(): Promise<void>;
  stats(): AiCacheStats;
  /** Writes pending changes now (tests, app hide). */
  flush(): Promise<void>;
}

interface Entry { v: string; exp: number }

/** FNV-1a over UTF-16 code units, two seeds → 16 hex chars. Not cryptographic; collision-safe enough for a cache. */
export function aiCacheKey(parts: string[]): string {
  const s = parts.join('\u0001');
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a ^= c; a = (a * 0x01000193) >>> 0;
    b ^= c; b = (b * 0x5bd1e995) >>> 0; b ^= b >>> 15;
  }
  const hx = function (n: number): string { const t = (n >>> 0).toString(16); return '00000000'.substring(t.length) + t; };
  return hx(a) + hx(b);
}

export function createAiCache(files: FileStore | null, now: () => number, limits: AiCacheLimits,
  timers: { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void }): AiCache {
  // Insertion order of `order` = least recently used first.
  let map: Record<string, Entry> = {};
  let order: string[] = [];
  let chars = 0;
  let loaded: Promise<void> | null = null;
  let saveTimer: unknown = null;
  let dirty = false;
  let chain: Promise<void> = Promise.resolve();

  function size(k: string, e: Entry): number { return k.length + e.v.length + 16; }

  function drop(k: string): void {
    const e = map[k];
    if (!e) { return; }
    chars -= size(k, e);
    delete map[k];
    const i = order.indexOf(k);
    if (i >= 0) { order.splice(i, 1); }
  }

  function touch(k: string): void {
    const i = order.indexOf(k);
    if (i >= 0) { order.splice(i, 1); }
    order.push(k);
  }

  function evict(): void {
    while (order.length && (order.length > limits.maxEntries || chars > limits.maxChars)) {
      drop(order[0]);
    }
  }

  function load(): Promise<void> {
    if (loaded) { return loaded; }
    loaded = !files ? Promise.resolve() : files.read(AI_CACHE_FILE).then(function (text) {
      if (!text) { return; }
      let o: { v?: unknown; e?: unknown } | null = null;
      try { o = JSON.parse(text); } catch (e) { o = null; }
      if (!o || o.v !== 1 || !Array.isArray(o.e)) { return; }
      const t = now();
      const list = o.e as unknown[];
      for (let i = 0; i < list.length; i++) {
        const r = list[i] as unknown[];
        if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string' || typeof r[2] !== 'number') { continue; }
        if ((r[2] as number) <= t || map[r[0] as string]) { continue; }
        const e: Entry = { v: r[1] as string, exp: r[2] as number };
        map[r[0] as string] = e;
        order.push(r[0] as string);
        chars += size(r[0] as string, e);
      }
      evict();
    }, function () { /* unreadable: start empty */ });
    return loaded;
  }

  function write(): Promise<void> {
    if (!files || !dirty) { return Promise.resolve(); }
    dirty = false;
    const t = now();
    const out: unknown[] = [];
    for (let i = 0; i < order.length; i++) {
      const e = map[order[i]];
      if (e && e.exp > t) { out.push([order[i], e.v, e.exp]); }
    }
    const fs = files;
    const text = JSON.stringify({ v: 1, e: out });
    chain = chain.then(function () { return fs.write(AI_CACHE_FILE, text); }).then(null, function () { dirty = true; });
    return chain;
  }

  function scheduleSave(): void {
    dirty = true;
    if (!files || saveTimer !== null) { return; }
    saveTimer = timers.setTimer(function () { saveTimer = null; write(); }, limits.saveDelayMs);
  }

  return {
    get: function (key: string): Promise<string | null> {
      return load().then(function () {
        const e = map[key];
        if (!e) { return null; }
        if (e.exp <= now()) { drop(key); scheduleSave(); return null; }
        touch(key);
        return e.v;
      });
    },
    set: function (key: string, value: string, ttlMs?: number): Promise<void> {
      return load().then(function () {
        drop(key);
        if (typeof value !== 'string' || key.length + value.length + 16 > limits.maxChars) { return; }
        const e: Entry = { v: value, exp: now() + (ttlMs && ttlMs > 0 ? ttlMs : limits.defaultTtlMs) };
        map[key] = e;
        order.push(key);
        chars += size(key, e);
        evict();
        scheduleSave();
      });
    },
    clear: function (): Promise<void> {
      map = {};
      order = [];
      chars = 0;
      dirty = false;
      loaded = Promise.resolve();
      if (saveTimer !== null) { timers.clearTimer(saveTimer); saveTimer = null; }
      if (!files) { return Promise.resolve(); }
      const fs = files;
      chain = chain.then(function () { return fs.remove(AI_CACHE_FILE); }).then(null, function () { /* already gone */ });
      return chain;
    },
    stats: function (): AiCacheStats {
      return { entries: order.length, chars: chars, persistent: !!files };
    },
    flush: function (): Promise<void> {
      if (saveTimer !== null) { timers.clearTimer(saveTimer); saveTimer = null; }
      return load().then(write);
    }
  };
}
