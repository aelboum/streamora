# Stage 6.1 report — Large catalogue performance and storage

Date: 2026-11-24. Target: Samsung UE50MU6100, Tizen 3.0, with the user's own Xtream provider (108,522 movies, 25,488 series). Nothing was committed, pushed, merged, tagged, released or deployed; version numbers are unchanged; all changes are local and unstaged. R3 (silent launch) was not investigated. Sorting, resume and subtitle functionality do not exist in the code (Stage 7/8), so there was nothing of that kind to preserve.

Evidence tags used below: **[W]** automated tests on Windows (Node, fake XHR and fake TV file store), **[D]** desktop performance tests (same harness, synthetic data), **[TV-S]** dev build on the TV with injected (simulated) remote keys against the real provider, **[V]** visual inspection, **[P]** physical remote. **[V] and [P] were not performed in this stage.**

## 1. Root causes (Stage 6 code, measured on the TV)

Baseline: Stage 6 TV run of 2026-11-24 (same code, same provider): movies 108,521 titles, 12.6 M characters in one file, download 34.5 s, longest UI stall during download 1.94 s, lowest free memory 71 MB, opening Movies 11.8 s, a 3.3 s freeze while opening. A repeat baseline run was attempted today (13:33) on the unchanged Stage 6 build: the app logged its start-up and then nothing for 11 minutes; the cause is unknown and the Stage 6 numbers are used as the baseline.

| # | Root cause | Where |
|---|---|---|
| R1 | The whole movie list was one catalogue section: opening Movies read 12.6 M characters, checksummed them, `JSON.parse`d them and decoded 108,521 objects, all synchronously after the read. The 3.3 s freeze and most of the 11.8 s. | `vod-service.load` → `CatalogueStore.load` → `decodeVod` → `createVodIndex` |
| R2 | Several full copies in memory at once: the file text, the parsed JSON, the decoded items, the index arrays. | same |
| R3 | The download fetched `get_vod_streams` without a category: one 12.6 M+ character XHR response (no streaming XHR on Tizen 3.0, so `responseText` grows to the full size), all rows in the builder, then `JSON.stringify` + ASCII escaping + header concatenation = more full copies. This explains the 71 MB lowest free memory. | `vod-service.refresh`, `xtream-client.streamList` |
| R4 | The grid was virtualised (pooled rows, posters only for bound cards) but the data was not paged: everything had to be in memory before anything was shown. | `vod-browse-screen` |
| R5 | Search scanned an in-memory array of all names (fast once loaded, but requires R1/R2). | `vod-index.search` |

Not causes: poster loading (only bound cards load posters; 28 posters after 1.5 s in every run), key handling (≈ 2 ms per press), categories (143, negligible).

## 2. Architecture and storage changes

Implements ARCHITECTURE rev 3 §7 "index only" storage for over-budget sections.

**On disk** (all files through CatalogueStore: header + fnv1a32 checksum, ASCII-escaped as required since Stage 5.2):

| File | Content | Size (108,522 movies) |
|---|---|---|
| `cat.<pl>.movie.json` | the **index**: categories `[id, name, adult, runs]`, shared image-URL prefixes, page counts, generation id, content hash | 37 k characters |
| `cat.<pl>.movie.<gen>-i<k>.json` | item pages, 1,000 rows `[id, name, imgPfx, imgRest, year, rating10, ext, genre, flags]` | ≤ 169 k each |
| `cat.<pl>.movie.<gen>-n<k>.json` | name pages for search, 10,000 lower-cased names | ≤ 300 k each |

