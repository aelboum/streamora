# CP2 — Android physical test plan

Date: 2026-11-26. **Plan.** Results of the sessions run so far are recorded in `CP2-PHYSICAL-TEST-RESULTS.md`. Installing on any device, collecting logs, and each part of the plan **need separate authorisation**. Background: `CP2-READINESS-AUDIT.md` (findings H1–L5, fixes F1–F10) and `CP2-ANDROID-IDENTITY-PROPOSAL.md`.

## 0. Common rules

**Results**
- **PASS:** the expected behaviour was observed, and the required evidence was recorded.
- **FAIL:** the behaviour differs from what is expected, or a stop condition happened.
- **INCONCLUSIVE:** the test couldn't be done, or the evidence wasn't recorded (for example, values reported as "ok" without being written down). **Missing evidence is never counted as PASS.**

**Evidence** (all read-only; nothing is written to the device):
- **Your observations,** with the exact text or values on screen. For Diagnostics, **transcribe** the six storage values and the top storage-event lines. The Samsung S5 gaps A3 and E5 came from values that were never written down.
- **Screen captures:** `adb exec-out screencap -p > file.png`. This writes on the PC only.
- **Logs:** `adb logcat -d` filtered to the app's process. ScreenShelf never logs URLs or credentials; the evidence is checked before it is kept.
- **Memory:** `adb shell dumpsys meminfo <package>` (PSS, Java heap, native heap) at the points named in the tests.
- **Versions:** `adb shell dumpsys package <package> | grep version` and `getprop` values.

**Stop conditions** (stop immediately, change nothing, report):
- "Your playlists are protected", or Diagnostics not Healthy when it should be;
- a playlist that disappears or changes unexpectedly;
- a crash loop, or the app not starting;
- credentials appearing in clear anywhere: screen, logs or files.

**Data policy:** the first Philips installation is **debug-signed and disposable** unless you decide otherwise. Its data is deleted when it is replaced by the release-signed app (`CP2-ANDROID-IDENTITY-PROPOSAL.md` §7). Credentials are entered **by you** on the device; I never type them.

**Not allowed without an extra, explicit approval:** reboot, uninstall, clearing data, changing TV or developer settings, `am force-stop` or `am kill`.

---

## A. Philips low-end compatibility device

**Device:** Philips QM164E, MediaTek MT5861, Android 7.1.2 (API 25), about 1.6 GB RAM, Java heap 192 MB, **720p interface**, armeabi-v7a, WebView 119, hardware AC-3, E-AC-3 and DTS decoders. Classification: **low-end compatibility device**. Its results are valid for this class only and are never claimed for modern devices.

| # | Test | Steps | PASS when | Evidence |
|---|---|---|---|---|
| A1 | Install and launch | Install the approved test APK by `adb install` (fresh, no `-r` needed); open it from the Android TV launcher | The app appears with its banner; it starts to Home within about 10 s; no crash | `dumpsys package` version; launch time (stopwatch); screencap of Home |
| A2 | Platform detection | Settings → Diagnostics | Platform `android`, "Android 7.1.2 (API 25) (tv)"; Secure key store **yes**; File storage yes; Warnings none | Transcribed lines plus screencap |
| A3 | 720p layout | Visit Home, Live TV, Movies, Series, Settings, Diagnostics, About, a dialog and the keyboard | Everything is readable and nothing is cut off; the 1920-wide page is scaled to 1280 × 720; focus is visible | Screencaps of each screen |
| A4 | 32-bit ARM | Covered by A1 and A10 (the APK is pure Java/JS, with no native libraries of its own) | The app runs; ExoPlayer decodes | Logcat without `UnsatisfiedLinkError` or ABI errors |
| A5 | Secure credentials (Keystore) | You add your Xtream playlist; then quit the app fully (exit dialog) and start it again | The login is kept, with no sign-in prompt; the playlist loads | Observation; optionally `adb shell run-as <package> cat shared_prefs/secrets.xml` (debug build only) shows **base64 ciphertext only**, never the password |
| A5b | Credentials after reboot | **Only with a separate reboot approval**: reboot the TV, start the app | The login is kept | Observation |
| A6 | Low-memory catalogue load | Import the playlist (about 22,000 channels); open Live TV; open Movies (about 108,000) and Series | The import finishes; no crash or WebView reload; lists open | Import time; `dumpsys meminfo` before, during and after; logcat without OOM or renderer crash |
| A7 | DI-1 storage on Android | Diagnostics → Refresh after the import and after A5 | Healthy · list 1 · backup **Valid** · backup 1 · integrity **Passed** · last backup with a time | **Transcribed values**, top event lines, screencap |
| A8 | Remote navigation | D-pad, OK, Back (exit dialog at Home), Home key and return, CH±, digits, colour keys and Info/Guide (if on the remote) | Each key acts as on Samsung; unmapped keys do nothing harmful | Per-key result list; note which keys the Philips remote has |
| A9 | Live TV | Play channels; CH+/CH− and ▲▼; number entry; Blue = previous; a dead channel; a stall | The picture starts (note the time); CH± stays in the category; a dead channel shows an error; a stall recovers or shows an error | Zap times for 5 changes; error text; logcat |
| A10 | Audio codecs | Play titles with **AC-3, E-AC-3, DTS** and AAC/MP3 audio; switch audio tracks | Sound on every track (hardware decoders); switching works | Per-codec result; the track list (audio-track sheet) |
| A11 | Subtitles | A title with embedded subtitles (MKV) and an HLS stream with subtitles; on, off, switch | Shown in the app's style, in sync; off works | Screencap with subtitles |
| A12 | VOD | Movie and episode: play, seek, leave, resume, next episode | The position is kept and resumed; seeking works | Observation; screencaps |
| A13 | Lifecycle | During playback: Home, then return; screen off / standby (if allowed without a settings change), then return | Playback stops when hidden and reopens on return (live) or at the position (VOD); no double audio | Observation; logcat |
| A14 | Keep-screen-on (M2) | Leave the app idle on Home for longer than the TV's screensaver delay | **Expected today: the screensaver never starts** (finding M2). Record what happens | Observation (a known finding, not a PASS criterion for acceptance) |
| A15 | S1–S3 | About (Android version shown); Settings → Subscription; last-channel option (on, restart, resume, cancel, CH± in its category, off) | As on Samsung S5 | Transcribed values; observations |
| A16 | Memory guard (M1) | During A6, compare Diagnostics "Free memory" with `dumpsys meminfo` | Recorded for the F7 decision; no PASS criterion yet | Both figures |

