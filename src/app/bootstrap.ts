// Application bootstrap: builds the AppContext from a Platform (manual dependency injection,
// one context object, no globals) and starts navigation. Runs unchanged under Node tests with
// the platform doubles, so start-up logic is tested on Windows.
import type { Platform } from './platform/platform.ts';
import type { BuildInfo } from './build-info.ts';
import type { AppConfig } from './config.ts';
import { loadConfig } from './config.ts';
import { createLifecycle } from './lifecycle.ts';
import type { Lifecycle } from './lifecycle.ts';
import { createMemoryLocalStore } from './platform/memory-stores.ts';
import { createLogger } from '../utils/log.ts';
import type { Logger } from '../utils/log.ts';
import { createKeyValueStore } from '../storage/kv-store.ts';
import type { KeyValueStore } from '../storage/kv-store.ts';
import { createCatalogueStore } from '../storage/catalogue-store.ts';
import type { CatalogueStore } from '../storage/catalogue-store.ts';
import { createSecretStore } from '../storage/secret-store.ts';
import type { SecretStore } from '../storage/secret-store.ts';
import { createPinService } from '../security/pin.ts';
import type { PinService } from '../security/pin.ts';
import { createHttpClient } from '../api/http-client.ts';
import type { HttpClient } from '../api/http-client.ts';
import { DEFAULT_RETRY } from '../api/retry.ts';
import { createPlaylistService } from '../services/playlist-service.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import { createRouter } from '../navigation/router.ts';
import type { Router, ScreenHost } from '../navigation/router.ts';
import { createKeyRouter } from '../navigation/key-router.ts';
import { createInputQuiet } from './input-quiet.ts';
import type { InputQuiet } from './input-quiet.ts';
import type { KeyRouter } from '../navigation/key-router.ts';
import { TIZEN_KEY_NAMES } from '../navigation/keys.ts';
import { createDiagnosticsScreen } from '../screens/diagnostics-screen.ts';
import { createExitDialog } from '../screens/exit-dialog.ts';
import { registerPlaylistScreens } from '../screens/playlist-screens.ts';
import { createTranslator } from '../i18n/strings.ts';
import { createEpgService } from '../services/epg-service.ts';
import { createVodService } from '../services/vod-service.ts';
import type { VodService } from '../services/vod-service.ts';
import { registerVodScreens } from '../screens/vod-screens.ts';
import { probeSource } from '../player/media-probe.ts';
import { createHomeScreen } from '../screens/home-screen.ts';
import { createSearchScreen } from '../screens/search-screen.ts';
import { createSettingsScreen } from '../screens/settings-screen.ts';
import type { UiLanguage } from '../screens/settings-screen.ts';
import { saveConfigOverride } from './config.ts';
import type { Translate } from '../i18n/strings.ts';
import { createProgressStore } from '../services/progress.ts';
import type { ProgressStore } from '../services/progress.ts';
import { createTrackPrefs } from '../services/track-prefs.ts';
import { createParental } from '../services/parental.ts';
import type { Parental } from '../services/parental.ts';
import { createPinDialog } from '../screens/pin-dialog.ts';
import type { PinDialogParams } from '../screens/pin-dialog.ts';
import type { TrackPrefStore } from '../services/track-prefs.ts';
import type { EpgService } from '../services/epg-service.ts';
import { createUserLists } from '../services/user-lists.ts';
import type { UserLists } from '../services/user-lists.ts';
import { createMyList } from '../services/my-list.ts';
import type { MyList } from '../services/my-list.ts';
import { createCategoryPrefsStore } from '../content/category-prefs.ts';
import type { CategoryPrefsStore } from '../content/category-prefs.ts';
import type { PlaybackEngine } from '../player/engine.ts';
import { registerLiveScreens, textOpener } from '../screens/live-screens.ts';
import type { TextInputState } from '../screens/text-entry-overlay.ts';

export interface AppDeps {
  platform: Platform;
  build: BuildInfo;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Creates the playback engine (AVPlay on the TV); absent or null = no playback. */
  engineFactory?: (log: Logger) => PlaybackEngine | null;
}

