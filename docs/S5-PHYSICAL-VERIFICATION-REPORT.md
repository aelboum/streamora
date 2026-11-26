# S5 — Final physical verification: report

Date: 2026-11-26. Device: Samsung UE50MU6100 (Tizen 3.0, ARMv7), app ID `SShelfDev1.ScreenShelf`, signing profile `probe-tizen`. S4 (the Samsung "Autorun Last App" help text) was **skipped** at your instruction. Nothing was committed, pushed, tagged, published or released.

**Evidence basis.**
- Release builds send no logs, and the TV allows no shell access to app storage.
- The functional checks were therefore carried out and judged **by you on the TV with the physical remote**. You confirmed: "All S5 physical verification steps passed and are approved."
- Where specific values were not sent to me, this report says so instead of inventing them.
- Install, restore and checksum steps were done and verified by me.

## 1. Build under test

**The S5 test build** is CP1 + DI-1 + DI-1.1 (including the layout fix) + S1 + S2 + S3. It contains every DI-1.1 check from the earlier gate build, plus S1–S3. Your "saved DI-1.1.1 build" was taken to mean this build, so that parts C–E could be tested.

| File | SHA-256 |
|---|---|
| `app.js` (387,389 B) | `91802e8cf03b101d44a86e4a47c85735e1b5e22fb7eb9d70701194afcd1401e8` |
| `app.css` | `382e0155f7b0e9830db5b8234b35f03d3d10c959b630ee71b708e3391cc0a3e0` |
| `config.xml` | `08b9151c8ed374be5e7a1a816bb4ea6ffac0c9c57129c9cd9b57dbac77b9239c` (byte-identical to production) |
| `icon.png` | `35fb3813…` |
| `index.html` | `629cf34f…` |

The build is kept in the session scratchpad: `s5-release/`, with checksums in `s3-release.sha256`.

## 2. Pre-install safeguards — PASS

| Check | Result |
|---|---|
| Stage 0 and later backups (3 archives, 3 git bundles) | 6 / 6 OK |
| Saved production build (pre-CP1, `c0adf0b`; `cp1-baseline/release`) | 5 / 5 OK |
| Saved DI-1.1 build (`di11c-release`) | 5 / 5 OK |
| S5 test build (`dist/release`, then copied to `s5-release`) | 5 / 5 OK |
| Installed before S5 | ScreenShelf 0.2.0, production, installed 2026-11-26 13:48:13 |
| Same app ID, same signing profile, identical `config.xml` | Yes |

**Install:** upgrade with `tizen install`; no uninstall and no data clearing. Installed **2026-11-26 14:38:57** local and launched.

## 3. Results per test

