// Android (TV and phone) implementation of the Platform interface (Stage 8). The app runs in a
// WebView of the android/ project; the native side injects two bridges (platform.ts):
//   ElitePlatform: private files, Android-Keystore-encrypted secrets, memory, exit, device type;
//   ElitePlayer:   Media3 ExoPlayer on a surface behind the transparent WebView (android-engine.ts).
// Keys: the activity turns remote/D-pad/back/media keys into the TV key codes the app already uses
// (keys.ts) and calls window.__eliteKey(code, down); the WebView never sees them, so there are no
// duplicates. Visibility: window.__eliteVisible(visible) from onPause/onResume.
// Touch (phones, touch TVs): a tap moves the focus to the tapped item with arrow keys and presses
// OK; a swipe sends arrow keys (one per ~120 px). Every screen keeps its remote navigation, so
// touch adds no second navigation model.
import type { AndroidPlatformBridge, FileStore, KeyStore, Platform, PlatformWindow, RawKeyEvent } from './platform.ts';
import { checkAlias, checkFileName, createWebCrypto, createWebLocalStore, createXhrFactory, listenNetwork } from './common.ts';
import type { WebCryptoLike } from './common.ts';

interface EliteWindow {
  __eliteKey?: (code: number, down: boolean) => void;
  __eliteVisible?: (visible: boolean) => void;
}

function bridgeFileStore(b: AndroidPlatformBridge): FileStore {
  function call<T>(fn: () => T): Promise<T> {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e instanceof Error ? e : new Error(String(e))); }
  }
  return {
    atomicReplace: true, // PlatformBridge.fileWrite writes a temp file and renames it
    read: function (name) { checkFileName(name); return call(function () { return b.fileRead(name); }); },
    write: function (name, text) {
      checkFileName(name);
      return call(function () { if (!b.fileWrite(name, text)) { throw new Error('write failed'); } });
    },
    remove: function (name) { checkFileName(name); return call(function () { b.fileRemove(name); }); },
    list: function () { return call(function () { return JSON.parse(b.fileList()) as string[]; }); }
  };
}

function bridgeKeyStore(b: AndroidPlatformBridge): KeyStore {
  return {
    persistent: true,
    save: function (alias, value) {
      checkAlias(alias);
      try { if (!b.keySave(alias, value)) { return Promise.reject(new Error('key save failed')); } } catch (e) { return Promise.reject(e); }
      return Promise.resolve();
    },
    load: function (alias) {
      checkAlias(alias);
      try { return Promise.resolve(b.keyLoad(alias)); } catch (e) { return Promise.reject(e); }
    },
    remove: function (alias) {
      checkAlias(alias);
      try { b.keyRemove(alias); } catch (e) { return Promise.reject(e); }
      return Promise.resolve();
    }
  };
}

/** Elements the focus engines mark with is-focused (tap targets). */
const FOCUSABLE = ['ss-tile', 'ss-bar__item', 'ss-rail__item', 'ss-cat', 'ss-ch', 'ss-card', 'ss-button', 'ss-row', 'ss-ep',
  'ss-key', 'ss-find__row', 'ss-find__field', 'ss-ime__field'];

function focusableOf(el: Element | null): HTMLElement | null {
  let n: Element | null = el;
  while (n && n.nodeType === 1) {
    const cls = ' ' + (n.className && typeof n.className === 'string' ? n.className : '') + ' ';
    for (let i = 0; i < FOCUSABLE.length; i++) {
      if (cls.indexOf(' ' + FOCUSABLE[i] + ' ') >= 0) { return n as HTMLElement; }
    }
    n = n.parentNode as Element | null;
  }
  return null;
}

function centre(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** The focused element (last visible one in DOM order = the top-most layer). */
function focusedElement(doc: Document): HTMLElement | null {
  const all = doc.querySelectorAll('.is-focused');
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i] as HTMLElement;
    if (el.offsetParent !== null) { return el; }
  }
  return null;
}

