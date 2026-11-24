// In-memory implementations of the storage interfaces. Used by the browser development
// platform and as Windows test doubles. They enforce the same name rules as the TV versions.
import type { FileStore, KeyStore, LocalStore } from './platform.ts';
import { checkAlias, checkFileName } from './common.ts';

export interface MemoryLocalStoreOptions {
  /** Total characters (keys + values) before setItem throws a QuotaExceededError. */
  quotaChars?: number;
}

export function createMemoryLocalStore(options?: MemoryLocalStoreOptions): LocalStore & { size(): number } {
  const data: Record<string, string> = {};
  const quota = options && options.quotaChars ? options.quotaChars : 0;
  function size(): number {
    let n = 0;
    for (const k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        n += k.length + data[k].length;
      }
    }
    return n;
  }
  return {
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem: function (key, value) {
      const prev = Object.prototype.hasOwnProperty.call(data, key) ? key.length + data[key].length : 0;
      if (quota && size() - prev + key.length + value.length > quota) {
        const err = new Error('quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data[key] = String(value);
    },
    removeItem: function (key) { delete data[key]; },
    keys: function () {
      const out: string[] = [];
      for (const k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k)) {
          out.push(k);
        }
      }
      return out;
    },
    size: size
  };
}

export interface MemoryFileStore extends FileStore {
  /** Test hook: direct access to stored text (for corruption tests). */
  peek(name: string): string | null;
  poke(name: string, text: string): void;
}

export function createMemoryFileStore(): MemoryFileStore {
  const files: Record<string, string> = {};
  function has(name: string): boolean { return Object.prototype.hasOwnProperty.call(files, name); }
  return {
    atomicReplace: true,
    read: function (name) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      return Promise.resolve(has(name) ? files[name] : null);
    },
    write: function (name, text) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      files[name] = String(text);
      return Promise.resolve();
    },
    remove: function (name) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      delete files[name];
      return Promise.resolve();
    },
    list: function () {
      const out: string[] = [];
      for (const k in files) {
        if (has(k)) {
          out.push(k);
        }
      }
      return Promise.resolve(out.sort());
    },
    peek: function (name) { return has(name) ? files[name] : null; },
    poke: function (name, text) { files[name] = text; }
  };
}

/** Non-persistent secret store: secrets live only for the session (browser development, tests). */
export function createMemoryKeyStore(): KeyStore & { count(): number } {
  const secrets: Record<string, string> = {};
  function has(a: string): boolean { return Object.prototype.hasOwnProperty.call(secrets, a); }
  return {
    persistent: false,
    save: function (alias, value) {
      try { checkAlias(alias); } catch (e) { return Promise.reject(e); }
      secrets[alias] = String(value);
      return Promise.resolve();
    },
    load: function (alias) {
      try { checkAlias(alias); } catch (e) { return Promise.reject(e); }
      return Promise.resolve(has(alias) ? secrets[alias] : null);
    },
    remove: function (alias) {
      try { checkAlias(alias); } catch (e) { return Promise.reject(e); }
      delete secrets[alias];
      return Promise.resolve();
    },
    count: function () {
      let n = 0;
      for (const k in secrets) {
        if (has(k)) {
          n++;
        }
      }
      return n;
    }
  };
}
