// Application lifecycle: visibility (Home key, source change) and network state, as events.
// Later stages subscribe (the player suspends on 'hidden', history saves, refresh pauses).
import type { Platform } from './platform/platform.ts';
import type { Logger } from '../utils/log.ts';

export type LifecycleEvent = 'hidden' | 'visible' | 'offline' | 'online' | 'exiting';

export interface Lifecycle {
  visible(): boolean;
  online(): boolean;
  on(cb: (e: LifecycleEvent) => void): () => void;
  /** Notifies subscribers ('exiting') and leaves the application. */
  exit(): void;
  dispose(): void;
}

export function createLifecycle(platform: Platform, log: Logger, initialOnline?: boolean): Lifecycle {
  let isVisible = true;
  let isOnline = initialOnline !== false;
  const subs: Array<(e: LifecycleEvent) => void> = [];

  function emit(e: LifecycleEvent): void {
    log.info('lifecycle ' + e);
    const list = subs.slice();
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](e);
      } catch (err) {
        log.error('lifecycle subscriber failed', { event: e }, err);
      }
    }
  }

  const offVisibility = platform.onVisibilityChange(function (v) {
    if (v === isVisible) {
      return;
    }
    isVisible = v;
    emit(v ? 'visible' : 'hidden');
  });
  const offNetwork = platform.onNetworkChange(function (on) {
    if (on === isOnline) {
      return;
    }
    isOnline = on;
    emit(on ? 'online' : 'offline');
  });

  return {
    visible: function () { return isVisible; },
    online: function () { return isOnline; },
    on: function (cb) {
      subs.push(cb);
      return function () {
        const i = subs.indexOf(cb);
        if (i >= 0) {
          subs.splice(i, 1);
        }
      };
    },
    exit: function () {
      emit('exiting');
      platform.exit();
    },
    dispose: function () {
      offVisibility();
      offNetwork();
      subs.length = 0;
    }
  };
}
