# S1 — About screen: report

Date: 2026-11-26. Scope: stage S1 of `docs/SETTINGS-IMPROVEMENTS-AUDIT.md` only (Feature 1). S2–S5 were not started. Nothing was installed, committed or pushed.

**Gate before S1:** the DI-1.1 physical evidence is recorded: backup Valid, 1 playlist, integrity Passed; see `docs/DI-1-REPORT.md` §19. Production was restored on the TV at 13:48:13.

## 1. What changed for the user

**Before:** Settings → About had four information rows (version, platform, screen, storage) that the remote could not focus (▲▼ skipped them), followed by Diagnostics.

**Now:**
- Settings → About shows **one focusable row, "About ScreenShelf"**, with the version as its value (`0.2.0`).
- **OK** opens a read-only **About screen** showing:
  - Version;
  - Platform;
  - Screen;
  - Storage;
  - **Fonts:** Barlow, Barlow Condensed (SIL Open Font License 1.1) · Material Symbols (Apache License 2.0). The licences were checked against the shipped `OFL-Barlow.txt` and `LICENSE-MaterialSymbols.txt`.
  - It also shows the hint "Press Back to return to Settings."
- The About screen has nothing to focus. Every key except Back is ignored. **Back** returns to Settings with focus on the About row.
- **Diagnostics** stays directly below About, unchanged.
- English and Dutch: "About ScreenShelf" / "Over ScreenShelf", "Fonts" / "Lettertypen", and so on.

## 2. Files changed

| File | Change |
|---|---|
| `src/screens/about-screen.ts` | **New:** read-only About screen (header, one key/value panel, hint) |
| `src/screens/settings-screen.ts` | The About group is now one row (`id: 'about'`) that pushes `about` when that route is registered |
| `src/app/bootstrap.ts` | `aboutLines()` shared by Settings and About; registers the `about` route (About lines plus the font line) |
| `src/i18n/strings.ts` | 4 keys each in English and Dutch: `set.aboutRow`, `about.fonts`, `about.fontsValue`, `about.back` |
| `src/styles/shell.css` | `.ss-about__hint` |
| `tests/unit/vod-ui.test.mjs` | Intended expectation change (planned in the audit): the About row is focusable, opens About, and Back restores focus. It used to assert that the About rows were skipped |
| `tests/unit/s1-about.test.mjs` | **New:** 4 tests through the real start-up and router |

**Not touched:**
- storage, playlists, DI-1 and diagnostics logic;
- `config.xml`, signing and the design source;
- all other screens.

## 3. Automated checks

| Check | Result |
|---|---|
| Typecheck | OK |
| Compat (ES5 and platform isolation) | 129 files, 0 findings |
| Unit tests | **409 / 409** (405 + 4 new) |
| Build tests | 6 / 6 |
| Samsung release build | OK |
| `release-check` | OK |
| Android build | OK (local only) |

**New tests:**
- one row instead of the information rows, with the version as its value, and Diagnostics right after it;
- OK opens About with all five rows; arrows and OK do nothing there; Back returns with focus on the row;
- **no localStorage writes**;
- Dutch labels, and `missingTranslations()` is empty;
- About is one panel with 5 rows.

**Layout check in a real browser** at 1920 × 1080, using the release build and remote key events from Home → Settings → About:
- the panel ends at 469 px and the hint at 520 px, both inside the 1080 px frame;
- each label is on the same line as its value;
- a single Back returns to Settings with focus on the "about" row.

Screenshot: `C:\Users\imran\AppData\Local\Temp\claude\2ee6d83e0f610cd7\a2b60d19-f285-4b84-aa78-3e897ba76ead\scratchpad\s1-about-layout.png`. The browser shows "browser n/a" and its own window size; the TV will show `tizen 3.0` and `1920 × 1080`.

## 4. Build (CP1 + DI-1 + DI-1.1 + S1), SHA-256

- `app.js` (377,414 B): `95149e86ed1649ea79dcf39985e71417c467d4dd6b6a715af712dfbe5aab3191`
- `app.css`: `382e0155f7b0e9830db5b8234b35f03d3d10c959b630ee71b708e3391cc0a3e0`
- `config.xml`: `08b9151c8ed374be5e7a1a816bb4ea6ffac0c9c57129c9cd9b57dbac77b9239c` (identical to production; app ID and signing profile unchanged)
- `icon.png`: `35fb3813…`
- `index.html`: `629cf34f…`

**Not installed.** The physical check of S1 belongs to S5.

## 5. Next

Waiting for your review of S1 before S2 (expiry metadata and Settings display), as agreed.
