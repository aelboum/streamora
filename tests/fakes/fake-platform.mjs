// Platform double for bootstrap/integration tests: memory stores, real WebCrypto from Node,
// scriptable keys, visibility and network events, fake XHR.
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createWebCrypto } from '../../src/app/platform/common.ts';
import { createXhrRegistry } from './fake-xhr.mjs';

export function createFakePlatform(overrides = {}) {
  const keyDown = [];
  const keyUp = [];
  const visibility = [];
  const network = [];
  const xhr = createXhrRegistry();
  const state = { exited: 0, registered: [] };
  const platform = {
    name: 'tizen',
    info: () => ({ name: 'tizen', platformVersion: '3.0', width: 1920, height: 1080, userAgent: 'fake' }),
    capabilities: () => ({
      appLifecycle: true, keyRegistration: true, avplay: false,
      fileStore: platform.fileStore !== null, secureKeyStore: platform.keyStore !== null, webCrypto: platform.crypto !== null
    }),
    memory: () => ({ availableMB: 220, totalMB: 1295 }),
    exit: () => { state.exited++; },
    onVisibilityChange: (cb) => { visibility.push(cb); return () => visibility.splice(visibility.indexOf(cb), 1); },
    onNetworkChange: (cb) => { network.push(cb); return () => network.splice(network.indexOf(cb), 1); },
    keys: {
      registerKeys: (names) => { state.registered = names.slice(); return names.slice(); },
      onKeyDown: (cb) => { keyDown.push(cb); return () => keyDown.splice(keyDown.indexOf(cb), 1); },
      onKeyUp: (cb) => { keyUp.push(cb); return () => keyUp.splice(keyUp.indexOf(cb), 1); }
    },
    localStore: createMemoryLocalStore(),
    fileStore: createMemoryFileStore(),
    keyStore: createMemoryKeyStore(),
    crypto: createWebCrypto(globalThis.crypto),
    xhrFactory: xhr.factory,
    ...overrides
  };
  return {
    platform,
    state,
    xhr,
    press(code) {
      let prevented = false;
      const ev = { keyCode: code, preventDefault: () => { prevented = true; } };
      keyDown.slice().forEach((cb) => cb(ev));
      keyUp.slice().forEach((cb) => cb(ev));
      return prevented;
    },
    setVisible: (v) => visibility.slice().forEach((cb) => cb(v)),
    setOnline: (v) => network.slice().forEach((cb) => cb(v))
  };
}
