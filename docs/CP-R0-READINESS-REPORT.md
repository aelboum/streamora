# Cross-platform R0: implementation-readiness report

Date: 2026-11-26. **R0 only.** No application source, build, configuration or TV change was made.

The cross-platform work uses its own numbering, CP1, CP2 and so on, separate from the ScreenShelf stage numbers (your decision 1).

Background:
- `docs/STAGE-14-CROSS-PLATFORM-AUDIT.md`;
- `docs/STAGE-14-CROSS-PLATFORM-ROADMAP.md`. Its steps R1–R6 map to CP1–CP6.

Evidence tags:
- **[R]** read in the repository;
- **[T]** verified on the Samsung TV;
- **[PC]** checked on this PC today;
- **[DOC]** official platform documentation;
- **[3P]** third-party source;
- **[A]** assumption.

## 1. Your R0 decisions (recorded)

| # | Decision |
|---|---|
| 1 | Separate numbering CP1, CP2 …; ScreenShelf stage numbers untouched |
| 2 | One shared web application with platform adapters and playback engines; no unnecessary native rewrite; Samsung implementation preserved |
| 3 | Order: Android TV, then LG webOS, then Philips Titan OS |
| 4 | Secure native storage where available; never plaintext; without secure storage the user signs in again; no cloud authentication |
| 5 | Without a free-memory API: adaptive strategy (cache limits, LRU eviction, bounded loading, cleanup). An estimate is never presented as a measurement |
| 6 | Titan: static HTTPS hosting allowed, nothing server-side. The HTTPS-to-HTTP question must be resolved before any Titan development |
| 7 | All user data local; no cloud sync |
| 8 | Product name **ScreenShelf** everywhere; EliteStream (Android) and streamora (repository) renamed progressively, without breaking builds or history |
| 9 | Physical test devices: Android TV box, LG webOS TV, Samsung UE50MU6100. No compatibility claims from emulators or build success |
| 10 | LG webOS CLI may be installed on this PC; no TV changes or app installs without authorisation |
| 11 | Native Media3 and hardware decoding first; FFmpeg only after a proven codec problem, with size, performance, licence and maintenance assessed |
| 12 | Sideloading and physical testing first; stores later |

## 2. Required hardware

| Device | Purpose | Status |
|---|---|---|
| Samsung UE50MU6100, Tizen 3.0 | Regression in every CP milestone | **Available** [T]; reachable at 192.168.1.19 by `sdb` today |
| Android TV box (physical) | CP2 | **Not yet known.** Please tell me the model and Android version |
| LG webOS TV (physical) | CP3 | **Not yet known.** Please tell me the model or year, and the webOS version (Settings → General → TV information) |
| Philips Titan OS TV | CP5 (gated) | Not needed until the Titan questions (§6) are answered. Titan has no emulator [DOC] |

**Recommended Android box properties:**
- Android TV / Google TV OS, Android 9 or later;
- HDMI with AC-3 / E-AC-3 passthrough, plus a remote with colour keys if possible;
- because decoders are device-specific, testing on two devices is better than one.

## 3. SDKs and tools

| Tool | Status [PC] | Note |
|---|---|---|
| Node 24.18.0, npm 11.16.0 | Installed | |
| Tizen SDK, `sdb`, certificate profile | Installed | Samsung workflow unchanged |
| JDK 17 / 21, Gradle 8.7 / 8.9 | Installed (`C:\Users\imran\Tools`) | |
| Android SDK: platform 34, build-tools 34.0.0, cmdline-tools, platform-tools (adb 1.0.41) | Installed | Enough for the current Gradle project (compileSdk 34) |
| **LG webOS TV CLI** `@webos-tools/cli` **3.2.6** | **Installed today** (your decision 10), global npm | `ares --version` OK. `ares-package` tested on a throw-away app in the session scratchpad: produced an `.ipk`. Nothing touched the repository or a TV |
| — npm install note | | npm skipped the install scripts of two dependencies: `ssh2` (falls back to pure JavaScript) and `cpu-features` (optional). Connecting to a TV will show whether anything is missing; nothing else is needed now |
| LG developer account | **Missing** | Needed for the Developer Mode app on the TV (your action) |
| Titan Partner Portal account, DevView | **Missing** | Only when CP5 is unblocked |
| Android release signing key | Not needed yet | Debug key is enough for sideloading (decision 12) |

## 4. Android application readiness

**What exists** [R]:
- **Project:** `android/` (Gradle) with `applicationId com.elitestream.app`, `minSdk 21`, `targetSdk 34` and Java 8.
- **Native code:**
  - `MainActivity` (WebView, key mapping);
  - `PlatformBridge`:
    - files in private storage;
    - secrets encrypted with AES-256-GCM, key in the Android Keystore;
    - free memory from `ActivityManager.MemoryInfo`;
  - `PlayerBridge`: Media3 1.3.1 ExoPlayer (HLS and progressive); track selection; subtitle cues forwarded to the shared renderer.
