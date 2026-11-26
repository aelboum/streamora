# Stage 11 — Movies & Series usability: report

Date: 2026-11-25. Scope: My List (movies and series), movie sorting, next episode.

**Evidence tags**
- **[SIM]** automated tests;
- **[TV-S]** scripted on the TV;
- **[TV-P]** physical remote, done by you, as you reported it.

Evidence: `docs/evidence/stage11/tv-stage11.jsonl` (3,729 lines over five test-build launches: measurements, key codes, memory heartbeats). It contains no URLs or credentials (checked by search). Titles appear only in aggregate (one suggested series name).

## 1. Initial repository and backup verification

- Branch `main`, HEAD `5739de1` (unchanged), 106 `git status` entries, nothing staged. This matches the Stage 10 report §12.
- Stage 0 backup: `sha256sum -c` **OK** for the archive and the git bundle.
- Read before starting:
  - `docs/STAGE-10-LIVE-TV-CONTROLS-REPORT.md`;
  - the Movies/Series browse, Details and player screens; `vod-pages.ts`, `vod-service.ts`, `xtream-types.ts`;
  - `progress.ts` (Continue watching), `user-lists.ts` (live favourites), `playlist-service.ts` (account removal), and the KV store.

## 2. Audit findings

**Movies**
- About 108,565 titles are stored as pages: 1,000 titles per item page and 10,000 lowercase names per name page.
- A browse view keeps at most 8 item pages and 400 "hot" items in memory.
- Each row stores: id, name, poster URL, **year**, rating, container extension, genre and an adult flag.
- The **year comes from the provider**: its `year` or release date, or a "(YYYY)" in its title, a rule that already existed in Stage 6. Nothing is invented.
- A category's titles are stored together, because the list is downloaded per category. Sorting one category therefore reads only its few pages.
- "All movies" by year would mean reading all ~109 item pages (≈ 20–30 s); by title, all 11 name pages (≈ 3.4 s, ~10–15 MB). That is why your decision: **sorting inside categories of up to 5,000 movies**.
- On the TV: **143** categories with titles; **138** sortable; **5** over 5,000 (the largest has 9,425); median 205 [TV-S].
- Rating exists but was not added as a sort (not in scope, and not checked for consistency).

**Series**
- `get_series_info` returns seasons and episodes. The parser *filled in* missing numbers: the list position for a missing `episode_num`, and season 1 when no season was given.
- **Correction:** every episode now records whether its season and episode numbers were really stated by the provider (`exact`). Only stated numbers decide the next episode.
- On the TV: 20 series spread over the catalogue, **549/549** episodes with stated numbers; all 20 have a next episode for at least one episode; 6 have more than one season [TV-S].
- Continue watching: `progress.ts`, KV `progress.<account>`, keys `e:<episodeId>`; 95 % counts as watched.

**Persistence and accounts**
- Settings and lists are in the KV store (localStorage), keyed per account id.
- Removing an account deletes its `fav.`, `recent.`, `vod.` and now `mylist.` keys.
- A provider failure never touches these keys.
- Provider ids are compared only within one account and one section, never across accounts.

## 3. My List

- **Storage:**
  - `services/my-list.ts`, KV `mylist.movie.<account>` and `mylist.series.<account>`, newest first, at most 500 each.
  - An entry is a compact copy: id, name, http(s) poster URL, year, rating, extension, genre, category id, adult flag, plus the time it was added. No plots, cast or pages; 500 titles stay under 100,000 characters.
- **UI:**
  - **Details:** "Add to My List" / "Remove from My List". For a movie it sits after Play/Resume; for a series it is **under the poster** (▲ from the seasons).
  - The **My List** category (★) follows "All movies"/"All series" and shows the saved items. OK opens their normal Details and playback. Adult titles still ask for the PIN while locked.
  - Coming back from Details refreshes My List.
- **Safety:**
  - Toggling the same id never duplicates.
  - A storage failure is reported ("My List could not be saved on this TV") and changes nothing.
  - Damaged stored data reads as empty and is not overwritten until you change the list.
  - Titles that left the provider's catalogue stay until you remove them; nothing is deleted automatically. Details then shows its existing "details not available" note.
  - The list is cleared only when you remove the account.

## 4. Movie sorting

- **Orders:**
  - Provider order (default);
  - Title A–Z and Title Z–A (case-insensitive; empty titles last);
  - Newest first and Oldest first (by the stored year; titles without a year last).
  - Equal values keep the provider order (stable).
- **Control** (your decision after the TV check): a **"Sort: …" button in the header above the posters**, reached with ▲ from the first row.
  - It always sorts the category on screen.
  - The first version, a row in the category column, sorted the wrong category: moving ▲ to it passed other categories, which were then shown.
- **Behaviour:**
  - The mode is kept while you move between categories and after Details.
  - "All movies", search results, My List and categories over 5,000 show "Shown in provider order".
  - No provider request is made, and the stored list is not changed.
  - One sorted list is cached; it is released before a new one is built.
