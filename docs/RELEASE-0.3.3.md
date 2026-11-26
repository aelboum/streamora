# Release 0.3.3 — EliteStream logo and app icons, Samsung production installation

Date: 2026-11-26. Previous release: `RELEASE-0.3.2.md`.

## 1. Contents

**New brand artwork** from the user's logo image, stored as `assets/brand/elitestream-logo.png` (2048 × 2048, transparent background).

**Generator.** `npm run brand` (`scripts/brand-assets.mjs`, uses ffmpeg) regenerates every derived image from that one file:

| Output | Use |
|---|---|
| `src/components/brand-assets.ts` (generated) | The mark (128 × 128) and the "elitestream" wordmark (72 px high) as PNG data URIs |
| `tizen/icon.png` | Samsung app icon, 512 × 512, the mark on the app's dark background (replaces the placeholder icon) |
| `android/app/src/main/res/drawable-nodpi/ic_launcher.png` | Android app icon, 192 × 192 |
| `android/app/src/main/res/drawable-nodpi/tv_banner.png` | Android TV launcher banner, 640 × 360, mark above the wordmark |

**In the app:**
- the Home header shows the new mark next to the "elitestream" wordmark image (replacing the old SVG mark and the "ELITE / STREAM" text);
- the side rail shows the new mark.

**Android:**
- the manifest uses `@drawable/ic_launcher` and `@drawable/tv_banner`;
- the old vector drawables `ic_mark.xml` and `banner.xml` are removed.

**Size:** `app.js` grows from 387 KB to 497 KB because of the embedded images.

**Tests:** two Home tests now check for the wordmark image (alt "EliteStream") instead of the text "ELITE".

**Version:**
- app **0.3.3**;
- Android **0.3.3-beta.1**, versionCode **303**.

## 2. Pre-install

**Checks:** 443/443 unit tests, 6/6 build tests, typecheck, compatibility check (no findings), release check and `npm run build:all` all OK.

**Browser check:** the Home header was rendered at 1920 × 1080 from `dist/release` and looked correct.

**Build:**
- `config.xml` version 0.3.3, `<name>EliteStream</name>`, application ID `SShelfDev1.ScreenShelf`;
- `app.js` SHA-256 `968f028bca94a325…`;
- `icon.png` SHA-256 `8d3d3db653fd8731…`.

**Rollback copy:** `screenshelf-backups/production-0.3.2-56f0e78`.
- It is the 0.3.2 build rebuilt from commit `56f0e78`. Its `app.js` SHA-256 `4420e28a6bcee99e…` is identical to the 0.3.2 installed at 20:46:27.
- Checksums verified 5/5. The worktree was removed (junction first), and `node_modules` was intact.
- **Restore:** copy `release/` to `dist/release`, then run `npm run tv:install -- release` (an upgrade; never uninstall, never clear data).

## 3. Installation

- `npm run tv:install -- release`: an upgrade, "Tizen application is successfully installed"; **no uninstall and no data clearing**.
- The TV reports **app_title EliteStream, app_version 0.3.3, installed 2026-11-26 21:13:10** (`vd_applist`).

## 4. Physical checks (by the user on the TV): all reported OK

| # | Check | Result |
|---|---|---|
| P1 | The new app icon appears in the apps list | PASS |
| P2 | The Home header shows the new mark and the "elitestream" wordmark | PASS |
| P3 | The side rail shows the new mark | PASS |
| P4 | The playlist is still present; About shows 0.3.3 | PASS |
| P5 | Live TV plays | PASS |

**Production status:** the Samsung TV runs **EliteStream 0.3.3**. The 0.3.2 rollback copy is kept in `screenshelf-backups`.

**Android:** the 0.3.3-beta.1 debug APK builds with the new icon and banner. It has not been installed on the Philips (Android testing is deferred).