export interface AppContext {
  platform: Platform;
  build: BuildInfo;
  log: Logger;
  config: AppConfig;
  kv: KeyValueStore;
  /** null when the platform has no file storage. */
  catalogue: CatalogueStore | null;
  /** null when the platform has no secure key store: credentials must then not be saved. */
  secrets: SecretStore | null;
  /** null when WebCrypto PBKDF2 is unavailable: the PIN feature is then disabled. */
  pin: PinService | null;
  http: HttpClient;
  /** null when file storage or the secure key store is missing (no plaintext credential fallback). */
  playlists: PlaylistService | null;
  /** null without playlists. */
  epg: EpgService | null;
  /** Movies and series (Stage 6). */
  vod: VodService | null;
  lists: UserLists;
  /** Stage 11: My List (movies and series per account). */
  myList: MyList;
  /** Stage 14: hidden / reordered categories per account and type. */
  catPrefs: CategoryPrefsStore;
  /** Stage 7B.2: viewing progress and watched marks. */
  progress: ProgressStore;
  /** Stage 7B.2: preferred audio / subtitle language. */
  trackPrefs: TrackPrefStore;
  /** Stage 7B.2 part 4: adult-content lock over the PIN service (null without PIN support). */
  parental: Parental | null;
  engine: PlaybackEngine | null;
  /** True while a text field owns the remote keys (system IME). */
  textInput: TextInputState;
  lifecycle: Lifecycle;
  /** Start-up findings for diagnostics (capabilities missing, config fixes). */
  warnings: string[];
  startedAt: number;
}

/**
 * Stage 7E: free memory (MB) below which a guide download is stopped on the TV. Measured on the
 * UE50MU6100: about 420 MB free at Live TV start; the app stopped responding at about 120 MB.
 */
const EPG_MIN_FREE_MB = 200;

/**
 * Stage 9: the decoded live catalogue of the active playlist stays in memory after Live TV closes,
 * so reopening it skips the 2.5–2.8 s file read and decode (TV, 21,986 channels). It is released
 * when free memory falls below LIVE_CACHE_MIN_FREE_MB: above the ≈ 120 MB at which the app stopped
 * responding (Stage 7E) and below the 200 MB guide floor, which guards a download that keeps growing;
 * the cache does not grow. Channel files above LIVE_CACHE_MAX_CHARS (≈ 50,000 channels) are not kept.
 */
const LIVE_CACHE_MIN_FREE_MB = 150;
const LIVE_CACHE_MAX_CHARS = 8000000;
const LIVE_CACHE_CHECK_MS = 10000;

/**
 * Stage 9: blocking file writes (catalogue updates) wait until no key was pressed for
 * WRITE_QUIET_MS, at most WRITE_MAX_WAIT_MS per call, and never while free memory is below
 * LIVE_CACHE_MIN_FREE_MB (pending pages would otherwise pile up). TV run 1: with the 200 MB guide
 * floor the gate was bypassed for 83 of 84 waits, because this TV usually has 156–200 MB free. See input-quiet.ts.
 */
const WRITE_QUIET_MS = 1500;
const WRITE_MAX_WAIT_MS = 5000;

