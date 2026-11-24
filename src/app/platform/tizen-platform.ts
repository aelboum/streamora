// Samsung Tizen TV implementation of the Platform interface.
import type { Platform, PlatformCapabilities, PlatformInfo, PlatformWindow } from './platform.ts';
import { createWebCrypto, createWebLocalStore, createXhrFactory, listenKeyEvents, listenNetwork, listenVisibility } from './common.ts';
import type { WebCryptoLike } from './common.ts';
import { createTizenFileStore } from './tizen-file-store.ts';
import { createTizenKeyStore } from './tizen-key-store.ts';

export function createTizenPlatform(win: PlatformWindow): Platform {
  const api = win.tizen as TizenApi;
  const fileStore = api.filesystem ? createTizenFileStore(api.filesystem) : null;
  const keyStore = api.keymanager ? createTizenKeyStore(api.keymanager) : null;
  const crypto = createWebCrypto(win.crypto as unknown as WebCryptoLike);
  const localStore = win.localStorage ? createWebLocalStore(win.localStorage) : null;
  const xhr = createXhrFactory(win);

  function platformVersion(): string {
    try {
      return String(api.systeminfo.getCapability('http://tizen.org/feature/platform.version'));
    } catch (e) {
      return 'unknown';
    }
  }

  return {
    name: 'tizen',
    info: function (): PlatformInfo {
      return {
        name: 'tizen',
        platformVersion: platformVersion(),
        width: win.innerWidth,
        height: win.innerHeight,
        userAgent: win.navigator.userAgent
      };
    },
    capabilities: function (): PlatformCapabilities {
      return {
        appLifecycle: !!(api.application && api.application.getCurrentApplication),
        keyRegistration: !!api.tvinputdevice,
        avplay: !!(win.webapis && win.webapis.avplay),
        fileStore: !!fileStore,
        secureKeyStore: !!keyStore,
        webCrypto: !!crypto
      };
    },
    memory: function () {
      const mb = function (fn: (() => number) | undefined): number {
        try { return fn ? Math.round(fn.call(api.systeminfo) / 1048576) : -1; } catch (e) { return -1; }
      };
      return { availableMB: mb(api.systeminfo.getAvailableMemory), totalMB: mb(api.systeminfo.getTotalMemory) };
    },
    exit: function () {
      api.application.getCurrentApplication().exit();
    },
    onVisibilityChange: function (cb) { return listenVisibility(win, cb); },
    onNetworkChange: function (cb) { return listenNetwork(win, cb); },
    keys: {
      registerKeys: function (names) {
        const ok: string[] = [];
        if (!api.tvinputdevice) {
          return ok;
        }
        for (let i = 0; i < names.length; i++) {
          try {
            api.tvinputdevice.registerKey(names[i]);
            ok.push(names[i]);
          } catch (e) { /* key not supported on this model */ }
        }
        return ok;
      },
      onKeyDown: function (cb) { return listenKeyEvents(win, 'keydown', cb); },
      onKeyUp: function (cb) { return listenKeyEvents(win, 'keyup', cb); }
    },
    localStore: localStore,
    fileStore: fileStore,
    keyStore: keyStore,
    crypto: crypto,
    xhrFactory: xhr
  };
}
