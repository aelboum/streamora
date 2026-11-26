# Release 0.3.2 — EliteStream name, Samsung production installation

Date: 2026-11-26. Previous release: `RELEASE-0.3.1.md`.

## 1. Contents

**Product name.** Per the user's decision (2026-11-26), both apps are named **EliteStream**. All visible "ScreenShelf" texts now read EliteStream:
- screen headers (shown in capitals as ELITESTREAM);
- the About and Diagnostics titles, "About EliteStream" / "Over EliteStream", and the exit dialog "Exit EliteStream?";
- the session-only sign-in and protected-storage messages (English and Dutch);
- the start-up text and start-up error;
- the Samsung **launcher name** (`config.xml` `<name>`).

**Unchanged on purpose:**
- The Samsung **application ID** `SShelfDev1.ScreenShelf` and the widget ID. `APP_NAME` stays part of the ID, and a new `DISPLAY_NAME` sets only the launcher name, so upgrades keep the data.
- Internal code comments and test data.
- Android was already `com.elitestream.app` / "EliteStream".
- The Home logo still reads "ELITE STREAM" (two words); the headers read "ELITESTREAM".

**Version:**
- app **0.3.2**;
- Android **0.3.2-beta.1**, versionCode **302** (history: 1 = 0.2.0, 2 = 0.3.0, 301 = 0.3.1-beta.1).

## 2. Pre-install

**Checks:** 443/443 unit tests, 6/6 build tests, typecheck, compatibility check (no findings), release check and `npm run build:all` all OK.

**Build:**
- `config.xml`: version 0.3.2, `<name>EliteStream</name>`, application ID `SShelfDev1.ScreenShelf`;
- `app.js` SHA-256 `4420e28a6bcee99e…`;
- built from the working tree on `main` (base `68daef4`) with the rename and version changes, committed afterwards together with this record.

**Rollback copy:** `screenshelf-backups/production-0.3.1-68daef4`.
- It is the 0.3.1 build rebuilt from tag `v0.3.1`. Its `app.js` SHA-256 `1b7b46086c17b292…` is identical to the 0.3.1 installed at 19:40:26.
- Checksums verified 5/5. The temporary worktree was removed (junction first), and `node_modules` was intact.
- **Restore:** copy `release/` to `dist/release`, then run `npm run tv:install -- release` (an upgrade; never uninstall, never clear data).

## 3. Installation

- `npm run tv:install -- release`: an upgrade, "Tizen application is successfully installed"; **no uninstall and no data clearing**.
- The TV reports **app_title EliteStream, app_version 0.3.2, installed 2026-11-26 20:46:27** (`vd_applist`).

## 4. Physical checks (by the user on the TV): all reported OK

| # | Check | Result |
|---|---|---|
| P1 | The app is named **EliteStream** in the apps list | PASS |
| P2 | The playlist is still present, without signing in again | PASS |
| P3 | Headers show ELITESTREAM; "About EliteStream" shows 0.3.2 | PASS |
| P4 | The exit dialog reads "Exit EliteStream?" | PASS |
| P5 | Live TV plays | PASS |

The Diagnostics storage values were not part of this check.

**Production status:** the Samsung TV runs **EliteStream 0.3.2**. The 0.3.1 rollback copy is kept in `screenshelf-backups`.

**Android:** the 0.3.2-beta.1 debug APK builds. It has not been installed on the Philips (Android testing is deferred).
