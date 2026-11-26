// DEV BUILDS ONLY (imported from dev-hooks.ts, which release builds replace with a no-op).
// Exercises the platform adapters on the real TV and logs the results through the dev log sink,
// so TV-only assumptions become evidence: File.moveTo (atomic replace), key-manager overwrite,
// PBKDF2 at 100,000 iterations, and whether XHR exposes responseURL. Stage 4 measurements follow
// (device-selftest-stage4.ts).
// Uses synthetic values only. Never touches real playlists, PINs or catalogues.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';
import { runStage4SelfTest } from './device-selftest-stage4.ts';
import { runStage4BSelfTest } from './device-selftest-stage4b.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import { runStage5SelfTest } from './device-selftest-stage5.ts';
import { runStage51SelfTest } from './device-selftest-stage51.ts';
import { runStage6SelfTest } from './device-selftest-stage6.ts';
import { runStage7B2SelfTest } from './device-selftest-stage7b2.ts';

/** Which later-stage suite runs after the Stage 3 checks. Stage 4 import measurements are kept in docs/evidence. */
const SUITE: string = '7b2';

const FILE = 'selftest.tmpdata.json';
const ALIAS = 'ss_selftest_probe';

function step(log: Logger, name: string, p: Promise<string>): Promise<void> {
  const t0 = Date.now();
  return p.then(function (detail) {
    log.info('selftest PASS ' + name, { ms: Date.now() - t0, detail: detail });
  }, function (e) {
    log.warn('selftest FAIL ' + name, { ms: Date.now() - t0 }, e);
  });
}

export function runDeviceSelfTest(platform: Platform, log: Logger, sinkUrl: string, app?: DevApp): Promise<void> {
  const L = log.child('selftest');
  if (SUITE === '7b2') {
    // Stage 7B.2: seek/tracks/resume, TV guide, Settings/Search, PIN cost on the user's Xtream playlist.
    return runStage7B2SelfTest(platform, log, app);
  }
  if (SUITE === '6') {
    // Stage 6: the user's Xtream playlist only; the platform checks (incl. the 1 MB file write) are skipped.
    return runStage6SelfTest(platform, log, app);
  }
  let chain: Promise<void> = Promise.resolve();

  const files = platform.fileStore;
  if (files) {
    chain = chain.then(function () {
      let payload = '';
      while (payload.length < 1048576) {
        payload += 'ScreenShelf self-test data 0123456789 ';
      }
      return step(L, 'fileStore write/read/replace/remove 1 MB', files.write(FILE, 'first').then(function () {
        return files.write(FILE, payload);
      }).then(function () {
        return files.read(FILE);
      }).then(function (back) {
        if (back !== payload) {
          throw new Error('read-back mismatch (' + (back === null ? 'null' : back.length) + ' chars)');
        }
        return files.list();
      }).then(function (names) {
        const listed = names.indexOf(FILE) >= 0;
        return files.remove(FILE).then(function () { return files.read(FILE); }).then(function (gone) {
          return 'atomicReplace=' + files.atomicReplace + ' listed=' + listed + ' removed=' + (gone === null);
        });
      }));
    });
  }

  const keys = platform.keyStore;
  if (keys) {
    chain = chain.then(function () {
      return step(L, 'keyStore save/overwrite/load/remove', keys.save(ALIAS, 'synthetic-1').then(function () {
        return keys.save(ALIAS, 'synthetic-2');
      }).then(function () {
        return keys.load(ALIAS);
      }).then(function (v) {
        if (v !== 'synthetic-2') {
          throw new Error('overwrite not read back');
        }
        return keys.remove(ALIAS);
      }).then(function () {
        return keys.load(ALIAS);
      }).then(function (gone) {
        return 'persistent=' + keys.persistent + ' removed=' + (gone === null);
      }));
    });
  }

  const crypto = platform.crypto;
  if (crypto) {
    chain = chain.then(function () {
      const pw = new Uint8Array([49, 50, 51, 52]);
      const salt = crypto.randomBytes(16);
      const t0 = Date.now();
      return step(L, 'PBKDF2-SHA256 100,000 iterations', crypto.pbkdf2Sha256(pw, salt, 100000, 256).then(function (dk) {
        return 'ms=' + (Date.now() - t0) + ' bytes=' + dk.length;
      }));
    });
  }

  if (sinkUrl) {
    chain = chain.then(function () {
      return step(L, 'XHR responseURL availability', new Promise<string>(function (resolve, reject) {
        const target = sinkUrl.replace(/\/ingest$/, '/selftest-responseurl');
        const x = platform.xhrFactory();
        x.onload = function () {
          const has = typeof x.responseURL === 'string';
          resolve('status=' + x.status + ' responseURL ' + (has ? (x.responseURL === target ? 'present, equals request' : 'present, differs') : 'ABSENT'));
        };
        x.onerror = function () { reject(new Error('request failed')); };
        x.open('GET', target, true);
        x.send(null);
      }));
    });
  }

  return chain.then(function () {
    L.info('selftest done', { memory: platform.memory() });
    // Stage 4: redirect guard and large imports against the dev sink's synthetic fixtures.
    if (SUITE === '4') { return runStage4SelfTest(platform, log, sinkUrl); }
    if (SUITE === '4b') { return runStage4BSelfTest(platform, log, sinkUrl, app); }
    if (SUITE === '5.1r') { return runStage51SelfTest(platform, log, sinkUrl, app, 10, false, false); }
    if (SUITE === '5.1') {
      // Stage 5.1: recovery (streams joined mid-packet, as before), gzip guides, then the Stage 5 scale runs.
      return runStage51SelfTest(platform, log, sinkUrl, app, 8, false, true).then(function () { return runStage5SelfTest(platform, log, sinkUrl, app, true); });
    }
    return runStage5SelfTest(platform, log, sinkUrl, app);
  });
}
