// Parental PIN (ARCHITECTURE.md rev 3 §7; SECURITY-DECISIONS.md S2; hardening per
// docs/SECURITY-PIN-FOLLOWUP.md P1–P4, approved for Stage 4B).
//
// Algorithm: PBKDF2 (RFC 8018) with HMAC-SHA-256, executed by the platform WebCrypto
// (crypto.subtle.deriveBits, verified on the TV). No JavaScript fallback exists.
//   password   = the PIN's ASCII digits (new PINs: 6–8 digits; older 4–5 digit PINs still verify)
//   salt       = 16 bytes from crypto.getRandomValues, new for every write
//   iterations = 600,000 (P1); older records (>= 100,000) verify and are re-hashed on success
//   output     = 32 bytes
// Recovery code (P3): 12 symbols of Crockford base32 (60 bits) from crypto.getRandomValues,
// shown once when the PIN is first set or when it is regenerated; only its PBKDF2 verifier
// (own salt, same iteration count) is stored.
//
// Storage (P4): the record lives in the Tizen key manager, not in localStorage:
//   aliases ss_pin_a / ss_pin_b, value = JSON PinRecord {v:2, gen, alg, it, salt, dk, rc}
// Crash-safe replacement: the key manager cannot overwrite an alias, so a new record is written
// to the *other* slot with gen+1 and only then is the old slot removed. On load the valid record
// with the highest gen wins. A crash at any point leaves the old or the new record, never none.
// A key manager that cannot be read makes the service fail closed ('unavailable').
// A Stage 3 record found in localStorage (KV "parental.pin") is migrated into a slot on load.
//
// Failed attempts are counted persistently (KV "parental.attempts") for PIN and recovery-code
// checks alike; after `maxAttempts` failures every check is refused for `lockoutMs`.
// Resets:
//   - resetWithPin / resetWithRecoveryCode (authenticated): remove the PIN and parental settings;
//   - resetUnauthenticated(phrase): wipes all playlists and their credentials first (callback),
//     then the PIN and parental settings. A journal (KV "parental.wipe") makes an interrupted
//     wipe resume on the next load; the PIN is removed only after the content is gone.
// PINs and recovery codes are never logged, stored in clear or returned in errors.
import type { CryptoProvider, KeyStore } from '../app/platform/platform.ts';
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { Logger } from '../utils/log.ts';
import { asciiBytes, constantTimeEqual, fromHex, toHex } from '../utils/bytes.ts';

export const PIN_ALGORITHM = 'PBKDF2-HMAC-SHA256';
/** Work factor for every new record (P1). */
export const PIN_ITERATIONS = 600000;
/** Oldest work factor still accepted when reading (Stage 3 records). */
export const LEGACY_MIN_ITERATIONS = 100000;
export const PIN_SALT_BYTES = 16;
export const PIN_KEY_BITS = 256;
export const MIN_PIN_LENGTH = 6;
export const RESET_CONFIRMATION = 'RESET PARENTAL CONTROLS AND DELETE PLAYLISTS';
export const PIN_SLOTS = ['ss_pin_a', 'ss_pin_b'];
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
export const RECOVERY_LENGTH = 12;

const NEW_PIN_RE = /^[0-9]{6,8}$/;
const ANY_PIN_RE = /^[0-9]{4,8}$/;
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const KEY_LEGACY = 'parental.pin';
const KEY_ATTEMPTS = 'parental.attempts';
const KEY_WIPE = 'parental.wipe';
const PARENTAL_PREFIX = 'parental.';

interface Verifier { it: number; salt: string; dk: string }

export interface PinRecord {
  v: 2;
  alg: string;
  gen: number;
  it: number;
  salt: string;
  dk: string;
  /** Recovery-code verifier, or null. */
  rc: Verifier | null;
}

interface Attempts { failures: number; lockedUntil: number }

export interface PinSettings {
  iterations: number;
  maxAttempts: number;
  lockoutMs: number;
}

export type PinState = 'loading' | 'none' | 'set' | 'unavailable';

