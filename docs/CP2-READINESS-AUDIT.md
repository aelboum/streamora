# CP2 — Android readiness audit

Date: 2026-11-26. **Read-only audit.** No source code was changed, no APK was built or installed, and no device setting or user data was touched. This document records the readiness audit and the identification of the first test device.

**Verdict: READY WITH BLOCKERS.**
- The Android code builds (0.3.0 debug APK) and uses the same web app as the Samsung release.
- It has **never run on a physical device**.
- A primary test device is still missing.
- The application identity and signing must be decided before any installation that keeps real data (`CP2-ANDROID-IDENTITY-PROPOSAL.md`).

---

## 1. Architecture

**The Android app is a thin native shell around the shared web app.** It is not a separate implementation.

| Part | File | Role |
|---|---|---|
| Build script | `scripts/android.mjs` | Builds the web app (`build.mjs release`, the same bundle as the Samsung release), copies `index.html`, `app.js`, `app.css` and `fonts/` to `android/app/src/main/assets/www` (generated, git-ignored), runs Gradle `assembleDebug`, and writes `dist/android/EliteStream-<version>-debug.apk` |
| Activity | `android/.../MainActivity.java` | Media3 `PlayerView` behind a **transparent WebView** (the same layering as AVPlay on Tizen). Loads `file:///android_asset/www/index.html`. Maps remote keys to the TV key codes of the web app |
| Platform bridge | `PlatformBridge.java` (JS name `ElitePlatform`) | Private files (`filesDir/catalogue`, written to a temp file then renamed), Keystore-encrypted secrets, memory figures, exit, device type |
| Player bridge | `PlayerBridge.java` (JS name `ElitePlayer`) | One ExoPlayer on the main thread; events to JS as `window.__elitePlayerEvent(json)` with the load's session ID |
| Web adapter | `src/app/platform/android-platform.ts` | Platform interface over the bridge; touch-to-key mapping; page scaling for screens wider than 16:9 |
| Web engine | `src/player/android-engine.ts` | `PlaybackEngine` over `ElitePlayer` (the same contract as `avplay-engine.ts`) |
| Selection | `src/app/main.ts`, `detect.ts` | The Android bridge is detected first; `createAndroidEngine` is used when the platform is `android` |

**The bundle.** Android uses the `all` bundle (`__SS_PLATFORM__='all'`), so the Samsung AVPlay and Tizen adapters are included but unused (CP1 open item). The APK built today contains the 0.3.0 web bundle: its `app.js` is identical to the 0.3.0 release.

## 2. Remote control, back button and lifecycle

**Key mapping** (`MainActivity.mapKeys`, delivered through `window.__eliteKey(code, down)`; the WebView never handles these keys itself):

| Android key | App key code |
|---|---|
| D-pad, `DPAD_CENTER`, `ENTER`, `NUMPAD_ENTER`, gamepad A | Arrows, OK (13) |
| `BACK`, `ESCAPE`, gamepad B | Back (10009) |
| `CHANNEL_UP` / `CHANNEL_DOWN`, `PAGE_UP` / `PAGE_DOWN` | CH+ (427) / CH− (428) |
| `PROG_RED` / `GREEN` / `YELLOW` / `BLUE` | 403 / 404 / 405 / 406 |
| `MEDIA_PLAY_PAUSE` / `PLAY` / `PAUSE` / `STOP` / `REWIND` / `FAST_FORWARD` | 10252 / 415 / 19 / 413 / 412 / 417 |
| `INFO`, `MENU` | 457 |
| `GUIDE` | 458 |
| 0–9 | 48–57 |

**Not mapped:** `LAST_CHANNEL` (previous channel), `MEDIA_NEXT` / `MEDIA_PREVIOUS`, `CAPTIONS`, `MEDIA_AUDIO_TRACK`, `SEARCH`.

