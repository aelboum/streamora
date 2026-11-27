// Application bootstrap: builds the AppContext from a Platform (manual dependency injection,
// one context object, no globals) and starts navigation. Runs unchanged under Node tests with
// the platform doubles, so start-up logic is tested on Windows.
import type { Platform } from './platform/platform.ts';
import type { BuildInfo } from './build-info.ts';
import type { AppConfig } from './config.ts';
import { loadConfig } from './config.ts';
import { createLifecycle } from './lifecycle.ts';
import type { Lifecycle } from './lifecycle.ts';
import { createMemoryKeyStore, createMemoryLocalStore } from './platform/memory-stores.ts';
import { createMemoryPolicy } from './memory-policy.ts';
import type { MemoryPolicy } from './memory-policy.ts';
import { engineCapabilities } from '../player/engine.ts';
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
import { createAboutScreen } from '../screens/about-screen.ts';
import { createAiSettingsScreen } from '../screens/ai-settings-screen.ts';
import { createPhonePairScreen, PHONE_PAIR_SCREEN } from '../screens/ai-phone-pair-screen.ts';
import { pairingCryptoAvailable } from '../ai/pairing/pair-crypto.ts';
import { createAiEngine } from '../ai/ai-engine.ts';
import type { AiEngine } from '../ai/ai-engine.ts';
import { createResumeToast } from '../screens/resume-toast.ts';
import type { ResumeToastParams } from '../screens/resume-toast.ts';
import { createResumeLive } from '../services/resume-live.ts';
import type { DiagnosticsSection } from '../screens/diagnostics-screen.ts';
import type { StorageReport } from '../services/playlist-service.ts';
import { formatDateTime } from '../screens/format.ts';
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
import { createDiagLog } from '../storage/diag-log.ts';
import { createAccountInfoStore } from '../services/account-info.ts';
import type { AccountInfo, AccountInfoStore } from '../services/account-info.ts';
import { subscriptionLines } from '../screens/subscription-text.ts';
import type { DiagLog } from '../storage/diag-log.ts';
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
  /** CP1: measured floors (Tizen, Android) or limits (platforms without a memory API). */
  memory: MemoryPolicy;
  /** DI-1: persistent storage-integrity log (file store; survives restarts, release builds too). */
  diag: DiagLog;
  /** S2: Xtream account metadata per playlist (KV account.<id>). */
  accounts: AccountInfoStore;
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
  /** AI-02: AI Intelligence Engine (idle until the user enables it; nothing depends on it). */
  ai: AiEngine;
  /** Start-up findings for diagnostics (capabilities missing, config fixes). */
  warnings: string[];
  startedAt: number;
}

/**
 * Stage 7E: free memory (MB) below which a guide download is stopped on the TV. Measured on the
 * UE50MU6100: about 420 MB free at Live TV start; the app stopped responding at about 120 MB.
 */
// CP1: GUIDE_FLOOR_MB in memory-policy.ts (200 MB, measured platforms only).

/**
 * Stage 9: the decoded live catalogue of the active playlist stays in memory after Live TV closes,
 * so reopening it skips the 2.5–2.8 s file read and decode (TV, 21,986 channels). It is released
 * when free memory falls below WORK_FLOOR_MB (memory-policy.ts, 150 MB): above the ≈ 120 MB at which the app stopped
 * responding (Stage 7E) and below the 200 MB guide floor, which guards a download that keeps growing;
 * the cache does not grow. Channel files above memory-policy.ts LIVE_CACHE_MAX_CHARS (≈ 50,000 channels) are not kept;
 * without a memory measurement (CP1) the limit is lower and no floor is checked.
 */
const LIVE_CACHE_CHECK_MS = 10000;