| # | Test | Result | Evidence and notes |
|---|---|---|---|
| **A** | **DI-1 integrity and backup** | | |
| A1 | No protected dialog at start; the playlist is shown | **PASS** | Your report |
| A2 | Diagnostics: Healthy · list 1 · backup Valid · backup 1 · integrity Passed | **PASS** | Your report. The individual values were not sent this time; the same values were recorded earlier at the DI-1.1 gate (`docs/DI-1-REPORT.md` §19) |
| A3 | Record the recent storage events | **INCONCLUSIVE** | The event lines were not sent, so they are **not recorded** (the same limitation as at the DI-1.1 gate) |
| **B** | **Regression** | | |
| B1 | Playlist present and active | **PASS** | Your report |
| B2 | Movies and Series open without unexpected reloads | **PASS** | Your report |
| B3 | Live TV, CH±, ▲▼ navigation | **PASS** | Your report |
| B4 | VOD playback, audio-track switching, subtitles | **PASS** | Your report |
| B5 | Restart: playlist, catalogue and backup survive | **PASS** | Your report |
| B6 | Memory: no stalls, crashes or data loss | **PASS** | Your report. No memory figures were recorded (a release build doesn't log) |
| **C** | **S1 About** | | |
| C1 | The About row is reachable with the remote (0.2.0 as its value) | **PASS** | Your report |
| C2 | The About screen shows version, platform, screen, storage and font licences | **PASS** | Your report |
| C3 | Back returns focus to the About row | **PASS** | Your report |
| C4 | Diagnostics still reachable | **PASS** | Your report |
| **D** | **S2 Expiry** | | |
| D1 | The current Xtream playlist shows the correct expiry state and date | **PASS** | Your report. The displayed text and date were not sent to me, so they are not recorded here |
| D2 | Account status kept separate | **PASS** | Your report |
| D3 | No playlist update triggered to force a refresh | **PASS** | No update was requested. The display uses the stored record or the pre-S2 expiry from the last update |
| **E** | **S3 Last channel** | | |
| E1 | Off by default; normal start-up | **PASS** | Your report |
| E2 | Enabled: the last channel resumes | **PASS** | Your report |
| E3 | "Resuming …" message; a key cancels | **PASS** | Your report |
| E4 | CH+ and CH− stay within the channel's category | **PASS** | Your report |
| E5 | Parental-control protection | **INCONCLUSIVE** (physical) | This step was **optional** (it needs a PIN set up and removed again). Whether it was performed on the TV was not recorded. The behaviour is covered by automated tests: S3 tests 5 and 14 (no auto-play of an adult channel while locked, no PIN prompt). Please confirm if you performed it, and I'll change this to PASS |
| E6 | Disabling the option restores normal start-up | **PASS** | Your report |

**Totals:** 22 PASS, 2 INCONCLUSIVE (A3, E5), 0 FAIL.

## 4. Restoration — PASS, with one confirmation pending

| Step | Result |
|---|---|
| Saved production build re-verified before restore | 5 / 5 OK |
| Restored as an upgrade (no uninstall, no clearing) | Installed **2026-11-26 14:47:22** local, launched |
| Installed package built from the verified files | `dist/release` matches the production checksums 5 / 5 at install time (`app.js` 350,405 B, SHA-256 `24380bc5…`) |
| Stage 0 backups after restore | **6 / 6 OK** |
| Final installed version | ScreenShelf **0.2.0** (pre-CP1 production, `c0adf0b`), app ID `SShelfDev1.ScreenShelf` |
| The playlist present and active after the restore | **INCONCLUSIVE until you glance at the TV.** It can't be read remotely. Every earlier production restore kept the playlist |
| No unexpected changes to application data | **Limited evidence.** Upgrade installs keep app data, and no destructive action was taken. The data itself can't be read remotely |

**Data left on the TV by the test builds** (harmless to production, which ignores them):
- the file `ss-playlists.bak.json`, the playlist backup;
- the file `ss-diag.json`, the diagnostics log;
- KV `account.<id>`, the expiry record;
- the KV keys `startup.resume-last-channel` and `startup.resume-guard` (the setting was turned off again in E6).

The production build does not read any of these, and none of them is a playlist entry.

**Note:** production `c0adf0b` still contains the original data-loss mechanism that DI-1 fixes, until a DI-1 build is shipped.

## 5. Open points for your review

1. **A3:** the recent storage events were not recorded.
2. **E5:** confirm whether the parental-control check was performed physically.
3. **After the restore:** a quick glance that the playlist is still listed and active in production.
4. **CP1 acceptance and shipping DI-1:** your decision. Nothing has been committed.

Stopped after restoration, as instructed.

## 6. Final status (updated 2026-11-26, after your confirmation)

- **The playlist after the production restore — PASS** (your confirmation). The playlist is visible and active in production 0.2.0 (installed 14:47:22).
  - This is the remaining playlist `pmwxc6brb01`.
  - The original `pmwuiieey01` was lost in the earlier incident and is not part of this result.
  - §4's "INCONCLUSIVE until you glance" is closed.
- **Totals:** 22 PASS, **2 INCONCLUSIVE** (A3 storage events, E5 parental control), 0 FAIL. These two stay INCONCLUSIVE; no evidence was added for them.
- **Release candidate equals the verified build:** the current `dist/release` build is byte-identical to the S5 test build (5 / 5 SHA-256). Final automated run: 438 / 438 unit, 6 / 6 build, compat 0 findings, `release-check` OK.
- **S5: complete.** Next steps: `DI-1-RELEASE-PLAN.md` (each step needs your authorisation).