- Positions are global (0 … total−1 = browse order). Each category is a list of position runs; with per-category downloads every category is one contiguous run, so "All" lists the categories in provider order.
- **Generations:** an update writes a new generation next to the current one; the index (written last) is the commit point; only then is the previous generation deleted. An update that fails, is empty, is aborted, or is interrupted by the app closing leaves the previous catalogue untouched; leftover pages are removed at the start of the next update.
- **Download per category:** `get_vod_streams&category_id=X` / `get_series&category_id=X`, one category at a time. Memory is bounded by the largest category (161 k characters for a 108k synthetic list [D]) instead of the whole list. If the provider lists no categories, the whole list is fetched in one request (fallback). Duplicate ids across categories are kept once.
- **Incremental:** if the new content hash equals the stored one and its pages exist, the new pages are dropped and the stored generation stays (`unchanged: true`).
- **Migration:** a Stage 6 single-file list (v1) fails the index validation, is discarded by the store and downloaded again on the next open.
- **In memory (VodView):** the index; at most 8 item pages (LRU); up to 400 recently requested items (so search hits spread over many pages stay visible); one name page at a time during a search.
- **Browse screen:** opens on the index alone; the visible rows plus one screen above and below are read in the background; unread cards show an empty placeholder (navigation keeps working); an unreadable page or malformed row shows "—" and is not retried endlessly. OK on a card whose page is still loading opens it once read. Search runs over the name pages incrementally and the results grow on screen while it runs.
- **Playback:** starting a movie or episode calls `vod.abortRefresh()`; a running list update stops and keeps the previous list.

## 3. Files modified

| File | Change |
|---|---|
| `src/content/vod-pages.ts` | **new**: page writer (categories, runs, prefixes, dedupe, page flushing, content hash), index validation, VodView (LRU pages, recent items, ensure, failed, incremental search, timings) |
| `src/content/vod-codec.ts`, `src/content/vod-index.ts` | **deleted** (replaced by vod-pages; no other users) |
| `src/storage/catalogue-store.ts` | page files: `pageFileName`, `savePage`, `loadPage`, `removePages`; save/load refactored into shared internal functions (same checksum, escaping and validation); `FILE_RE` extended; `removePlaylist` also removes page files; `cleanup` tmp group renumbered |
| `src/api/xtream/xtream-client.ts` | optional `categoryId` for `vodStreams` / `seriesList` (validated) |
| `src/services/vod-service.ts` | per-category paged refresh with generations, index-only `load` returning a `VodView`, `abortRefresh`, phase diagnostics |
| `src/screens/vod-browse-screen.ts` | lazy pages, placeholders, read-ahead, incremental search, open-after-load, diagnostics |
| `src/screens/vod-screens.ts` | playback start stops a running list update |
| `src/app/platform/platform.ts`, `src/app/platform/tizen-file-store.ts` | optional `timings()` diagnostics (longest synchronous call per FileStream operation); chunk sizes unchanged |
| `src/i18n/strings.ts` | `vod.searching` (EN, NL) |
| `src/dev/device-selftest-stage6.ts` | dev only: paged API, first-titles time, 60-row scroll, placeholders, search progress, file-store timings |
| `tests/fakes/fake-xtream-vod.mjs` | `byCategory` (list requests honour `category_id`) |
| `tests/unit/vod.test.mjs`, `tests/unit/vod-ui.test.mjs` | see §6 |
| `docs/STAGE-6.1-REPORT.md`, `docs/evidence/stage6.1-tv-selftest.jsonl` | this report and the TV evidence (counts and timings only) |
| `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION-STATUS.md`, `docs/TEST-REPORT.md` | Stage 6.1 notes |

## 4. Indexing improvements

- Titles are written page by page as they arrive (1,000 rows); no full list in memory at any point.
- Batches: one category per request; the existing streaming JSON reader still parses each response in 16 ms slices.
- Interrupted indexing (abort, app closed while writing), failed page writes, empty and malformed responses: previous catalogue kept, no pages of the failed update left (tested [W]).
- No duplicate indexing: ids seen once per update; repeated categories map to one entry; unchanged list detected by content hash.
- Playback has priority: starting VOD playback aborts a running update.

## 5. Memory improvements

| | Stage 6 [TV-S] | Stage 6.1 [TV-S] |
|---|---|---|
| Lowest free memory during movie download | **71 MB** | **165 MB** (first paged download, incl. discarding the old 12.6 M file); 405–432 MB in later runs |
| Free memory while browsing Movies | not measured separately | 164 MB (first run), 317–351 MB later |
| Largest single provider response | whole list (≥ 12.6 M chars) | one category (161 k chars in the 108k synthetic test [D]) |
| Titles held in memory while browsing | all 108,521 | ≤ 8 pages × 1,000 + ≤ 400 items, regardless of catalogue size [W] |

## 6. Automated test results [W]