- **Web side:** `src/app/platform/android-platform.ts` and `src/player/android-engine.ts`.
- **Build:** `npm run build:all` builds the APK each release. Current file: `dist/android/EliteStream-0.2.0-debug.apk`, 5.2 MB, from the latest release build.

**Readiness:**

| Item | State |
|---|---|
| Builds | Yes [PC] |
| Runs on a device | **Never tested.** Nothing is claimed (decision 9) |
| Secure storage (decision 4) | Android 6.0+: Keystore AES-GCM. **Android 5.x (API 21–22):** saving a secret *fails*, so credentials are never stored in clear. But the user is then not offered a sign-in-again session; Xtream accounts simply cannot be saved. **Gap for CP1:** a session-only credential mode in which the password is asked again after restart. The app already knows a session-only key store (`persistent: false`, bootstrap warning); the playlist screens need a re-entry prompt. |
| Memory guard | Real free-memory value available (no estimate needed); 150 MB floor applies |
| Audio | Device MediaCodec decoders; no FFmpeg (decision 11). AC-3 / E-AC-3 to be measured in CP2 |
| Naming (decision 8) | App title in the web bundle is already "ScreenShelf"; APK file name and `applicationId` say EliteStream. Changing `applicationId` makes a new app on the device (no upgrade path). Harmless before any user installs; best done at the start of CP2 or with the first sideload |
| Media3 version | 1.3.1 (2024). An upgrade is a dependency change and needs your approval; only if CP2 shows a need |

**CP2 can start** as soon as a device is available and you authorise installing the APK on it.

## 5. LG webOS readiness

| Item | State |
|---|---|
| Tools | CLI 3.2.6 installed; packaging works [PC] |
| Runtime | webOS 3–24: Chromium 38–108 [DOC]. The ES5 bundle is the right target |
| Needed code (CP3) | `webos-platform.ts`, HTML5 `<video>` engine, IndexedDB FileStore, webOS key map, `appinfo.json` + `.ipk` script |
| Secure storage | **None for web apps** [A/DOC: no keystore API found]. Per decision 4: **session-only credentials**. Passwords are kept in memory only and asked again after each restart. Playlist definitions without passwords, favourites and settings persist locally. M3U URLs that contain credentials count as secrets too (the existing credential-template handling separates them) [R] |
| Memory | No free-memory API [A]. Decision 5 applies: bounded catalogue loading, LRU for pages and posters, cache caps, cleanup on screen exit. Shown and logged as "limit", never as "free memory" |
| Keys | Back 461 [DOC]; CH± possibly not delivered to web apps [DOC forum]. To verify on the TV |
| On the TV (your action, needs your authorisation) | Install the "Developer Mode" app from the LG Content Store, sign in with the LG developer account, enable Developer Mode (the TV restarts), note the IP and passphrase. The session lasts about 50 h and can be extended [DOC/3P] |
| Distribution | Sideloading through Developer Mode (decision 12) |

## 6. Titan OS: outstanding questions

Read today in the Titan developer docs ([DOC], `docs.titanos.tv`: introduction, publishing, submit-app, platform-versions, media-specifications, media, remote-control, cookies, security-and-tools, devviewinstall, faq, titan-sdk, performance pages).

**Documented:**
- **App model:** a hosted HTML5 app, given by URL; test and production URLs go through the Partner Portal. No HTTP-or-HTTPS rule is stated for the app URL.
- **Media transport:** "HTTP or HTTPS using HTTP protocol v1.1 and Range requests"; TLS 1.2.
- **Formats:**
  - progressive **MPEG2-TS** (H.264; AAC, AC-3, E-AC-3) and MP4 (H.264/H.265);
  - HLS v3 (TS segments; fMP4 not listed);
  - DASH; MSE.
- **Subtitles:** out-of-band (WebVTT, EBU-TT-D) everywhere; in-band only with DASH and MSS.
- **Engines:** Chrome 84 (Philips 2020–2022), Chrome 112 (2023–2024), Chromium 122 (2025–2026). RAM 1–2 GB.
- **Keys:**
  - Back 8 (Philips) or 461 (JVC);
  - colour 403–406;
  - CH± 33/34 (PageUp/PageDown);
  - digits 48–57;
  - media keys;
  - Titan SDK `getKeyCodes()`.
- **Storage:** localStorage (about 5–10 MB) and cookies.
- **Exit:** Back on the main screen must ask for confirmation, then exit.
- **No emulator.** DevView on a paired physical TV; access is requested in the Partner Portal. QA intake takes 2–4 weeks; release needs business terms.

**Not documented, so these must be asked or tested:**