**Back.** Mapped keys are always consumed, so the app decides what Back does. At Home it shows its own exit dialog; Yes calls `ElitePlatform.exit()`, which runs `finishAndRemoveTask`. If the page fails to load, Back does nothing; Home still works.

**Lifecycle.**
- `onPause` and `onResume` call `window.__eliteVisible(false/true)`. The engine then **suspends**: the player stops and remembers the position for VOD.
- On return it **reopens** the same source.
- `onDestroy` releases the player and destroys the WebView.

**Screen.** `FLAG_KEEP_SCREEN_ON` is always set, including on idle menus (finding M2). The system UI is hidden (immersive).

## 3. Credential storage — correct in the code (R0 decision 4)

| Android | Behaviour |
|---|---|
| 6.0+ (API ≥ 23) | AES-256-GCM key in the **Android Keystore** (alias `elitestream_secrets_v1`); only `IV + ciphertext` in base64 is stored in `SharedPreferences "secrets"`. `bridgeKeyStore` reports `persistent: true` |
| 5.x (API 21–22) | `keySave` returns false; the web adapter uses `createMemoryKeyStore()` (CP1), so logins are **session-only** and the app asks for them again after a restart |
| Plaintext fallback | **None** |

- `android:allowBackup="false"`, so app data is not included in ADB or cloud backups.
- The key is not bound to the screen lock (no `setUserAuthenticationRequired`).
- `keyLoad` returns null on any decrypt failure. That makes a lost or invalidated key look like a missing login (M6).

## 4. Playback

- **ExoPlayer (Media3 1.3.1):**
  - HLS when the type is `hls` or the URL contains `.m3u8`, otherwise progressive (TS, MP4, MKV);
  - `DefaultHttpDataSource` with cross-protocol redirects allowed, a 15 s connect timeout and a 20 s read timeout;
  - an optional User-Agent and Referer.
- **Buffering:** fixed `DefaultLoadControl(15000, 50000, 2000, 3000)`. The `bufferMs` argument passed from JS is **ignored** (M3), so `capabilities().bufferControl = true` is inaccurate.
- **Tracks:**
  - audio and text tracks are listed with the ID `groupIndex × 100 + trackIndex`, and selected through `TrackSelectionOverride`;
  - text is off at load;
  - cues are forwarded to JS and drawn by the web app.
- **Errors:** IO errors map to `connection`, parsing to `format`, decoder errors to `unsupported`, the rest to `unknown`.
- **Not handled:** audio focus and `AudioAttributes` (M4), MediaSession.

## 5. Findings by severity

**High**

| ID | Finding |
|---|---|
| H1 | **Never run on a device.** No physical or emulator evidence; no tests for the Java code; no unit tests for `android-engine.ts`, the bridge file store or the touch mapping. All Android claims so far rest on code inspection |
| H2 | **The identity and signing can't be changed later without data loss.** Debug key (tied to this PC), `applicationId com.elitestream.app`, label "EliteStream", Keystore alias `elitestream_secrets_v1`. Changing the signing key or the application ID after a real installation forces an uninstall, which deletes playlists and logins. DI-1 can't protect against that. See `CP2-ANDROID-IDENTITY-PROPOSAL.md` |
| H3 | **Large catalogue files cross the JS bridge as whole strings** (`fileRead`/`fileWrite`; the live channel file and the VOD page index). Risk of slowness or out-of-memory on low-RAM devices. Unmeasured |
| H4 | **Codec coverage.** No FFmpeg extension, so AC-3, E-AC-3 and DTS depend on device decoders or passthrough. VOD may play silent or fail as `unsupported`. (The Philips device has hardware AC-3/E-AC-3/DTS decoders: §9) |

**Medium**

