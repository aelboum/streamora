# CP2 — Android physical test results

Plan and criteria: `CP2-PHYSICAL-TEST-PLAN.md`. Background: `CP2-READINESS-AUDIT.md`.

**Status: in progress.**
- Part A (Philips low-end device) is partly done.
- Part B (modern primary device) and part C (Android 5) have not started.
- Missing evidence is recorded as INCONCLUSIVE, never as PASS.

## 1. Session 1 — 2026-11-26, Philips QM164E (part A)

**Device:**
- Philips QM164E (`QM16XE_F`), MediaTek MT5861, Android 7.1.2 / API 25, build N2G48H.
- About 1.6 GB RAM, Java heap limit 192 MB, 720p interface, armeabi-v7a, WebView 119.0.6045.193.
- Classification: **low-end compatibility device**. These results are not claimed for modern devices.

**Builds tested** (debug-signed, disposable install):

| Install | Time | APK | Contents |
|---|---|---|---|
| First install | 17:06:01 | `EliteStream-0.3.0-debug.apk`, SHA-256 `963530446dd7044a…` | 0.3.0 web bundle |
| Update (`adb install -r`, data kept) | 17:49:31 | `EliteStream-0.3.0-debug.apk`, SHA-256 `747c89633997c159…` | 0.3.0 plus F11/F12, later committed as `9f87502` |

Both are `com.elitestream.app`, versionCode 2 / versionName 0.3.0, debug key.

**Evidence collection:**
- Read-only `adb` from the PC: `logcat` (URLs redacted), `dumpsys meminfo`, `screencap`.
- File **names and sizes** only, via `run-as`.
- `secrets.xml` checked for format only; values were never printed.
- The user's observations.
- Credentials were entered by the user on the TV. Nothing was written to the device except the two installs.

### Results

