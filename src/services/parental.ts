// Parental lock state on top of the PIN service (Stage 7B.2 part 4).
//   KV "parental.lock-adult"  true/false; absent = true. The "parental." prefix means the PIN
//                            service's resets remove it together with the PIN.
// The lock is active when a PIN exists and "Lock adult content" is on. A key manager that cannot be
// read counts as "PIN set" (the PIN service fails closed), so adult content stays locked then too.
// Entering the PIN unlocks adult content for this session for 4 hours (memory only: a restart
// locks again).
import type { PinService } from '../security/pin.ts';
import type { KeyValueStore } from '../storage/kv-store.ts';

export const UNLOCK_MS = 4 * 3600000;
const KEY_LOCK = 'parental.lock-adult';

export interface Parental {
  /** A PIN service exists on this device (WebCrypto + key store). */
  available(): boolean;
  hasPin(): boolean;
  lockAdult(): boolean;
  setLockAdult(on: boolean): void;
  /** Adult content needs the PIN right now. */
  locked(): boolean;
  unlock(): void;
  relock(): void;
  pin(): PinService | null;
}

function isBool(x: unknown): x is boolean { return typeof x === 'boolean'; }

export function createParental(pin: PinService | null, kv: KeyValueStore, now: () => number): Parental {
  let unlockedUntil = 0;
  function lockAdult(): boolean { return kv.get<boolean>(KEY_LOCK, isBool, true); }
  return {
    available: function () { return !!pin; },
    hasPin: function () { return !!pin && pin.hasPin(); },
    lockAdult: lockAdult,
    setLockAdult: function (on) { kv.set(KEY_LOCK, on); },
    locked: function () {
      if (!pin || !pin.hasPin() || !lockAdult()) { return false; }
      return now() >= unlockedUntil;
    },
    unlock: function () { unlockedUntil = now() + UNLOCK_MS; },
    relock: function () { unlockedUntil = 0; },
    pin: function () { return pin; }
  };
}
