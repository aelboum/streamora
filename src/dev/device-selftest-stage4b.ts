// DEV BUILDS ONLY (called from device-selftest.ts). Stage 4B measurements on the real TV:
//   A. PIN service on the real key manager and WebCrypto: 600,000-iteration timings, change,
//      recovery-code reset, crash-safe slot rotation (a failed removal of the old slot, then a
//      restart). Skipped if a PIN record already exists on the device.
//   B. Playlist UI driven with INJECTED remote key events (not the physical remote) through the
//      real key router and screens: 50,000-channel import with the HTTP warning, progress,
//      event-loop lag (UI responsiveness), free memory, then a second run cancelled with Back.
//      The synthetic playlist is removed afterwards.
// Synthetic values only. PINs and codes used here are test values and are never logged.
// Result keys avoid the word "pin": the logger redacts keys that look like secrets.
import type { KeyStore, Platform } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';
import type { AppContext, StartedApp } from '../app/bootstrap.ts';
import { createKeyValueStore } from '../storage/kv-store.ts';
import { createMemoryLocalStore } from '../app/platform/memory-stores.ts';
import { createPinService, PIN_SLOTS } from '../security/pin.ts';
import type { PinService } from '../security/pin.ts';

export interface DevApp {
  ctx: AppContext;
  started: StartedApp;
  root: HTMLElement;
}

const USER = 'tvtest_user';
const PASS = 'tvtest_pass_0';
const KEY = { down: 40, right: 39, ok: 13, back: 10009 };