/**
 * Stage 9: blocking file writes (catalogue updates) wait until no key was pressed for
 * WRITE_QUIET_MS, at most WRITE_MAX_WAIT_MS per call, and never while free memory is below
 * WORK_FLOOR_MB (pending pages would otherwise pile up). TV run 1: with the 200 MB guide
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
  // DI-1: storage-integrity events go to a small persistent log in the file store.
  const diag = createDiagLog(platform.fileStore, deps.now);
  const kv = createKeyValueStore(local, log.child('kv'), function (e, d) { diag.record(e, d); });
  const accounts = createAccountInfoStore(kv); // S2
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

  // CP1 (R0 decision 4): without a secure store logins are kept in memory for this session only and
  // asked for again after a restart (Home, playlist form); never stored in plain text.
  const secrets = createSecretStore(platform.keyStore || createMemoryKeyStore());
  if (!secrets.persistent) {
    warnings.push('no secure key store: logins are kept for this session only');
  }
  const memory = createMemoryPolicy(platform);


  const http = createHttpClient({ xhrFactory: platform.xhrFactory, setTimer: deps.setTimer, clearTimer: deps.clearTimer });
  const lifecycle = createLifecycle(platform, log.child('lifecycle'));

  const playlists = catalogue && secrets
    ? createPlaylistService({
      kv: kv, catalogue: catalogue, secrets: secrets, http: http, now: deps.now, log: log.child('playlists'),
      // DI-1: list backup in the file store; without localStorage the list is protected, never empty.
      files: platform.fileStore, diag: diag, storagePersistent: !!platform.localStore,
      accounts: accounts,
      timers: { setTimer: deps.setTimer, clearTimer: deps.clearTimer },
      retry: { attempts: config.network.retryAttempts, delaysMs: DEFAULT_RETRY.delaysMs },
      limits: {
        requestTimeoutMs: config.network.requestTimeoutMs, maxResponseChars: config.network.maxResponseChars,
        maxPlaylistChars: config.network.maxPlaylistChars, idleTimeoutMs: config.network.streamIdleTimeoutMs,
        totalTimeoutMs: config.network.streamTotalTimeoutMs
      },
      liveCache: {
        maxChars: memory.liveCacheMaxChars, minFreeMB: memory.workFloorMB,
        memoryMB: memory.freeMB, checkMs: LIVE_CACHE_CHECK_MS
      }
    })
    : null;
  if (!playlists) {
    warnings.push('playlists unavailable: file storage is required');
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
        minFreeMB: memory.guideFloorMB
      },
      memoryMB: memory.freeMB
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
  } else {
    boot.info('player capabilities', engineCapabilities(engine) as unknown as Record<string, unknown>); // CP1
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
    catalogue: catalogue, secrets: secrets, pin: pin, parental: pin ? createParental(pin, kv, deps.now) : null, http: http, playlists: playlists, epg: epg, vod: vod, lists: lists, myList: myList, catPrefs: catPrefs, memory: memory, diag: diag, accounts: accounts, progress: progress, trackPrefs: trackPrefs, engine: engine,
    textInput: { active: false }, lifecycle: lifecycle,
    // AI-02: created idle; provider credentials live in the platform key store (ai_key_* /
    // ai_session_*), switches, consent and routes in KV ai.settings, the cache in the file store
    // (ai-cache.json). All off by default.
    ai: createAiEngine({
      kv: kv, keyStore: platform.keyStore, files: platform.fileStore, xhrFactory: platform.xhrFactory,
      log: log.child('ai'), now: deps.now, setTimer: deps.setTimer, clearTimer: deps.clearTimer
    }),
    warnings: warnings, startedAt: startedAt
  };
}

/**
 * DI-1.1: read-only "Playlist storage" and "Recent storage events" sections of the diagnostics
 * screen. Uses only the measured StorageReport and the privacy-filtered persistent log; anything
 * not verified is shown as UNKNOWN.
 */
