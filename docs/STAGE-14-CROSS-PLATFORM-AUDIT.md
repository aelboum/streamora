# Cross-platform IPTV migration: architecture audit

Date: 2026-11-26. **Audit and planning only.** No source, build, dependency or TV change was made. Commit `c0adf0b` on `main`; the working tree was clean before and after.

**Naming:** this audit was requested as "Stage X" under the file names `STAGE-14-CROSS-PLATFORM-*`. "Stage 14" in the project history is *category management* (`docs/STAGE-14-CATEGORY-MANAGEMENT-REPORT.md`). The two are different pieces of work, and the numbering for the migration stages is decision D1 (§20).

Evidence tags:
- **[R]** read in the repository;
- **[T]** verified on the Samsung TV in earlier stages;
- **[DOC]** official platform documentation;
- **[3P]** third-party or community source;
- **[A]** assumption, to be verified.

Sources are listed at the end.

---

## 1. Executive summary

1. **The codebase is already a shared-core design with a platform layer, so no rewrite is needed.**
   - All Tizen API access sits in `src/app/platform/` and `src/player/avplay-engine.ts`. `scripts/compat-check.mjs` enforces this [R].
   - About **4 %** of the 22,800 product source lines are Samsung-specific. Everything else is plain TypeScript compiled to ES5, rendering into the DOM, and depends only on interfaces [R].
2. **An Android TV build exists but has never run on a device** [R]:
   - a WebView shell plus a native Media3/ExoPlayer player (`android/`, `src/player/android-engine.ts`, `src/app/platform/android-platform.ts`);
   - built by `npm run build:all` on every release.
3. **LG webOS is the cheapest new platform.**
   - Packaged web apps (`.ipk`) run the same ES5 bundle.
   - webOS 3.x uses Chromium 38, webOS 24 uses Chromium 108 [DOC].
   - Needed: a webOS platform adapter, an HTML5 `<video>` playback engine, IndexedDB-based large storage, a key map, and packaging.
4. **Philips is three separate cases:**
   - **Android TV / Google TV (2015–2025 models):** the Android APK.
   - **Titan OS (2024+, all 2026 models):** a *hosted* HTML5 app (a URL), reached only through Titan's Partner Portal, QA and business terms [DOC]. It is technically close to webOS, but distribution, hosting and mixed-content rules are open risks.
   - **Saphi:** no third-party developer route was found. Not feasible.
5. **Recommended architecture: keep one web application and add platform adapters.** Do not split into a multi-package monorepo now.
   - Android keeps the hybrid WebView + native Media3 design.
   - A Jetpack Compose rewrite is not recommended. It would duplicate the whole UI and all of its tests.
6. **Recommended order:**
   1. contract hardening (no Samsung behaviour change);
   2. Android device validation;
   3. LG webOS;
   4. shared HTML5 engine hardening;
   5. Titan OS, after the business and hosting questions are answered.

## 2. Existing architecture assessment [R]