| # | Question | Why it blocks |
|---|---|---|
| T1 | May an HTTPS-hosted app call **plain HTTP** Xtream APIs (XHR) and play **HTTP** streams? Is there a mixed-content exception on Titan devices? | Many Xtream providers are HTTP-only. Chromium blocks HTTPS-page → HTTP XHR by default. If blocked, ScreenShelf on Titan could serve HTTPS providers only |
| T2 | May the app URL be HTTP (not HTTPS)? | The only way around T1 without a relay. Your decision 6 allows HTTPS hosting only, so an HTTP-hosted option would need a new decision from you |
| T3 | CORS: do provider API responses need CORS headers for a hosted app? Xtream servers usually send none | Same effect as T1: API calls fail even over HTTPS |
| T4 | Does Titan accept playlist-based IPTV players (no own content, user-supplied Xtream/M3U)? | Distribution |
| T5 | IndexedDB availability and quota | Large catalogues (the 5–10 MB localStorage is far too small for 22,000 channels) |
| T6 | Any secure storage for credentials? (The docs suggest server sessions, which decision 6 excludes) | Without it: sign in again at each start (decision 4) |
| T7 | Lifecycle events (suspend, resume, visibility) | Decoder release when hidden |
| T8 | Multiple audio-track switching on progressive TS / MP4 (the SDK exposes a `multiaudioSupport` capability flag only) | Track features |

**Recommended next step for Titan** (no development):
- Send T1–T4 to `apponboarding@titanos.tv`, the address given in the docs. I can draft the message; sending it is your action.
- Separately, T1/T3 can be answered by a 10-line test page in DevView, once you have a Partner account and a Titan TV.

**Titan stays blocked** until T1–T3 are answered (decision 6).

## 7. Security and storage decisions (to implement in CP1+)

| Platform | Credentials | Large data | Small data | Memory guard |
|---|---|---|---|---|
| Samsung | `tizen.keymanager` [T] (unchanged) | `tizen.filesystem` [T] | localStorage | Real value, 150 MB floor [T] |
| Android 6.0+ | Keystore AES-256-GCM [R] | Private files [R] | localStorage (WebView) | Real value (`ActivityManager`), 150 MB floor |
| Android 5.x | **Session-only** (sign in again) | Private files | localStorage | Real value |
| LG webOS | **Session-only** | IndexedDB (to build) | localStorage | Adaptive limits (decision 5), labelled as limits |
| Titan OS | **Session-only** unless T6 says otherwise | IndexedDB if T5 allows, otherwise reduced catalogue mode | localStorage | Adaptive limits |

**Fixed rules:**
- no plaintext passwords anywhere;
- no obfuscated "encryption" with a key stored next to the data;
- no cloud, sync or server sessions;
- PIN records stay hashed (PBKDF2) as today.

## 8. Remaining blockers

| # | Blocker | Owner | Blocks |
|---|---|---|---|
| B1 | Android TV box: model, availability, authorisation to sideload the APK | You | CP2 |
| B2 | LG TV: model and webOS version; LG developer account; Developer Mode on the TV (your authorisation) | You | CP3 device tests (CP3 code can start earlier) |
| B3 | Titan T1–T3 (HTTP/mixed content/CORS) | Titan, then you | CP5 entirely |
| B4 | Titan Partner account, DevView access, Titan TV | You / Titan | CP5 |
| B5 | Approval of CP1 (contract hardening, including the session-only credential mode) | You | Everything after |

**Not blocking:** the tools on this PC are complete for CP1–CP3.

## 9. Proposed CP plan (from the roadmap, renumbered)

| CP | Content | Can start after |
|---|---|---|
| CP1 | Contract hardening: engine capabilities, per-platform key map, memory policy (real vs adaptive), IndexedDB FileStore, `--platform` build flag, **session-only credential mode with re-entry prompt**; Samsung behaviour identical | Your approval of this report |
| CP2 | Android device validation and fixes; ScreenShelf naming of the APK | CP1 + B1 |
| CP3 | LG webOS adapter, HTML5 engine, packaging | CP1 (+ B2 for device tests) |
| CP4 | HTML5 engine and track hardening | CP3 |
| CP5 | Titan OS proof of concept | B3, B4, CP4 |
| CP6 | Release engineering; stores later | Accepted platforms |

Every CP milestone ends with a physical Samsung regression on the UE50MU6100.

## 10. State of the repository

- **Source code:** no source, build, test or configuration file was changed.
- **New files:**
  - this report;
  - the two cross-platform documents from the audit (still uncommitted).
- **Outside the repository:**
  - global npm package `@webos-tools/cli` 3.2.6;
  - a throw-away packaging test in the session scratchpad.
- **TV:** nothing installed on or changed on any TV.
- **Git:** nothing committed or pushed; `main` at `c0adf0b`.