`npm run check` passes: typecheck 0 errors; compatibility check **91 files, 0 findings**; **243 unit tests** (Stage 6: 232); **5 build tests**; release check OK. Release bundle JS 211.6 KB (Stage 6: 203 KB), CSS 15.3 KB.

New or rewritten tests (`vod.test.mjs`, 21 tests; `vod-ui.test.mjs`, 6 tests):
- paged writer/view: pages, runs, prefixes, Unicode on a TV-like (non-ASCII-damaging) store, duplicates, malformed rows, missing pages, page-name guards;
- bounded page cache with 28 visible items on 28 different pages;
- search: word match, prefix first, Unicode, incremental progress, cancel;
- per-category import (request count), restart, details, playback URLs, credentials never logged or stored;
- fallback without categories (uncategorised titles kept);
- incremental updates, missing page rewritten, empty / error object / auth / truncated / network responses keep the list and leave no pages;
- interrupted indexing (abort during the 3rd category; app killed after writing pages without an index);
- storage failure while writing pages;
- Stage 6 v1 file migration;
- M3U unsupported, one update at a time, playlist removal removes state and page files;
- 20 × Movies ↔ Series switching;
- 1,000 / 10,000 / 50,000 / 108,521 movies and 30,000 series; empty catalogue;
- UI: browse with asynchronous pages, search results growing, details, play, Back chain, series, player errors, Live TV regression.

Expectations changed in existing tests (behaviour changes, not weakened checks): the fixture's two titles without a listed category are no longer imported when categories exist (6 → 4 titles); "All" follows category order (series order changed).

Not covered by automated tests: the TV's real FileStream timing (only measured on the TV, §9).

## 7. Large-catalogue benchmark results [D]

Desktop (Windows, Node 24, fake XHR, in-memory TV-like store; for comparison only, not TV performance):

| Titles | Categories | Import | Stored | Files | Index | Largest file | Largest response | Open (index) | First 3 screens | Search (first hit) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 movies | 10 | 0.16 s | 0.10 M | 3 | 32 k | 57 k | 21 k | 1 ms | 3 ms | 1 ms |
| 10,000 movies | 13 | 1.2 s | 0.78 M | 12 | 32 k | 158 k | 163 k | 1 ms | 1 ms | 5 ms |
| 50,000 movies | 67 | 6.6 s | 3.88 M | 56 | 34 k | 167 k | 160 k | 1 ms | 1 ms | 19 ms (8) |
| 108,521 movies | 145 | 14.8 s | 8.46 M | 121 | 37 k | 169 k | 161 k | 1 ms | 2 ms | 43 ms (20) |
| 30,000 series | 40 | 3.1 s | 2.62 M | 34 | 17 k | — | — | 0 ms | 3 ms | 13 ms |

## 8. Before/after comparison (TV, real provider, injected keys) [TV-S]

"After" ranges cover four runs (run 1 = first paged download incl. migration; runs 2–4 = unchanged list). Run 4 used 16 K FileStream write chunks as an experiment (reverted, see §9).

| Measurement | Stage 6 (before) | Stage 6.1 (after) | Target | Met? |
|---|---|---|---|---|
| Movies: titles / categories | 108,521 / 143 | 108,522 / 143 (+1, cause not determined) | correct counts | see S61-3 |
| Opening Movies: screen ready | 11.8 s | **99–192 ms** | ≤ 2 s | **yes** |
| Opening Movies: first titles on screen | 11.8 s | **224–742 ms** | ≤ 2 s | **yes** |
| Longest stall while browsing Movies | **3.3 s** | 105–138 ms (461 ms in run 1, right after the migration) | < 100 ms | **no** (close) |
| Key handling | 1.06 ms/press | 2.0–2.4 ms/press | — | yes |
| 60 rows scrolled at remote speed, placeholders left after 1 s | not measured | 0 | no freezes | yes |
| Search across all titles (2,000 hits) | 212 ms (in memory, after the 11.8 s load) | 281–337 ms | responsive | yes |
| Movie details / playback | 330 ms / 1.7 s start | 281–296 ms / no failure in 8 s | — | yes |
| Movie list download | 34.5 s (one request) | **92.8–104.4 s** (143 requests) | — | **slower** |
| Longest stall during the movie download | 1.94 s | 467–1,602 ms | < 100 ms | **no** |
| Lowest free memory during the download | **71 MB** | **165 MB** (run 1), 405–432 MB | bounded | **yes** |
| Series: titles | 25,489 | 25,488 (−1, cause not determined) | — | see S61-3 |
| Opening Series: first titles | 3.0 s | 190–210 ms | ≤ 2 s | yes |
| Longest stall while browsing Series | 0.48 s | 135–164 ms | < 100 ms | no (close) |
| Series search (2,000 hits) | 138 ms | 835–1,027 ms (first hits 267–400 ms) | responsive | partly |
| Series download | 11.0 s | 90.7–100.7 s (97 requests) | — | **slower** |
| Longest stall during the series download | 0.56 s | 191–2,722 ms | < 100 ms | **no** |
| Live TV after VOD | 1.3 s | 1.2–1.9 s | unchanged | yes |
| Stored size, movies | 12.6 M chars in one file | 121 files, ≤ 169 k item pages [D]; 37 k read at open | per-file budget 5 M | yes |