| Area | Implementation | Files / size |
|---|---|---|
| Entry | `src/app/main.ts` → `bootstrap.ts`, which builds the context (platform, storage, services) and registers the screens | `src/app` 8 files, 937 lines |
| Platform layer | `Platform` interface: info, capabilities, memory, LocalStore, FileStore, KeyStore, crypto, XHR factory, key registration, lifecycle. `detect.ts` picks Tizen, Android (`window.ElitePlatform`) or browser | `src/app/platform` 9 files, 1,094 lines |
| Navigation | Own router (screens and overlays), key router (throttle, IME guard), focus manager (zones), key map | `src/navigation` 4 files, 603 lines |
| UI | Vanilla TypeScript DOM screens; no framework; virtualised lists with fixed row pools; CSS with design tokens; 1920×1080 logical layout | `src/screens` 30 files, 6,974 lines; `src/components` 5 files, 431 lines |
| API | XHR HTTP client (timeouts, size limits, network policy); Xtream client and types | `src/api` 5 files, 1,525 lines |
| Content | M3U parser, Xtream source, catalogue codec, channel index, VOD pages and index, EPG parser and index, gzip, sorting, category prefs, next episode | `src/content` 17 files, 3,921 lines |
| Services | Playlists, EPG, VOD, user lists (favourites, recent), My List, progress, track preferences, parental | `src/services` 8 files, 2,236 lines |
| Storage | KeyValueStore (localStorage envelope), CatalogueStore (FileStore with a budget), SecretStore (KeyStore) | `src/storage` 3 files, 526 lines |
| Security | PIN (PBKDF2 through WebCrypto, lockout) | `src/security` 1 file |
| Playback | `PlaybackEngine` interface; `avplay-engine.ts` (Samsung); `android-engine.ts` (bridge to Media3); live and VOD controllers; track info and naming; `media-probe.ts` (reads track tables from MKV/MP4 by range requests) | `src/player` 7 files, 2,326 lines |
| State | Per-screen closures plus services; no global store. Persistent state goes through KeyValueStore and CatalogueStore | |
| i18n | EN + NL tables with a missing-key test | 1,002 lines |
| Build | tsc (ES5) → esbuild IIFE → acorn ES5 gate; release check (no dev logging); Tizen packaging `scripts/tv.mjs`; Android `scripts/android.mjs` (Gradle) | `scripts/` |
| Tests | 361 unit tests (Node test runner, fake DOM, fake engine, fake HTTP/Xtream, fake Tizen) and 5 build tests; **all pass** (run during this audit) | `tests/` |
| Dev tooling | Dev log sink, device self-test suites; excluded from release builds | `src/dev` 17 files, 3,845 lines |

**Product source** (without `src/dev`): about **22,800 lines**.

**Samsung-specific code:**

| File | Lines |
|---|---|
| `tizen-platform.ts` | 79 |
| `tizen-file-store.ts` | 241 |
| `tizen-key-store.ts` | 58 |
| `avplay-engine.ts` | 498 |
| `types/tizen.d.ts` | ~60 |
| **Total** | **~940 (about 4 %)** |

**Implicit Tizen assumptions in shared code:**
- **One video decoder:** the Live preview and the player share one engine.
- **Write gate:** synchronous Tizen file writes are held back while the remote is in use (`input-quiet.ts`).
- **Free-memory floor:** read through the platform; the 150 MB guard.
- **Samsung key codes:** in `keys.ts`.
- **AVPlay quirks:** handled inside the engine, for example the 32-track limit and two-letter language codes.

All of these are parameters or capabilities today, except the key map, which is one shared table.

## 3. Repository dependency map [R]

```text
main.ts ─► bootstrap.ts ─► platform/detect ─► tizen | android | browser platform
                │
                ├─► storage (kv-store, catalogue-store, secret-store) ─► Platform.local/files/keys
                ├─► api/http-client ─► Platform.xhrFactory ; api/xtream
                ├─► services (playlist, epg, vod, user-lists, my-list, progress, track-prefs, parental)
                │        └─► content (parsers, indexes, codecs)  [pure]
                ├─► player engine: avplay-engine (tizen) | android-engine (bridge) | fake (tests)
                │        └─► live-controller, vod-controller, track-info, media-probe  [pure]
                └─► navigation (router, key-router, focus, keys) ─► screens + components ─► DOM
```

**Reusable on every web runtime** (webOS, Titan, Android WebView, browser):
- content, services, storage logic, api, navigation, screens, components, i18n, security, controllers.

**Platform-bound:**
- the platform implementations;
- the engines;
- the Tizen key registration;
- the packaging scripts.

## 4. Samsung compatibility assessment

**Must be preserved:**
- Tizen 3.0 / ARMv7 with the ES5 gate [T];
- AVPlay single decoder, with the tuned zap and stall rules [T];
- registration of Samsung remote keys (colour, CH, digits, media) [T];
- `tizen.filesystem` and `tizen.keymanager` [T];
- signed `.wgt` and the `tv:*` workflow;
- the 150 MB floor.

**Direct Samsung API use** is limited to the platform folder and `avplay-engine.ts`, as enforced by `compat-check`.