- **Memory guard (added after the TV run, §8):** below the app's 150 MB free-memory floor, no sort is started. The provider order stays, with the note "Not sorted right now — the TV is low on memory". Unit-tested; the low-memory path was not reached on the TV.
- **TV timing [TV-S]:** largest sortable category, 4,951 titles. Reading titles and years 0.56–0.62 s, then 7–38 ms per sort; 4,949 have a year.

## 5. Next-episode detection and ordering

**`content/next-episode.ts`** uses stated numbers only:
- the next higher episode number in the same season (gaps allowed);
- otherwise the first episode of the next higher season ≥ 1;
- season 0 (specials) is never continued from or into;
- a duplicated number or episode id means **no** prompt;
- the catalogue order is never used; numbers decide.

**When it appears:**
- Your physical check asked for earlier than the very end. It now appears **2 minutes before the end while the episode keeps playing** (episodes of 5 minutes or longer), or when the stream ends by itself, whichever comes first.
- It appears once per episode.
- The end credits themselves cannot be detected on this TV: the app has no access to the picture.
- It never appears on Back or on an error.

**Prompt:**
- Top right, **see-through** (your check): "Next episode · S2 E1 · Title", **Play next / Cancel**.
- Nothing starts without OK (your decision: no countdown).
- ←/→/OK work on the prompt; pause and ▲▼ still work on the video. Back or Cancel closes it, and it does not return at the end.

**Playing the next episode:**
- It reuses the same player screen and controller: no second player.
- The finished episode is marked watched, Continue watching follows the new episode, and audio/subtitle auto-choice runs again for it.
- Back returns to the series' episodes as before.

## 6. Automated test results

`npm run check`:
- typecheck OK;
- ES5 `compat-check: 122 files, 0 finding(s)`;
- **347/347 unit tests** and **5/5 build tests** pass.

`npm run build:all`:
- release `app.js` 338,382 B;
- `release-check: OK`; no Stage 11 test code or LAN address in the release bundle;
- APK rebuilt (not run on a device).

**New tests (16)**

`tests/unit/stage11-movies-series.test.mjs` (10):
- **My List:** add/remove/toggle without duplicates; movies and series apart; a restart (a new store over the same storage); account isolation and clearing; only small fields stored; bad ids refused; damaged data; storage failure and recovery; 500 titles, then "full".
- **Sorting:** the four orders; empty titles and unknown years last; stable ties; input unchanged; 5,000 titles quickly.
- **Next episode:** same season, gaps, the next season, a season-number gap, the last episode, another series' id; specials; filled-in numbers; duplicate numbers and ids; the parser's "stated" flag.

`tests/unit/vod-ui.test.mjs` (6):
- My List through Details and the category, the restart, a second account and its removal, series;
- sorting through the header button, order kept after Details, All not sorted;
- next episode after a normal end, then into the next season, Cancel, Continue watching;
- no prompt on Back, on an error, or after the last episode;
- the 2-minute prompt while playing, with no pause;
- a My List row with one title shows no left-over posters;
- the low-memory sort guard.

**Existing tests changed for intended behaviour:**
- Two Stage 6 browse tests had their navigation adjusted while the Sort row was in the column. They are back to their original steps now that it is a header button.
- One next-episode test now plays from the start, because the prompt appears 2 minutes before the end.

No test was removed or weakened.

## 7. Physical TV and remote tests [TV-P]

One test build, updated three times after your checks. Each fix was rebuilt and checked again by you.

