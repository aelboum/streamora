// Screen registration and navigation (screen stack + one overlay layer).
// Back rules (ARCHITECTURE.md rev 2 §2C, kept in rev 3):
//   1. an open overlay gets onBack; if it does not consume it, it is closed;
//   2. otherwise the top screen gets onBack;
//   3. otherwise, if there is more than one screen, the top one is popped;
//   4. otherwise (at the root) the root-back handler runs (e.g. focus side nav / exit dialog).
// Screens below the top stay mounted but hidden (instant return, kept focus). Popped screens are
// destroyed. Exceptions thrown by screens are caught and logged; the router stays consistent.
import type { RemoteKeyEvent } from './key-router.ts';
import type { Logger } from '../utils/log.ts';

/** A layer the router mounts a screen into. The DOM implementation lives in app/dom-host.ts. */
export interface HostLayer {
  readonly element: unknown;
  show(): void;
  hide(): void;
  remove(): void;
}

export interface ScreenHost {
  createLayer(id: string, overlay: boolean): HostLayer;
}

export interface Screen {
  mount(layer: HostLayer): void;
  onShow(): void;
  onHide(): void;
  /** True when the key was consumed. */
  onKey(e: RemoteKeyEvent): boolean;
  /** True when Back was consumed. */
  onBack(): boolean;
  destroy(): void;
}

export type ScreenFactory = (params: Record<string, unknown>, nav: Router) => Screen;

interface Entry {
  id: string;
  screen: Screen;
  layer: HostLayer;
}

export interface Router {
  register(id: string, factory: ScreenFactory): void;
  isRegistered(id: string): boolean;
  push(id: string, params?: Record<string, unknown>): boolean;
  replace(id: string, params?: Record<string, unknown>): boolean;
  pop(): boolean;
  resetTo(id: string, params?: Record<string, unknown>): boolean;
  openOverlay(id: string, params?: Record<string, unknown>): boolean;
  closeOverlay(): boolean;
  /** Routes a key: overlay first, then the top screen, then Back rules. */
  handleKey(e: RemoteKeyEvent): boolean;
  stack(): string[];
  overlay(): string | null;
  setRootBackHandler(fn: () => void): void;
}

export function createRouter(host: ScreenHost, log: Logger): Router {
  const factories: Record<string, ScreenFactory> = {};
  const stack: Entry[] = [];
  let overlay: Entry | null = null;
  let rootBack: () => void = function () { /* none */ };
  let seq = 0;

  function safe(what: string, id: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (e) {
      log.error('router: screen ' + what + ' failed', { screen: id }, e);
      return false;
    }
  }

  function create(id: string, params: Record<string, unknown>, isOverlay: boolean): Entry | null {
    const factory = factories[id];
    if (!factory) {
      log.error('router: unknown screen', { screen: id });
      return null;
    }
    let screen: Screen;
    try {
      screen = factory(params, api);
    } catch (e) {
      log.error('router: screen factory failed', { screen: id }, e);
      return null;
    }
    const layer = host.createLayer(id + '-' + (++seq), isOverlay);
    if (!safe('mount', id, function () { screen.mount(layer); })) {
      layer.remove();
      return null;
    }
    return { id: id, screen: screen, layer: layer };
  }

  function show(entry: Entry): void {
    entry.layer.show();
    safe('onShow', entry.id, function () { entry.screen.onShow(); });
  }

  function hide(entry: Entry): void {
    safe('onHide', entry.id, function () { entry.screen.onHide(); });
    entry.layer.hide();
  }

  function destroy(entry: Entry): void {
    safe('destroy', entry.id, function () { entry.screen.destroy(); });
    entry.layer.remove();
  }

  function top(): Entry | null {
    return stack.length ? stack[stack.length - 1] : null;
  }

  const api: Router = {
    register: function (id, factory) {
      if (!/^[a-z][a-z0-9-]{0,40}$/.test(id)) {
        throw new Error('invalid screen id');
      }
      factories[id] = factory;
    },
    isRegistered: function (id) { return Object.prototype.hasOwnProperty.call(factories, id); },
    push: function (id, params) {
      const entry = create(id, params || {}, false);
      if (!entry) {
        return false;
      }
      api.closeOverlay();
      const prev = top();
      if (prev) {
        hide(prev);
      }
      stack.push(entry);
      show(entry);
      return true;
    },
    replace: function (id, params) {
      const entry = create(id, params || {}, false);
      if (!entry) {
        return false;
      }
      api.closeOverlay();
      const prev = stack.pop();
      if (prev) {
        hide(prev);
        destroy(prev);
      }
      stack.push(entry);
      show(entry);
      return true;
    },
    pop: function () {
      if (stack.length <= 1) {
        return false;
      }
      api.closeOverlay();
      const prev = stack.pop() as Entry;
      hide(prev);
      destroy(prev);
      show(stack[stack.length - 1]);
      return true;
    },
    resetTo: function (id, params) {
      const entry = create(id, params || {}, false);
      if (!entry) {
        return false;
      }
      api.closeOverlay();
      while (stack.length) {
        const e = stack.pop() as Entry;
        hide(e);
        destroy(e);
      }
      stack.push(entry);
      show(entry);
      return true;
    },
    openOverlay: function (id, params) {
      const entry = create(id, params || {}, true);
      if (!entry) {
        return false;
      }
      api.closeOverlay();
      overlay = entry;
      show(entry);
      return true;
    },
    closeOverlay: function () {
      if (!overlay) {
        return false;
      }
      const o = overlay;
      overlay = null;
      hide(o);
      destroy(o);
      return true;
    },
    handleKey: function (e) {
      if (overlay) {
        const o = overlay;
        let consumed = false;
        if (e.key === 'back') {
          safe('onBack', o.id, function () { consumed = o.screen.onBack(); });
          if (!consumed) {
            api.closeOverlay();
          }
          return true;
        }
        safe('onKey', o.id, function () { consumed = o.screen.onKey(e); });
        return true; // overlays are modal
      }
      const t = top();
      if (!t) {
        return false;
      }
      if (e.key === 'back') {
        let consumed = false;
        safe('onBack', t.id, function () { consumed = t.screen.onBack(); });
        if (consumed) {
          return true;
        }
        if (stack.length > 1) {
          api.pop();
          return true;
        }
        try { rootBack(); } catch (x) { log.error('router: root back handler failed', undefined, x); }
        return true;
      }
      let consumed2 = false;
      safe('onKey', t.id, function () { consumed2 = t.screen.onKey(e); });
      return consumed2;
    },
    stack: function () {
      const out: string[] = [];
      for (let i = 0; i < stack.length; i++) {
        out.push(stack[i].id);
      }
      return out;
    },
    overlay: function () { return overlay ? overlay.id : null; },
    setRootBackHandler: function (fn) { rootBack = fn; }
  };
  return api;
}