**Risk:** shared changes for other platforms can change Samsung behaviour indirectly, for example key-map, focus or storage-contract changes.

**Mitigation:**
- every migration stage keeps `npm run check` green;
- every migration stage repeats a short Samsung TV regression (Live zap, VOD play with tracks, My List, categories);
- the existing self-test suites are reused.

## 5. LG webOS compatibility assessment

| Topic | Finding |
|---|---|
| App type | Packaged web app (`appinfo.json`, `.ipk`), built with the webOS TV CLI (`@webos-tools/cli`: `ares-package`, `ares-install`, `ares-launch`) [DOC]. Not installed on this PC. |
| Runtime | webOS 3.x Chromium 38; 4.x 53; 5.x 68; 6.x 79; 22: 87; 23: 94; 24: 108 [DOC]. A TV keeps its shipped engine [3P]. The ES5 bundle covers all of them; webOS 3 is about as old as Tizen 3. |
| Playback | HTML5 `<video>` on the platform media pipeline. HLS is native. Plain MPEG-TS over HTTP is commonly used by webOS IPTV apps [3P]; must be verified on the target model [A]. |
| Audio tracks | `video.audioTracks`, webOS 3.0+ [DOC forum]. Reported pitfalls: languages normalised to base codes, a wrong default track with some files, switching failing on some firmware [3P]. Our track naming (Stage 7E/7F) and the range-request probe help here. |
| Subtitles | `textTracks` for in-band tracks (support varies) [A]. External SRT/WebVTT: we already render cues ourselves on both platforms (Stage 7B.2), so this is reusable. |
| Keys | Back = 461 [DOC]; arrows, OK and colour keys 403–406 [A, typical]. **Channel ±:** a webOS forum answer says they are not available to web apps [DOC forum]; to verify on the TV. CH±-dependent features (zapping, paging) need an alternative, for example ▲▼ in the player, which already works. Some keys report `key: "Unidentified"`, so the app must keep matching on `keyCode`, as it does today. |
| Storage | localStorage is available. **No `tizen.filesystem`:** large catalogues need an **IndexedDB FileStore**. **No equivalent of `tizen.keymanager`:** credential storage needs a decision (D4). |
| Memory | No reliable free-memory API for web apps [A]. The 150 MB guard needs a webOS policy: size caps and a "memory unknown" path (`availableMB = -1` already exists). |
| Lifecycle | `visibilitychange`, `webOSRelaunch`; the media must be suspended when the app is hidden (`suspend` / `restore` already exist) [DOC]. |
| Developer testing | Developer Mode app; the session lasts about 50 h and is extended from the app or with `ares-extend-dev` [DOC/3P]. Needs an LG account and an LG TV. |
| Distribution | LG Content Store via a seller account and app review [DOC]. Store policy for playlist-based IPTV players is not documented publicly; Infomir's Ministra player was listed [3P]. Region and model availability vary. |

**Reuse:** everything above the platform layer.

**New work:**
- `webos-platform.ts`;
- `html5-engine.ts`, shared with Titan and the browser;
- IndexedDB FileStore;
- the key map;
- an `appinfo.json` / `.ipk` builder;
- the memory policy.

## 6. Android TV / Google TV compatibility assessment

**Existing hybrid** [R]:
- `MainActivity.java`, 170 lines: WebView with the web bundle and a key mapping to DOM key codes.
- `PlatformBridge.java`, 245 lines:
  - files in `getFilesDir()/catalogue`;
  - secrets with AES-256-GCM through the Android Keystore (Android 6.0+);
  - free memory from `ActivityManager.MemoryInfo`.
- `PlayerBridge.java`, 420 lines:
  - Media3 1.3.1 ExoPlayer: HLS and progressive sources;
  - track selection through `TrackSelectionOverride`;
  - cues forwarded to the web subtitle renderer;
  - `PlayerView` under the WebView.
- `minSdk 21`, `targetSdk 34`, Java 8; APK signed with the debug key.

