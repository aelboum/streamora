# CP1 — Platform contract hardening: report

Date: 2026-11-26. Scope: CP1 as defined in `docs/STAGE-14-CROSS-PLATFORM-ROADMAP.md` (R1) and `docs/CP-R0-READINESS-REPORT.md` §9. CP2 and CP3 were not started.

> **Status update (2026-11-26): CP1 is NOT ACCEPTED.** A confirmed playlist data-loss incident blocks it; see §8. The repair, DI-1, is implemented and passes automated verification (`docs/DI-1-REPORT.md`). Physical Samsung verification with DI-1 is still pending. The sections below are the original CP1 record and are kept unchanged.

- **TV:** Samsung physical regression passed on 2026-11-26 (§4), and the production build was restored afterwards. Nothing was committed or pushed.
- **Titan OS:** remains blocked. The inquiry draft is in `docs/CP-TITAN-INQUIRY-DRAFT.md` (not sent).

## 1. Implementation summary

### 1.1 Per-platform key maps
- `src/navigation/keys.ts`:
  - `mapKeyCode(code, allowBrowserKeys, platform?)` picks a table per platform.
  - Tizen and Android (the Android activity already translates to Samsung codes) use the existing `CODES` object, **unchanged**. No platform given also means Samsung.
  - New tables:
    - **webOS:** Back 461, colour 403–406, media keys, 33/34 in case the TV delivers Channel ±. To verify in CP3.
    - **Titan:** Back 8 and 461, CH 33/34, Play/Pause 179, from docs.titanos.tv/remote-control.
- `key-router.ts` takes an optional `platform`; `bootstrap.ts` passes `platform.name`.
- **Not done in CP1:** per-platform hint texts ("CH▲▼ page"). They depend on whether the webOS TV delivers CH ±, which only a device can show (CP3). Samsung hints are unchanged.

### 1.2 Engine capabilities
- `src/player/engine.ts`:
  - `EngineCapabilities` (`multiDecoder`, `trackSwitching`, `embeddedSubtitles`, `bufferControl`, `maxTracks`);
  - optional `PlaybackEngine.capabilities()`;
  - `engineCapabilities(engine)`, which gives safe defaults (single decoder) for engines without the method.
- AVPlay reports today's proven behaviour: one decoder, tracks switchable, the first 32 tracks, embedded cues, buffer control.
- The Android engine reports the same; not yet verified on a device.
- The capabilities are logged at start-up ("player capabilities").
- No current engine is multi-decoder, so the live preview and zapping behave exactly as before. These code paths will read the flag when an engine reports otherwise (CP2/CP3 measurements).

### 1.3 Memory policy
New `src/app/memory-policy.ts` (decision 5):

| Platform | Measured | Floors | Live cache limit |
|---|---|---|---|
| Tizen, Android | Yes | 150 MB work floor, 200 MB guide floor | 8,000,000 chars |
| Everything else (browser now; webOS and Titan later) | No | No floor ever checked; `freeMB()` returns −1 even if a platform offers a number | 4,000,000 chars |

- `describe()` says either "N MB free (measured)" or "not measured; limits apply". It never shows an estimate.
- `bootstrap.ts` uses the policy everywhere it used `platform.name === 'tizen' ? 150 : 0` and `platform.memory().availableMB`. These are:
  - the live cache;
  - the guide floor;
  - Live TV, Movies/Series and Search guards;
  - the write-pressure gate.
- **On Samsung the values are identical.** A failing memory read now yields −1 ("unknown", no guard) instead of an exception.
- **Android now gets the 150 / 200 MB floors** (before CP1 it had none). This follows R0 decision 5 ("Samsung and Android keep 150 MB").

### 1.4 IndexedDB FileStore
New `src/app/platform/idb-file-store.ts`:
- **Format:** one object store `files`, key = file name, value = text.
- **Atomic writes:** each write is one `put` in its own transaction (atomic replace).
- **`list()`:** works through a key cursor (no `getAllKeys`, which Chromium 38 / webOS 3 lacks).
- **Errors:** generic error messages that never include content; a failed open is retried.
- **Not used by any platform yet** (webOS in CP3). It is not in the Samsung bundle, because nothing imports it.