function step(log: Logger, name: string, p: Promise<unknown>): Promise<void> {
  const t0 = Date.now();
  return p.then(function (detail) {
    log.info('selftest PASS ' + name, { ms: Date.now() - t0, detail: detail });
  }, function (e) {
    log.warn('selftest FAIL ' + name, { ms: Date.now() - t0 }, e);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise<void>(function (resolve) { setTimeout(resolve, ms); });
}

function until(fn: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  return new Promise<void>(function (resolve, reject) {
    function poll(): void {
      if (fn()) { resolve(); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error('timeout: ' + what)); return; }
      setTimeout(poll, 100);
    }
    poll();
  });
}

function slotCount(ks: KeyStore): Promise<number> {
  return Promise.all([ks.load(PIN_SLOTS[0]), ks.load(PIN_SLOTS[1])]).then(function (s) {
    return (s[0] !== null ? 1 : 0) + (s[1] !== null ? 1 : 0);
  });
}

// ------------------------------------------------------------------ A. PIN
function pinSuite(platform: Platform, L: Logger): Promise<unknown> {
  const crypto = platform.crypto;
  const ks = platform.keyStore;
  if (!crypto || !ks) {
    return Promise.reject(new Error('no crypto or key store'));
  }
  let failRemoveOf = '';
  // Key store wrapper that can make one removal fail (power loss before the old slot is removed).
  const wrapped: KeyStore = {
    persistent: ks.persistent,
    save: function (a, v) { return ks.save(a, v); },
    load: function (a) { return ks.load(a); },
    remove: function (a) {
      if (a === failRemoveOf) { failRemoveOf = ''; return Promise.reject(new Error('simulated power loss')); }
      return ks.remove(a);
    }
  };
  function make(): PinService {
    return createPinService(crypto as NonNullable<Platform['crypto']>, wrapped, createKeyValueStore(createMemoryLocalStore()),
      { iterations: 600000, maxAttempts: 5, lockoutMs: 60000 }, function () { return Date.now(); }, L);
  }
  const out: Record<string, number | string | boolean> = {};
  let pin = make();
  let code = '';
  let t0 = 0;
  let created = false;
  return pin.load().then(function (st) {
    if (st !== 'none') {
      throw new Error('a PIN record already exists on this TV (' + st + '); PIN self-test skipped');
    }
    created = true;
    t0 = Date.now();
    return pin.setPin(null, '246801');
  }).then(function (r) {
    out.setMs = Date.now() - t0; // PIN verifier + recovery-code verifier: 2 × PBKDF2 600,000
    if (!r.ok || !r.recoveryCode) { throw new Error('setPin failed'); }
    code = r.recoveryCode;
    t0 = Date.now();
    return pin.verify('246801');
  }).then(function (r) {
    out.verifyMs = Date.now() - t0;
    out.verifyOk = r.ok;
    return pin.verify('000000');
  }).then(function (r) {
    out.wrongRejected = !r.ok;
    return Promise.all([ks.load(PIN_SLOTS[0]), ks.load(PIN_SLOTS[1])]);
  }).then(function (s) {
    failRemoveOf = s[0] !== null ? PIN_SLOTS[0] : PIN_SLOTS[1];
    t0 = Date.now();
    return pin.setPin('246801', '135792');
  }).then(function (r) {
    out.changeMs = Date.now() - t0;
    if (!r.ok) { throw new Error('change failed'); }
    return slotCount(ks);
  }).then(function (n) {
    out.slotsAfterInterruptedChange = n; // 2: old slot could not be removed
    pin = make(); // restart
    return pin.load();
  }).then(function () {
    return pin.verify('135792');
  }).then(function (r) {
    out.newWinsAfterRestart = r.ok;
    return slotCount(ks);
  }).then(function (n) {
    out.slotsAfterRestart = n;
    return pin.verify('246801');
  }).then(function (r) {
    out.oldRejected = !r.ok;
    t0 = Date.now();
    return pin.resetWithRecoveryCode(code);
  }).then(function (r) {
    out.recoveryResetMs = Date.now() - t0;
    out.recoveryResetOk = r.ok;
    return slotCount(ks);
  }).then(function (n) {
    out.slotsAfterReset = n;
    return out;
  }, function (e) {
    if (!created) {
      throw e;
    }
    // Leave no test record behind.
    return ks.remove(PIN_SLOTS[0]).then(null, function () { /* */ }).then(function () {
      return ks.remove(PIN_SLOTS[1]).then(null, function () { /* */ });
    }).then(function () { throw e; });
  });
}

// ------------------------------------------------------------------ B. UI import
interface ProbeResult { maxLagMs: number; lagsOver100ms: number; probeSamples: number; freeMinMB: number }

function uiSuite(platform: Platform, app: DevApp, origin: string): Promise<unknown> {
  const svc = app.ctx.playlists;
  if (!svc) {
    return Promise.reject(new Error('no playlist service'));
  }
  const router = app.started.router;
  const kr = app.started.keyRouter;
  function press(code: number): void {
    const ev = { keyCode: code, preventDefault: function () { /* */ } };
    kr.keyDown(ev);
    kr.keyUp(ev);
  }
  function visibleText(): string {
    const kids = app.root.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      const el = kids[i] as HTMLElement;
      if (el.style && el.style.display !== 'none') {
        return el.textContent || '';
      }
    }
    return '';
  }
  // Responsiveness probe: lateness of a 50 ms timer = time the UI thread was busy.
  let maxLag = 0;
  let over100 = 0;
  let samples = 0;
  let last = Date.now();
  let minFree = platform.memory().availableMB;
  let probe: unknown = null;
  function startProbe(): void {
    maxLag = 0; over100 = 0; samples = 0; last = Date.now(); minFree = platform.memory().availableMB;
    probe = setInterval(function () {
      const n = Date.now();
      const lag = n - last - 50;
      last = n;
      samples++;
      if (lag > maxLag) { maxLag = lag; }
      if (lag > 100) { over100++; }
      if (samples % 10 === 0) {
        const m = platform.memory().availableMB;
        if (m >= 0 && m < minFree) { minFree = m; }
      }
    }, 50);
  }
  function stopProbe(): ProbeResult {
    if (probe !== null) { clearInterval(probe as number); probe = null; }
    return { maxLagMs: maxLag, lagsOver100ms: over100, probeSamples: samples, freeMinMB: minFree };
  }

  let id = '';
  const out: Record<string, unknown> = {};
  return svc.add({ name: 'selftest 50k', kind: 'm3u', url: origin + '/get.php?username=' + USER + '&password=' + PASS + '&n=50000' }).then(function (a) {
    if (!a.ok) { throw new Error('add failed: ' + a.code); }
    id = a.playlist.id;
    router.resetTo('playlists');
    const list = svc.list();
    for (let i = 0; i < list.length && list[i].id !== id; i++) {
      press(KEY.down);
    }
    press(KEY.ok); // details
    return wait(500);
  }).then(function () {
    out.freeBeforeMB = platform.memory().availableMB;
    press(KEY.ok); // Update now -> HTTP warning
    return wait(500);
  }).then(function () {
    out.warningShown = router.overlay() === 'confirm';
    press(KEY.right);
    startProbe();
    const t0 = Date.now();
    press(KEY.ok); // Continue
    return until(function () { return /Updated:|update failed/.test(visibleText()); }, 180000, 'import result').then(function () {
      out.importMs = Date.now() - t0;
      out.resultOk = /Updated: 50000 channels/.test(visibleText());
      const pr = stopProbe();
      out.fullMaxLagMs = pr.maxLagMs;
      out.fullLagsOver100ms = pr.lagsOver100ms;
      out.fullProbeSamples = pr.probeSamples;
      out.fullFreeMinMB = pr.freeMinMB;
    });
  }).then(function () {
    press(KEY.ok); // Close
    return wait(1000);
  }).then(function () {
    startProbe();
    press(KEY.ok); // Update now: no warning the second time
    out.warningShownAgain = router.overlay() === 'confirm';
    return wait(3000);
  }).then(function () {
    const t1 = Date.now();
    press(KEY.back); // cancel
    return until(function () { return /cancelled|Updated:/.test(visibleText()); }, 60000, 'cancel').then(function () {
      out.cancelAckMs = Date.now() - t1;
      out.cancelled = /cancelled/.test(visibleText());
      const pr = stopProbe();
      out.cancelMaxLagMs = pr.maxLagMs;
      out.cancelLagsOver100ms = pr.lagsOver100ms;
    });
  }).then(function () {
    press(KEY.ok); // Close
    const t2 = Date.now();
    return svc.loadLive(id).then(function (l) {
      out.keptAfterCancel = l.status === 'ok' ? l.catalogue.channels.length : l.status;
      out.cachedLoadMs = Date.now() - t2;
      out.freeAfterMB = platform.memory().availableMB;
      out.stillImporting = svc.importing() !== null;
    });
  }).then(function () {
    return svc.remove(id).then(function () { router.resetTo('playlists'); return out; });
  }, function (e) {
    stopProbe();
    return (id ? svc.remove(id) : Promise.resolve()).then(function () { router.resetTo('playlists'); throw e; });
  });
}

export function runStage4BSelfTest(platform: Platform, log: Logger, sinkUrl: string, app?: DevApp): Promise<void> {
  const L = log.child('selftest4b');
  const origin = sinkUrl.replace(/\/ingest$/, '');
  return step(L, 'PIN on the key manager (600,000 iterations, rotation, recovery)', pinSuite(platform, L)).then(function () {
    if (!app) {
      L.warn('UI self-test skipped (no app context)');
      return undefined;
    }
    return step(L, 'UI: 50,000-channel import via injected remote keys, then cancel', uiSuite(platform, app, origin));
  }).then(function () {
    L.info('stage 4B self-test done', { memory: platform.memory() });
  });
}