| Topic | Assessment |
|---|---|
| Kotlin vs Java | The existing bridges are Java, which is enough for thin bridges. New native code can be Kotlin; mixing is supported. No rewrite needed. |
| Compose for TV vs shared web UI | **Shared web UI recommended.** Compose would re-implement about 7,400 lines of screens and components plus their UI tests, and fork every future UI change. Compose only makes sense if Android becomes the lead platform, or if WebView performance on target boxes proves unacceptable (measure first). |
| Media3 | HLS (TS and fMP4 segments); progressive MP4, MKV and MPEG-TS through extractors. AC-3 / E-AC-3 / DTS depend on the device decoders or passthrough; an FFmpeg audio extension is the software fallback (licence and build work) [DOC/A]. Subtitles: WebVTT, TTML, CEA-608/708 [DOC]; Media3 also contains SubRip, SSA and DVB parsers [A: verify in 1.3.1]. |
| Hardware decoding | MediaCodec by default. Tunnelled playback is optional on Android TV (better AV sync on some TVs) [A]. |
| Keys | D-pad, Enter, Back and media keys mapped in `MainActivity`. Colour keys and CH± depend on the remote; Philips remotes have colour keys [A]. |
| Lifecycle | `onPause` / `onStop` must release the player (the bridge calls `suspend` / `restore`) [R]; verify on a device. |
| Distribution | Sideloading works now. Google Play needs a release key, TV quality guidelines (leanback launcher, banner) and review; IPTV players without content have mixed review outcomes [A]. |
| Status | **Never run on a device.** Stage 8 audit risk T7. |

## 7. Philips platform assessment

| Platform | Models | Third-party apps | Route |
|---|---|---|---|
| Android TV | Philips 2015–~2021 | Yes (Play Store, sideloading) | The Android APK |
| Google TV | Philips ~2022–2025 (OLED+9xx kept Google TV through 2025) [3P] | Yes (Play Store; sideloading possible but restricted by Google TV settings) | The Android APK |
| Titan OS | From 2024 on LCD/Mini-LED (for example PUS83xx, MLED9xx); Philips moved its 2026 EU/UK lineup to Titan OS [3P] | Yes, **as hosted HTML5 apps** through the Titan Partner Portal; DevView for testing on a paired TV; QA about 2–4 weeks; publishing after "terms with Titan's business development team" [DOC/3P] | A web build hosted at a URL |
| Saphi | Older low-cost Philips LCDs | No public SDK or store route found | Not feasible |

**Titan OS details:**
- **Engines:** Chromium 84 on older chipsets (NVT671, MTK9288); Chromium 122 on NT690E [DOC].
- **Media:** MSE supported; HLS v3 (live and VOD); DASH; MP4 with H.264/H.265 and AAC/MP3 [DOC]. MPEG-TS over plain HTTP progressive is **not** listed [A: likely needs MSE remuxing, for example mpegts.js].
- **Remote control:** documented at `docs.titanos.tv/remote-control` [DOC]; not read in detail.
- **No emulator:** testing needs a real Titan TV and DevView access [DOC/3P].

**Titan OS obstacles:**
1. **Hosted URL.** The app must be served from a web host. Static hosting is enough; credentials stay on the TV. Even so, this conflicts with product decision P3 ("no backend of any kind") as worded (D6).
2. **Mixed content.** An HTTPS-hosted page calling `http://` Xtream APIs and streams is normally blocked by Chromium. Many providers are HTTP-only. This is not documented for Titan [A]; one user reports that browser access works but app access does not [3P]. **This may make Titan unworkable for HTTP providers** unless the app can be hosted over HTTP or Titan relaxes the rule.
3. **Business acceptance** of a playlist-based IPTV player is unknown.
4. **No reliable memory API** and unknown storage quota [A].

**Verdict:**
- **Technically feasible for HTTPS providers.**
- **Distribution feasibility unknown** until Titan answers (partner account, IPTV policy, HTTP allowance).
- Treat Titan as **gated**: do not invest beyond a DevView proof of concept until those answers exist.

## 8. Playback architecture comparison