### 1.5 Build-time platform selection
- `scripts/build.mjs`:
  - `build(mode, env, platform)`;
  - command line `node scripts/build.mjs release --platform <all|tizen|android|browser>`.
- **Default `all`** is today's bundle: every adapter, runtime detection, `dist/<mode>`, with config.xml. The npm scripts, `tv:*` and `android:build` are unchanged and use the default.
- **A single platform:**
  - `detect.ts` branches on `__SS_PLATFORM__`; the minifier removes the other adapters;
  - output goes to `dist/<mode>-<platform>`;
  - config.xml is written only for `all` and `tizen`.
- `scripts/lib/release-check.mjs` takes `{ config: false }` for non-Tizen platform builds.
- Measured (release):

  | Build | `app.js` |
  |---|---|
  | `all` | 353,621 B |
  | `tizen` | 346,834 B (no `ElitePlatform`) |
  | `android` | 345,494 B (no `keymanager`) |

  The AVPlay engine is still in the Android bundle, because `main.ts` picks the engine at run time. That is harmless; it can be narrowed when CP2 needs it.

### 1.6 Session-only logins (decision 4)
- **`bootstrap.ts`:**
  - without a platform key store, logins go to an in-memory session store;
  - this replaces the old behaviour of disabling playlists entirely;
  - never plaintext, never localStorage or files.
- **`android-platform.ts`:** the Android Keystore bridge is used only from **API 23 (Android 6.0)**. Below that, logins are session-only, the `secureKeyStore` capability is false, and nothing reaches the native store.
- **`PlaylistService`:** new `credentialsPersistent()` and `hasCredentials(id)`.
- **Home (re-entry prompt):**
  - When logins are session-only and the active playlist has no login (after a restart), Home asks **once per app run**: "Sign in again", with **Later** and **Sign in**.
  - Sign in opens the existing edit form.
- **Playlist form:** shows a notice that the login is kept only until the app closes and is never stored in plain text.
- **Strings:** EN and NL.
- **Where this applies:** with a secure store (Samsung keymanager, Android 6+) no prompt or notice ever appears.

### 1.7 Platform-isolation check
- `scripts/lib/compat-rules.mjs`: `PLATFORM_GLOBALS` = `tizen`, `webapis`, `ElitePlatform`, `indexedDB`, `PalmSystem`, `webOS`, `webOSSystem`, `TitanSDK` and `SmartTvA_API`.
- Each may only appear in `src/app/platform/` (plus the AVPlay engine and the type declarations), as before for `tizen` and `webapis`.
- `npm run compat`: 127 files, 0 findings.

## 2. Files changed

**Modified (17):**

| File | Change |
|---|---|
| `scripts/build.mjs` | `--platform`, per-platform output folder, config.xml only for all/tizen |
| `scripts/lib/compat-rules.mjs` | `PLATFORM_GLOBALS` isolation |
| `scripts/lib/release-check.mjs` | `{ config: false }` option |
| `src/app/bootstrap.ts` | Memory policy, session key store, key-map platform, capabilities log, sign-in state for Home |
| `src/app/platform/android-platform.ts` | `androidApiLevel`; Keystore only from API 23 |
| `src/app/platform/detect.ts` | Build-time platform branches |
| `src/i18n/strings.ts` | `signin.*`, `form.sessionOnly` (EN/NL) |
| `src/navigation/key-router.ts` | `platform` option |
| `src/navigation/keys.ts` | webOS and Titan tables, `KeyPlatform`, `mapKeyCode` platform argument |
| `src/player/android-engine.ts` | `capabilities()` |
| `src/player/avplay-engine.ts` | `capabilities()` |
| `src/player/engine.ts` | `EngineCapabilities`, defaults, `engineCapabilities()` |
| `src/screens/home-screen.ts` | Sign-in-again prompt |
| `src/screens/playlist-form-screen.ts` | Session-only notice |
| `src/services/playlist-service.ts` | `credentialsPersistent()`, `hasCredentials()` |
| `src/types/build-globals.d.ts` | `__SS_PLATFORM__` |
| `tests/unit/bootstrap.test.mjs` | Two expectations, see below |