export function createAppContext(deps: AppDeps): AppContext {
  const startedAt = deps.now();
  const log = createLogger(200, deps.now);
  const boot = log.child('boot');
  const warnings: string[] = [];
  const platform = deps.platform;

  let local = platform.localStore;
  if (!local) {
    local = createMemoryLocalStore();
    warnings.push('settings storage unavailable: settings are not saved');
  }
  const kv = createKeyValueStore(local, log.child('kv'));
  const cfg = loadConfig(kv);
  for (let i = 0; i < cfg.warnings.length; i++) {
    warnings.push('config: ' + cfg.warnings[i]);
  }
  const config = cfg.config;
  log.setLevel(config.logging.level);

  const catalogue = platform.fileStore
    ? createCatalogueStore(platform.fileStore,
      { budgetChars: config.storage.sectionBudgetChars, maxChars: config.storage.sectionMaxChars }, deps.now, log.child('catalogue'))
    : null;
  if (!catalogue) {
    warnings.push('file storage unavailable: catalogues cannot be cached');
  }

  const secrets = platform.keyStore ? createSecretStore(platform.keyStore) : null;
  if (!secrets) {
    warnings.push('secure key store unavailable: playlist credentials cannot be saved');
  } else if (!secrets.persistent) {
    warnings.push('secure key store is session-only: credentials are forgotten on restart');
  }


  const http = createHttpClient({ xhrFactory: platform.xhrFactory, setTimer: deps.setTimer, clearTimer: deps.clearTimer });
  const lifecycle = createLifecycle(platform, log.child('lifecycle'));

  const playlists = catalogue && secrets
    ? createPlaylistService({
      kv: kv, catalogue: catalogue, secrets: secrets, http: http, now: deps.now, log: log.child('playlists'),
      timers: { setTimer: deps.setTimer, clearTimer: deps.clearTimer },
      retry: { attempts: config.network.retryAttempts, delaysMs: DEFAULT_RETRY.delaysMs },
      limits: {
        requestTimeoutMs: config.network.requestTimeoutMs, maxResponseChars: config.network.maxResponseChars,
        maxPlaylistChars: config.network.maxPlaylistChars, idleTimeoutMs: config.network.streamIdleTimeoutMs,
        totalTimeoutMs: config.network.streamTotalTimeoutMs
      },
      liveCache: {
        maxChars: LIVE_CACHE_MAX_CHARS, minFreeMB: platform.name === 'tizen' ? LIVE_CACHE_MIN_FREE_MB : 0,
        memoryMB: function () { return platform.memory().availableMB; }, checkMs: LIVE_CACHE_CHECK_MS
      }
    })
    : null;
  if (!playlists) {
    warnings.push('playlists unavailable: file storage and a secure key store are both required');
  } else {
    // Interrupted-import detection and catalogue cleanup; runs in the background.
    playlists.recover().then(function (r) {
      if (r.interrupted || r.removedFiles) {
        boot.info('playlist recovery', { interrupted: r.interrupted, removedFiles: r.removedFiles });
      }
    }, function (e) { boot.warn('playlist recovery failed', undefined, e); });
  }

  const lists = createUserLists(kv);
  const myList = createMyList(kv, deps.now);
  const catPrefs = createCategoryPrefsStore(kv);
  const progress = createProgressStore(kv, deps.now);
  const trackPrefs = createTrackPrefs(kv);
  const epg = playlists && catalogue
    ? createEpgService({
      playlists: playlists, catalogue: catalogue, http: http, now: deps.now, log: log.child('epg'),
      timers: { setTimer: deps.setTimer, clearTimer: deps.clearTimer, now: deps.now },
      limits: {
        maxChars: config.network.maxPlaylistChars, idleTimeoutMs: config.network.streamIdleTimeoutMs,
        totalTimeoutMs: config.network.streamTotalTimeoutMs, pastHours: config.epg.pastHours, futureHours: config.epg.futureHours,
        maxPerChannel: config.epg.maxPerChannel, maxTotal: config.epg.maxProgrammes, staleMs: config.epg.staleHours * 3600000,
        defaultOffsetMin: config.epg.defaultOffsetMin, maxGzipBytes: config.epg.maxGzipMB * 1000000,
        // Stage 7E: stop a guide download before the TV runs out of memory (see epg-service.ts).
        minFreeMB: platform.name === 'tizen' ? EPG_MIN_FREE_MB : 0
      },
      memoryMB: function () { return platform.memory().availableMB; }
    })
    : null;
  const vod = playlists && catalogue ? createVodService({ playlists: playlists, catalogue: catalogue, kv: kv, now: deps.now, log: log.child('vod') }) : null;
  let engine: PlaybackEngine | null = null;
  try {
    engine = deps.engineFactory ? deps.engineFactory(log.child('avplay')) : null;
  } catch (e) {
    boot.warn('playback engine could not be created', undefined, e);
  }
  if (!engine) {
    warnings.push('video playback unavailable on this platform');
  }

  // PIN record in the key manager (Stage 4B P4); without WebCrypto or a key store the feature is off.
  const pinKeys = platform.keyStore;
  const pin = platform.crypto && pinKeys
    ? createPinService(platform.crypto, pinKeys, kv, {
      iterations: config.security.pinIterations,
      maxAttempts: config.security.pinMaxAttempts,
      lockoutMs: config.security.pinLockoutMs
    }, deps.now, log.child('parental'), {
      wipeContent: function () { return playlists ? playlists.removeAll() : Promise.resolve(); }
    })
    : null;
  if (!pin) {
    warnings.push(platform.crypto ? 'secure key store unavailable: parental PIN disabled' : 'WebCrypto PBKDF2 unavailable: parental PIN disabled');
  } else {
    pin.load().then(function (st) {
      boot.info('parental state', { state: st });
    }, function () { /* load never rejects */ });
  }

  for (let j = 0; j < warnings.length; j++) {
    boot.warn(warnings[j]);
  }
  boot.info('context ready', { platform: platform.name, capabilities: platform.capabilities(), build: deps.build.mode });

  return {
    platform: platform, build: deps.build, log: log, config: config, kv: kv,
    catalogue: catalogue, secrets: secrets, pin: pin, parental: pin ? createParental(pin, kv, deps.now) : null, http: http, playlists: playlists, epg: epg, vod: vod, lists: lists, myList: myList, catPrefs: catPrefs, progress: progress, trackPrefs: trackPrefs, engine: engine,
    textInput: { active: false }, lifecycle: lifecycle,
    warnings: warnings, startedAt: startedAt
  };
}