| | Samsung AVPlay [T] | LG `<video>` [DOC/A] | Android Media3 [DOC/R] | Titan `<video>`/MSE [DOC/A] |
|---|---|---|---|---|
| Decoders | One player per app | Platform pipeline; usually one | MediaCodec; several instances possible | Platform; usually one |
| Live TS over HTTP | Yes [T] | Likely [3P] | Yes (TsExtractor) | Probably needs MSE remux |
| HLS | Yes | Native | Yes | Native v3 + MSE |
| DASH | Yes | Yes | Module not included yet | Yes |
| H.264 / H.265 | Yes / yes (2017 panel) | Per model | Per device | Per model |
| AC-3 / E-AC-3 | Yes [T] | Per model | Device decoder, passthrough or FFmpeg | Per model |
| Audio track list | Yes; first 32 only [T] | `audioTracks` (quirks) | Full `Tracks` API | `audioTracks` / MSE |
| Embedded subtitles | Partly; app renders [T] | `textTracks` partly | Yes (cues to the web renderer) | Partly |
| External SRT/VTT | App renderer [T] | App renderer | App renderer or Media3 | App renderer |
| Buffer control | `setBufferingParam` [T] | Limited | `LoadControl` | MSE / limited |

**Proposed `IPTVPlayer` vs the existing `PlaybackEngine` (`src/player/engine.ts`):**
- The existing interface is **already richer and proven on the TV**:
  - `PlaybackSource` (type, live flag, headers) instead of a bare URL;
  - `LoadOptions` (buffer, start position);
  - an event stream (buffering %, playing, error codes, ended, subtitle cues, tracks changed, seek-failed);
  - `setRect` for video-plane layering;
  - `suspend` / `restore`;
  - `MediaTrack` with language, exactness, codec, channels, sample rate, bitrate, name, forced and SDH flags;
  - `selectTrack` (`'text'`, −1 = off).
- Getters are synchronous because engines cache state. Making them promise-based adds latency on the remote path for no gain.

**Recommended changes (additive):**
1. **`capabilities()`:** containers and codecs, `multiDecoder`, `trackSwitching`, `embeddedSubtitles`, `bufferControl`. The live preview and zapping rules then adapt per platform instead of assuming AVPlay.
2. **`stats()` (optional):** resolution, bitrate, dropped frames, for diagnostics.
3. **Error detail:** keep the four codes and add an optional `detail` field.
4. **External subtitles:** stay in the app renderer (shared). No engine API needed.

Codec support will **differ per TV**. The UI must show what the stream and device offer and never promise more.

## 9. Shared-core feasibility

- **High.** The core (content, services, storage logic, api, controllers, i18n, security) is pure TypeScript with no DOM or platform access, apart from the documented interfaces. It is covered by 361 tests running in Node.
- **For Android**, the core runs inside the WebView unchanged. This is the main reason not to port the core to Kotlin.
- **Data centralisation is in place:**
  - PlaylistService (Xtream and M3U through one `ImportSource` abstraction);
  - CatalogueStore;
  - Channel / VOD / EPG indexes;
  - UserLists, My List, progress, track prefs, category prefs — all per account, local.
- **A future REST provider** fits as another source next to `xtream-source.ts` and `m3u-source.ts`.
- **Sync of preferences:** local only. An optional backend would contradict decision P3 and needs a security design. It is not needed for multi-platform support (D7).

## 10. Shared UI feasibility

- **High for the web platforms** (Tizen, webOS, Titan, Android WebView): same DOM, CSS and focus model.
- **Requirements:**
  - Layout is a 1920×1080 logical canvas. webOS and Titan apps run at 1920×1080 or scale; Android WebView needs viewport scaling (verify on 720p boxes).
  - The key map must become per platform. Product actions stay the same; physical keys differ (CH± on webOS, no digits on some Android remotes).
  - Magic Remote pointer (LG): optional pointer/hover support. The focus model stays primary.
  - Netflix-style consistency: the current design system (tokens, rail, posters, sheets) already serves all screens. Visual polish is independent of platform.

## 11. Platform-specific implementation requirements