The two `bootstrap.test.mjs` expectations encoded the pre-R0 rule "no secure store means no playlists". Decision 4 replaced that rule:
- the "no plaintext fallback" assertion now checks `secrets.persistent === false`;
- the warning text changed.

No assertion was removed or weakened.

**Also modified:** `tests/build/build.test.mjs` (+1 test). `tests/build/` used to be ignored by the `build/` rule (the known Stage 0 finding); after the `.gitignore` change in §3 it can be tracked.

**New (4 code, 2 docs):**
- `src/app/memory-policy.ts`;
- `src/app/platform/idb-file-store.ts`;
- `tests/fakes/fake-indexeddb.mjs`;
- `tests/unit/cp1-platform-contract.test.mjs`;
- `docs/CP-TITAN-INQUIRY-DRAFT.md`;
- this report.

**Kept untouched:** `docs/CP-R0-READINESS-REPORT.md`, `docs/STAGE-14-CROSS-PLATFORM-AUDIT.md`, `docs/STAGE-14-CROSS-PLATFORM-ROADMAP.md`.

## 3. Tests executed and results

| Check | Result |
|---|---|
| `npm run typecheck` | OK |
| `npm run compat` (ES5 source rules + platform isolation) | 127 files, **0 findings** |
| `npm test` (unit) | **374 / 374 pass** (361 before + 13 CP1) |
| `npm run test:build` | **6 / 6 pass** (5 before + 1 CP1 `--platform`) |
| ES5 bundle gate (acorn) | OK for `all`, `tizen` and `android` release bundles |
| `npm run build:all` | release OK, `release-check: OK`, APK built (`EliteStream-0.2.0-debug.apk`, 5,215,054 B) |
| Final run, 2026-11-26 (`npm run check`, `build:release`, `check:release`) | typecheck OK; compat 127 files, 0 findings; unit 374 / 374; build 6 / 6; release build OK; `release-check: OK` |
| Clean checkout (387 files from `git ls-files --cached --others --exclude-standard`, then `npm ci`) | `npm run test:build` **6 / 6 pass** |

**`.gitignore` change (task B).** The pattern `build/` also matched `tests/build/`, so the build tests were invisible to Git. It is now `/build/`, which ignores only the root build output, with a one-line comment. Nothing else is newly visible: the Android build folders stay ignored by `android/.gitignore`, and `probe/build/` keeps its own rule. Nothing is staged or committed.

**The 13 CP1 tests** (`tests/unit/cp1-platform-contract.test.mjs`) cover:
- Samsung and Android key tables identical code by code, against the pre-CP1 table;
- the webOS and Titan tables, and the key router passing the platform through;
- AVPlay capabilities and the defaults;
- the memory policy, measured and not measured, plus its use in the app context;
- the IndexedDB store: CRUD, sorted list, cursor fallback, persistence, quota failure keeping the old data, open retry, blocked open;
- Android API-level selection of the key store;
- session-only logins:
  - kept for the session;
  - gone after a restart;
  - no password or username in localStorage;
- the sign-in prompt: shown once per run, Later and Sign in, the form notice, never shown with a secure store;
- the isolation rule.

## 4. Samsung compatibility assessment

**Baseline:** the release `app.js` before CP1 was 350,405 B (SHA-256 `24380bc5…`); after CP1 it is 353,621 B (SHA-256 `5c0706e5…`). The bundle is not byte-identical, because it now contains the new tables, capabilities and policy code.

**Functional equivalence on Samsung**, by inspection and tests:

