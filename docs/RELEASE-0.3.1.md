# Release 0.3.1 — Samsung production installation

Date: 2026-11-26. Previous release and procedure: `DI-1-RELEASE-PLAN.md` (0.3.0, §9).

## 1. Contents

0.3.1 is 0.3.0 plus the CP2 work, all on `main` and pushed:

| Commit | Change | Effect on Samsung |
|---|---|---|
| `9f87502` | **F11:** Android bridge `undefined` normalised to `null`. **F12:** the playlist form shows an error instead of hanging on "Saving…" | **F12 only.** An unexpected save failure now shows "The playlist couldn't be saved on this TV.". F11 is Android-only |
| `598419a` | Version 0.3.1 (Android 0.3.1-beta.1 / versionCode 301); Android release signing outside the repository | Version shown in About and `config.xml` |
| `efe0306` | **F5:** Android remote-key parity. **F3:** Android buffer setting | None (Android-only) |
| `38dc96a`, `bf82cc5` | CP2 documentation | None |

**Product name decision** (2026-11-26): both apps will be named **EliteStream**. The in-app "SCREENSHELF" headers are not renamed in this release, so the app still shows both names (CP2 observation O1). The Samsung technical ID stays `SShelfDev1.ScreenShelf`.

## 2. Pre-install

- **Tree:** clean on `main` at `efe0306`.
- **Checks:** 443/443 unit tests, 6/6 build tests, typecheck, compatibility check and `npm run build:all` all OK.
- **Build:** `npm run build:release` gave 0.3.1 (`config.xml` version 0.3.1); `release-check` OK; `app.js` SHA-256 `1b7b46086c17b292…`.
- **Rollback copy:** `screenshelf-backups/production-0.3.0-0ad03e0`.
  - It is the 0.3.0 build rebuilt from tag `v0.3.0` in a temporary worktree.
  - Its `app.js` SHA-256 `a9c9c6cc81c35214…` is identical to the 0.3.0 installed on 2026-11-26 15:14.
  - Checksums verified 5/5. The worktree was removed afterwards.
  - **Restore:** copy `release/` to `dist/release`, then run `npm run tv:install -- release` (an upgrade; never uninstall, never clear data).
- **TV:** UE50MU6100 at 192.168.1.19:26101, connected with `sdb`; production 0.3.0 installed.

## 3. Installation

- `npm run tv:install -- release`: an upgrade with `tizen install`; **no uninstall and no data clearing**.
- The TV reports **`SShelfDev1.ScreenShelf` app_version 0.3.1, installed 2026-11-26 19:40:26** (`vd_applist`).

**Attempted remote inspection (not part of the checks):**
- `sdb shell` is disabled on this retail TV (`intershell_support: disabled`).
- The app was started once in debug mode (`0 debug`, port 41634), but the inspector reset every connection and a second debug start hung. The attempt was abandoned, the port forwards were removed, and the user reopened the app normally.
- **Consequence:** Samsung post-install checks can only be done by the user on the TV.

## 4. Physical checks (by the user on the TV)

| # | Check | Result |
|---|---|---|
| P1 | The playlist is still present after the upgrade, without signing in again | **PASS** |
| P2 | Settings → About shows **0.3.1** | **PASS** |
| P3 | Live TV plays | **PASS** |
| P4 | CH+ switches channels | **PASS** |
| P5 | A film plays | **PASS** |
| P6 | Diagnostics storage values (state, list, backup, backup count, integrity, last backup) | **INCONCLUSIVE** (not transcribed) |

No stop condition occurred and no rollback was needed.

**Not checked:**
- the F12 error path (it cannot be triggered without fault injection; it is covered by the unit test);
- CH−;
- Series playback;
- the subscription line;
- last channel at start-up.

**Production status:** the Samsung TV runs **0.3.1**. The 0.3.0 rollback copy is kept in `screenshelf-backups`.

## 5. Not done

- No tag `v0.3.1` and no GitHub release (they need separate approval).
- The Android beta APK has not been built: the production signing key does not exist yet.
- Android is not installed with 0.3.1: the Philips still runs the 0.3.0 + F11/F12 debug test build. Android physical testing is deferred by decision (`CP2-PHYSICAL-TEST-RESULTS.md`).