| ID | Finding |
|---|---|
| M1 | **The memory guard measures `ActivityManager.availMem`**, system-wide free memory, not the WebView/renderer heap. The 150/200 MB floors may be meaningless on Android (CP1 open item) |
| M2 | **`FLAG_KEEP_SCREEN_ON` is permanent.** The TV never sleeps and the screensaver never starts while the app is open, even on idle menus; phones drain their battery |
| M3 | **`bufferMs` is ignored by the bridge**, so the engine misreports `bufferControl` |
| M4 | **No audio focus**, so playback continues over calls and other audio (mainly phones) |
| M5 | **The Android bundle includes the Samsung AVPlay and Tizen code** (size only) |
| M6 | **Keystore key invalidation or loss** silently loses logins (`keyLoad` returns null). The user only sees "saved login missing" at the next update |
| M7 | **Old WebViews on Android 5–7 boxes**: rendering and layout unverified. (The Philips device has an updated WebView, 119) |

**Low**

| ID | Finding |
|---|---|
| L1 | Missing key mappings (§2) |
| L2 | `setAllowUniversalAccessFromFileURLs(true)` and `MIXED_CONTENT_ALWAYS_ALLOW` are broad. Acceptable while the content is local-only; review before any store release |
| L3 | Back does nothing if the page fails to load |
| L4 | Media3 1.3.1; target SDK 34. Fine for sideloading; a store release would later need target SDK 35 |
| L5 | The touch and phone flow is untested (outside the TV scope) |

## 6. Memory and catalogue risks (detail)

- **Catalogue size.** The test account has about 22,000 live channels and 108,000 movies plus 25,000 series.
- **Live channel file.** It is read in one `fileRead` call, which builds a Java `String`, passes it through the bridge and parses it in JS, for several MB.
- **VOD index.** The paged index (Stage 6.1) limits single reads, but many pages pass through the bridge.
- **DI-1 adds small files only:** the backup, the diagnostics log and the account record.
- **Low-RAM devices:** on devices with a 192 MB Java heap and about 1.6 GB of RAM (the Philips), the risk is out-of-memory or WebView renderer crashes. The memory guard (M1) may not intervene.

**Required evidence (CP2):**
- import time;
- peak memory (`dumpsys meminfo` of the app process);
- the absence of crashes when opening Live TV, Movies and Series.

## 7. Android build details

| Item | Value |
|---|---|
| `namespace` / `applicationId` | `com.elitestream.app` |
| `versionCode` / `versionName` | 2 / `0.3.0` (since commit `4b9c677`; before that 1 / `0.2.0`) |
| `minSdk` / `targetSdk` / `compileSdk` | 21 / 34 / 34 |
| Java | 1.8 source and target |
| Dependencies | `androidx.media3` 1.3.1: exoplayer, exoplayer-hls, ui |
| Signing | **Android debug key** (`assembleDebug`); no release `signingConfig` |
| Manifest | `INTERNET`, `ACCESS_NETWORK_STATE`; leanback and touchscreen both optional; `LAUNCHER` and `LEANBACK_LAUNCHER`; `singleTask`; `sensorLandscape`; `usesCleartextTraffic=true`; `allowBackup=false`; label `EliteStream`; banner and icon from `res/drawable` |
| Output | `dist/android/EliteStream-0.3.0-debug.apk` (5,162,844 B on 2026-11-26) |
| Tools (outside the repo) | JDK 17, Android SDK (platform 34, build-tools 34.0.0), Gradle 8.7, adb 1.0.41 |

## 8. Automated test coverage and gaps

**Covered today** (`tests/unit/cp1-platform-contract.test.mjs`):
- `androidApiLevel`;
- the choice of Keystore or memory store by API level;
- the Android key table, identical to Samsung's.

The shared app (navigation, playback logic, DI-1, S1–S3) is covered by the 438 unit tests, all of which run against fakes.

**Gaps (must be covered physically, or by new tests):**
- `android-engine.ts`: the session-ID filtering, the load/prepare/firstFrame contract, error mapping, suspend and restore, and track parsing.
- `bridgeFileStore`: errors thrown by the bridge become rejections, the `fileWrite` false path, list parsing.
- `installTouch` and `pageScale`.
- All Java code:
  - key mapping;
  - Keystore encrypt and decrypt round trip;
  - the atomic rename;
  - ExoPlayer event order;
  - track IDs;
  - `setRect` scaling.