## 9. Samsung TV test results

| Validation | Status |
|---|---|
| Automated tests [W] | PASS (§6) |
| Desktop performance tests [D] | done (§7) |
| Simulated TV test with the real provider [TV-S] | **PASS**, 4 runs: movies and series downloaded per category, stored as pages, opened from the index, scrolled 60 rows, searched, details fetched, one movie and one episode played 8 s without failure, Back returned to details, Live TV played afterwards |
| Real-provider TV test | yes (the same runs; the user's own Xtream playlist) |
| Visual inspection [V] | **NOT TESTED** (placeholders, "—" cards, search progress text never looked at on screen) |
| Physical remote [P] | **NOT TESTED** |
| Playback aborting a running update on the TV | **NOT TESTED** on the TV (tested [W]) |

Diagnosis of the remaining download stalls [TV-S]: the longest synchronous page encoding (JSON + ASCII escaping + checksum) was 63–180 ms; the longest single `FileStream.write()` call was **515–810 ms** (run 2: page write 2.85 s ≈ the 2.72 s stall). Reducing the write chunk from 100 K to 16 K characters (run 4) did not change the worst case (515 / 810 ms) or the number of stalls (7 vs 6), so the chunk sizes were restored. Reads: ≤ 128 ms per call.

After the runs the **release build was reinstalled** on the TV (`check:release` OK). The movie and series lists on the TV are now stored in the paged format (the Stage 6 files were replaced); the playlist and its live catalogue were not touched.

## 10. Remaining problems and risks

| # | Issue / risk |
|---|---|
| S61-1 | **Download stalls of 0.5–2.7 s** while a list update runs: individual Tizen `FileStream.write()` calls block regardless of size. Not solved. Options for a later stage: fewer page files written less often, or postponing writes while the user is pressing keys. Browsing during an update is affected; playback aborts updates. |
| S61-2 | **Downloads are about 3× (movies) and 9× (series) slower**: one request per category, ≈ 0.7–1 s each at this provider. Fetching 2–3 categories in parallel would keep memory bounded but needs ordering work; not done. |
| S61-3 | Titles outside the provider's listed categories are no longer stored when categories exist (per-category download). The real provider shows +1 movie / −1 series versus the Stage 6 run; whether this is a provider change or such titles was not determined. |
| S61-4 | Browse stalls 105–164 ms (target < 100 ms); 461 ms once right after the first download. Series search 0.8–1.0 s for 2,000 hits. |
| S61-5 | Detecting an unchanged list still downloads and encodes everything (the hash covers all pages); only the commit is skipped. |
| S61-6 | The unchanged-list shortcut checks that the last item page exists; a missing middle page shows "—" until the next update that changes content. |
| S61-7 | Stored total 8.46 M characters for 108k movies [D] (index + item pages + search name pages, which duplicate the names); each file is far under the 5 M per-file budget and only 37 k is read when opening. |
| S61-8 | Visual and physical-remote validation outstanding (also from Stages 5–6). |
| S61-9 | The baseline re-run on the Stage 6 build went silent after start-up (cause unknown, not investigated further). |
| S61-10 | Diagnostics added (`timings()`, phase timings in the `vod: refresh` log) remain in the code; they log numbers only. |
