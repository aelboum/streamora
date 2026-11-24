// PIN security tests (Stage 3, hardened in Stage 4B: P1 600,000 iterations, P2 six digits,
// P3 recovery code / authenticated and unauthenticated reset, P4 key-manager record with
// crash-safe replacement). They run the real PIN service on Node's WebCrypto (the same API as
// the TV's crypto.subtle), so PBKDF2 itself is the platform implementation, not a test double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPinService, PIN_ALGORITHM, PIN_ITERATIONS, PIN_SLOTS, RESET_CONFIRMATION, RECOVERY_ALPHABET,
  isPinRecord, normalizeRecoveryCode, formatRecoveryCode
} from '../../src/security/pin.ts';
import { createWebCrypto } from '../../src/app/platform/common.ts';
import { createKeyValueStore, KV_PREFIX } from '../../src/storage/kv-store.ts';
import { createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { asciiBytes, toHex, constantTimeEqual } from '../../src/utils/bytes.ts';
import { createLogger } from '../../src/utils/log.ts';

const crypto = createWebCrypto(globalThis.crypto);
const SETTINGS = { iterations: 600000, maxAttempts: 5, lockoutMs: 60000 };

/** Key store wrapper that can fail (simulated crash/power loss) from a chosen operation on. */
function crashableKeys(inner = createMemoryKeyStore()) {
  const ops = [];
  let crashAt = -1;
  const wrap = (name, fn) => (...args) => {
    ops.push(name + ':' + args[0]);
    if (crashAt >= 0 && ops.length - 1 >= crashAt) return Promise.reject(new Error('power lost'));
    return fn(...args);
  };
  return {
    persistent: true,
    inner,
    ops,
    crashAfter(n) { crashAt = ops.length + n; },
    heal() { crashAt = -1; },
    save: wrap('save', (a, v) => inner.save(a, v)),
    load: (a) => inner.load(a),
    remove: wrap('remove', (a) => inner.remove(a))
  };
}

async function setup(opts = {}) {
  let now = 1_000_000;
  const local = opts.local || createMemoryLocalStore();
  const keys = opts.keys || crashableKeys();
  const kv = createKeyValueStore(local);
  const log = createLogger(500);
  const wiped = [];
  const pin = createPinService(opts.crypto || crypto, keys, kv, opts.settings || SETTINGS, () => now, log, {
    wipeContent: opts.wipeContent || (() => { wiped.push(now); return Promise.resolve(); })
  });
  const state = await pin.load();
  return { pin, local, keys, kv, log, wiped, state, advance: (ms) => { now += ms; } };
}

async function slots(keys) {
  const v = await Promise.all(PIN_SLOTS.map((a) => keys.load(a)));
  return v.map((x) => (x === null ? null : JSON.parse(x)));
}

test('platform PBKDF2-HMAC-SHA256 matches published test vectors', async () => {
  const c1 = await crypto.pbkdf2Sha256(asciiBytes('password'), asciiBytes('salt'), 1, 256);
  assert.equal(toHex(c1), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
  const c4096 = await crypto.pbkdf2Sha256(asciiBytes('password'), asciiBytes('salt'), 4096, 256);
  assert.equal(toHex(c4096), 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a');
});

test('no default PIN', async () => {
  const { pin, state } = await setup();
  assert.equal(state, 'none');
  assert.equal(pin.hasPin(), false);
  for (const guess of ['000000', '123456']) assert.deepEqual(await pin.verify(guess), { ok: false, reason: 'no-pin' });
});

test('P1/P4: record lives in the key manager, 600,000 iterations, random salt, nothing in localStorage', async () => {
  const { pin, local, keys } = await setup();
  const r = await pin.setPin(null, '482613');
  assert.equal(r.ok, true);
  const [a, b] = await slots(keys);
  assert.equal(b, null);
  assert.equal(isPinRecord(a), true);
  assert.deepEqual([a.v, a.alg, a.gen, a.it, a.salt.length, a.dk.length], [2, PIN_ALGORITHM, 1, PIN_ITERATIONS, 32, 64]);
  const expected = await crypto.pbkdf2Sha256(asciiBytes('482613'), Buffer.from(a.salt, 'hex'), 600000, 256);
  assert.equal(a.dk, toHex(expected), 'record is exactly PBKDF2(pin, salt, 600000)');
  assert.equal(JSON.stringify(a).includes('482613'), false);
  assert.equal(local.keys().some((k) => /parental\.pin/.test(k)), false, 'no verifier in localStorage');
  assert.deepEqual(await pin.verify('482613'), { ok: true });
  const other = await setup();
  await other.pin.setPin(null, '482613');
  assert.notEqual((await slots(other.keys))[0].salt, a.salt, 'salts are random');
});

test('P1: configuration cannot lower the work factor', async () => {
  const { pin, keys } = await setup({ settings: { iterations: 1000, maxAttempts: 5, lockoutMs: 60000 } });
  await pin.setPin(null, '135792');
  assert.equal((await slots(keys))[0].it, 600000);
});

test('P2: new PINs need 6-8 digits; an older short PIN still verifies and asks for an upgrade', async () => {
  const { pin } = await setup();
  for (const bad of ['1234', '12345', '123456789', '12a456', ' 123456', '', null, 123456]) {
    assert.equal((await pin.setPin(null, bad)).reason, 'invalid-format', String(bad));
  }
  assert.equal(pin.hasPin(), false);
  // Stage 3 record (4 digits, 100,000 iterations, localStorage) is migrated, then re-hashed.
  const local = createMemoryLocalStore();
  const salt = crypto.randomBytes(16);
  const dk = await crypto.pbkdf2Sha256(asciiBytes('4826'), salt, 100000, 256);
  local.setItem(KV_PREFIX + 'parental.pin', JSON.stringify({ v: 1, d: { alg: PIN_ALGORITHM, it: 100000, salt: toHex(salt), dk: toHex(dk) } }));
  const m = await setup({ local });
  assert.equal(m.state, 'set');
  assert.equal(local.getItem(KV_PREFIX + 'parental.pin'), null, 'legacy record removed after migration');
  assert.equal((await slots(m.keys)).filter(Boolean)[0].it, 100000);
  assert.deepEqual(await m.pin.verify('4826'), { ok: true, upgradeRequired: true });
  const after = (await slots(m.keys)).filter(Boolean);
  assert.equal(after.length, 1);
  assert.equal(after[0].it, 600000, 're-hashed at the current work factor on success');
  assert.equal((await m.pin.setPin('4826', '1234')).reason, 'invalid-format');
  assert.deepEqual(await m.pin.setPin('4826', '90817263'), { ok: true });
  assert.deepEqual(await m.pin.verify('90817263'), { ok: true });
});

test('failed attempts count down, then lock out even the correct PIN; counter resets on success', async () => {
  const { pin, advance, log } = await setup();
  await pin.setPin(null, '246801');
  for (let left = 4; left >= 1; left--) {
    assert.deepEqual(await pin.verify('000000'), { ok: false, reason: 'wrong', attemptsLeft: left });
  }
  assert.deepEqual(await pin.verify('000000'), { ok: false, reason: 'locked', retryInMs: 60000 });
  assert.equal((await pin.verify('246801')).reason, 'locked');
  assert.equal((await pin.resetWithPin('246801')).reason, 'locked', 'reset is locked too');
  assert.equal((await pin.setPin('246801', '111222')).reason, 'locked', 'change is locked too');
  advance(60001);
  assert.deepEqual(await pin.verify('246801'), { ok: true });
  await pin.verify('111111');
  await pin.verify('246801');
  assert.deepEqual(await pin.verify('111111'), { ok: false, reason: 'wrong', attemptsLeft: 4 });
  assert.equal(JSON.stringify(log.entries()).includes('246801'), false, 'PIN never logged');
});

test('PIN change requires the current PIN and keeps the recovery code', async () => {
  const { pin } = await setup();
  const first = await pin.setPin(null, '246801');
  assert.equal((await pin.setPin(null, '135792')).reason, 'wrong');
  assert.equal((await pin.setPin('000000', '135792')).reason, 'wrong');
  assert.deepEqual(await pin.setPin('246801', '135792'), { ok: true });
  assert.equal((await pin.verify('246801')).reason, 'wrong');
  assert.deepEqual(await pin.verify('135792'), { ok: true });
  assert.deepEqual(await pin.resetWithRecoveryCode(first.recoveryCode), { ok: true }, 'code still valid after a change');
});

test('P3: recovery code is shown once and stored only as a PBKDF2 verifier', async () => {
  const { pin, keys, local, log } = await setup();
  const r = await pin.setPin(null, '246801');
  const code = r.recoveryCode;
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  const [rec] = await slots(keys);
  assert.ok(rec.rc && rec.rc.it === 600000 && rec.rc.salt !== rec.salt);
  const expected = await crypto.pbkdf2Sha256(asciiBytes(code), Buffer.from(rec.rc.salt, 'hex'), 600000, 256);
  assert.equal(rec.rc.dk, toHex(expected));
  const everything = JSON.stringify(rec) + JSON.stringify(local.keys().map((k) => local.getItem(k))) + JSON.stringify(log.entries());
  assert.equal(everything.includes(code), false, 'code never stored or logged in clear');
  assert.equal((await pin.verify('246801')).recoveryCode, undefined, 'never returned again');
  assert.equal(formatRecoveryCode(code).length, 14);
  assert.equal(normalizeRecoveryCode(' ' + formatRecoveryCode(code).toLowerCase() + ' '), code);
  assert.equal(normalizeRecoveryCode('OOOO-IIII-LLLL'), '000011111111', 'look-alike letters mapped');
  assert.equal(normalizeRecoveryCode('UUUU-UUUU-UUUU'), null, 'U is not in the alphabet');
  assert.equal(normalizeRecoveryCode('ABC'), null);
});

test('P3: recovery codes come from getRandomValues without bias (every symbol used, no repeats)', async () => {
  // Fast PBKDF2 stand-in for this test only: the property under test is the code generator.
  let randomCalls = 0;
  const fast = {
    randomBytes: (n) => { randomCalls++; return crypto.randomBytes(n); },
    pbkdf2Sha256: (p, s, _it, bits) => crypto.pbkdf2Sha256(p, s, 1, bits)
  };
  const seen = new Set();
  const counts = new Map();
  for (let i = 0; i < 150; i++) {
    const { pin } = await setup({ crypto: fast });
    const c = (await pin.setPin(null, '246801')).recoveryCode;
    seen.add(c);
    for (const ch of c) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  assert.equal(seen.size, 150);
  assert.equal(counts.size, RECOVERY_ALPHABET.length);
  for (const [, n] of counts) assert.ok(n > 20 && n < 110, 'roughly uniform (expected ≈ 56): ' + n);
  assert.ok(randomCalls >= 150 * 3, 'salts and code all drawn from the platform RNG');
});

test('P3: regenerating the code needs the PIN and invalidates the old code', async () => {
  const { pin } = await setup();
  const old = (await pin.setPin(null, '246801')).recoveryCode;
  assert.equal((await pin.regenerateRecoveryCode('000000')).reason, 'wrong');
  const r = await pin.regenerateRecoveryCode('246801');
  assert.equal(r.ok, true);
  assert.notEqual(r.recoveryCode, old);
  assert.equal((await pin.resetWithRecoveryCode(old)).reason, 'wrong');
  assert.deepEqual(await pin.resetWithRecoveryCode(r.recoveryCode), { ok: true });
});

test('authenticated reset (PIN or recovery code) removes the PIN and parental settings only', async () => {
  for (const how of ['pin', 'code']) {
    const { pin, kv, keys, wiped } = await setup();
    const code = (await pin.setPin(null, '246801')).recoveryCode;
    kv.set('parental.locked-categories', ['adult']);
    kv.set('settings', { keep: true });
    assert.equal((how === 'pin' ? await pin.resetWithPin('999999') : await pin.resetWithRecoveryCode('ZZZZ-ZZZZ-ZZZZ')).reason, 'wrong');
    assert.equal(pin.hasPin(), true);
    const r = how === 'pin' ? await pin.resetWithPin('246801') : await pin.resetWithRecoveryCode(formatRecoveryCode(code));
    assert.deepEqual(r, { ok: true }, how);
    assert.equal(pin.hasPin(), false);
    assert.deepEqual(kv.names(), ['settings']);
    assert.deepEqual(await slots(keys), [null, null]);
    assert.deepEqual(wiped, [], 'playlists untouched by an authenticated reset');
  }
});

test('recovery-code guesses share the attempt counter and lockout', async () => {
  const { pin } = await setup();
  await pin.setPin(null, '246801');
  for (let i = 0; i < 4; i++) assert.equal((await pin.resetWithRecoveryCode('AAAA-AAAA-AAAA')).reason, 'wrong');
  assert.equal((await pin.resetWithRecoveryCode('AAAA-AAAA-AAAA')).reason, 'locked');
  assert.equal((await pin.verify('246801')).reason, 'locked');
  assert.equal((await pin.resetWithRecoveryCode('not a code')).reason, 'invalid-format');
});

test('unauthenticated reset needs the exact phrase and wipes playlists first, then the PIN', async () => {
  const order = [];
  const env = await setup({ wipeContent: () => { order.push('content'); return Promise.resolve(); } });
  await env.pin.setPin(null, '246801');
  env.kv.set('parental.locked-categories', ['adult']);
  assert.equal((await env.pin.resetUnauthenticated('reset')).reason, 'invalid-format');
  assert.equal((await env.pin.resetUnauthenticated('RESET PARENTAL CONTROLS')).reason, 'invalid-format', 'Stage 3 phrase no longer enough');
  assert.equal(env.pin.hasPin(), true);
  const realRemove = env.keys.remove;
  env.keys.remove = (a) => { order.push('pin:' + a); return realRemove(a); };
  assert.deepEqual(await env.pin.resetUnauthenticated(RESET_CONFIRMATION), { ok: true });
  assert.equal(order[0], 'content', 'content is deleted before the PIN');
  assert.ok(order.length >= 3);
  assert.equal(env.pin.hasPin(), false);
  assert.deepEqual(env.kv.names(), []);
});

test('unauthenticated reset: if deleting playlists fails, the PIN stays and the wipe resumes on the next load', async () => {
  const local = createMemoryLocalStore();
  const keys = crashableKeys();
  let fail = true;
  const content = [];
  const wipeContent = () => (fail ? Promise.reject(new Error('disk')) : (content.push('wiped'), Promise.resolve()));
  const a = await setup({ local, keys, wipeContent });
  await a.pin.setPin(null, '246801');
  assert.equal((await a.pin.resetUnauthenticated(RESET_CONFIRMATION)).reason, 'error');
  assert.equal(a.pin.hasPin(), true, 'no bypass: PIN kept');
  fail = false;
  const b = await setup({ local, keys, wipeContent }); // restart
  assert.deepEqual(content, ['wiped'], 'interrupted wipe resumed at load');
  assert.equal(b.state, 'none');
  assert.equal(b.kv.get('parental.wipe', () => true, null), null);
});

test('P4 crash-safe replacement: a crash at any step leaves the old or the new PIN, never none', async () => {
  // A PIN change does: remove(target) -> save(target) -> remove(old). Power is lost before each step.
  for (let step = 0; step < 3; step++) {
    const keys = crashableKeys();
    const local = createMemoryLocalStore();
    const a = await setup({ keys, local });
    await a.pin.setPin(null, '246801');
    keys.crashAfter(step);
    await a.pin.setPin('246801', '135792');
    keys.heal();
    const b = await setup({ keys, local }); // power back on
    assert.equal(b.state, 'set', 'step ' + step);
    const oldOk = (await b.pin.verify('246801')).ok;
    const newOk = (await b.pin.verify('135792')).ok;
    assert.ok(oldOk !== newOk, 'exactly one PIN valid at step ' + step + ' (old=' + oldOk + ', new=' + newOk + ')');
    if (step === 2) assert.equal(newOk, true, 'new record already written when the old one could not be removed');
    assert.equal((await slots(keys)).filter(Boolean).length, 1, 'stale slot cleaned up on load (step ' + step + ')');
  }
});

test('P4: highest generation wins; a corrupt or tampered record fails closed', async () => {
  const keys = crashableKeys();
  const local = createMemoryLocalStore();
  const a = await setup({ keys, local });
  await a.pin.setPin(null, '246801');
  await a.pin.setPin('246801', '135792');
  const [s0, s1] = await slots(keys);
  const live = s0 || s1;
  assert.equal(live.gen, 2);
  const stale = { ...live, gen: 1, dk: '00'.repeat(32) };
  await keys.inner.save(s0 ? PIN_SLOTS[1] : PIN_SLOTS[0], JSON.stringify(stale));
  const b = await setup({ keys, local });
  assert.deepEqual(await b.pin.verify('135792'), { ok: true });
  // Tampered: lowered iteration count -> not accepted, controls locked rather than removed.
  const keys2 = crashableKeys();
  await keys2.inner.save(PIN_SLOTS[0], JSON.stringify({ ...live, it: 1 }));
  const c = await setup({ keys: keys2 });
  assert.equal(c.state, 'unavailable');
  assert.equal(c.pin.hasPin(), true, 'treated as protected');
  assert.equal((await c.pin.verify('135792')).reason, 'unavailable');
  assert.equal((await c.pin.setPin(null, '111111')).reason, 'unavailable', 'cannot set a new PIN over it');
  assert.deepEqual(await c.pin.resetUnauthenticated(RESET_CONFIRMATION), { ok: true }, 'the content-wiping reset is the way out');
  assert.equal(c.pin.state(), 'none');
  const keys3 = crashableKeys();
  await keys3.inner.save(PIN_SLOTS[1], 'not json');
  assert.equal((await setup({ keys: keys3 })).state, 'unavailable');
});

test('key manager unreadable: fail closed', async () => {
  const keys = { persistent: true, load: () => Promise.reject(new Error('locked')), save: () => Promise.reject(new Error('x')), remove: () => Promise.reject(new Error('x')) };
  const { pin, state } = await setup({ keys });
  assert.equal(state, 'unavailable');
  assert.equal(pin.hasPin(), true);
  assert.equal((await pin.verify('246801')).reason, 'unavailable');
});

test('operations before load and concurrent operations are refused', async () => {
  const kv = createKeyValueStore(createMemoryLocalStore());
  const fresh = createPinService(crypto, createMemoryKeyStore(), kv, SETTINGS, () => 0);
  assert.equal((await fresh.verify('246801')).reason, 'not-loaded');
  assert.equal((await fresh.setPin(null, '246801')).reason, 'not-loaded');
  const { pin } = await setup();
  await pin.setPin(null, '246801');
  const [a, b] = await Promise.all([pin.verify('246801'), pin.verify('246801')]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: false, reason: 'busy' });
});

test('constantTimeEqual compares full length; no PIN provider without WebCrypto', () => {
  const a = new Uint8Array([1, 2, 3]);
  assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 3])), true);
  assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 4])), false);
  assert.equal(constantTimeEqual(a, new Uint8Array([1, 2])), false);
  assert.equal(createWebCrypto(undefined), null);
  assert.equal(createWebCrypto({ getRandomValues: () => {} }), null);
});
