# DI-1 production release: readiness, installation plan and rollback

Date: 2026-11-26. **Preparation only.** Nothing has been committed, pushed, tagged, published or installed for this release. Every step marked ⛔ needs your explicit authorisation.

## 1. What would be released

**The release candidate** is the current working tree on `main`: CP1 + DI-1 + DI-1.1 (diagnostics view, with the layout fix) + S1 (About) + S2 (expiry) + S3 (last channel). S4 was skipped.

**Version 0.2.0: candidate = verified build.** With the version unchanged, the release build is **byte-identical to the build physically verified in S5**, re-checked today (5 / 5 files):

| File | SHA-256 |
|---|---|
| `app.js` (387,389 B) | `91802e8cf03b101d44a86e4a47c85735e1b5e22fb7eb9d70701194afcd1401e8` |
| `app.css` | `382e0155f7b0e9830db5b8234b35f03d3d10c959b630ee71b708e3391cc0a3e0` |
| `config.xml` | `08b9151c8ed374be5e7a1a816bb4ea6ffac0c9c57129c9cd9b57dbac77b9239c` |
| `icon.png` | `35fb3813bd5bf24a52dbdd1310a79e80cb9e4009750a4735b69ff3bd97fc6db0` |
| `index.html` | `629cf34f…` |

**Identity:**
- `tizen:application id="SShelfDev1.ScreenShelf" package="SShelfDev1"`, signing profile `probe-tizen`;
- `config.xml` privileges and CSP are byte-identical to production `c0adf0b`;
- Android: `com.elitestream.app`, `versionName 0.2.0`, `versionCode 1` (debug APK only, not part of this TV release).

**Why ship the combined build rather than a DI-1-only build on `c0adf0b`:**
- The combined build is the one that passed the physical verification (DI-1.1 gate and S5).
- A DI-1-only patch for `c0adf0b` exists in the session scratchpad (`DI-1-on-c0adf0b-src.patch`, `-tests.patch`). It passes 383/383 automated tests and builds, but it has **never been tested on the TV**.
- Its DI-1 core is identical to the candidate's: `kv-store`, `diag-log`, `catalogue-store` and `common.ts` are byte-identical, and `playlist-service` differs only by additive CP1, DI-1.1 and S2 code (one changed line, 84 added).
- Shipping it would need its own physical verification.

## 2. Proposed version: **0.3.0**, your decision

**Why 0.3.0:**
- 0.2.0 is the version of the vulnerable production build now on the TV. Shipping the fix as 0.2.0 would make the safe and unsafe builds indistinguishable: About shows "0.2.0" for both, and so do support logs and the Tizen app list.
- This release adds user-facing features (About, expiry, last channel), platform work (CP1) and a data-integrity repair, with **no breaking change to stored data**. All new storage is additive: backup file, quarantine keys, `account.<id>`, start-up keys.
- Before 1.0, that is a **minor** bump in SemVer terms: 0.2.0 → 0.3.0. It is not a patch (0.2.1), because of the new features.

**Cost of the bump:**
- `package.json` (from which the build writes `config.xml` `version` and the About value) changes. So do `config.xml` and `app.js`, which embeds the version string.
- The candidate is then **no longer byte-identical** to the S5-verified build. Mitigation, before installing:
  1. rebuild;
  2. diff the 0.3.0 build against the S5 build, where **only the version string** may differ;
  3. post-install physical checks (§4).
- For Android, `versionName 0.3.0`, and `versionCode` must rise to **2** for upgrade installs. That only matters when an Android release happens.

**Alternative:** keep 0.2.0 and ship the exact S5-verified bytes. The cost is that the fixed and vulnerable builds can't be told apart.

## 3. Pre-installation checks (all must pass, or stop)

1. Stage 0 backups: `sha256sum -c *.archives.sha256` in `Documents/screenshelf-backups`, **6 / 6 OK**.
2. The saved production build `scratchpad/cp1-baseline/release` (rollback target): **5 / 5 OK** against `release.sha256`. Before release, **copy it to a durable location** (for example `screenshelf-backups/production-0.2.0-c0adf0b/` with its checksum file), because the session scratchpad is not durable. ⛔ needs your OK, since it writes outside the repo.
3. The release build in `dist/release`: 5 / 5 OK against its recorded checksums. For 0.3.0, the version-only diff from §2.
4. `npm run check` (typecheck, compat, 438 unit, 6 build), `check:release` OK, `config.xml` identity unchanged.
5. The TV is reachable (`sdb devices` shows UE50MU6100). Record the installed version and install date (`vd_applist`).
6. The release commit and tag exist (⛔ separate authorisation) and the build is made from that commit.

## 4. Installation (⛔ needs your authorisation)