| Platform | Platform adapter | Engine | Storage | Keys | Packaging |
|---|---|---|---|---|---|
| Samsung | Existing | AVPlay (existing) | tizen.filesystem / keymanager (existing) | Existing | `.wgt` (existing) |
| LG webOS | **New** `webos-platform.ts` | **New** `html5-engine.ts` | **New** IndexedDB FileStore; KeyStore decision | **New** map (461 Back; CH± check) | **New** `appinfo.json` + `.ipk` script |
| Android | Existing (verify) | Existing Media3 bridge (verify; maybe Media3 upgrade, DASH, FFmpeg audio) | Existing (files + Keystore) | Existing mapping (verify colour keys) | Existing Gradle; **new** release signing, TV banner |
| Titan OS | **New** `titan-platform.ts` (close to webOS) | `html5-engine.ts` + MSE TS remux (if needed) | IndexedDB; KeyStore decision | **New** map per Titan docs | **New** hosted static build + Partner Portal |

## 12. Performance risks

- **Old engines** (webOS 3 Chromium 38, Titan Chromium 84) have Tizen-3-class CPUs and RAM. The existing designs carry over:
  - virtual lists;
  - index-only VOD pages;
  - per-category index arrays;
  - lazy EPG;
  - zap debounce.
- **IndexedDB throughput and quota** on old webOS and Titan are unknown. Catalogue files are written in pages already, which suits IndexedDB records.
- **No free-memory reading** on webOS and Titan. The 150 MB floor cannot be measured there; a substitute is needed: size caps by catalogue size and device class.
- **Android WebView over a native PlayerView:**
  - transparency and compositing cost on low-end boxes;
  - large DOM is fine with the fixed row pools;
  - must be measured on a device.
- **Images:** posters load through the browser cache. There is no explicit image cache on any platform. Low-RAM devices may need a poster size or quality setting.

## 13. Security considerations

- **Credentials:**
  - Tizen keymanager [T];
  - Android Keystore AES-GCM [R];
  - **webOS and Titan have no secure keystore.** Options: localStorage (plaintext), or encrypted with a key that is also on the device (obfuscation only). Decision D4.
- **Mixed content and network policy** (decision P4: http/https to any host):
  - packaged apps (Tizen, webOS, Android) are not affected;
  - hosted Titan is (§7).
