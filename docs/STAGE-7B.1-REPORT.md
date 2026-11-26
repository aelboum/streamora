# Stage 7B.1: Implement the approved UX redesign (report)

Date: 24 Nov 2026. Design source: Claude Design project "EliteStream Phase 1 directions"
(b0825867-219c-49db-a9dc-18763fb859be), read at these etags: Handover 1795532737828573,
Home v2 1795532737828573, Logo 1795532277692008, P1-A 1795533348672561, P1-B 1795532947863018,
P2 1795532984381152, P3 1795533348672561, StateHome 1795533383489723, Design System
1795532398050185. The design project was not modified in this stage.

Evidence labels: [W] automated tests on Windows · [D] desktop browser · [TV-S] Samsung TV with
simulated remote input · [V] visual inspection of the TV screen · [P] physical remote.

## A. Implementation summary

| Design | Implemented as |
|---|---|
| Design system tokens, type, focus ring, buttons, rows, dialogs, keyboard | `styles/tokens.ts`, `base.css`, `shell.css`, `playlists.css` (all existing class names kept) |
| Signal Play mark + ELITE STREAM lockup, icons | `components/brand.ts` (SVG data URIs, exact mark geometry from the design) |
| 01 Home hub (Home v2a) | `screens/home-screen.ts`, new root screen; tiles Live TV / Movies / Series / Settings / Add account, bottom bar, clock, provider chip |
| Left rail on section screens | `components/rail.ts` + `screens/sections.ts` (Live TV, Movies, Series) |
| 02 Live TV, 03 channel banner | `live-tv-screen.ts` (rail, 8 × 100 rows, 12 category rows, CH pages 8, selected tint, Favourites start), `live.css` |
| 06 / 23–25 Movies & Series grid, large catalogue | `vod-browse-screen.ts` (5 × 220 cards, 2 rows + peek, Find a category row + Yellow, 10-row column, counter, CH pages 10, three card states, update chip, failure toast), `find-category-sheet.ts`, `virtual-list.ts` (`visible` option), `vod.css` |
| 07 / 09 / 10 details, seasons, episodes | `vod.css` restyle (no behaviour change) |
| 11/12 VOD player bar, player status | `vod.css`, `live.css` restyle (title, progress, state only) |

## B. Files (Stage 7B.1 only; Stage 6.1 changes are still uncommitted in the same tree)

New: `src/components/brand.ts`, `src/components/rail.ts`, `src/screens/home-screen.ts`,
`src/screens/sections.ts`, `src/screens/find-category-sheet.ts`, `docs/STAGE-7B.1-REPORT.md`,
`docs/evidence/stage7b.1-tv.jsonl`.
Modified: `src/app/bootstrap.ts` (register Home, root = home), `src/components/virtual-list.ts`,
`src/screens/live-tv-screen.ts`, `src/screens/vod-browse-screen.ts`, `src/screens/vod-screens.ts`
(register `vod-find`), `src/i18n/strings.ts` (EN + NL), `src/styles/*.css`, `src/styles/tokens.ts`,
`src/dev/device-selftest-stage6.ts` (key counts for the 5-column grid), `tests/unit/bootstrap.test.mjs`,
`tests/unit/live-ui.test.mjs`, `tests/unit/vod-ui.test.mjs` (+5 tests). Deleted: none.

## C. Design fidelity: differences

1. Fonts (follow-up, approved): Barlow 400–700 and Barlow Condensed 500–700 (latin + latin-ext,
   SIL OFL 1.1) and a Material Symbols Rounded subset with only the 14 glyphs the app uses
   (Apache 2.0) are bundled in `src/fonts` (≈ 265 KB, copied to `dist/<mode>/fonts` by the build;
   `styles/fonts.css`). Icons are Material Symbols glyphs as in the design. Other scripts (Arabic
   titles etc.) fall back to the TV's system font per glyph.
2. Home tiles: Movies and Series show a three-poster collage taken from the first stored title page
   (read once per account, 800 ms after Home appears; no network, no full load). Live TV keeps the
   gradient; the favourite-channel logo strip is not shown (it would need the 22k-channel list).
   Counts show only when already known.
3. Home bottom bar: Search is shown disabled (no global search exists). Favourites opens Live TV on
   its Favourites category; TV opens Live TV. Settings opens the existing account/playlist screen.
   Add account opens a choice dialog (Xtream / M3U) built from the existing confirm dialog.
4. Rail: Search item disabled; Favourites opens Live TV Favourites.
5. Live TV: no preview video (proposed, AVPlay unverified); the channel logo fills the preview slot.
   Header shows title + account name + guide status (no clock).
6. Movies/Series: the existing "Update list" row stays (manual update is existing behaviour; the
   design shows only the background chip). The grid keeps 3 DOM rows (2 visible + peek).
