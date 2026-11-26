# Release 0.3.4 — Show / Hide password, Samsung production installation

Date: 2026-11-26. Previous release: `RELEASE-0.3.3.md`.

## 1. Contents

**Show / Hide password with the Samsung system keyboard** (`text-entry-overlay.ts`).
- In password fields the dialog now has **Done · Show · On-screen keyboard · Cancel**.
- **Show** switches the field from dots to readable text, and the button becomes **Hide** (Dutch: Tonen / Verbergen).
- The password is hidden by default, and hidden again automatically when the dialog closes. Nothing is stored or logged; the field is still cleared on close.
- Text and URL fields are unchanged.
- The app's own on-screen keyboard already had a Show / Hide key (also used on Android).
- `button-list.ts` gains `setLabel` to change a button's label.
- The keyboard-strategy test covers Show, Hide and hiding again on close.

**Version:**
- app **0.3.4**;
- Android **0.3.4-beta.1**, versionCode **304**.

## 2. Pre-install

**Checks:** 443/443 unit tests, 6/6 build tests, typecheck, compatibility check (no findings), release check and `npm run build:all` (Samsung and Android) all OK.

**Build:** `config.xml` version 0.3.4; `app.js` SHA-256 `330636e79e544438…`.

**Rollback copy:** `screenshelf-backups/production-0.3.3-bc516e5`.
- It is the 0.3.3 build rebuilt from tag `v0.3.3`. Its `app.js` SHA-256 `968f028bca94a325…` is identical to the 0.3.3 installed at 21:13:10.
- Checksums verified 5/5. The worktree was removed (junction first), and `node_modules` was intact.
- **Restore:** copy `release/` to `dist/release`, then run `npm run tv:install -- release` (an upgrade; never uninstall, never clear data).

## 3. Installation

- `npm run tv:install -- release`: an upgrade, "Tizen application is successfully installed"; **no uninstall and no data clearing**.
- The TV reports **app_title EliteStream, app_version 0.3.4, installed 2026-11-26 21:30:08** (`vd_applist`).

## 4. Physical checks (by the user on the TV): all reported OK

| # | Check | Result |
|---|---|---|
| P1 | Password field with the Samsung keyboard: **Show** makes the typed characters readable; the button becomes **Hide** | PASS |
| P2 | **Hide** shows dots again | PASS |
| P3 | Leaving with Cancel saves nothing | PASS |
| P4 | The playlist is still present; live TV plays; About shows 0.3.4 | PASS |

**Production status:** the Samsung TV runs **EliteStream 0.3.4**. The 0.3.3 rollback copy is kept in `screenshelf-backups`.

**Android:** the 0.3.4-beta.1 debug APK builds. It has not been installed on the Philips (Android testing is deferred).