- **Hosted Titan build:** the hosting origin must serve only static files. No logs of user URLs; a strict CSP.
- **PIN:** WebCrypto PBKDF2 is available on Chromium 38+ only in secure contexts [A: verify on webOS file:// apps].
- **Android:** the `@JavascriptInterface` bridges must stay minimal; no arbitrary file or URL access from JavaScript; a release key outside the repo.

## 14. Migration risks

| # | Risk | Mitigation |
|---|---|---|
| M1 | Samsung regressions from shared changes | Additive interfaces; `npm run check`; a Samsung TV regression in every stage |
| M2 | webOS CH± unavailable; CH-based features | ▲▼ alternatives already exist; per-platform hints |
| M3 | Titan distribution or HTTP blocked | Gate Titan behind Partner answers and a DevView PoC |
| M4 | Codec and track behaviour differs per TV | Capability flags; per-device test matrix; never promise identical support |
| M5 | No test hardware (LG, Philips, Android TV) | Hardware list in §19; nothing ships without a device test, as on Samsung |
| M6 | Store review rejects IPTV players | Sideloading / developer routes first; neutral listing (no content) |
| M7 | Monorepo reorganisation breaks the history and the build | Do not reorganise now (§16) |

## 15. Recommended target architecture

```text
One TypeScript application (ES5 bundle)
├── core            content, services, storage logic, api, controllers, i18n, security   [shared, pure]
├── ui              navigation, screens, components, styles                              [shared, DOM]
├── platform        Platform interface + tizen | webos | titan | android | browser
├── engines         PlaybackEngine + avplay | html5 (webOS/Titan/browser) | android-bridge
└── builds          tizen .wgt | webos .ipk | titan hosted static | android APK (WebView + Media3)
```

- Selected at runtime by `detect.ts` and at build time by a platform flag, so release bundles contain only one platform's code.
- This is the proposed architecture in §3 of the request, with one change: the shared core and shared UI stay **one codebase**. Android's adapter is the existing native bridge, not a separate native UI.

## 16. Proposed repository structure

The `apps/ packages/ adapters/` monorepo is **not recommended now**:
- the code has a single consumer (one bundle);
- splitting packages adds build and tooling work (workspaces, per-package tsconfig, ES5 gates per package);
- it would rewrite every import and every file reference in the existing reports;
- it brings no runtime benefit.

**Recommended (incremental, folder-level):**

```text
screenshelf/
├── src/                     (unchanged layout)
│   ├── app/platform/        + webos-platform.ts, titan-platform.ts, idb-file-store.ts
│   ├── player/              + html5-engine.ts (+ ts-remux adapter if Titan needs it)
│   └── navigation/          keys.ts → per-platform key maps
├── platforms/               packaging only
│   ├── tizen/   (config.xml, icons)      ← moved from current build inputs later, if wanted
│   ├── webos/   (appinfo.json, icons)
│   └── titan/   (hosting manifest, CSP)
├── android/                 (existing Gradle project)
├── scripts/                 build.mjs gets --platform; tv.mjs, webos.mjs, android.mjs
├── tests/  docs/
```

Revisit a package split only if a second, different consumer appears, for example a native Compose UI or a backend.

## 17. Implementation roadmap (summary)

See `docs/STAGE-14-CROSS-PLATFORM-ROADMAP.md`.

| Step | Content |
|---|---|
| R0 | Decisions and hardware |
| R1 | Contract hardening, no Samsung change |
| R2 | Android device validation |
| R3 | LG webOS |
| R4 | HTML5 engine and track hardening |
| R5 | Titan OS PoC (gated) |
| R6 | Release engineering and stores |

## 18. Estimated complexity per platform

Relative estimates for one developer with this codebase. Device availability dominates.

| Platform | Complexity | Rough effort | Main driver |
|---|---|---|---|
| Samsung (keep) | Low | Regression per stage | Protection only |
| Android TV / Google TV / Philips Android | Medium | 2–4 weeks | Device validation, WebView/PlayerView layering, codecs, release signing |
| LG webOS | Medium | 3–5 weeks | HTML5 engine, IndexedDB store, keys, packaging, track quirks |
| Titan OS | Medium-High, plus external dependency | 2–4 weeks technical after webOS; plus partner and QA lead time (weeks, unknown) | Hosting, mixed content, partner terms |
| Native Compose Android UI | Very high (not recommended) | 3–6 months | Full UI rewrite |
| Saphi | Not feasible | — | No developer route |

## 19. External SDK and hardware requirements

| Need | Status on this PC |
|---|---|
| Tizen SDK and certificates | Installed (`C:\Development\Tizen`) [R] |
| JDK 17/21, Android SDK, Gradle 8.7/8.9, platform-tools | Installed (`C:\Users\imran\Tools`) [R] |
| webOS TV CLI (`@webos-tools/cli`) | **Not installed.** Needs npm global install (approval) |
| LG developer account; LG TV with Developer Mode | Needed |
| Android TV / Google TV device; ideally a Philips Google TV | Needed |
| Titan Partner Portal account, DevView access, Philips Titan TV | Needed (gated) |
| Static HTTPS hosting (Titan only) | Needed if Titan goes ahead |
| Google Play / LG Seller accounts | Only for store release |

Suggested test matrix:
- the existing Samsung 2017 TV;
- one older webOS TV (webOS 4–6) and one recent (22+);
- one Android TV box with AC-3 passthrough;
- one Philips Google TV;
- one Philips Titan TV.

## 20. Outstanding technical decisions (for your approval)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Stage numbering for the migration (Stage 14 is taken by category management) | Number them 15+ in order, or use an "X" series (X1–X6) |
| D2 | Architecture: one web app with adapters (this audit) vs a monorepo split vs native Compose for Android | One web app with adapters |
| D3 | Platform order | Android validation → webOS → Titan (gated) |
| D4 | Credential storage on webOS / Titan (no secure keystore) | Encrypted localStorage plus an on-screen notice, or a "don't remember password" option; decide before R3 |
| D5 | Memory guard on platforms without a memory API | Size caps per device class; keep 150 MB on Samsung and Android |
| D6 | Titan hosting (conflicts with "no backend" P3 as worded): static hosting allowed? | Allow static, credential-free hosting only, if Titan proceeds |
| D7 | Preference sync | Local only (no cloud), as today |
| D8 | Product and app naming across stores (ScreenShelf in the app, EliteStream on Android, streamora repository) | One name before any store submission |
| D9 | Hardware purchases / access (§19) | Android box + one webOS TV first |
| D10 | Install the webOS CLI on this PC | When R3 starts |
| D11 | FFmpeg audio extension for Android (AC-3/DTS software fallback; licensing) | Only if device tests show missing decoders |
| D12 | Store distribution vs sideloading per platform | Sideloading / developer mode first |

## Sources

- LG webOS TV: [Web API and Web Engine](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine) · [CLI Developer Guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide) · [Developer Mode app](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) · [Back button](https://webostv.developer.lge.com/develop/guides/back-button) · [Magic Remote](https://webostv.developer.lge.com/develop/guides/magic-remote) · [Forum: multi audio](https://forum.webostv.developer.lge.com/t/video-multi-audio/24156) · [Forum: Channel Up/Down](https://forum.webostv.developer.lge.com/t/cannot-press-channel-up-down-to-trigger-an-event/18008) · [Forum: "Unidentified" keys](https://forum.webostv.developer.lge.com/t/some-of-the-keys-in-magic-remote-are-giving-key-parameter-as-unidentified/3961) · [webosbrew: web engine](https://www.webosbrew.org/develop/guides/web-app/web-engine) · [Plex: wrong audio track](https://forums.plex.tv/t/lg-webos-wrong-audio-track/939218) · [Emby: webOS audio tracks](https://emby.media/community/topic/133687-emby-for-webos-multiple-audio-tracks-problem) · [Infomir Ministra on LG](https://infomir.eu/eng/press-center/news/226-ministra-player-lg/)
- Titan OS: [Introduction](https://docs.titanos.tv/introduction) · [Publishing](https://docs.titanos.tv/publishing) · [Testing / DevView](https://docs.titanos.tv/devviewinstall) · [Device specifications](https://docs.titanos.tv/platform-versions) · [Media specifications](https://docs.titanos.tv/media-specifications) · [Remote control](https://docs.titanos.tv/remote-control) · [SofAds: Titan OS](https://sofads.com/monetization/titan-os/) · [Oxagile: Titan OS](https://www.oxagile.com/video/smart-tv/titan-os/) · [Emby: Titan app thread](https://emby.media/community/topic/133939-philips-smart-tv-titanos-emby-app/page/4/) · [MDN: Mixed content](https://developer.mozilla.org/Security/MixedContent)
- Philips line-ups: [What Hi-Fi: Philips ditching Google TV](https://www.whathifi.com/news/philips-is-ditching-goolge-tv-but-not-on-its-oleds) · [What Hi-Fi: What is Titan OS](https://www.whathifi.com/advice/what-is-titan-os-philips-new-tv-operating-system-explained) · [Expert Reviews: 2025 models](https://www.expertreviews.co.uk/technology/tvs-home-cinema/philips-new-oled-oled-mini-led-and-qd-led-tv-models-launched) · [Android Authority: 2026 switch](https://www.androidauthority.com/philips-google-tv-titan-os-3651035) · [heise: 2026 Titan OS](https://heise.de/-11223309) · [Notebookcheck: 2024 Ambilight with Titan OS](https://www.notebookcheck.net/Philips-2024-4K-Ambilight-TVs-appear-with-new-Titan-OS.804097.0.html) · [hifi.de: Titan OS and Saphi](https://hifi.de/ratgeber/titan-os-was-das-smart-tv-system-kann-und-was-du-darueber-wissen-musst-267854)
- Android: [Media3 ExoPlayer supported formats](https://developer.android.com/media/media3/exoplayer/supported-formats)