7. Find a category (follow-up): the sheet is part of the Movies/Series screen, so it stays visible
   while the filter is typed in the keyboard on top; matches update when the keyboard closes.
11. Details (follow-up, design 07/09): backdrop (provider backdrop, else the poster at 35 %, no
   blur on Tier B), scrims, overline "MOVIE · GENRE", 88px title (72 for series), primary Play.
12. VOD player (follow-up, design 12): top band with title and clock, progress with elapsed and
   remaining time, one play/pause control (OK already toggles pause) and the state text. No seek,
   audio, subtitle or episode buttons (functions don't exist).
8. Not implemented because the function doesn't exist (scope rule): resume/progress/Continue
   watching, seek/scrubber, audio/subtitle sheets, next-episode prompt, EPG grid, Settings screen,
   global search, sorting, VOD favourites, theme picker. Their buttons are not shown.
9. Parental PIN dialog (19): not built. The PIN service exists (6–8 digits, lockout, recovery code),
   but no screen asks for a PIN and no category is locked today, so there was no UI behaviour to
   restyle; adding it would be new functionality.
10. Tier B (2017 TV): focus = 4px ring without glow; scale 1.04 on cards, tiles and buttons only.

## D. Functionality preservation

- Live TV: categories, search, favourites, recently watched, Now/Next, Watch / Favourite / Update
  guide, AVPlay playback, zapping: unchanged logic [W]; playback after VOD [TV-S].
- Movies / Series: paged library, incremental search, details, seasons/episodes, playback: unchanged
  logic [W]; movie and episode played 8 s without failure [TV-S].
- Back: grid → categories → leave; rail → categories; section root → Home; Home → exit confirm [W].
- Parental PIN service: untouched.
- AVPlay lifecycle and the shared engine: untouched (no player reloads added).

## E. Large-catalogue safety

Storage format, paging, the 8-page LRU and the update commit rule are untouched. The screen still
reads only the index on open and pages for the visible rows ± one screen. Find a category filters the
category names already in memory. Card size never changes (220×330 in all three states). Data never
moves focus (category tint and counter are rebinds only). A failed update keeps the stored list
[W test]. DOM: 3 grid rows × 5 cards, 10 category rows, 8 channel rows, 9 sheet rows.

## F. Tests [W]

`npm run check` → exit 0: typecheck clean · compat 96 files, 0 findings · unit 248/248 · build 5/5.
`npm run build:release && npm run check:release` → OK (release app.js 231,352 B).
New tests: Home hub navigation and disabled sections; rail; Find a category + counter + CH paging;
card states + failed update toast.

## G. Performance (single [TV-S] run, compared with Stage 6.1 runs 2–4)

| | Stage 6.1 | 7B.1 |
|---|---|---|
| Movies screen ready / first titles | 99–192 ms / 224–742 ms | 131 ms / 229 ms |
| Series screen ready / first titles | — / 190–210 ms | 82 ms / 192 ms |
| Browse max stall, movies | 105–138 ms (461 run 1) | **322 ms** |
| Browse max stall, series | 135–164 ms | **200 ms** |
| Search movies / series | 281–337 / 835–1027 ms | 281 / 886 ms |
| Placeholders after 60-row scroll | 0 | 0 |

The higher browse stalls are a possible regression (focus ring/scale, larger cards), from one run
with low free memory (122–165 MB, like Stage 6.1 run 1). Not verified; re-measure. The movie update
time in this run (575 s) is not comparable: the app was in the background for 476 s during it.

## H. TV validation

- [TV-S] Stage 6 self-test with the real provider on the UE50MU6100: movies PASS, series PASS, Live
  TV after VOD PASS. Viewport reported 1920×1080. Library: 108,565 movies / 143 categories,
  25,490 series / 97 categories.
- The first launch went silent after start-up (as once in Stage 6.1, cause unknown); a relaunch ran.
  During the relaunch the log also shows Live TV opened and a channel played while the self-test
  was updating; the source of those actions isn't known.
- Follow-up run (fonts, details, player, Find panel, tile art) [TV-S]: movies PASS (screen ready
  26 ms, browse max stall 90 ms, search 303 ms, movie played 8 s). The app then went silent before
  the series step (third silent run overall, cause unknown); series and Live TV were not re-run on
  this build.
- [V] not performed: nobody looked at the TV screen. [P] not performed.
- Release build reinstalled afterwards; dev log sink stopped.

## I. Outstanding

Fonts not bundled · PIN dialog not built (no existing UI) · possible browse-stall regression ·
update stalls 0.5–2.7 s (Stage 6.1, unchanged) · colour keys other than Yellow unchanged · Handover
§16 items not verified on the TV except the viewport · proposed features listed in C.8.

## J. Repository state

No commit, no push, no merge, no tag, no release, no deployment. The Claude Design project was not
modified.