| Area | Samsung behaviour after CP1 | Evidence |
|---|---|---|
| Keys | Same table object, same codes | Code-by-code test against the pre-CP1 table |
| Key registration | Unchanged (`TIZEN_KEY_NAMES` untouched) | Bootstrap tests |
| Memory floors | 150 / 200 MB, same reads; a throwing read becomes "unknown" | Memory-policy tests, context test |
| Credentials | `tizen.keymanager` (persistent); no prompt, no notice | Prompt test with a persistent store |
| Platform detection | `all` bundle, same runtime order (Android bridge, Tizen, browser) | Build test (both adapters present) |
| Playback | AVPlay unchanged; `capabilities()` only adds a method and a log line | Existing player tests unchanged and passing |
| ES5 | Gate passes | Build tests |
| Packaging | Same config.xml, privileges, CSP | Build test "config.xml carries exactly the approved privileges" |

**Physical Samsung regression: performed 2026-11-26 on the UE50MU6100 and passed** (with your authorisation; your verdict: "all ok").

Procedure:
1. Checked the Stage 0 backups: all three archives and git bundles verified OK.
2. Recorded the installed version: ScreenShelf 0.2.0 (`SShelfDev1.ScreenShelf`), installed 2026-11-26 00:07 local, which is the pre-CP1 build from `c0adf0b`.
3. Installed the CP1 test build at 10:06 local. It was a dev build with the dev log sink and the passive zap logger, which records keys, stream opens, engine events and free memory, with no URLs or credentials. `src/dev/device-selftest.ts` was restored straight after the build (SHA-1 `07584dfe…` matches).
4. You ran the checklist with the physical remote.
5. Restored production at 10:30 local (details below).

| Check | Your result | Log evidence (passive logger, 1,474 lines, 481 key presses) |
|---|---|---|
| Startup | OK | Platform `tizen`, every capability true (secure key store included), no warnings, 288 MB free at start |
| Navigation and remote | OK | Home, Live TV, live player, Movies and Series browse, details, VOD player, Settings, playlist form and details; ▲▼◀▶, OK and Back all mapped as before |
| Live TV | OK | 21,989 channels, 375 categories; 5 CH+ presses (code 427) and 15 ▲▼ presses in the player; zaps reached playback in about 1.0–1.4 s; one stalled prepare reopened itself |
| VOD | OK | Several movies and episodes; seeking; one `avplay: seek no answer` after 10 s, a message that existed before CP1, and playback went on |
| Audio tracks | OK | Three `avplay: track` audio switches (ids 1 and 2) |
| Subtitles | OK | Subtitle cue events, on and off |
| Memory handling | OK | Lowest free memory 214 MB; the guide download stopped twice at the 200 MB floor (154 and 169 MB), as designed; no crash |
| Authentication | OK | After a full restart: no sign-in prompt, the playlist and its catalogue loaded (movie index 108,665 items) and Live TV opened, so the login was kept in `tizen.keymanager` |

Notes:
- **Keys missing from the log.** The log contains no CH− (428), number keys or Blue (406) presses, so for those three only your physical result covers them.
- **Startup log lines not received.** The new `player capabilities` line and the old `context ready` line are written synchronously during startup, before the dev sink connects, so they did not reach the PC. This existed before CP1 and is not a regression.
- **Playlist added during the test.** The log shows a new Xtream playlist being added (`pmwxc6brb01`). The earlier playlist (`pmwuiieey01`) did not appear in this run's log, and no `playlist removed` line was logged. See item 1 in §5.

**Production restored (2026-11-26, 10:30 local):**
- Copied the saved pre-CP1 release build (identical to `c0adf0b`; `app.js` 350,405 B, SHA-256 `24380bc5…`) to `dist/release`. All 5 files match their recorded checksums.
- Installed and launched it: ScreenShelf 0.2.0, install date 2026-11-26 10:30:09.
- The dev sink stopped receiving lines, as it should for a release build.
- Backups re-verified afterwards: 6 / 6 OK.
- `dist/release` now holds the production build. `npm run build:release` regenerates the CP1 build.