**Part A acceptance (low-end class):** A1–A3, A5, A6, A7, A8, A9, A10, A12 and A13 PASS; no stop condition. INCONCLUSIVE items are listed, never hidden.

---

## B. Modern primary Android TV (to be identified)

**Device requirements:**
- Android TV or Google TV, **Android 9+ (API 28+)**;
- **at least 2 GB RAM**;
- **1080p** interface (4K panel fine);
- a standard remote (D-pad, Back, Home; ideally CH±, digits, colour keys);
- ADB debugging authorised;
- no earlier installation.

This device carries the **Android release validation**. For the final acceptance, its run must use the **release-signed APK with the final identity** (application ID, label, key; proposal §1–§4).

| # | Test | PASS when | Evidence |
|---|---|---|---|
| B1 | Install and launch (release-signed, final ID) | It installs, appears as "ScreenShelf" in the launcher and starts | `dumpsys package` (ID, version, signature hash); screencap |
| B2 | Platform and storage | Diagnostics: android, correct API, Secure key store yes, Healthy, backup Valid, integrity Passed | Transcribed values |
| B3 | 1080p layout | Every screen sharp and complete | Screencaps |
| B4 | Credentials | Kept after an app restart and after a device restart (with approval); ciphertext only | Observation; `secrets.xml` check only if a debug build is used for this |
| B5 | Catalogue and performance | Import, Live, Movies and Series; times recorded; no crash | Times; `meminfo` |
| B6 | Remote | As A8, with the full remote | Per-key list |
| B7 | Live TV | As A9; zap times | Times; logcat |
| B8 | Codecs | AC-3, E-AC-3, DTS: decoder **or** passthrough to TV or receiver, with sound | Per-codec result, and how it was output |
| B9 | Subtitles and audio tracks | As A10 and A11 | Screencaps |
| B10 | VOD | As A12 | Observations |
| B11 | Lifecycle | As A13, plus Google TV "Ambient" / screensaver behaviour | Observations |
| B12 | S1–S3 | As A15 | Values |
| B13 | Update path | Install a newer `versionCode` signed with the **same key** over the existing app | Data kept (playlist, login, settings); Diagnostics Healthy | Transcribed values |
| B14 | Upgrade safety | **Optional and only on a disposable install:** confirm that an APK with a different signature is refused (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) and the installed app and data are untouched | `adb install` output |

**Part B acceptance (Android release):** B1–B13 PASS with the release-signed final identity; no stop condition.

---

## C. Optional Android 5 device (session-only logins)

**Device:** any Android 5.0 or 5.1 (API 21–22) TV box. ADB authorised. Disposable install.

| # | Test | PASS when | Evidence |
|---|---|---|---|
| C1 | Detection | Diagnostics: android API 21/22, **Secure key store no**; the warning "no secure key store: logins are kept for this session only" | Transcribed values |
| C2 | Add a playlist | Playlist added; the form shows the session-only notice | Screencap |
| C3 | Session only | After quitting and restarting the app: Home shows the **"Sign in again"** prompt; the playlist definition is still listed; **no password stored** (`secrets.xml` absent or without that entry; debug build `run-as`) | Observation; file listing |
| C4 | Re-authentication | "Sign in" opens the playlist form; after entering the login, the playlist works until the next restart | Observation |
| C5 | M3U | An M3U playlist asks for its URL again after a restart (by design, CP1 §5) | Observation |
| C6 | Old WebView | Layout and fonts usable (WebView version recorded) | WebView version; screencaps |

**Part C acceptance:** C1–C4 PASS. C5 is documented behaviour. C6 is informational.

---

## D. Order and authorisations

1. **Now (approved):** this plan; no execution.
2. **Next, needs approval:**
   - build the test APK (today: `EliteStream-0.3.0-debug.apk`, `com.elitestream.app`, debug key);
   - install it on the Philips (disposable);
   - run part A, with read-only evidence collection.
3. **After your identity decision:** implement F1 (ID, label, alias, APK names, release signing config); create the production key with backups; rebuild.
4. **Part B** on the modern device with the release-signed build.
5. **Fixes** F2–F7 as indicated by A and B (each approved separately), then a regression run (A or B subset).
6. **Part C** only if an Android 5 device is available.
