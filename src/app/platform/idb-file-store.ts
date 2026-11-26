// CP1: FileStore on IndexedDB, for platforms without a file API (LG webOS, Titan OS; CP3/CP5).
// Not used on Samsung (tizen.filesystem) or Android (private files through the bridge).
// One object store "files": key = file name (FILE_NAME_RE), value = the whole text. A write is one
// put() in its own readwrite transaction, so a reader sees the old or the new text, never a mix:
// atomicReplace is true. list() walks a key cursor (getAllKeys is missing before Chromium 48, and
// webOS 3.x runs Chromium 38). Every failure (quota, blocked, aborted transaction) rejects with a
// generic error and never includes file content.
// Only the IndexedDB parts the code uses are typed here, so tests can pass a small fake.
import type { FileStore } from './platform.ts';
import { checkFileName } from './common.ts';

export interface IdbRequestLike<T> {
  result: T;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: ((ev: unknown) => void) | null;
  onblocked: ((ev: unknown) => void) | null;
}
export interface IdbCursorLike { key: unknown; continue(): void }
export interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike<unknown>;
  put(value: unknown, key: string): IdbRequestLike<unknown>;
  delete(key: string): IdbRequestLike<unknown>;
  openKeyCursor?(): IdbRequestLike<IdbCursorLike | null>;
  openCursor(): IdbRequestLike<IdbCursorLike | null>;
}
export interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  oncomplete: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onabort: ((ev: unknown) => void) | null;
}
export interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(stores: string, mode: 'readonly' | 'readwrite'): IdbTransactionLike;
  close(): void;
}
export interface IdbFactoryLike {
  open(name: string, version: number): IdbOpenRequestLike;
}

const STORE = 'files';
const VERSION = 1;

export function createIdbFileStore(idb: IdbFactoryLike, dbName: string): FileStore {
  let opening: Promise<IdbDatabaseLike> | null = null;

  function db(): Promise<IdbDatabaseLike> {
    if (!opening) {
      const p = new Promise<IdbDatabaseLike>(function (resolve, reject) {
        let req: IdbOpenRequestLike;
        try { req = idb.open(dbName, VERSION); } catch (e) { reject(new Error('storage unavailable')); return; }
        req.onupgradeneeded = function () {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE)) { d.createObjectStore(STORE); }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(new Error('storage unavailable')); };
        req.onblocked = function () { reject(new Error('storage blocked')); };
      });
      opening = p;
      // A failed open is retried on the next call.
      p.then(null, function () { if (opening === p) { opening = null; } });
    }
    return opening;
  }

  /** Runs `fn` in one transaction; resolves with fn's value once the transaction completed. */
  function tx<T>(mode: 'readonly' | 'readwrite', fn: (s: IdbObjectStoreLike, set: (v: T) => void) => void): Promise<T> {
    const failed = mode === 'readwrite' ? 'storage write failed' : 'storage read failed';
    return db().then(function (d) {
      return new Promise<T>(function (resolve, reject) {
        let value: T;
        let t: IdbTransactionLike;
        try {
          t = d.transaction(STORE, mode);
        } catch (e) {
          reject(new Error('storage unavailable'));
          return;
        }
        t.oncomplete = function () { resolve(value); };
        t.onerror = function () { reject(new Error(failed)); };
        t.onabort = function () { reject(new Error(failed)); };
        try {
          fn(t.objectStore(STORE), function (v) { value = v; });
        } catch (e) {
          reject(new Error(failed));
        }
      });
    });
  }

  return {
    atomicReplace: true,
    read: function (name) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      return tx<string | null>('readonly', function (s, set) {
        set(null);
        const r = s.get(name);
        r.onsuccess = function () { set(typeof r.result === 'string' ? r.result : null); };
      });
    },
    write: function (name, text) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      return tx<void>('readwrite', function (s) { s.put(String(text), name); });
    },
    remove: function (name) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      return tx<void>('readwrite', function (s) { s.delete(name); });
    },
    list: function () {
      return tx<string[]>('readonly', function (s, set) {
        const out: string[] = [];
        set(out);
        const r = s.openKeyCursor ? s.openKeyCursor() : s.openCursor();
        r.onsuccess = function () {
          const c = r.result;
          if (c) {
            if (typeof c.key === 'string') { out.push(c.key); }
            c.continue();
          } else {
            out.sort();
          }
        };
      });
    }
  };
}