| Check | First result | Fix | Final result |
|---|---|---|---|
| Add / remove a movie | ok | — | ok |
| My List shows only saved titles | **not ok**: 4 extra, unselectable posters | cleared unused grid cards (an old pre-existing display bug: a hidden card's poster stayed visible) | **ok** |
| Add / remove a series | ok, but the list showed extras | same fix | **ok** |
| Series Details with the My List button | **not ok**: button covered the episodes; season button cut off | button moved under the poster, smaller | **ok** |
| Sorting, all orders | **not ok** | header "Sort: …" button (your choice) | **ok** |
| Sort kept after Details | **not ok** | same | **ok** |
| Sort button fully visible when focused | not ok (bottom cut off) | centred in the header | **ok** |
| Leftmost poster's focus ring | cut off by the category menu | 8 px grid margin, outer cards grow inwards | **ok** |
| Next-episode prompt | ok, but only at the very end | 2 min before the end, video keeps playing | **ok** |
| Cancel / Play next / no prompt on Back | ok | — | ok |
| Prompt see-through | requested | 55 % background | **ok** |
| Restart: My List kept | — | — | **ok** (after the restart the log shows 1 movie + 1 series saved) |
| Live TV and the Stage 10 controls (list over video, Blue, number entry) | — | — | **ok** |

- **Not tested physically:** switching between accounts (the TV has one account). Isolation is covered by unit tests.
- **Not tested:** a season-to-season transition on the TV. You tested next episode on "FR - Love Is Blind", and the transition itself is unit-tested.

## 8. Memory measurements [TV-S, from 1,079 heartbeats every 5 s]

| Screen | Heartbeats | Lowest | 10th percentile | Median |
|---|---|---|---|---|
| Movies/Series browse | 554 | **133** | 188 | 293 |
| Details | 172 | **129** | 207 | 238 |
| VOD player | 279 | 167 | 231 | 260 |
| Home | 51 | 158 | 186 | 222 |
| Live TV / player | 6 / 11 | 166 / 178 | — | 218 / 239 |

- **21 heartbeats were below 160 MB; the lowest was 129 MB.** The app stayed responsive (0 errors).
  - One low point (139 MB) came 21 s after opening Movies with no sorting. This matches earlier stages, which measured 128–166 MB while browsing.
  - The others (129–133 MB) came right after repeated re-sorting of the 4,754-title category.
- Sorting itself measured no drop (183 → 188 MB, 151 → 155 MB), but each sort briefly allocates arrays and lowercase names.
- **Mitigation added:** no sort starts below the 150 MB floor. The floor itself is unchanged.
- The pre-existing guide memory guard stopped one guide download (149 MB < 200 MB), the known Stage 7E behaviour.

## 9. Known limitations and unresolved issues

- **Sorting is per category, up to 5,000 titles** (your decision). "All movies" and the 5 largest categories stay in provider order.
- **Year sorting** depends on the provider's year or release date, or a "(YYYY)" in the title. Titles without one go last.
- **The next-episode prompt cannot follow the end credits.** It uses a fixed 2 minutes before the end. On episodes with long credits it may appear while the story is still running; on very short credits after them.
- **My List keeps titles that leave the provider's catalogue** until you remove them. Their Details may be incomplete.
- **Memory while browsing** can fall to about 130 MB, as in earlier stages. Lowering it is outside this stage.
- **Not verified on the TV:** the low-memory sort guard (unit-tested only) and account switching (one account).
- One `vod: playback failed` warning was logged during your session (one title did not start). That is not related to these features and was not investigated.

## 10. Normal release build restored

- `src/dev/device-selftest.ts` restored byte-identical (SHA-1 `07584df…`); `npm run check` and `npm run build:all` were rerun afterwards.
- The release build was **installed** and **launched**.
- It has the same application id as the test build, so it **replaced** it.
- The last two log-sink lines are the test build's final heartbeat batch, sent before it was replaced; the count did not change afterwards.
- The dev-only `src/dev/device-selftest-stage11.ts` stays in the tree, unreferenced.

## 11. Git status

**Nothing was committed, pushed, published or released.** HEAD is still `5739de1`, and nothing is staged.

`git status`: **115 entries**. New against the Stage 0 backup:
- tracked files now modified: `src/api/xtream/xtream-types.ts`, `src/models/content.ts`;
- new files:
  - `src/services/my-list.ts`, `src/content/vod-sort.ts`, `src/content/next-episode.ts`;
  - `src/dev/device-selftest-stage11.ts`;
  - `tests/unit/stage11-movies-series.test.mjs`;
  - `docs/evidence/stage11/`;
  - this report;
- Stage 9 and 10 entries as before.

Other files changed in Stage 11 that were already in the changed list:
- `vod-browse-screen.ts`, `vod-details-screen.ts`, `vod-player-screen.ts`, `vod-screens.ts`;
- `vod-pages.ts`, `vod-service.ts`, `playlist-service.ts`;
- `bootstrap.ts`, `strings.ts`, `vod.css`;
- `tests/unit/vod-ui.test.mjs`.

All earlier uncommitted work is preserved.

## 12. Follow-up after your review (2026-11-25)

You asked for two changes. Both were built, checked by you on the TV ("all ok"), and are now in the release build.

1. **Series sorting.** Series have the same "Sort: …" button above the posters, with the same five orders and the same rules:
   - categories of up to 5,000 titles;
   - no sort below 150 MB free memory;
   - the provider order otherwise.
   
   The note now says "up to 5,000 titles" for both Movies and Series.
2. **The series My List button is now the movie button.** It is full-size, in the text column, and reached with ▲ from the seasons. To make room without covering the lists:
   - the series header grows 440 → 480 px, and its season/episode lists shrink 500 → 460 px (**5 rows instead of 6**);
   - the plot is limited to 2 lines and the cast line to 1;
   - on series the button label shows the saved state, without the extra "Added to My List" line.
   
   The small under-poster button from §7 is removed.

**Checks:**
- **348/348 unit tests** pass (one new test for series sorting and the button's position) and **5/5 build tests** pass.
- ES5 0 findings; `release-check: OK`.
- Release build reinstalled and launched; `src/dev/device-selftest.ts` restored (SHA-1 `07584df…`).
- The evidence file was refreshed: 0 errors, no URLs or credentials.

**Not committed or pushed.**