**Risk for Samsung: low.** The only code paths on the TV that changed are:
- the bootstrap wiring: same values;
- `mapKeyCode`: same table;
- `detect.ts`: same order;
- the Home `onShow` early return: a secure store means no prompt.

## 5. Remaining issues

1. **Confirm the playlist list after the test.** A new playlist was added during the regression, and the earlier one did not appear in the log. It is probably a deliberate re-add. Please check in the production app whether the earlier playlist is still listed. If it disappeared without you removing it, that is a data issue and needs investigating before CP1 is accepted. Nothing in the CP1 diff touches how playlists are stored or loaded.
2. **M3U URL re-entry with session-only storage.**
   - On platforms without a secure store, the playlist definition (name and server) persists, but the login does not.
   - An M3U playlist stores no URL, because the URL may carry credentials, so its URL has to be entered again after each restart.
   - This is by design (decision 4).
   - It does not apply to Samsung, where `tizen.keymanager` is persistent.
3. **Android memory floors not validated.** The 150 / 200 MB floors are new for Android (decision 5). They are based on Samsung figures and need measuring on an Android device in CP2.
4. **The Android bundle contains the Samsung player code.** The engine is chosen at run time in `main.ts`, so the AVPlay engine is still in the Android bundle. Removing it is optional; it is in CP2.
5. **Multi-decoder capabilities deferred.** Every engine reports `multiDecoder: false`. Using the flag (for example preview or picture-in-picture) waits until a device measurement shows an engine that supports it (CP2/CP3).
6. **LG CH+ / CH− not verified.** The webOS key table maps 33/34 to CH+ / CH−, from documentation only. This needs a physical check on an LG TV before CP3 relies on it; the per-platform hint texts wait for the same check.
7. **Titan OS questions open.** Titan stays blocked until the four questions are answered:
   - T1: HTTPS app reaching HTTP providers;
   - T2: HTTP hosting;
   - T3: CORS;
   - T4: content policy.
   
   They are in `docs/CP-TITAN-INQUIRY-DRAFT.md`. The draft has not been sent; sending it is your decision.
8. **Regression log gaps.** CH−, number entry and Blue are covered by your physical result only. Earlier stages already verified them on this TV, and their key codes are unchanged (code-by-code test).

## 6. Repository and authorisation boundaries

- **No commit, push, release or deployment.** `main` is still at `c0adf0b`; all CP1 changes are uncommitted.
- **TV:** only the authorised CP1 test install, followed by the production restore. No firmware change and no TV settings changed. The production build (pre-CP1, `c0adf0b`) is installed again.
- **Only CP1 work.** CP2 and CP3 were not started.

## 7. Final status

**CP1 is complete, pending your approval.**
- Tests: unit 374 / 374, build 6 / 6 (also from a clean checkout), typecheck OK, ES5 and platform isolation 0 findings, release check OK.
- Samsung physical regression passed.
- Production is restored and verified.
- Backups are intact.
- One open confirmation: §5 item 1 (the playlist list).
- All changes are uncommitted on the working tree, including the `.gitignore` change. A commit needs your authorisation.

## 8. Data-integrity incident and DI-1 (added 2026-11-26)

**Incident (confirmed).**
- The original Xtream playlist `pmwuiieey01` disappeared from the UE50MU6100 without being deleted by you. It had about 108,627 movies and 25,502 series, and its entry, catalogue and login were all lost.
- It last loaded on 25 Nov at 22:57 UTC and was already missing at the first CP1 start on 26 Nov at 09:06 UTC.
- The only remaining playlist is `pmwxc6brb01`, added separately during the CP1 test. You confirmed on the TV that 1 playlist is listed.
- §5 item 1 (the playlist check) is therefore answered: **FAIL**.