export function storageDiagnostics(ctx: AppContext, rep: StorageReport | null, t: Translate): DiagnosticsSection[] {
  const unknown = t('diag.unknown');
  const lines: Array<{ label: string; value: string }> = [];
  if (!ctx.playlists) {
    lines.push({ label: t('diag.state'), value: t('diag.state.unavailable', { problem: 'no-service' }) });
  } else if (!rep) {
    lines.push({ label: t('diag.state'), value: unknown });
    lines.push({ label: t('diag.listCount'), value: unknown });
    lines.push({ label: t('diag.backup'), value: unknown });
    lines.push({ label: t('diag.backupCount'), value: unknown });
    lines.push({ label: t('diag.integrity'), value: unknown });
  } else {
    const st = rep.state === 'healthy' ? t('diag.state.healthy') : rep.state === 'unknown' ? unknown : t('diag.state.' + rep.state, { problem: rep.problem || '' });
    lines.push({ label: t('diag.state'), value: st });
    lines.push({ label: t('diag.listCount'), value: rep.listEntries === null ? unknown : String(rep.listEntries) });
    lines.push({ label: t('diag.backup'), value: rep.backup === 'unknown' ? unknown : t('diag.backup.' + rep.backup) });
    lines.push({ label: t('diag.backupCount'), value: rep.backupEntries === null ? unknown : String(rep.backupEntries) });
    lines.push({ label: t('diag.integrity'), value: rep.integrity === 'unknown' ? unknown : t('diag.integrity.' + rep.integrity) });
  }
  const ev = ctx.diag.entries();
  let last = '';
  for (let i = ev.length - 1; i >= 0 && !last; i--) {
    if (ev[i].e === 'backup-written') { last = formatDateTime(ev[i].t); }
  }
  lines.push({ label: t('diag.lastBackup'), value: last || unknown });
  const rows: string[] = [];
  for (let j = ev.length - 1; j >= 0; j--) {
    const d = ev[j].d;
    const parts: string[] = [];
    if (d) { for (const k in d) { if (Object.prototype.hasOwnProperty.call(d, k)) { parts.push(k + '=' + String(d[k])); } } }
    rows.push(formatDateTime(ev[j].t) + '  ' + ev[j].e + (parts.length ? '  ' + parts.join(' ') : ''));
  }
  return [
    { title: t('diag.storage'), lines: lines, position: 'top' }, // DI-1.1: always visible
    { title: t('diag.events', { n: ev.length }), lines: [], rows: rows.length ? rows : [t('diag.noEvents')] }
  ];
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
    let storageRep: StorageReport | null = null; // DI-1.1: last read-only report for this screen
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
      },
      // DI-1.1: read-only storage report (fresh reads only; see PlaylistService.storageReport).
      refresh: function () {
        if (!ctx.playlists) { return Promise.resolve(); }
        return ctx.playlists.storageReport().then(function (r) { storageRep = r; }, function () { storageRep = null; });
      },
      sections: function () { return storageDiagnostics(ctx, storageRep, t); }
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
  /**
   * S2: subscription rows for one playlist. The stored account record; for playlists imported
   * before S2, the expiry from the last update (TV clock; no status). M3U: not available.
   */
  function subscriptionFor(playlistId: string, detailed: boolean): Array<{ label: string; value: string }> {
    const pl = ctx.playlists;
    const def = pl ? pl.get(playlistId) : null;
    if (!def) { return []; }
    let info: AccountInfo | null = ctx.accounts.get(playlistId);
    const ls = def.lastStatus;
    if (!info && def.kind === 'xtream' && ls && typeof ls.expiresAt === 'number' && ls.expiresAt >= 946684800000 && ls.expiresAt < 4102444800000) {
      info = { expiry: { kind: 'date', at: ls.expiresAt }, status: '', trial: !!ls.trial, maxConnections: ls.maxConnections || null, checkedAt: ls.at, clock: { source: 'device', offsetMs: 0, reason: 'no-server-time' } };
    }
    return subscriptionLines(def.kind, info, now(), t, detailed);
  }
  /** S3: the last-channel start-up option, where Live TV can play (engine + Live TV screens). */
  const resumePlaylists = ctx.playlists;
  const resume = resumePlaylists && ctx.engine && ctx.epg ? createResumeLive({
    kv: ctx.kv, playlists: resumePlaylists, lists: ctx.lists, parental: ctx.parental,
    memoryLow: function () { return ctx.memory.low(); }, hasPlayer: true,
    now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer, log: ctx.log.child('resume'),
    text: function (name: string) { return { title: t('resume.title', { name: name }), body: t('resume.cancel') }; },
    rootScreen: 'home',
    ui: {
      top: function () { const s = router.stack(); return s.length ? s[s.length - 1] : null; },
      overlay: function () { return router.overlay(); },
      openToast: function (title: string, body: string, cancel: () => void) {
        const tp: ResumeToastParams = { title: title, body: body, cancel: cancel };
        router.openOverlay('resume-toast', tp as unknown as Record<string, unknown>);
      },
      closeToast: function () { if (router.overlay() === 'resume-toast') { router.closeOverlay(); } },
      openLive: function (playlistId: string, channelId: string) { router.push('live-tv', { playlistId: playlistId, resume: { channelId: channelId } }); }
    }
  }) : null;
  /** Settings → About: version, platform, screen, storage (S1: shown on the About screen). */
  function aboutLines(): Array<{ label: string; value: string }> {
    const info = ctx.platform.info();
    const caps = ctx.platform.capabilities();
    return [
      { label: t('set.version'), value: ctx.build.version + (ctx.build.mode === 'release' ? '' : ' (' + ctx.build.mode + ')') },
      { label: t('set.platform'), value: info.name + ' ' + info.platformVersion },
      { label: t('set.screen'), value: info.width + ' × ' + info.height },
      { label: t('set.storage'), value: caps.fileStore ? t('set.storageFiles') : t('set.storageNone') }
    ];
  }
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
      setTimer: tm.setTimer, clearTimer: tm.clearTimer, openText: textOpener(preferIme), live: !!ctx.epg, vod: !!ctx.vod,
      subscription: function (pid: string) { return subscriptionFor(pid, true); }
    });
  }
  if (ctx.playlists && ctx.epg) {
    registerLiveScreens(router, {
      doc: doc, t: t, playlists: ctx.playlists, epg: ctx.epg, lists: ctx.lists, lifecycle: ctx.lifecycle, engine: ctx.engine,
      textInput: ctx.textInput, preferIme: preferIme, now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer, log: ctx.log, parental: ctx.parental,
      // Stage 14: Manage categories (not opened below the 150 MB floor).
      catPrefs: ctx.catPrefs, memoryMB: ctx.memory.freeMB, minFreeMB: ctx.memory.workFloorMB,
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
      memoryMB: ctx.memory.freeMB, minFreeMB: ctx.memory.workFloorMB,
      lifecycle: ctx.lifecycle, engine: ctx.engine, openText: textOpener(preferIme),
      now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer, log: ctx.log, prepareTimeoutMs: ctx.config.player.prepareTimeoutMs,
      // Stage 7E: real track languages / codecs / bitrates from the file (a few small range requests).
      probe: function (src) { return probeSource(ctx.platform.xhrFactory, src, 8000); }
    });
  }
  if (ctx.playlists) {
    // Stage 7B.1: the Home hub (design 01) is the root; the playlist list is reached from Settings.
    const pl = ctx.playlists;
    // CP1: asked once per app run for each playlist (session-only logins).
    const signIn = { asked: {} as Record<string, boolean> };
    router.register('home', function (_p, nav) {
      return createHomeScreen({ doc: doc, t: t, playlists: pl, vod: ctx.vod, progress: ctx.progress, parental: ctx.parental, now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer, signIn: signIn }, nav);
    });
  }
  if (ctx.playlists) {
    const pl2 = ctx.playlists;
    router.register('search', function (_p, nav) {
      return createSearchScreen({
        doc: doc, t: t, playlists: pl2, vod: ctx.vod, kv: ctx.kv, openText: textOpener(preferIme),
        // Stage 10: below the live-cache floor the stored lists load one after another.
        memoryMB: ctx.memory.freeMB,
        minFreeMB: ctx.memory.workFloorMB
      }, nav);
    });
    // S1: About screen (read-only): the Settings About rows plus the font licences.
    router.register('about', function (_p, nav) {
      return createAboutScreen({
        doc: doc, t: t,
        lines: function () {
          return aboutLines().concat([{ label: t('about.fonts'), value: t('about.fontsValue') }]);
        }
      }, nav);
    });
    // AI-02: Settings → AI Intelligence.
    router.register('ai-settings', function (_p, nav) {
      return createAiSettingsScreen({ doc: doc, t: t, ai: ctx.ai, openText: textOpener(preferIme) }, nav);
    });
    // AI-02: API key with the phone (QR, end-to-end encrypted). Only with a configured relay and a
    // cryptographic random source.
    const pairing = ctx.ai.pairing;
    if (pairing && pairingCryptoAvailable()) {
      router.register(PHONE_PAIR_SCREEN, function (p, nav) {
        const provider = String(p && p.provider || '');
        const adapter = ctx.ai.registry.adapter(provider);
        const desc = ctx.ai.registry.descriptor(provider);
        const valid = adapter && adapter.validKey ? adapter.validKey : function () { return false; };
        const onSaved = p && typeof p.onSaved === 'function' ? p.onSaved as () => void : function () { /* none */ };
        return createPhonePairScreen({
          doc: doc, t: t, http: pairing.http, baseUrl: pairing.baseUrl, provider: provider, providerName: desc ? desc.name : provider,
          validKey: valid,
          saveKey: function (key: string) { return ctx.ai.settings.setCredential(provider, 'api-key', key, valid); },
          onSaved: onSaved, now: now, setTimer: tm.setTimer, clearTimer: tm.clearTimer
        }, nav);
      });
    }
    router.register('settings', function (_p, nav) {
      return createSettingsScreen({
        resumeLast: resume ? { get: function () { return resume.enabled(); }, set: function (on: boolean) { resume.setEnabled(on); } } : undefined,
        doc: doc, t: t, playlists: pl2, progress: ctx.progress, trackPrefs: ctx.trackPrefs, kv: ctx.kv, parental: ctx.parental,
        language: function () { return lang; }, setLanguage: setLanguage,
        about: aboutLines,
        subscription: function (pid: string) { return subscriptionFor(pid, false); }
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
  // S3: "Play last channel on app startup" (off by default; one attempt per app session).
  router.register('resume-toast', function (p, nav) {
    return createResumeToast(doc, p as unknown as ResumeToastParams, nav);
  });

  const registeredKeys = ctx.platform.keys.registerKeys(TIZEN_KEY_NAMES);
  // Stage 9: file writes of catalogue updates wait while the remote is in use.
  const quiet = createInputQuiet({
    now: now, setTimer: tm.setTimer, quietMs: WRITE_QUIET_MS, maxWaitMs: WRITE_MAX_WAIT_MS,
    pressure: function () { return ctx.memory.low(); }
  });
  const files = ctx.platform.fileStore;
  if (files && files.setWriteGate) { files.setWriteGate(quiet.wait); }
  const keyRouter = createKeyRouter({
    now: now,
    throttleMs: ctx.config.ui.keyRepeatThrottleMs,
    allowBrowserKeys: ctx.platform.name === 'browser',
    platform: ctx.platform.name, // CP1: the platform's key table (Samsung: unchanged)
    dispatch: function (e) { quiet.note(); return router.handleKey(e); },
    // While the system IME owns a text field, only Back is routed (the rest goes to the IME).
    textInputActive: function () { return ctx.textInput.active; }
  });
  const detachKeys = keyRouter.attach(ctx.platform.keys);

  if (!router.resetTo(rootScreen)) {
    log.error('root screen could not be opened');
  }
  if (resume) {
    resume.run();
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