## 9. First test device: Philips QM164E (read-only identification, 2026-11-26)

| Item | Value |
|---|---|
| Address | 192.168.1.108, ADB over the network on port 5555, **authorised by the user** (this PC's key fingerprint `31:2E:49:F5:90:DC:07:3D:68:07:F1:A0:32:F5:FB:A0`) |
| Manufacturer / model / device | PHILIPS / **QM164E** / `QM16XE_F` |
| Chipset | MediaTek **MT5861** |
| Android | **7.1.2, API 25**, build N2G48H (`PHILIPS/QM16XE_F/QM16XE_F:7.1.2/N2G48H/01610224:user/release-keys`), security patch **2018-08-05** |
| Features | television, leanback, `leanback_only`, `live_tv`, webview; Google Play and Play services present |
| RAM | **~1.6 GB** visible (`MemTotal` 1,600,852 kB); Java heap growth limit **192 MB** (heap size 512 MB); `low_ram` flag not set |
| Interface | **1280 × 720 at 50 Hz**, density 213. The panel and video plane may be higher; unverified |
| CPU | **armeabi-v7a** (32-bit ARM) |
| WebView | Google WebView **119.0.6045.193** |
| Audio decoders | MediaTek DSP: **AC-3, E-AC-3, DTS**, AAC, MP3; plus the Google AAC and MP3 decoders |
| Existing apps | **No EliteStream or ScreenShelf** (no IPTV apps at all) |

**Classification (your decision): CP2 LOW-END COMPATIBILITY TEST DEVICE.**
- It is **not** the primary Android release-validation device.
- It is below the primary requirements: Android 7.1.2 against 9+, about 1.6 GB against 2 GB+, a 720p interface against 1080p.

**What it can show:**
- old-Android compatibility (API 25 uses the Keystore path, since it is at least 23);
- 720p scaling;
- 32-bit ARM;
- low-memory behaviour (H3, M1);
- hardware multichannel audio (H4).

**What it can't show:**
- modern Android TV or Google TV behaviour;
- 1080p layout;
- session-only logins (that needs Android 5);
- anything for other manufacturers.

## 10. Blockers and outstanding decisions

**Blockers:**
1. **A modern primary device** (Android 9+, at least 2 GB, 1080p, Android TV or Google TV) is not available yet.
2. **Identity and signing (H2)** must be decided before any installation that keeps real data (`CP2-ANDROID-IDENTITY-PROPOSAL.md`).

**Decisions for you:**
1. Approve `CP2-ANDROID-IDENTITY-PROPOSAL.md`: the application ID, label, signing key and Keystore alias.
2. Whether the **first installation on the Philips is disposable** (a debug-signed test install that may be wiped later), or waits for the final identity and release key.
3. Authorisation to **build and install** the test APK by ADB on the Philips, and to collect evidence (logcat, `dumpsys meminfo`, `adb exec-out screencap`; nothing written to the TV).
4. Which **modern primary device** to use, and whether to add an **Android 5** device (optional, plan part C).
5. Fix order: the physical baseline first, then fixes F2–F7 (recommended), or fixes first.

**Proposed fixes** (not implemented; each needs approval):

| ID | Fix |
|---|---|
| F1 | Identity and signing (proposal document) |
| F2 | Keep the screen on only while video plays |
| F3 | Use `bufferMs`, or report `bufferControl: false` |
| F4 | Audio focus |
| F5 | The missing key mappings |
| F6 | Unit tests for `android-engine` and the bridge file store |
| F7 | Android memory policy after measurement |
| F8 | Optional Android-only bundle |
| F9 | FFmpeg audio extension, only if codec tests fail |
| F10 | Media3 upgrade, only with approval |

Physical test plan: `CP2-PHYSICAL-TEST-PLAN.md`.