**Investigation (read-only).**
- The mechanism was reproduced offline in both `c0adf0b` and CP1, using disposable data. The CP1 code did not introduce it.
- An unreadable or damaged playlist list was read as an empty list and deleted. Start-up cleanup then deleted every catalogue file of the "unknown" playlists, and a later add overwrote the list.
- The most likely window is a production (`c0adf0b`) start between 23:07 and 09:06 UTC, with medium-to-high confidence. The TV trigger is not identified.
- The full findings are in the session reports and in `docs/DI-1-REPORT.md` §1–2.

**DI-1 repair: implemented, automated verification complete.**
- An unreadable list is never treated as empty:
  - damaged values are quarantined and never deleted;
  - list writes are refused while the list is protected;
  - cleanup runs only after a verified read, and deletes only the files of playlists you removed;
  - each entry is validated on its own;
  - a verified backup is kept in the file store;
  - a persistent, privacy-filtered diagnostics log records storage events;
  - Home shows a recovery dialog instead of "No account".
- **CP1 working tree with DI-1:**
  - unit tests 396 / 396 (374 + 22 DI-1 tests);
  - build tests 6 / 6;
  - typecheck OK;
  - compat 128 files, 0 findings;
  - release build and `release-check` OK;
  - APK built (local only).
- **Production baseline `c0adf0b` with DI-1 (scratch copy):** 383 / 383 tests, release build OK.
- Details: `docs/DI-1-REPORT.md`.

**Status.**
- **CP1 acceptance: BLOCKED** until DI-1 is approved and verified on the TV.
- **Physical regression: PENDING.** The CP1 regression in §4 was run on the CP1 build **without** DI-1. DI-1 has not been installed or tested on the TV.
- **The original playlist can't be recovered.** Its catalogue files were already deleted before CP1 was installed, and there was no backup at the time.
- Nothing has been committed, pushed or released.

**Update (2026-11-26): DI-1.1 physical gate closed (PASS).**
- On the UE50MU6100, Diagnostics showed:
  - Storage Healthy;
  - list 1;
  - backup Valid with 1 playlist;
  - integrity Passed;
  - last backup 12:17.
- Details: `docs/DI-1-REPORT.md` §19.
- Production was restored at 13:48:13.
- The A–E regression on the DI-1 build is still pending (stage S5).
- **CP1 acceptance stays blocked** until that regression and your approval.

## 9. Formal acceptance status (2026-11-26)

**Recommendation: CP1 — PASS** (subject to your formal approval). It must ship **together with DI-1**, never without it.

| Requirement | Evidence | Status |
|---|---|---|
| Implementation (key maps, engine capabilities, memory policy, IndexedDB FileStore, build-time platform, session-only logins, isolation rule) | §1; 13 CP1 tests; full suite 438 / 438 | PASS |
| Samsung physical regression (CP1 build) | §4: your "all ok"; the logged session | PASS |
| Samsung regression on the combined build (CP1 + DI-1 + S1–S3) | S5 B1–B6 | PASS |
| Data-integrity incident (§8) | Not caused by CP1; repaired by DI-1 (DI-1 accepted, see `DI-1-REPORT.md` §20) | Resolved by DI-1 |
| Build, ES5 and isolation | typecheck OK; compat 134 files, 0 findings; build tests 6 / 6; `release-check` OK | PASS |
| App identity | `config.xml` byte-identical to production; app ID `SShelfDev1.ScreenShelf` | PASS |

**Playlist survival.** After the final production restore (2026-11-26 14:47:22), you confirmed the playlist is still visible and active. That is the remaining playlist `pmwxc6brb01`. The original `pmwuiieey01` was lost in the incident **before** CP1 was installed, and it cannot be recovered.

**Open (not blocking CP1):**
- §5 items 2–8: M3U URL re-entry in session-only mode; Android memory floors not validated on a device; the Android bundle still contains AVPlay; multi-decoder deferred; LG CH± not verified; Titan blocked.
- No physical test on Android, LG or Titan (by design: CP2/CP3).

The release plan is in `DI-1-RELEASE-PLAN.md`. Nothing has been committed or released.