1. `npm run tv:install -- release`: an **upgrade** with the same app ID and signing profile. **Never** `tv:uninstall`, never clear app data, never factory-reset.
2. `npm run tv:run -- release`. Record the install time from `vd_applist`.
3. **Physical verification** (you, with the remote; a release build doesn't log):

| # | Check | Expected |
|---|---|---|
| P1 | Home | No "Your playlists are protected" dialog; the playlist name is on the chip |
| P2 | Settings → Accounts and playlists | Playlist `pmwxc6brb01` listed and marked active |
| P3 | Settings → Diagnostics → Refresh | Storage **Healthy** · list **1** · backup **Valid** · backup **1** · integrity **Passed** · last backup with a time |
| P4 | Recent storage events (▼) | **Write down** the top lines (closes the A3 gap) |
| P5 | About | The version shown is the released version |
| P6 | Live TV, Movies and Series | Open without a full reload; a channel and a title play |
| P7 | Settings → Subscription | Expiry shown; no unexpected Account status line |
| P8 | Restart the app | P1–P3 still hold |

**Stop conditions.** On any of the following, **stop and press nothing further**. Note what the screen shows; no recovery and no restore without your decision:
- a protected dialog, or Storage state not Healthy;
- the playlist missing or not active;
- Backup Missing, Invalid or Unreadable, or integrity FAILED;
- the list count not 1;
- any unexpected change (titles missing, settings reset);
- the app not starting, or a crash loop.

## 5. Rollback (non-destructive)

**When:** a functional regression without a data problem.
1. Verify the production build copy (5 / 5 checksums).
2. Put it in `dist/release` and run `npm run tv:install -- release` as an **upgrade**, without uninstalling, then `tv:run`.
3. Verify the install time, and that the playlist is listed (you).
4. Re-verify the backups (6 / 6).

The app data stays. The DI-1 files (backup, diagnostics log, `account.<id>`, start-up keys) are ignored by 0.2.0 and do no harm.

**Caveat:** rolling back reinstates the original data-loss mechanism. Roll back only for a serious regression, and re-release the fix as soon as possible.

**When there is a data problem** (a stop condition): **don't roll back automatically.** The DI-1 build is the one that protects and preserves the data (quarantine, backup, no deletion). Installing 0.2.0 over a damaged state would let its destructive start-up cleanup run. Keep DI-1 installed and decide together.

## 6. Release notes (draft)

**ScreenShelf 0.3.0** (proposed)

**Data safety:**
- **Fixes:** a playlist could disappear, together with its downloaded channels and films, when the TV's stored playlist list couldn't be read at start-up.
- **Protected mode:**
  - ScreenShelf now never treats an unreadable list as empty;
  - it keeps damaged data in quarantine instead of deleting it;
  - it keeps a verified backup of the playlist list;
  - it shows a "Your playlists are protected" screen with safe choices (Try again, Restore backup, Continue without) instead of an empty start.
- **Cleanup:** start-up cleanup only removes files of playlists you deleted yourself.
- **Diagnostics:** Settings → Diagnostics shows the playlist storage state, the backup and its integrity check, and recent storage events. These are read-only and contain no passwords or addresses.

**New:**
- **About:** Settings → About ScreenShelf: version, platform, screen, storage and font licences.
- **Subscription:** Settings → Subscription shows when an Xtream subscription ends (date and days left, Expired, No expiration, or Unknown). M3U playlists show "Not available". If the TV clock is far off, the server clock is used.
- **Last channel:** Settings → Playback → "Play last channel on app startup" is off by default. When on, ScreenShelf resumes the last channel you watched, in its category, after a short message you can cancel with any key. It never auto-plays a locked adult channel.

**Under the hood:** platform groundwork for Android, LG webOS and Titan OS (CP1). No change on Samsung.

## 7. Commit plan (⛔ needs your authorisation)

**Branch:** you're on `main`. The proposal is a new branch, `release/di1-cp1` (name your choice), not a direct commit to `main`.

**Content:** 65 working-tree entries, 37 modified and 28 new.
- **Source and tests:** all files listed in `docs/CP1-REPORT.md` §2, `docs/DI-1-REPORT.md` §3 and §18, and the S1–S3 reports.
- **`.gitignore`:** `/build/`, so that `tests/build/build.test.mjs` is tracked.
- **Docs:**
  - CP1: `CP1-REPORT`, `CP-R0-READINESS-REPORT`, `CP-TITAN-INQUIRY-DRAFT`;
  - Stage 14: `STAGE-14-CROSS-PLATFORM-AUDIT`, `-ROADMAP`;
  - DI-1: `DI-1-REPORT`, this plan;
  - Settings: `SETTINGS-IMPROVEMENTS-AUDIT`, `S1`, `S2`, `S3` and `S5` reports.

**Suggested split:** one commit for "CP1 + DI-1 + S1–S3 source and tests", one for "docs". The source changes can't be split cleanly by stage, because `bootstrap.ts`, `strings.ts` and `playlist-service.ts` carry several stages each.

**Not committed:** `dist/`, `logs/`, the scratchpad files and the backups. These are already ignored or outside the repo.

**Before committing:**
- a secret scan;
- the reports mention LAN addresses only (TV `192.168.1.19`, PC `192.168.1.180`) and no credentials;
- commits are unsigned only if you say so again (last time: "commit without signing").

## 8. Prepared release candidate 0.3.0 (2026-11-26)

**Approved by you:**
- CP1, DI-1 and S5 acceptance;
- the release as **0.3.0**;
- branch `release/0.3.0-cp1-di1`;
- two unsigned local commits.

A3 and E5 stay **INCONCLUSIVE**. No push, tag, publication or TV installation has been done.

**Version update.** Only these three files change:

| File | Change |
|---|---|
| `package.json` | `"version": "0.2.0"` → `"0.3.0"`. The build writes this into `config.xml` and into the app (About and diagnostics) |
| `package-lock.json` | Both `"version"` fields: 0.2.0 → 0.3.0 |
| `android/app/build.gradle` | `versionCode 1` → `2`; `versionName '0.2.0'` → `'0.3.0'` |

**Not changed:**
- the app identity: `SShelfDev1.ScreenShelf`, package `SShelfDev1`, signing profile `probe-tizen`, Android `applicationId`;
- privileges and CSP;
- the tests, which pass their own fixed version strings.

**Release candidate 0.3.0, SHA-256** (`dist/release`):

| File | SHA-256 | Compared with the S5-verified build |
|---|---|---|
| `app.js` (387,389 B) | `a9c9c6cc81c3521494a7acb526a8b03903072d7889c03715de292d092bd43aa4` | **1 byte** differs: `version:"0.2.0"` → `"0.3.0"` |
| `app.css` | `382e0155f7b0e9830db5b8234b35f03d3d10c959b630ee71b708e3391cc0a3e0` | identical |
| `config.xml` | `71292500edad676bcd2a2f5d0b989cf6a53ccbfa98d809ec9d89d385b44e5271` | **1 byte** differs: `version="0.2.0"` → `"0.3.0"` |
| `icon.png` | `35fb3813bd5bf24a52dbdd1310a79e80cb9e4009750a4735b69ff3bd97fc6db0` | identical |
| `index.html` | `629cf34f6dd26b2d8cd1123f73b78aeb25381a362daf41b48cb41ba717772fc0` | identical |

Replacing `0.3.0` with `0.2.0` in `app.js` and `config.xml` gives byte-identical copies of the S5-verified build. So the candidate is the verified build, with the version string changed.

**Android:** `EliteStream-0.3.0-debug.apk` (5,162,844 B). The manifest has `versionCode 2` and `versionName 0.3.0`. It is a debug build, not part of the TV release.

**Final checks (0.3.0):**
- typecheck OK;
- compat 134 files, 0 findings (ES5 and platform isolation);
- unit tests **438 / 438**;
- build tests **6 / 6**;
- Samsung release build OK;
- `release-check` OK;
- Android build OK;
- secret scan clean (69 files; no keys, `.env` or keystore files; the only `password=` values are known test fixtures already in `c0adf0b`).

**Permanent rollback copy:** `Documents/screenshelf-backups/production-0.2.0-c0adf0b/`
- `release/` (5 files and 17 fonts);
- `release.sha256`: **5 / 5 OK** after copying;
- `fonts.sha256`: 17 / 17. The fonts are byte-identical to `src/fonts` at `c0adf0b`;
- `README.txt`.

The scratchpad original was kept (still 5 / 5).

## 9. Production installation of 0.3.0 (2026-11-26) — PASS

**Released:** commits `4b9c677` (source and tests) and `0ad03e0` (docs), on `main` and `release/0.3.0-cp1-di1`, tag `v0.3.0`; all pushed to GitHub. No GitHub release has been published.

**Pre-install checks (§3), all passed:**
- Stage 0 backups 6 / 6;
- rollback copy `screenshelf-backups/production-0.2.0-c0adf0b` 5 / 5 (fonts 17 / 17);
- a fresh build from the tagged commit (clean tree) byte-identical to the recorded 0.3.0 candidate (5 / 5);
- `release-check` OK;
- the same app ID;
- the TV reachable, with production 0.2.0 installed (14:47:22).

**Install (§4):** upgrade with `tizen install`; no uninstall and no data clearing. The TV reports **`SShelfDev1.ScreenShelf` version 0.3.0, installed 2026-11-26 15:14:26** local, and the app launched.

**Physical checks P1–P8:** carried out by you on the TV; you reported "all checks pass on the TV".

| # | Check | Result |
|---|---|---|
| P1 | Home: no protected dialog; the playlist on the chip | PASS |
| P2 | The playlist (`pmwxc6brb01`) listed and active | PASS |
| P3 | Diagnostics: Healthy · 1 · Valid · 1 · Passed · last backup time | PASS (values not transcribed) |
| P4 | Recent storage events | PASS as a check; the event lines themselves were **not transcribed**, so S5 **A3 stays INCONCLUSIVE** |
| P5 | About shows 0.3.0 | PASS |
| P6 | Live TV, Movies and Series open; playback works | PASS |
| P7 | The Subscription line shows the expiry | PASS |
| P8 | After a restart, P1–P3 hold | PASS |

No stop condition occurred and no rollback was needed.

**Production status:** the TV now runs **0.3.0 with the DI-1 data-integrity protection**. The original data-loss mechanism of 0.2.0 is no longer installed. The 0.2.0 rollback copy is kept in `screenshelf-backups`.

**Still INCONCLUSIVE:** A3 (storage-event lines) and E5 (parental control on the TV). They stay that way without actual evidence.
