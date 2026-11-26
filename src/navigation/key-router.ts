// Turns raw key events into RemoteKeyEvents and hands them to one handler (the screen router).
// Held keys: the TV repeats keydown about every 108 ms after 458 ms, and `event.repeat` is always
// false [M/V, probe 1], so a repeat is detected as a second keydown before the keyup.
// Repeated arrows are throttled (default 110 ms) so held keys step at most about 9 times a second.
import type { KeyInput, RawKeyEvent } from '../app/platform/platform.ts';
import type { RemoteKey } from './keys.ts';
import { isArrow, mapKeyCode } from './keys.ts';
import type { KeyPlatform } from './keys.ts';

export interface RemoteKeyEvent {
  key: RemoteKey;
  digit?: number;
  /** True for auto-repeat while held. */
  repeat: boolean;
  /** Milliseconds since the key went down. */
  heldMs: number;
  code: number;
}

export interface KeyRouterOptions {
  now: () => number;
  throttleMs: number;
  allowBrowserKeys: boolean;
  /** CP1: the platform's key table (keys.ts); absent = the Samsung table. */
  platform?: KeyPlatform;
  /** Returns true when the event was consumed. */
  dispatch: (e: RemoteKeyEvent) => boolean;
  /** When true (a text field has focus), only Back is routed; other keys go to the field. */
  textInputActive?: () => boolean;
}

export interface KeyRouter {
  keyDown(e: RawKeyEvent): void;
  keyUp(e: RawKeyEvent): void;
  /** Listens on the platform key input; returns a detach function. */
  attach(keys: KeyInput): () => void;
  /** Keys currently held (codes). */
  held(): number[];
}

export function createKeyRouter(opts: KeyRouterOptions): KeyRouter {
  const down: Record<number, { since: number; lastSent: number }> = {};

  function keyDown(e: RawKeyEvent): void {
    const mapped = mapKeyCode(e.keyCode, opts.allowBrowserKeys, opts.platform);
    if (!mapped) {
      return;
    }
    if (opts.textInputActive && opts.textInputActive() && mapped.key !== 'back') {
      return;
    }
    // Back must never fall through to the engine (it would leave the app).
    e.preventDefault();
    const t = opts.now();
    const state = down[e.keyCode];
    const repeat = !!state;
    if (repeat && isArrow(mapped.key) && t - state.lastSent < opts.throttleMs) {
      return;
    }
    if (!state) {
      down[e.keyCode] = { since: t, lastSent: t };
    } else {
      state.lastSent = t;
    }
    const ev: RemoteKeyEvent = { key: mapped.key, repeat: repeat, heldMs: repeat ? t - down[e.keyCode].since : 0, code: e.keyCode };
    if (mapped.digit !== undefined) {
      ev.digit = mapped.digit;
    }
    opts.dispatch(ev);
  }

  function keyUp(e: RawKeyEvent): void {
    delete down[e.keyCode];
  }

  return {
    keyDown: keyDown,
    keyUp: keyUp,
    attach: function (keys) {
      const a = keys.onKeyDown(keyDown);
      const b = keys.onKeyUp(keyUp);
      return function () { a(); b(); };
    },
    held: function () {
      const out: number[] = [];
      for (const k in down) {
        if (Object.prototype.hasOwnProperty.call(down, k)) {
          out.push(Number(k));
        }
      }
      return out;
    }
  };
}
