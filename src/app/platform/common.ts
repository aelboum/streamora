// Helpers shared by the Tizen and browser platform implementations.
import type { CryptoProvider, LocalStore, PlatformWindow, RawKeyEvent, XhrLike } from './platform.ts';

/** Flat file names: lower-case, digits, dot, dash, underscore; max 100 characters. */
export const FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** Key-manager aliases: letters, digits, underscore; max 64 characters. */
export const KEY_ALIAS_RE = /^[A-Za-z0-9_]{1,64}$/;

export function checkFileName(name: string): void {
  if (typeof name !== 'string' || !FILE_NAME_RE.test(name) || name.indexOf('..') >= 0) {
    throw new Error('invalid file name');
  }
}

export function checkAlias(alias: string): void {
  if (typeof alias !== 'string' || !KEY_ALIAS_RE.test(alias)) {
    throw new Error('invalid key alias');
  }
}

export function listenVisibility(win: PlatformWindow, cb: (visible: boolean) => void): () => void {
  const doc = win.document;
  function handler(): void {
    cb(!doc.hidden);
  }
  doc.addEventListener('visibilitychange', handler);
  return function () { doc.removeEventListener('visibilitychange', handler); };
}

export function listenNetwork(win: PlatformWindow, cb: (online: boolean) => void): () => void {
  if (!win.addEventListener || !win.removeEventListener) {
    return function () { /* not supported */ };
  }
  function on(): void { cb(true); }
  function off(): void { cb(false); }
  win.addEventListener('online', on);
  win.addEventListener('offline', off);
  return function () {
    if (win.removeEventListener) {
      win.removeEventListener('online', on);
      win.removeEventListener('offline', off);
    }
  };
}

export function listenKeyEvents(win: PlatformWindow, type: 'keydown' | 'keyup', cb: (e: RawKeyEvent) => void): () => void {
  const doc = win.document;
  function handler(e: KeyboardEvent): void {
    cb({ keyCode: e.keyCode, preventDefault: function () { e.preventDefault(); } });
  }
  doc.addEventListener(type, handler);
  return function () { doc.removeEventListener(type, handler); };
}

/** Wraps window.localStorage. Reads never throw; writes throw on quota (caller handles). */
export function createWebLocalStore(storage: Storage): LocalStore {
  return {
    getItem: function (key) {
      try { return storage.getItem(key); } catch (e) { return null; }
    },
    setItem: function (key, value) { storage.setItem(key, value); },
    removeItem: function (key) {
      try { storage.removeItem(key); } catch (e) { /* ignore */ }
    },
    keys: function () {
      const out: string[] = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k !== null) {
            out.push(k);
          }
        }
      } catch (e) { /* ignore */ }
      return out;
    }
  };
}

/** Minimal WebCrypto surface; satisfied by window.crypto on the TV and globalThis.crypto in Node. */
export interface WebCryptoLike {
  getRandomValues(array: Uint8Array): Uint8Array;
  subtle?: {
    importKey(format: string, keyData: Uint8Array, algorithm: { name: string }, extractable: boolean, usages: string[]): PromiseLike<unknown>;
    deriveBits(algorithm: { name: string; salt: Uint8Array; iterations: number; hash: string }, baseKey: unknown, length: number): PromiseLike<ArrayBuffer>;
  };
}

/** Returns null when PBKDF2 via crypto.subtle is unavailable. There is deliberately no JS fallback. */
export function createWebCrypto(c: WebCryptoLike | undefined | null): CryptoProvider | null {
  if (!c || typeof c.getRandomValues !== 'function' || !c.subtle ||
      typeof c.subtle.importKey !== 'function' || typeof c.subtle.deriveBits !== 'function') {
    return null;
  }
  const subtle = c.subtle;
  return {
    randomBytes: function (length) {
      const out = new Uint8Array(length);
      c.getRandomValues(out);
      return out;
    },
    pbkdf2Sha256: function (password, salt, iterations, lengthBits) {
      return Promise.resolve(subtle.importKey('raw', password, { name: 'PBKDF2' }, false, ['deriveBits']))
        .then(function (key) {
          return subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, key, lengthBits);
        })
        .then(function (bits) { return new Uint8Array(bits); });
    }
  };
}

export function createXhrFactory(win: PlatformWindow): () => XhrLike {
  return function () {
    const Ctor = win.XMLHttpRequest;
    if (!Ctor) {
      throw new Error('XMLHttpRequest unavailable');
    }
    return new Ctor() as unknown as XhrLike;
  };
}