export function installTouch(doc: Document, press: (code: number) => void): () => void {
  let sx = 0, sy = 0, st = 0, active = false;
  const STEP = 120;

  function tap(x: number, y: number): void {
    const target = focusableOf(doc.elementFromPoint(x, y));
    if (!target) {
      return;
    }
    for (let guard = 0; guard < 40; guard++) {
      const f = focusedElement(doc);
      if (!f) { return; }
      const a = centre(f), b = centre(target);
      if (f === target || (Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4)) {
        press(13); // OK
        return;
      }
      const dx = b.x - a.x, dy = b.y - a.y;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      press(horizontal ? (dx > 0 ? 39 : 37) : (dy > 0 ? 40 : 38));
      if (focusedElement(doc) === f) {
        // Blocked on that axis (zone edge): try the other axis once, then give up.
        const other = horizontal ? (dy > 0 ? 40 : dy < 0 ? 38 : 0) : (dx > 0 ? 39 : dx < 0 ? 37 : 0);
        if (!other) { return; }
        press(other);
        if (focusedElement(doc) === f) { return; }
      }
    }
  }

  function onStart(e: TouchEvent): void {
    if (!e.touches || e.touches.length !== 1) { active = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); active = true;
  }
  function onEnd(e: TouchEvent): void {
    if (!active || !e.changedTouches || !e.changedTouches.length) { return; }
    active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    e.preventDefault();
    // Distances are in CSS px of the 1920-wide page (the WebView scales the whole page).
    if (Math.abs(dx) < 30 && Math.abs(dy) < 30 && Date.now() - st < 600) {
      tap(t.clientX, t.clientY);
      return;
    }
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const n = Math.max(1, Math.min(30, Math.round((horizontal ? Math.abs(dx) : Math.abs(dy)) / STEP)));
    // Swipe up moves the content up = focus moves down (like scrolling a list).
    const code = horizontal ? (dx < 0 ? 39 : 37) : (dy < 0 ? 40 : 38);
    for (let i = 0; i < n; i++) { press(code); }
  }
  function onMove(e: TouchEvent): void { if (active) { e.preventDefault(); } }

  doc.addEventListener('touchstart', onStart as EventListener, false);
  doc.addEventListener('touchmove', onMove as EventListener, false);
  doc.addEventListener('touchend', onEnd as EventListener, false);
  return function () {
    doc.removeEventListener('touchstart', onStart as EventListener, false);
    doc.removeEventListener('touchmove', onMove as EventListener, false);
    doc.removeEventListener('touchend', onEnd as EventListener, false);
  };
}

/** The WebView lays the page out 1920 wide (index.html viewport) and scales it to the screen width.
 *  On screens wider than 16:9 (most phones in landscape) the 1080-high page would be cut off, so
 *  the body is scaled down further and centred. PlayerBridge.setRect uses the same formula. */
export function pageScale(innerWidth: number, innerHeight: number): { k: number; dx: number } {
  const k = innerHeight > 0 ? Math.min(1, innerHeight / 1080, innerWidth / 1920) : 1;
  return { k: k, dx: Math.max(0, (innerWidth - 1920 * k) / 2) };
}

function fitPage(win: PlatformWindow): void {
  const body = win.document.body;
  function apply(): void {
    if (!body) { return; }
    const s = pageScale(win.innerWidth, win.innerHeight);
    const tf = s.k < 1 ? 'translateX(' + s.dx.toFixed(1) + 'px) scale(' + s.k.toFixed(4) + ')' : '';
    body.style.webkitTransformOrigin = '0 0';
    body.style.transformOrigin = '0 0';
    body.style.webkitTransform = tf;
    body.style.transform = tf;
  }
  apply();
  if (win.addEventListener) { win.addEventListener('resize', apply); }
}

export function createAndroidPlatform(win: PlatformWindow): Platform {
  const b = win.ElitePlatform as AndroidPlatformBridge;
  const ew = win as unknown as EliteWindow;
  const downCbs: Array<(e: RawKeyEvent) => void> = [];
  const upCbs: Array<(e: RawKeyEvent) => void> = [];
  const visCbs: Array<(v: boolean) => void> = [];

  function fire(list: Array<(e: RawKeyEvent) => void>, code: number): void {
    const ev: RawKeyEvent = { keyCode: code, preventDefault: function () { /* native already consumed it */ } };
    const copy = list.slice();
    for (let i = 0; i < copy.length; i++) { copy[i](ev); }
  }
  function press(code: number): void {
    fire(downCbs, code);
    fire(upCbs, code);
  }
  ew.__eliteKey = function (code, down) { fire(down ? downCbs : upCbs, code); };
  ew.__eliteVisible = function (v) {
    const copy = visCbs.slice();
    for (let i = 0; i < copy.length; i++) { copy[i](v); }
  };
  installTouch(win.document, press);
  fitPage(win);

  const crypto = createWebCrypto(win.crypto as unknown as WebCryptoLike);
  function add<T>(list: T[], cb: T): () => void {
    list.push(cb);
    return function () { const i = list.indexOf(cb); if (i >= 0) { list.splice(i, 1); } };
  }

  return {
    name: 'android',
    info: function () {
      return { name: 'android', platformVersion: b.version() + ' (' + b.deviceType() + ')', width: win.innerWidth, height: win.innerHeight, userAgent: win.navigator.userAgent };
    },
    capabilities: function () {
      return { appLifecycle: true, keyRegistration: true, avplay: false, fileStore: true, secureKeyStore: true, webCrypto: !!crypto };
    },
    memory: function () {
      try { return { availableMB: b.availableMemoryMB(), totalMB: b.totalMemoryMB() }; } catch (e) { return { availableMB: -1, totalMB: -1 }; }
    },
    exit: function () { b.exit(); },
    onVisibilityChange: function (cb) { return add(visCbs, cb); },
    onNetworkChange: function (cb) { return listenNetwork(win, cb); },
    keys: {
      registerKeys: function (names) { return names.slice(); }, // the activity maps every key itself
      onKeyDown: function (cb) { return add(downCbs, cb); },
      onKeyUp: function (cb) { return add(upCbs, cb); }
    },
    localStore: win.localStorage ? createWebLocalStore(win.localStorage) : null,
    fileStore: bridgeFileStore(b),
    keyStore: bridgeKeyStore(b),
    crypto: crypto,
    xhrFactory: createXhrFactory(win)
  };
}
