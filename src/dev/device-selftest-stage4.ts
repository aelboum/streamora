// DEV BUILDS ONLY (called from device-selftest.ts). Stage 4 measurements on the real TV against
// the synthetic fixtures served by the PC dev sink (scripts/lib/tv-fixtures.mjs):
//   - redirect behaviour of the TV's XHR with the HTTP client's guard (SECURITY-DECISIONS O4);
//   - 50,000-channel M3U and Xtream imports through the real PlaylistService, with the real
//     tizen.filesystem and key manager: import time, minimum free memory, stored size, cached
//     load time, unchanged re-import time; plus a 150,000-channel M3U stress run.
// Synthetic credentials only. Playlist definitions live in an in-memory KV store, so the app's
// real playlist list is never touched; the test playlists, their files and secrets are removed.
import type { FileStore, Platform } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';
import { createHttpClient } from '../api/http-client.ts';
import type { HttpClient } from '../api/http-client.ts';
import { createKeyValueStore } from '../storage/kv-store.ts';
import { createCatalogueStore } from '../storage/catalogue-store.ts';
import { createSecretStore } from '../storage/secret-store.ts';
import { createMemoryLocalStore } from '../app/platform/memory-stores.ts';
import { createPlaylistService } from '../services/playlist-service.ts';
import type { PlaylistInput, PlaylistService } from '../services/playlist-service.ts';
import { DEFAULT_CONFIG } from '../app/config.ts';

const USER = 'tvtest_user';
const PASS = 'tvtest_pass_0';

function step(log: Logger, name: string, p: Promise<unknown>): Promise<void> {
  const t0 = Date.now();
  return p.then(function (detail) {
    log.info('selftest PASS ' + name, { ms: Date.now() - t0, detail: detail });
  }, function (e) {
    log.warn('selftest FAIL ' + name, { ms: Date.now() - t0 }, e);
  });
}

function redirects(http: HttpClient, origin: string): Promise<unknown> {
  function run(to: string, credentialed: boolean) {
    const url = origin + '/fixture/redirect?to=' + to + (credentialed ? '&username=' + USER + '&password=' + PASS : '');
    const h = http.request<unknown>(credentialed
      ? { url: url, policy: { kind: 'userSource' }, responseType: 'json', credentialOrigin: origin, timeoutMs: 10000 }
      : { url: url, policy: { kind: 'userSource' }, responseType: 'json', timeoutMs: 10000 });
    return h.result.then(function (r) {
      // Flat strings: the logger redacts keys that look like credentials and limits nesting.
      return { ok: r.ok, text: to + (credentialed ? '+cred' : '') + ' -> ' + (r.ok ? 'ok redirect=' + r.redirect : 'error ' + r.error.kind) };
    });
  }
  return run('cross', true).then(function (a) {
    return run('same', true).then(function (b) {
      return run('cross', false).then(function (c) {
        if (a.ok || a.text.indexOf('redirect-blocked') < 0) {
          throw new Error('cross-origin redirect with credentials was not blocked: ' + a.text);
        }
        return [a.text, b.text, c.text].join('; ');
      });
    });
  });
}

function importRun(platform: Platform, files: FileStore, svc: PlaylistService, input: PlaylistInput): Promise<unknown> {
  let minFree = platform.memory().availableMB;
  const freeBefore = minFree;
  let samples = 0;
  return svc.add(input).then(function (a) {
    if (!a.ok) {
      throw new Error('add failed: ' + a.code);
    }
    const id = a.playlist.id;
    const t0 = Date.now();
    return svc.refresh(id, function () {
      samples++;
      const m = platform.memory().availableMB;
      if (m >= 0 && m < minFree) { minFree = m; }
    }).result.then(function (r) {
      const importMs = Date.now() - t0;
      if (!r.ok) {
        return svc.remove(id).then(function () { throw new Error('import failed: ' + r.code + ' ' + r.message); });
      }
      const after = platform.memory().availableMB;
      if (after >= 0 && after < minFree) { minFree = after; }
      const t1 = Date.now();
      return svc.loadLive(id).then(function (l) {
        const loadMs = Date.now() - t1;
        const channels = l.status === 'ok' ? l.catalogue.channels.length : -1;
        const t2 = Date.now();
        return svc.refresh(id).result.then(function (again) {
          const reimportMs = Date.now() - t2;
          return files.read('cat.' + id + '.live.json').then(function (text) {
            return svc.remove(id).then(function () {
              return {
                kind: input.kind, live: r.counts.live, categories: r.categories, importMs: importMs, fetchMs: r.fetchMs, storeMs: r.storeMs, overBudget: r.overBudget,
                storedChars: text ? text.length : -1, loadStatus: l.status, loadMs: loadMs, channelsLoaded: channels,
                reimportMs: reimportMs, reimportUnchanged: again.ok && again.unchanged,
                // Flat fields: nested objects are cut by the logger's depth limit.
                freeBeforeMB: freeBefore, freeMinMB: minFree, memSamples: samples
              };
            });
          });
        });
      });
    });
  });
}

export function runStage4SelfTest(platform: Platform, log: Logger, sinkUrl: string): Promise<void> {
  const L = log.child('selftest4');
  const files = platform.fileStore;
  if (!files || !platform.keyStore || !sinkUrl) {
    L.warn('stage 4 self-test skipped (needs file store, key store and the dev sink)');
    return Promise.resolve();
  }
  const origin = sinkUrl.replace(/\/ingest$/, '');
  const net = DEFAULT_CONFIG.network;
  const http = createHttpClient({ xhrFactory: platform.xhrFactory });
  const svc = createPlaylistService({
    kv: createKeyValueStore(createMemoryLocalStore()),
    catalogue: createCatalogueStore(files,
      { budgetChars: DEFAULT_CONFIG.storage.sectionBudgetChars, maxChars: DEFAULT_CONFIG.storage.sectionMaxChars },
      function () { return Date.now(); }, L),
    secrets: createSecretStore(platform.keyStore),
    http: http,
    now: function () { return Date.now(); },
    log: L,
    timers: { setTimer: function (fn, ms) { return setTimeout(fn, ms); }, clearTimer: function (h) { clearTimeout(h as number); } },
    retry: { attempts: 1, delaysMs: [] },
    limits: {
      requestTimeoutMs: net.requestTimeoutMs, maxResponseChars: net.maxResponseChars, maxPlaylistChars: net.maxPlaylistChars,
      idleTimeoutMs: net.streamIdleTimeoutMs, totalTimeoutMs: net.streamTotalTimeoutMs
    }
  });
  const base = origin + '/get.php?username=' + USER + '&password=' + PASS;
  const m3u50k: PlaylistInput = { name: 'selftest m3u', kind: 'm3u', url: base + '&n=50000' };
  const xt50k: PlaylistInput = { name: 'selftest xtream', kind: 'xtream', server: origin, username: USER, password: PASS };
  const m3u150k: PlaylistInput = { name: 'selftest m3u big', kind: 'm3u', url: base + '&n=150000' };

  return step(L, 'redirect guard on the TV XHR', redirects(http, origin))
    .then(function () { return step(L, 'M3U import 50,000 channels', importRun(platform, files, svc, m3u50k)); })
    .then(function () { return step(L, 'Xtream import 50,000 channels', importRun(platform, files, svc, xt50k)); })
    .then(function () { return step(L, 'M3U import 150,000 channels (stress)', importRun(platform, files, svc, m3u150k)); })
    .then(function () {
      L.info('stage 4 self-test done', { memory: platform.memory() });
    });
}
