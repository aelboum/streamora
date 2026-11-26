# Stage 14 — Category management: report

Dates: 2026-11-25 to 26. This stage is ready for your review. Nothing was committed, pushed or published.

## 1. Initial repository and backup verification

- **Branch:** `stages-6.1-to-11`; HEAD `5739de1`, the only commit.
- **Staged:** 163 files. These are Stages 6.1 to 11 plus the zap-speed change (`docs/ZAP-SPEED-REPORT.md`), staged by you for the signed commit. Nothing was unstaged at the start.
- **Difference from the reports:** only the zap-speed change, which is reported and was approved by you. Nothing else differed materially.
- **Backups:** in `C:\Users\imran\Documents\screenshelf-backups\`, `sha256sum -c` gives **OK** for both archives and both bundles (`…183600` and `…225600`).
- **Reports read:**
  - Stage 9, Stage 10 and Stage 11;
  - Stage 0 backup.
- **Stage 14 changes are unstaged.** They sit on top of the staged index, which is untouched. No reset, clean, revert or overwrite.

## 2. Category architecture audit

| Item | Finding |
|---|---|
| Live categories | Part of the live catalogue file (`LiveCatalogue.categories`), decoded together with all ~22,000 channels. `channel-index.ts` builds per-category index arrays once per load. |
| Movie / Series categories | In the small VOD index file (`vod-pages.ts`, `VodView.categories`), loaded without the title pages. |
| Identifiers | Stable. Xtream uses `category_id`. M3U uses `"g" + fnv1a32(group-title)`, so a renamed M3U group is a new category; that is a provider-side fact. |
| Order today | The provider order, filtered to categories with content (`count > 0`). |
| Special rows | Live: Search, Favourites, Recently watched, All channels. VOD: Search, Find a category, Update list, All, My List, then the Sort button. These are UI items (`CatKind`), not provider categories. |
| Player zapping | The player gets the shown category's index list. Number entry falls back to all channels. |

**Measured on the TV:**
- Live TV: **374–375 categories** (370 with channels), 21,986 channels.
- Series: 102 categories. Movies: about 149.

## 3. Account and persistence audit

- **Accounts:** playlist id `^[a-z0-9]{1,32}$`.
- **Settings storage:** `KeyValueStore` (localStorage, envelope with a version). Writes never throw; `set` returns false when the value is not stored.
- **Account removal:** `playlist-service.ts` removes the account's keys by name, in two places (remove and recovery).
- **Account switching:** each screen gets the `playlistId`, so nothing is shared between accounts.
- **Decision 1 (yours):** the manager opens **inside each screen**, where the categories are already in memory. From Settings, Live TV would first have to load the full 22,000-channel catalogue.

## 4. Category visibility

- **Hidden** means hidden from the **category column only** (decision 2, yours). A hidden category is still reached by:
  - All channels / All movies / All series;
  - Search, channel-number entry, Favourites, My List, Continue watching.
- **Find a category** lists only the shown categories, because it lists the column.
- **The provider data is never changed.** Hiding stores one id. The column is built from an index list (`arrange()`).
- **Hiding the category on screen:** when the sheet closes, the screen shows All instead.

## 5. Category ordering

- **The sheet:** "Manage categories" is a row after All (Live) or after My List (Movies, Series). It is the same side sheet as "Find a category".
- **Keys (decision 3, yours):**
  - OK = hide / show;
  - ► = pick up; then ▲▼ (CH▲▼ by 9) move it, and OK, ◄ or Back put it down;
  - Back = close.
  - Each change is **saved at once**, and the sheet shows "Saved" (or "Not saved…").
- **Special rows are fixed** (decision 4, yours): they are not listed and never move.
- **Hidden categories keep their relative place.** Showing one again puts it back where it was.
- **Provider changes:**
  - A new category is placed after the category that precedes it in the provider list.
  - Ids the provider no longer returns stay in the saved order, so a short or failed provider list never erases your choices, and they return to their place.
  - Duplicate ids are listed once; duplicate names are told apart by id.

## 6. Restore defaults

- OK on "Restore defaults" opens a confirmation (Cancel is first and focused).
- **Restore** removes this account's key for **this type only**. Favourites, My List, other types, other accounts and settings are untouched.
- When nothing needs restoring, no dialog opens. After restoring, the focus stays on the button.

## 7. Storage format and account isolation

- **Key:** `catprefs.<live|movie|series>.<playlistId>`.
- **Value:** `{"v":1,"d":{"order":[ids],"hidden":[ids]}}`. An empty `order` means provider order, and default settings remove the key.
- **Size:** ids only, at most 80 characters each and at most 3,000 per list. Above that, ids of removed categories are dropped first. No names, channels or titles are stored.
- **Invalid stored data** falls back to the defaults.
- **Storage failure** (quota): the sheet says "Not saved: the TV storage is full. The change applies until the app closes." Nothing crashes.
- **Account removal:** both removal paths delete the three `catprefs.*` keys of that account only.
- **New code:**
  - `src/content/category-prefs.ts` (store, `mergeOrder`, `arrange`, editor);
  - `src/screens/category-manager.ts` (sheet);
  - wiring in `live-tv-screen.ts`, `vod-browse-screen.ts`, `live-screens.ts`, `vod-screens.ts` and `bootstrap.ts`;
  - account removal in `playlist-service.ts`;
  - strings (EN/NL) and CSS in `vod.css`.

## 8. Memory and performance

- **150 MB guard:** the sheet does not open below 150 MB free. A message says to try later. The floor itself is unchanged.
- **Unit benchmark** (Node): ordering 400 categories over a 22,000-channel index takes well under 20 ms each; 399 moves take well under 50 ms. The channel and category arrays are the same objects before and after.
- **TV** (dev-sink, `docs/evidence/stage14/tv-stage14.jsonl`, 529 lines, no URLs or credentials):
  - Live TV ready with 375 category rows: column render **117 ms**.
  - Free memory during the test: **156–477 MB**. The sheet opened at 165, 377, 460 and 462 MB.
  - No errors, no "Not saved", no low-memory refusals.
  - One warning: `epg: download stopped, device memory low` (the existing EPG guard).
- **What the sheet holds:** the name and count arrays and the editor (ids and positions). It releases them on close. Its DOM is a fixed pool of 9 rows.

## 9. Automated tests

- **New: `tests/unit/stage14-categories.test.mjs`** (9 tests):
  - order merge with new, removed and duplicate ids;
  - arrange, hide by id, provider data unchanged;
  - editor: hide, show, repeated moves, saved place restored, back to defaults, unknown ids kept;
  - store: per account and type, restart, reset, removal, invalid data, quota failure, cap;
  - performance (22,000 channels, 400 categories);
  - Live TV UI:
    - hide and move; All count; zapping stays in the category; number entry reaches a hidden category; restart;
    - hidden shown category falls back to All; Restore with Cancel and confirm; second account; account removal;
    - 150 MB guard with retry; storage failure;
    - regression for the timer fix below.
- **Added to `tests/unit/vod-ui.test.mjs`** (1 test): Movies hide and move; All; My List with a hidden category; Sort in a visible category; Find; restart; Series has separate prefs and a series opens with its episodes. The test setup gets an opt-in `catPrefs`; no existing test was changed or weakened.
- **`npm run check`:** **361/361 unit**, **5/5 build**, ES5 compat 0 findings.
- **`npm run build:all`:** `release-check: OK`; APK rebuilt.

**Fix found by the tests (existing code):**
- **Bug:** in Live TV and Movies/Series, a category passed on the way, or left again within 150 ms, was still shown afterwards. The new Manage row, which does not change the list, made this more likely.
- **Fix:** a focus change now always cancels the pending one, in `onFocus` of both screens.

## 10. Physical TV tests

All tests were done on the UE50MU6100 with the **physical remote, by you**. The TV ran one dev test build that logs only key presses, player events and memory.

- **Your result for the 11-point checklist: "all ok".** The checklist covered:
  - Live TV: hide, move, column, playback, CH±, number entry, Blue, OK list;
  - Movies: hide, move, Sort, My List, open a movie and return;
  - Series: hide, move, open a series and play episodes, next episode;
  - restart persistence;
  - Restore defaults in one section only;
  - second account.
- **Log coverage:**
  - The log shows the sheet opened 4× in Live TV (370 categories) and 1× in a VOD section (143 categories), Restore defaults in Live TV, and 7 live playback starts.
  - It shows **only one app launch**. The restart (point 9) therefore probably resumed the app rather than starting it fresh. Persistence after a full start is verified by the automated tests (new store over the same storage).
  - Series manager use and point 11 (second account) are not visible in the log. They rest on your "all ok". If no second account was available, account isolation is **verified by automated tests only**.
- No crash, freeze or navigation problem was reported or logged.

## 11. Known limitations

- **M3U groups:** a renamed group gets a new id, so it shows as a new category in the provider's position. The old id's place is kept in case it comes back.
- **"Find a category"** and "Category n of N" count only the shown categories.
- **Adult categories** are listed in the sheet by name while locked, as in the column today. Their content still needs the PIN.
- **Passing rows:** when moving quickly over My List or Find onto "Manage categories", nothing is shown any more until the focus rests on a category. This follows from the fix in §9.

## 12. Release build restored

- `src/dev/device-selftest.ts` restored byte-identical (SHA-1 `07584df…`).
- `npm run build:all`: release `app.js` 350,405 B, with `release-check: OK`.
- `tv:install -- release` and `tv:run -- release`: "successfully installed" and "successfully launched".
- The release build has no dev sink; the release and dev builds share the app id, so installing release replaced the test build.

## 13. Git status

- **Unchanged:** HEAD `5739de1`; branch `stages-6.1-to-11`; the 163 staged files.
- **Stage 14, unstaged:** 9 modified files (412 insertions, 16 deletions) and new files:
  - `src/content/category-prefs.ts`, `src/screens/category-manager.ts`;
  - `tests/unit/stage14-categories.test.mjs`;
  - `docs/evidence/stage14/`;
  - this report.
- **Nothing was committed, pushed or published.** The prepared signed commit does not include Stage 14 until you stage it.
