// Development fallback when the app runs in a desktop browser. Secrets and large files are
// kept in memory only (lost on reload), so nothing sensitive is written to browser storage.
import type { Platform, PlatformWindow } from './platform.ts';
import { createWebCrypto, createWebLocalStore, createXhrFactory, listenKeyEvents, listenNetwork, listenVisibility } from './common.ts';
import type { WebCryptoLike } from './common.ts';
import { createMemoryFileStore, createMemoryKeyStore } from './memory-stores.ts';

export function createBrowserPlatform(win: PlatformWindow): Platform {
  const crypto = createWebCrypto(win.crypto as unknown as WebCryptoLike);
  const fileStore = createMemoryFileStore();
  const keyStore = createMemoryKeyStore();
  return {
    name: 'browser',
    info: function () {
      return {
        name: 'browser',
        platformVersion: 'n/a',
        width: win.innerWidth,
        height: win.innerHeight,
        userAgent: win.navigator.userAgent
      };
    },
    capabilities: function () {
      return { appLifecycle: false, keyRegistration: false, avplay: false, fileStore: true, secureKeyStore: false, webCrypto: !!crypto };
    },
    memory: function () { return { availableMB: -1, totalMB: -1 }; },
    exit: function () { /* a browser tab cannot exit itself */ },
    onVisibilityChange: function (cb) { return listenVisibility(win, cb); },
    onNetworkChange: function (cb) { return listenNetwork(win, cb); },
    keys: {
      registerKeys: function () { return []; },
      onKeyDown: function (cb) { return listenKeyEvents(win, 'keydown', cb); },
      onKeyUp: function (cb) { return listenKeyEvents(win, 'keyup', cb); }
    },
    localStore: win.localStorage ? createWebLocalStore(win.localStorage) : null,
    fileStore: fileStore,
    keyStore: keyStore,
    crypto: crypto,
    xhrFactory: createXhrFactory(win)
  };
}