export type PinResult =
  /** upgradeRequired: verified with a PIN shorter than 6 digits; the UI asks for a new one. */
  | { ok: true; upgradeRequired?: boolean; recoveryCode?: string }
  | { ok: false; reason: 'invalid-format' | 'no-pin' | 'busy' | 'error' | 'unavailable' | 'not-loaded' }
  | { ok: false; reason: 'wrong'; attemptsLeft: number }
  | { ok: false; reason: 'locked'; retryInMs: number };

export interface PinServiceOptions {
  /** Deletes every playlist and its credentials (unauthenticated reset). */
  wipeContent?: () => Promise<void>;
}

export interface PinService {
  /** Reads the key manager, migrates a Stage 3 record, resumes an interrupted wipe. */
  load(): Promise<PinState>;
  state(): PinState;
  /** True when a PIN is set, and also when the key manager is unreadable (fail closed). */
  hasPin(): boolean;
  /** Sets the first PIN (current = null; returns the recovery code) or changes it (current must verify). */
  setPin(current: string | null, next: string): Promise<PinResult>;
  verify(pin: string): Promise<PinResult>;
  /** New recovery code (the PIN must verify); the old code stops working. */
  regenerateRecoveryCode(pin: string): Promise<PinResult>;
  /** Removes the PIN and parental settings after the current PIN verifies. */
  resetWithPin(pin: string): Promise<PinResult>;
  /** Removes the PIN and parental settings after the recovery code verifies. */
  resetWithRecoveryCode(code: string): Promise<PinResult>;
  /** Without PIN or code: deletes all playlists and credentials, then the PIN. Needs the exact phrase. */
  resetUnauthenticated(confirmation: string): Promise<PinResult>;
  lockRemainingMs(): number;
}

function isVerifier(x: unknown, minIt: number): x is Verifier {
  const r = x as Verifier;
  return !!r && typeof r === 'object' && typeof r.it === 'number' && r.it >= minIt && r.it <= 10000000 &&
    typeof r.salt === 'string' && r.salt.length === PIN_SALT_BYTES * 2 && fromHex(r.salt) !== null &&
    typeof r.dk === 'string' && r.dk.length === PIN_KEY_BITS / 4 && fromHex(r.dk) !== null;
}

export function isPinRecord(x: unknown): x is PinRecord {
  const r = x as PinRecord;
  return !!r && typeof r === 'object' && r.v === 2 && r.alg === PIN_ALGORITHM && typeof r.gen === 'number' && r.gen >= 1 &&
    isVerifier(r, LEGACY_MIN_ITERATIONS) && (r.rc === null || isVerifier(r.rc, LEGACY_MIN_ITERATIONS));
}

/** Stage 3 localStorage record {alg, it, salt, dk}. */
function isLegacyRecord(x: unknown): x is { alg: string } & Verifier {
  const r = x as { alg: string };
  return !!r && typeof r === 'object' && r.alg === PIN_ALGORITHM && isVerifier(r, LEGACY_MIN_ITERATIONS);
}

function isAttempts(x: unknown): x is Attempts {
  const a = x as Attempts;
  return !!a && typeof a === 'object' && typeof a.failures === 'number' && a.failures >= 0 && typeof a.lockedUntil === 'number';
}

function anyObject(x: unknown): x is unknown {
  return !!x && typeof x === 'object';
}

/** Format accepted for a new or changed PIN. */
export function isValidNewPin(pin: unknown): pin is string {
  return typeof pin === 'string' && NEW_PIN_RE.test(pin);
}

/** Format accepted when checking a PIN (includes older 4–5 digit PINs). */
export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === 'string' && ANY_PIN_RE.test(pin);
}

/** Canonical form of a typed recovery code (case, separators and look-alike letters tolerated); null if invalid. */
export function normalizeRecoveryCode(code: unknown): string | null {
  if (typeof code !== 'string') {
    return null;
  }
  const c = code.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(c) ? c : null;
}

/** "ABCD-EFGH-JKMN" for display. */
export function formatRecoveryCode(code: string): string {
  return code.substring(0, 4) + '-' + code.substring(4, 8) + '-' + code.substring(8, 12);
}