| Test | Result | Evidence |
|---|---|---|
| A1 Install and launch | **PASS** | Install `Success`. First start: activity displayed after **3.4 s** (`am start -W`, started over ADB because the app had not been opened yet). User: opened from the Android TV launcher, **banner shows, remote works**. Screen captures of Home. No `FATAL`/ANR in logcat |
| A2 Platform detection | **PASS** | Diagnostics, transcribed by the user and matching a screen capture: Platform `android Android 7.1.2 (API 25) (tv)`, Video (AVPlay) no, File storage yes, Secure key store **yes**, WebCrypto yes, Remote keys yes, Free memory 736 MB, Network online, Warnings **none** |
| A5 Secure credentials (Keystore) | **PASS** (after F11) | `shared_prefs/secrets.xml` holds exactly **one value, 128 characters of base64, with no readable username, password or address** (format check only). Playlist backup holds no credentials. User: after closing via Back → Yes and starting again, the playlist works without signing in again. The activity was recreated (new task t959, previously t949), so the page and WebView were rebuilt. Note: Android kept the process cached (same process ID). A full process kill or TV restart (A5b) has not been tested |
| A6 Low-memory catalogue load | **PASS** (after F11) | User: import and opening Live TV, Movies and Series all fine and fast. Counts: **21,989 live channels, 108,665 movies, 25,515 series**. Import about 17:53–17:56, from catalogue file timestamps, not a stopwatch. App PSS: about 58 MB idle; **peak 124 MB** during the import (17:54:41); **peak 128 MB** while browsing (18:25:33). Java heap at most 5.7 MB (limit 192 MB). TV free memory fell to about 23 MB during the import; Android reclaimed cache itself. **No crash, ANR or low-memory kill:** the same app process ran from 17:50 to the end of the session. Catalogue on disk 6.6 MB: live list, movie index (1 + 120 pages), series index (1 + 29 pages) |
| A7 DI-1 storage on Android | **INCONCLUSIVE** | The Diagnostics storage values were not transcribed (skipped at the user's request). Supporting only: `ss-playlists.bak.json` exists with `count 1`, kind `xtream`, no credentials |
| A3, A4, A8–A16 | **Not tested** | — |

A1 note: "remote works" is a first impression. The per-key check (A8) has not been done.

### Defect found and fixed: first playlist could not be added (CP2-D1)

**Symptom:**
- On the first build, **Save** in "Add Xtream account" stayed on "Saving…" indefinitely.
- No playlist and no credentials were stored.
- Logcat showed `Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'length')` once per Save press (17:14:59 and 17:20:37).

**Root cause:**
1. A Java `@JavascriptInterface` method that returns a `null` String reaches JavaScript as **`undefined`**.
2. On a fresh install the playlist backup file does not exist, so `PlatformBridge.fileRead` returned `null`, which arrived as `undefined`.
3. `PlaylistService.loadBackup` tests `text === null`, so it treated the value as a damaged backup and read `text.length`, which threw.
4. The add flow therefore always failed.
5. The form had no rejection handler, so it never left "Saving…".

**Scope:**
- Every fresh Android install.
- Samsung is not affected: its file store returns a real `null`.
- The CP1 fake bridge returned `null`, which is why the automated tests missed it.

**Fixes** (approved by the user; commit `9f87502`, pushed):
- **F11:** `bridgeFileStore.read` and `bridgeKeyStore.load` (`android-platform.ts`) normalise bridge results to `string | null`.
- **F12:** the playlist form shows the existing storage message instead of hanging on any unexpected save failure. This is shared code, so it also applies to Samsung, though it fixes no Samsung defect.

**Tests:**
- New `tests/unit/cp2-android-bridge.test.mjs`, with a fake bridge that returns `undefined` like the real WebView. With the pre-F11 store it reproduces the device error exactly.
- An F12 test in `playlist-ui.test.mjs`, which fails without F12.
- Results: 442/442 unit, 6/6 build, typecheck and compatibility checks OK.

**Device verification:** after the update, the playlist was added and imported (A5 and A6 above).

### Observations (not failures)

| # | Observation | Follow-up |
|---|---|---|
| O1 | **Mixed branding:** the Home header shows "ELITE STREAM" while Settings, Diagnostics and the forms show "SCREENSHELF". This comes from the shared web app, so Samsung is probably the same | Add to the identity work (F1) |
| O2 | Diagnostics viewport shows **1920 × 1081** at a 1280 × 720 interface (a scaling rounding artefact) | Check during A3 (720p layout) |
| O3 | Diagnostics "Free memory" (736 MB) is the TV's system-wide available memory, not the app's usage (finding M1) | F7 memory policy |
| O4 | The Diagnostics label "Video (AVPlay)" is Samsung-specific; the value "no" is correct on Android | Cosmetic |
| O5 | **The ADB-over-network connection drops repeatedly** on this TV (`offline` / "failed to connect", while ping and port 5555 still answer). It was restored by switching **USB-foutopsporing** off and on in Developer options. Developer options had to be unlocked again (Build × 7). Memory recording during the import stopped at 17:55 because of this | Test-environment limitation. Allow time for reconnection in later sessions |

## 2. Still open

**Part A (Philips):**
- **A7:** transcribe the storage values.
- **A3:** 720p layout of all screens.
- **A8:** per-key remote check.
- **Playback:**
  - A9 live TV and channel-switching times;
  - A10 audio codecs (AC-3, E-AC-3, DTS);
  - A11 subtitles;
  - A12 movies and episodes (seek, resume, next episode).
- **Lifecycle and screen:**
  - A13 lifecycle;
  - A14 keep-screen-on (M2).
- **Other:**
  - A15 S1–S3 on Android;
  - A16 memory-guard comparison;
  - optionally A5b, credentials after a TV restart, which needs separate approval.

**Part B:** a modern primary device (Android 9 or later, at least 2 GB, 1080p) is still required.

**Before any release:** the identity and signing decisions (`CP2-ANDROID-IDENTITY-PROPOSAL.md`).