export interface StartedApp {
  router: Router;
  keyRouter: KeyRouter;
  /** Stage 9: gate that holds blocking file writes back while keys are pressed (diagnostics). */
  writeGate: InputQuiet;
  registeredKeys: string[];
  stop(): void;
}

function yesNo(v: boolean): string {
  return v ? 'yes' : 'no';
}

/** Registers screens and keys and shows the root screen. */
export interface StartTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export function startApp(ctx: AppContext, host: ScreenHost, doc: Document, now: () => number, timers?: StartTimers): StartedApp {
  const log = ctx.log.child('app');
  const router = createRouter(host, ctx.log.child('router'));

  router.register('diagnostics', function (_params, nav) {
    return createDiagnosticsScreen(doc, {
      title: 'Diagnostics · build ' + ctx.build.version + ' (' + ctx.build.mode + ')',
      lines: function () {
        const info = ctx.platform.info();
        const caps = ctx.platform.capabilities();
        const mem = ctx.platform.memory();
        return [
          { label: 'Platform', value: info.name + ' ' + info.platformVersion },
          { label: 'Viewport', value: info.width + ' × ' + info.height },
          { label: 'Video (AVPlay)', value: yesNo(caps.avplay) },
          { label: 'File storage', value: yesNo(caps.fileStore) },
          { label: 'Secure key store', value: yesNo(caps.secureKeyStore) },
          { label: 'WebCrypto', value: yesNo(caps.webCrypto) },
          { label: 'Remote keys', value: yesNo(caps.keyRegistration) },
          { label: 'Free memory', value: mem.availableMB >= 0 ? mem.availableMB + ' MB' : 'unknown' },
          { label: 'Network', value: ctx.lifecycle.online() ? 'online' : 'offline' },
          { label: 'Warnings', value: ctx.warnings.length ? ctx.warnings.join('; ') : 'none' }
        ];
      },
      recentLog: function () {
        const entries = ctx.log.entries().slice(-8);
        const out: string[] = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          out.push(e.level.toUpperCase() + ' ' + (e.component ? e.component + ': ' : '') + e.msg);
        }
        return out;
      }
    }, nav);
  });
  router.register('exit-dialog', function (_params, nav) {
    return createExitDialog(doc, nav, function () { ctx.lifecycle.exit(); });
  });
  router.setRootBackHandler(function () { router.openOverlay('exit-dialog'); });
  const tm = timers || { setTimer: function (fn: () => void, ms: number) { return setTimeout(fn, ms); }, clearTimer: function (h: unknown) { clearTimeout(h as number); } };
  // Stage 7B.2: the language can change at run time (Settings); every screen calls through `t`.
  let lang: UiLanguage = ctx.config.ui.language;
  let table = createTranslator(lang);
  const t: Translate = function (key, params) { return table(key, params); };
  function setLanguage(l: UiLanguage): void {
    if (l === lang) { return; }
    const cur = ctx.kv.get<Record<string, unknown> | null>('config', function (x): x is Record<string, unknown> | null { return !!x && typeof x === 'object'; }, null) || {};
    const ui = cur.ui && typeof cur.ui === 'object' ? cur.ui as Record<string, unknown> : {};
    const next: Record<string, unknown> = {};
    for (const k in cur) { if (Object.prototype.hasOwnProperty.call(cur, k)) { next[k] = cur[k]; } }
    const nui: Record<string, unknown> = {};
    for (const k in ui) { if (Object.prototype.hasOwnProperty.call(ui, k)) { nui[k] = ui[k]; } }
    nui.language = l;
    next.ui = nui;
    if (saveConfigOverride(ctx.kv, next).length) { log.warn('language not saved'); }
    lang = l;
    table = createTranslator(l);
    router.resetTo('home');
    router.push('settings');
  }
  // Stage 5 keyboard strategy: the Samsung IME where available, the app keyboard otherwise.
  const preferIme = ctx.platform.name === 'tizen' && ctx.config.ui.keyboard === 'auto';
  if (ctx.playlists) {
    registerPlaylistScreens(router, {
      doc: doc, playlists: ctx.playlists, t: t, now: now,
      setTimer: tm.setTimer, clearTimer: tm.clearTimer, openText: textOpener(preferIme), live: !!ctx.epg, vod: !!ctx.vod
    });
  }
  if (ctx.playlists && ctx.epg) {
    registerLiveScreens(router, {
      doc: doc, t: t, playlists: ctx.playlists, epg: ctx.epg, lists: ctx.lists, lifecycle: ctx.lifecycle, engine: ctx.engine,
      textInput: ctx.textInput, preferIme: preferIme, now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer, log: ctx.log, parental: ctx.parental,
      // Stage 14: Manage categories (not opened below the 150 MB floor).
      catPrefs: ctx.catPrefs, memoryMB: function () { return ctx.platform.memory().availableMB; }, minFreeMB: ctx.platform.name === 'tizen' ? LIVE_CACHE_MIN_FREE_MB : 0,
      // Stage 7E: the focused channel plays in the details column once the focus rested 0.7 s
      // (+0.12 s info delay); the TV's single decoder, so nothing else plays meanwhile.
      preview: { debounceMs: 700 },
      player: {
        bufferSec: ctx.config.player.liveBufferSec, prepareTimeoutMs: ctx.config.player.prepareTimeoutMs, prepareStallMs: ctx.config.player.prepareStallMs,
        zapDebounceMs: ctx.config.player.zapDebounceMs, retryDelaysMs: [2000, 5000, 10000], numberEntryMs: ctx.config.player.numberEntryMs,
        // A single CH+/CH−/▲▼ tunes at once; presses closer than this keep the zap debounce.
        zapQuietMs: 600
      }
    });
  }
  if (ctx.playlists && ctx.vod) {
    registerVodScreens(router, {
      doc: doc, t: t, playlists: ctx.playlists, vod: ctx.vod, progress: ctx.progress, trackPrefs: ctx.trackPrefs, parental: ctx.parental, myList: ctx.myList, catPrefs: ctx.catPrefs,
      memoryMB: function () { return ctx.platform.memory().availableMB; }, minFreeMB: ctx.platform.name === 'tizen' ? LIVE_CACHE_MIN_FREE_MB : 0,
      lifecycle: ctx.lifecycle, engine: ctx.engine, openText: textOpener(preferIme),
      now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer, log: ctx.log, prepareTimeoutMs: ctx.config.player.prepareTimeoutMs,
      // Stage 7E: real track languages / codecs / bitrates from the file (a few small range requests).
      probe: function (src) { return probeSource(ctx.platform.xhrFactory, src, 8000); }
    });
  }
  if (ctx.playlists) {
    // Stage 7B.1: the Home hub (design 01) is the root; the playlist list is reached from Settings.
    const pl = ctx.playlists;
    router.register('home', function (_p, nav) {
      return createHomeScreen({ doc: doc, t: t, playlists: pl, vod: ctx.vod, progress: ctx.progress, parental: ctx.parental, now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer }, nav);
    });
  }
  if (ctx.playlists) {
    const pl2 = ctx.playlists;
    router.register('search', function (_p, nav) {
      return createSearchScreen({
        doc: doc, t: t, playlists: pl2, vod: ctx.vod, kv: ctx.kv, openText: textOpener(preferIme),
        // Stage 10: below the live-cache floor the stored lists load one after another.
        memoryMB: function () { return ctx.platform.memory().availableMB; },
        minFreeMB: ctx.platform.name === 'tizen' ? LIVE_CACHE_MIN_FREE_MB : 0
      }, nav);
    });
    router.register('settings', function (_p, nav) {
      return createSettingsScreen({
        doc: doc, t: t, playlists: pl2, progress: ctx.progress, trackPrefs: ctx.trackPrefs, kv: ctx.kv, parental: ctx.parental,
        language: function () { return lang; }, setLanguage: setLanguage,
        about: function () {
          const info = ctx.platform.info();
          const caps = ctx.platform.capabilities();
          return [
            { label: t('set.version'), value: ctx.build.version + (ctx.build.mode === 'release' ? '' : ' (' + ctx.build.mode + ')') },
            { label: t('set.platform'), value: info.name + ' ' + info.platformVersion },
            { label: t('set.screen'), value: info.width + ' × ' + info.height },
            { label: t('set.storage'), value: caps.fileStore ? t('set.storageFiles') : t('set.storageNone') }
          ];
        }
      }, nav);
    });
  }
  if (ctx.parental) {
    const par = ctx.parental;
    router.register('pin-dialog', function (p, nav) {
      return createPinDialog({ doc: doc, t: t, parental: par, openText: textOpener(preferIme) }, p as unknown as PinDialogParams, nav);
    });
  }
  const rootScreen = ctx.playlists ? 'home' : 'diagnostics';

  const registeredKeys = ctx.platform.keys.registerKeys(TIZEN_KEY_NAMES);
  // Stage 9: file writes of catalogue updates wait while the remote is in use.
  const quiet = createInputQuiet({
    now: now, setTimer: tm.setTimer, quietMs: WRITE_QUIET_MS, maxWaitMs: WRITE_MAX_WAIT_MS,
    pressure: function () { const mb = ctx.platform.memory().availableMB; return ctx.platform.name === 'tizen' && mb >= 0 && mb < LIVE_CACHE_MIN_FREE_MB; }
  });
  const files = ctx.platform.fileStore;
  if (files && files.setWriteGate) { files.setWriteGate(quiet.wait); }
  const keyRouter = createKeyRouter({
    now: now,
    throttleMs: ctx.config.ui.keyRepeatThrottleMs,
    allowBrowserKeys: ctx.platform.name === 'browser',
    dispatch: function (e) { quiet.note(); return router.handleKey(e); },
    // While the system IME owns a text field, only Back is routed (the rest goes to the IME).
    textInputActive: function () { return ctx.textInput.active; }
  });
  const detachKeys = keyRouter.attach(ctx.platform.keys);

  if (!router.resetTo(rootScreen)) {
    log.error('root screen could not be opened');
  }
  log.info('started', { ms: now() - ctx.startedAt, keys: registeredKeys.length });

  return {
    router: router,
    keyRouter: keyRouter,
    writeGate: quiet,
    registeredKeys: registeredKeys,
    stop: function () {
      if (files && files.setWriteGate) { files.setWriteGate(null); }
      detachKeys();
      ctx.lifecycle.dispose();
    }
  };
}