export function createPinService(crypto: CryptoProvider, keys: KeyStore, kv: KeyValueStore, settings: PinSettings,
  now: () => number, log?: Logger, options?: PinServiceOptions): PinService {
  const iterations = Math.max(PIN_ITERATIONS, Math.floor(settings.iterations));
  const maxAttempts = Math.max(1, Math.floor(settings.maxAttempts));
  const lockoutMs = Math.max(1000, Math.floor(settings.lockoutMs));
  let busy = false;
  let state: PinState = 'loading';
  let current: PinRecord | null = null;
  let currentSlot = -1;

  function attempts(): Attempts {
    return kv.get<Attempts>(KEY_ATTEMPTS, isAttempts, { failures: 0, lockedUntil: 0 });
  }
  function lockRemaining(): number {
    const a = attempts();
    return a.lockedUntil > now() ? a.lockedUntil - now() : 0;
  }
  function derive(secret: string, salt: Uint8Array, it: number): Promise<Uint8Array> {
    return crypto.pbkdf2Sha256(asciiBytes(secret), salt, it, PIN_KEY_BITS);
  }
  function makeVerifier(secret: string): Promise<Verifier> {
    const salt = crypto.randomBytes(PIN_SALT_BYTES);
    return derive(secret, salt, iterations).then(function (dk) {
      return { it: iterations, salt: toHex(salt), dk: toHex(dk) };
    });
  }
  function matches(secret: string, v: Verifier): Promise<boolean> {
    return derive(secret, fromHex(v.salt) as Uint8Array, v.it).then(function (dk) {
      return constantTimeEqual(dk, fromHex(v.dk) as Uint8Array);
    });
  }
  function newRecoveryCode(): string {
    const bytes = crypto.randomBytes(RECOVERY_LENGTH);
    let s = '';
    for (let i = 0; i < RECOVERY_LENGTH; i++) {
      s += RECOVERY_ALPHABET.charAt(bytes[i] & 31); // 256 is a multiple of 32: no modulo bias
    }
    return s;
  }

  function parseSlot(raw: string | null): PinRecord | null {
    if (raw === null) {
      return null;
    }
    try {
      const r: unknown = JSON.parse(raw);
      return isPinRecord(r) ? r : null;
    } catch (e) {
      return null;
    }
  }

  /** Crash-safe replacement: write the other slot with gen+1, then remove the old slot. */
  function writeRecord(pinV: Verifier, rc: Verifier | null): Promise<void> {
    const target = currentSlot === 0 ? 1 : 0;
    const old = currentSlot;
    const rec: PinRecord = { v: 2, alg: PIN_ALGORITHM, gen: current ? current.gen + 1 : 1, it: pinV.it, salt: pinV.salt, dk: pinV.dk, rc: rc };
    const text = JSON.stringify(rec);
    return keys.remove(PIN_SLOTS[target]).then(null, function () { /* not present */ }).then(function () {
      return keys.save(PIN_SLOTS[target], text);
    }).then(function () {
      current = rec;
      currentSlot = target;
      state = 'set';
      if (old >= 0) {
        // Best effort: a leftover old slot has a lower gen and loses on the next load.
        return keys.remove(PIN_SLOTS[old]).then(null, function () { /* removed on next load */ });
      }
      return undefined;
    });
  }

  /** Removes both slots (the stale one first) and every parental.* setting (except the wipe journal when asked). */
  function removeAll(keepJournal: boolean): Promise<void> {
    const order = currentSlot === 1 ? [0, 1] : [1, 0];
    return keys.remove(PIN_SLOTS[order[0]]).then(function () {
      return keys.remove(PIN_SLOTS[order[1]]);
    }).then(function () {
      current = null;
      currentSlot = -1;
      state = 'none';
      const names = kv.names();
      for (let i = 0; i < names.length; i++) {
        if (names[i].indexOf(PARENTAL_PREFIX) === 0 && !(keepJournal && names[i] === KEY_WIPE)) {
          kv.remove(names[i]);
        }
      }
    });
  }

  function failure(): PinResult {
    const a = attempts();
    const failures = a.failures + 1;
    if (failures >= maxAttempts) {
      kv.set(KEY_ATTEMPTS, { failures: 0, lockedUntil: now() + lockoutMs });
      if (log) { log.warn('parental: locked after repeated failures', { lockoutMs: lockoutMs }); }
      return { ok: false, reason: 'locked', retryInMs: lockoutMs };
    }
    kv.set(KEY_ATTEMPTS, { failures: failures, lockedUntil: 0 });
    return { ok: false, reason: 'wrong', attemptsLeft: maxAttempts - failures };
  }

  function precheck(): PinResult | null {
    if (state === 'loading') {
      return { ok: false, reason: 'not-loaded' };
    }
    if (state === 'unavailable') {
      return { ok: false, reason: 'unavailable' };
    }
    if (!current) {
      return { ok: false, reason: 'no-pin' };
    }
    const wait = lockRemaining();
    return wait > 0 ? { ok: false, reason: 'locked', retryInMs: wait } : null;
  }

  /** PIN check with attempt counting; re-hashes older records on success. */
  function checkPin(pin: string): Promise<PinResult> {
    if (!isValidPinFormat(pin)) {
      return Promise.resolve<PinResult>({ ok: false, reason: 'invalid-format' });
    }
    const pre = precheck();
    if (pre) {
      return Promise.resolve(pre);
    }
    const rec = current as PinRecord;
    return matches(pin, rec).then(function (ok): PinResult | Promise<PinResult> {
      if (!ok) {
        return failure();
      }
      kv.set(KEY_ATTEMPTS, { failures: 0, lockedUntil: 0 });
      const res: PinResult = pin.length < MIN_PIN_LENGTH ? { ok: true, upgradeRequired: true } : { ok: true };
      if (rec.it < iterations) {
        return makeVerifier(pin).then(function (v) { return writeRecord(v, rec.rc); }).then(function () { return res; });
      }
      return res;
    });
  }

  function exclusive(fn: () => Promise<PinResult>): Promise<PinResult> {
    if (busy) {
      return Promise.resolve<PinResult>({ ok: false, reason: 'busy' });
    }
    busy = true;
    return fn().then(function (r) { busy = false; return r; }, function () {
      busy = false;
      if (log) { log.error('parental: PIN operation failed'); } // no error object: it could carry a value
      return { ok: false, reason: 'error' } as PinResult;
    });
  }

  function wipe(): Promise<void> {
    kv.set(KEY_WIPE, { at: now() });
    const content = options && options.wipeContent ? options.wipeContent() : Promise.resolve();
    // Content first: if deleting it fails, the PIN stays and the journal makes the next load retry.
    return content.then(function () {
      return removeAll(true);
    }).then(function () {
      kv.remove(KEY_WIPE);
      if (log) { log.warn('parental: unauthenticated reset completed; playlists deleted'); }
    });
  }

  return {
    load: function () {
      return Promise.all([keys.load(PIN_SLOTS[0]), keys.load(PIN_SLOTS[1])]).then(function (raw): Promise<PinState> {
        const a = parseSlot(raw[0]);
        const b = parseSlot(raw[1]);
        if (a && (!b || a.gen >= b.gen)) {
          current = a; currentSlot = 0;
        } else if (b) {
          current = b; currentSlot = 1;
        } else {
          current = null; currentSlot = -1;
        }
        state = current ? 'set' : 'none';
        if (!current && (raw[0] !== null || raw[1] !== null)) {
          // A slot exists but holds no valid record (corrupt or tampered): fail closed.
          state = 'unavailable';
          if (log) { log.error('parental: PIN record unreadable; parental controls locked'); }
          return Promise.resolve(state);
        }
        let chain: Promise<unknown> = Promise.resolve();
        if (current && (currentSlot === 0 ? b : a)) {
          // Leftover from an interrupted replacement: remove the lower generation.
          const stale = PIN_SLOTS[currentSlot === 0 ? 1 : 0];
          chain = keys.remove(stale).then(null, function () { /* retried next time */ });
        }
        if (!current) {
          const legacy = kv.get<unknown>(KEY_LEGACY, function (x): x is unknown { return isLegacyRecord(x); }, null);
          if (legacy && isLegacyRecord(legacy)) {
            chain = chain.then(function () {
              return writeRecord({ it: legacy.it, salt: legacy.salt, dk: legacy.dk }, null);
            }).then(function () {
              kv.remove(KEY_LEGACY);
              if (log) { log.info('parental: PIN record moved to the key manager'); }
            });
          }
        }
        if (kv.get<unknown>(KEY_WIPE, anyObject, null)) {
          chain = chain.then(function () {
            if (log) { log.warn('parental: resuming an interrupted unauthenticated reset'); }
            return wipe();
          });
        }
        return chain.then(function () { return state; });
      }).then(null, function (): PinState {
        // Fail closed: the PIN can't be checked, so nothing it protects opens.
        state = 'unavailable';
        if (log) { log.error('parental: key manager unavailable; parental controls locked'); }
        return state;
      });
    },
    state: function () { return state; },
    hasPin: function () { return state === 'unavailable' || current !== null; },

    setPin: function (cur, next) {
      return exclusive(function () {
        if (!isValidNewPin(next)) {
          return Promise.resolve<PinResult>({ ok: false, reason: 'invalid-format' });
        }
        if (state === 'loading' || state === 'unavailable') {
          return Promise.resolve<PinResult>({ ok: false, reason: state === 'loading' ? 'not-loaded' : 'unavailable' });
        }
        if (!current) {
          const code = newRecoveryCode();
          return makeVerifier(next).then(function (pv) {
            return makeVerifier(code).then(function (rv) { return writeRecord(pv, rv); });
          }).then(function (): PinResult {
            kv.set(KEY_ATTEMPTS, { failures: 0, lockedUntil: 0 });
            if (log) { log.info('parental: PIN set'); }
            return { ok: true, recoveryCode: code };
          });
        }
        if (cur === null) {
          return Promise.resolve<PinResult>({ ok: false, reason: 'wrong', attemptsLeft: Math.max(0, maxAttempts - attempts().failures) });
        }
        return checkPin(cur).then(function (r): PinResult | Promise<PinResult> {
          if (!r.ok) {
            return r;
          }
          const keepRc = current ? current.rc : null;
          return makeVerifier(next).then(function (pv) { return writeRecord(pv, keepRc); }).then(function (): PinResult {
            if (log) { log.info('parental: PIN changed'); }
            return { ok: true };
          });
        });
      });
    },

    verify: function (pin) {
      return exclusive(function () { return checkPin(pin); });
    },

    regenerateRecoveryCode: function (pin) {
      return exclusive(function () {
        return checkPin(pin).then(function (r): PinResult | Promise<PinResult> {
          if (!r.ok || !current) {
            return r;
          }
          const rec = current;
          const code = newRecoveryCode();
          return makeVerifier(code).then(function (rv) {
            return writeRecord({ it: rec.it, salt: rec.salt, dk: rec.dk }, rv);
          }).then(function (): PinResult {
            if (log) { log.info('parental: recovery code regenerated'); }
            return { ok: true, recoveryCode: code };
          });
        });
      });
    },

    resetWithPin: function (pin) {
      return exclusive(function () {
        return checkPin(pin).then(function (r): PinResult | Promise<PinResult> {
          if (!r.ok) {
            return r;
          }
          return removeAll(false).then(function (): PinResult {
            if (log) { log.warn('parental: controls reset with the PIN'); }
            return { ok: true };
          });
        });
      });
    },

    resetWithRecoveryCode: function (code) {
      return exclusive(function () {
        const c = normalizeRecoveryCode(code);
        if (c === null) {
          return Promise.resolve<PinResult>({ ok: false, reason: 'invalid-format' });
        }
        const pre = precheck();
        if (pre) {
          return Promise.resolve(pre);
        }
        const rc = (current as PinRecord).rc;
        if (!rc) {
          return Promise.resolve(failure());
        }
        return matches(c, rc).then(function (ok): PinResult | Promise<PinResult> {
          if (!ok) {
            return failure();
          }
          return removeAll(false).then(function (): PinResult {
            if (log) { log.warn('parental: controls reset with the recovery code'); }
            return { ok: true };
          });
        });
      });
    },

    resetUnauthenticated: function (confirmation) {
      return exclusive(function () {
        if (confirmation !== RESET_CONFIRMATION) {
          return Promise.resolve<PinResult>({ ok: false, reason: 'invalid-format' });
        }
        if (state === 'loading') {
          return Promise.resolve<PinResult>({ ok: false, reason: 'not-loaded' });
        }
        return wipe().then(function (): PinResult { return { ok: true }; });
      });
    },

    lockRemainingMs: lockRemaining
  };
}
