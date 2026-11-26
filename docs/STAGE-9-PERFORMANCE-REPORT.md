# Stage 9 — Performance: report

Date: 2026-11-25. Scope: the three approved improvements only.
- Stage 0 (backup) was completed and verified first: `docs/STAGE-0-BACKUP-REPORT.md`.

**Evidence tags**
- **[SIM]** unit tests;
- **[TV-M]** measured on the TV with scripted keys. Nobody looked at the screen or used the physical remote.

Evidence: `docs/evidence/stage9-performance/tv-run-stage9.jsonl` (159 lines, two passes). It contains no URLs or credentials (checked by search). The channel-order hashes were masked by the log redaction.

## 1. Summary of the three improvements

| # | Improvement | Result on the TV |
|---|---|---|
| 1 | **Global Search shows results progressively** | First result card after 0.23–2.9 s, against 3.3–5.6 s of blank screen before. The complete result is **not** faster in this test (§8) |
| 2 | **Live TV channel list cached in memory** | Reopening Live TV: **0.15–0.23 s** (cached), against **2.42 s** uncached in the same run and 2.5–2.8 s in Stage 7E. Released automatically below 150 MB free memory, which happened often on this TV (§10) |
| 3 | **Blocking file writes wait while the remote is in use** | Same pass, same unchanged list: longest freeze **during key use 413 → 278 ms**. Freezes moved into the pauses (up to 958 ms). The update took 15 s longer. A modest gain, not a removal of the freezes |

## 2. Root cause of each problem

1. **Search.**
   - The screen waited for **every** list before showing anything: `Promise.all` over the channel list, the movie index and the series index, then the full name-page scan of movies **and** series, then the title pages.
   - The scan already reported progress (`onProgress`), but the screen ignored it.
   - Older scans were never cancelled when a new query started.
2. **Live TV reload.**
   - The router destroys a screen when it is left.
   - Each visit therefore called `PlaylistService.loadLive`, which read the 2.35 M-character channel file from the TV's file system and decoded 21,986 channels: 2.25 s read + decode in this run, plus building the index.
3. **Update freezes.**
   - Each Tizen `FileStream.write()` is a synchronous native call that can block for 0.5–0.8 s or more **regardless of how much it writes** (Stage 6.1; 16 K chunks did not help).
   - The page writes of an update run whenever the download produces a page, also while the user is pressing keys.
   - The freeze itself cannot be shortened from JavaScript. Only *when* it happens can be chosen.

## 3. Files changed

| File | Change |
|---|---|
| `src/screens/search-screen.ts` | Per-list loading (channels, movies, series each start when their own list is ready); progressive movie/series rows; cancel older scans; stale-result guard; duplicate-query guard; error message per list; focus kept on the same title when rows grow |
| `src/services/playlist-service.ts` | Live cache: `liveCache` option, checksum-validated reuse, in-flight sharing, release on account switch / removal / remove-all / changed refresh / recovery / low memory; `liveCacheInfo()`, `releaseLiveCache()`; `LiveLoad.cached` |
| `src/app/input-quiet.ts` | **New**: the "remote is quiet" gate (quiet time, wait cap, memory-pressure bypass, statistics) |
| `src/app/platform/tizen-file-store.ts` | Optional write gate before each blocking write-side call (delete, create, each 100 K chunk, move) |
| `src/app/platform/platform.ts` | `FileStore.setWriteGate?` (CRLF kept) |
| `src/app/bootstrap.ts` | Constants and wiring: cache budget, gate timing, the gate fed by every key press (CRLF kept) |
| `src/screens/live-tv-screen.ts` | `live tv ready` log adds `cached` (CRLF kept) |
| `src/i18n/strings.ts` | `search.failed.movie` / `search.failed.series` (EN, NL; CRLF kept) |
| `tests/unit/stage9-performance.test.mjs` | **New**, 13 tests |
| `src/dev/device-selftest-stage9.ts` | **New**, dev-only (not referenced by any build): the TV measurements |

`src/dev/device-selftest.ts` was switched to the Stage 9 suite for the TV run and restored byte-identical afterwards (SHA-1 `07584df…`).

No change to:
- AVPlay or playback;
- navigation and key handling, apart from the gate noting each key press;
- provider requests;
- EPG, subtitles or audio.

## 4. Implementation details

**Search** (`run()`):
- Every query gets a generation number. Results of an older generation are dropped, and its scans are cancelled (`SearchJob.cancel`).
- An identical query while it is still running is not started twice.
- The stored lists load once per screen, **each on its own**.
- Channels are searched in memory as soon as the channel list is ready.
- Movies and series start scanning as soon as their own index is ready.
- On every scan progress, only the first 10 hits (two screens of cards) are read from their pages and shown. The final result is the same list as before (prefix matches first, 40 per row).
- The message shows "Searching…" while any list is still working. "Nothing found" appears only when every list finished without hits. A list that failed says so ("Movies could not be searched.").
- When rows grow, focus stays on the same title.

**Live cache** (`playlist-service.ts`):
- One entry: the active playlist's decoded catalogue, plus the checksum of the channel file it came from.
- Every `loadLive` still reads the small `meta` file. The cached copy is returned only when `meta.liveHash` equals that checksum, so a refresh, a recovery, an interrupted import or any other change to the files can never serve old channels.
- The cache is released:
  - on an account switch, removal, or remove-all;
  - after a refresh that changed the list (an unchanged or failed refresh keeps it, since the files still match);
  - after a recovery that removed files;
  - when free memory is below the floor (checked at every use and every 10 s while something is cached).
- Only the active playlist is kept, and only when nothing was invalidated while it loaded.
- Two screens loading at once (Live TV and Search) share one read.
- The same objects are returned. No screen modifies them (checked in the code).
- No persistent storage was added.

**Write gate** (`input-quiet.ts`, `tizen-file-store.ts`):
- Every key press is noted.
- Before each blocking write-side call, the file store waits until no key was pressed for **1.5 s**.
- It waits **at most 5 s per call**, so an update always finishes and pending pages cannot pile up.
- It does not wait at all when free memory is below **150 MB**.
- Writes stay in the same order. Temp-file-then-move atomicity is unchanged, and a failing gate never blocks a write.

## 5. Memory safeguards

How the budget was chosen, from the current memory architecture:
- The app stopped responding at about **120 MB** free (Stage 7E).
- The guide download is stopped at **200 MB**, because a download keeps growing.
- This TV usually has 150–270 MB free with the catalogue loaded (this run: 135–271 MB).

| Safeguard | Value | Measured on the TV |
|---|---|---|
| Release / do not keep the cache below | **150 MB** free | Released or not kept **8 times** in this run (`low-memory`); the app kept running |
| Largest channel file kept | **8,000,000** characters (about 50,000 channels) | This playlist: **2,345,762** characters |
| Memory check while cached | every **10 s**, and at each use | — |
| Extra memory held by the cache outside Live TV | — | Not separable from the noise. Free memory outside Live TV with the cache held: 198 MB, inside the normal 176–210 MB range of the same minutes |
| Write gate disabled below | **150 MB** free | Pass 1 used the 200 MB guide floor: bypassed for 83 of 84 waits. Lowered to 150 MB for pass 2: 0 bypasses |

## 6. Automated test results

`npm run check`:
- typecheck OK;
- **317/317 unit tests** pass, 13 of them new;
- **5/5 build tests** pass.

New tests (`tests/unit/stage9-performance.test.mjs`) [SIM]:
- **Search:**
  - progressive rows while the scan runs, with the complete result at the end;
  - a slow list keeps "Searching…";
  - a slow channel list does not hold back movie results;
  - failed lists vs no results;
  - a newer query cancels the older scans, and late results of the older query are ignored;
  - a duplicate running query is not started twice;
  - lists are loaded once per screen.
- **Cache:**
  - the first open reads the file, later opens reuse it (same order and categories);
  - concurrent loads share one read;
  - an account switch or removal releases it, and a non-active account is never cached;
  - an unchanged refresh keeps it, a failed refresh keeps the safe copy, and a changed refresh replaces it;
  - a channel file changed behind its back is never served (checksum);
  - not kept below 150 MB or above the size budget;
  - released when memory falls, with no timer left behind;
  - without the option, the old behaviour.
- **Updates:**
  - the gate runs at once when idle and waits during key use;
  - the 5 s cap and the memory-pressure bypass;
  - in the Tizen file store: nothing blocking runs before the gate opens, the old file stays readable during a held update, the content is complete and atomic, and a failing gate still writes;
  - a catalogue save while keys are pressed writes nothing until quiet, then stores identical data.

## 7. ES5 compatibility

`compat-check: 116 files, 0 finding(s)`.

`npm run build:all`:
- release `app.js` 323,016 B;
- `release-check: OK (no development logging code or origins)`;
- no Stage 9 self-test or LAN address in the release bundle;
- APK rebuilt (not run on a device).

## 8. Before-and-after performance measurements [TV-M]

The "before" values are from earlier stages (named), or measured in this run on the old code path (Live TV with the cache released, update with the gate off).

| Measurement | Before | After |
|---|---|---|
| **Search, first result on screen** | blank for 3.3–5.6 s (Stage 7D) | **0.23–2.9 s**: pass 1: 0.23 / 2.74 / – / 2.94 s; pass 2 (per-list loading): 1.99 / **0.84** / – / 2.80 s (common, common 2, no result, Arabic) |
| **Search, complete result** | 3.3–5.6 s (Stage 7D) | **6.0–13.3 s** in this test. Not directly comparable, and **not an improvement**: each query opened a new Search screen with nothing cached (memory was below the cache floor), so it read the channel file again and loaded and scanned movies **and** series at the same time |
| **Live TV reopening** | **2.42 s** (cache released, this run); 2.5–2.8 s (Stage 7E) | **0.154 / 0.163 / 0.229 s** (3 cached reopens; load 49–69 ms) |
| **Update freezes while keys are used** (series list, 25,502 titles) | gate off: up to **945 ms** (pass 1, changed list, 9 freezes); **413 ms** (pass 2, unchanged, 3 freezes) | gate on, pass 2 (unchanged): up to **278 ms** (3 freezes); pass 1 (bypassed by the 200 MB floor): 328 ms (13) |
| Update freezes in pauses | off: 904 ms (5) / 443 ms (1) | on, pass 2: **958 ms (8)**: the writes moved there |
| Update duration | off: 101 s (changed) / 89 s (unchanged) | on: 89 s (pass 1) / **104 s** (pass 2) |
| Free memory | 207 MB before the first Live TV open | pass 1: 145–271 MB; pass 2: 135–230 MB (lowest during Search, §10) |
| Provider requests in the first 3 s of a Live TV open | **2** (uncached open) | **1, 1, 0** (cached opens). The source of these requests was not identified (URLs are not logged) |

**Not measured:**
- rendering smoothness;
- what a person sees;
- the physical remote.

"First result on screen" means the first result card present in the DOM.

## 9. Samsung TV test results [TV-M]

One temporary dev build, two passes. Pass 2 ran after two fixes found in pass 1: per-list search loading, and the gate's memory floor lowered from 200 to 150 MB. The real provider and the 21,986-channel playlist were used. **0 errors** were logged in both passes.

| Check | Result |
|---|---|
| 1. Search shows initial results promptly | **Partly.** Channels and movies appear before the scans end (0.23–2.9 s). The first result can still take about 2–3 s when the channel file must be read again at the same time |
| 2. Results continue loading correctly | Yes: rows grew to Channels 23–36, Movies 40, Series 40; "Nothing found" only for the no-result query |
| 3. Rapid search does not cause errors | Yes, both passes: two queries 0.2 s apart ended on the second query (all visible titles match it), with 0 errors |
| 4. Live TV opens from the cache on later visits | Yes: `cached: true` on reopens 1–3, 0.15–0.23 s |
| 5. Channel ordering and favourites correct | Channels 21,986 and categories 374 on every open; favourites 2 of 2 resolved. Order checked by unit test; on the TV the order hash was masked by the log redaction, and a cached open returns the same object |
| 6. Account switching invalidates the cache | **Not tested on the TV:** the TV has one account, and adding one would change your provider settings. Covered by unit tests |
| 7. Updates do not make the interface unresponsive | **Improved, not solved:** freezes during key use went from 413 to 278 ms in the comparable pass; freezes still happen in pauses and when the 5 s cap is reached |
| 8. Memory stable | 135–271 MB, no downward trend; ended at 201 MB (§10) |
| 9. No new errors | 0 errors in both passes |

Scripted remote input was used throughout. This is not physical-remote verification.

## 10. Memory observations

- **Pass 1:** 145–271 MB (55 heartbeats, every 5 s). **Pass 2:** 135–230 MB (51 heartbeats). End values: 188 and 201 MB.
- **The lowest values (135–153 MB) came while Search loaded its three lists at the same moment** with nothing cached.
  - This was the same before Stage 9: it already loaded all three in parallel.
  - It is close to the 120 MB at which the app stopped in Stage 7E, though the app kept running.
- **The cache was released or not kept 8 times because free memory was below 150 MB.** On this TV with this catalogue the cache therefore often does not survive Search or browsing. Live TV is then as slow as before (2.4 s), and never less safe.

## 11. Remaining limitations

1. **The complete search result is not faster** (6–13 s in this test).
   - Scanning all name pages of movies and series stays the cost: about 300 ms per page, about 3.4 s per list (Stage 7D).
   - Making the full scan itself faster would change the search index: an architecture change outside this scope.
2. **The first search result can still take 2–3 s** when the channel file must be read at the same time. The cache was not available then because of low memory.
3. **The live cache often yields** on this TV, because free memory is often below 150 MB. Raising the benefit would need less memory use elsewhere, outside scope. **Decision (you, 2026-11-25): keep the 150 MB floor.**
4. **Update freezes are moved, not removed.**
   - During continuous key use, one write may still run after 5 s.
   - In pauses, freezes of up to about 1 s remain.
   - The update takes about 15 s longer (104 s against 89 s).
   - The platform call cannot be made non-blocking from JavaScript.
5. **Not verified on the TV:** account switching (one account); rendering; the physical remote. The 0.98 s freeze while the 2.35 M-character channel file is decoded (synchronous `JSON.parse`) is unchanged.
6. **Measurement variance:** the update freeze figures differ a lot between runs (945 vs 413 ms with the gate off), so the gate's effect is shown by one comparable pair only.

## 12. Normal release build restored

- `src/dev/device-selftest.ts` restored (SHA-1 verified); `npm run check` and `npm run build:all` were rerun afterwards.
- The **release build was installed** ("Tizen application is successfully installed") and **launched** ("successfully launched").
- The release package has the same application id as the test build (`SShelfDev1.ScreenShelf`), so the installation **replaced** the temporary test build.
- After the release launch the dev log sink received **no new lines**. The release build has no dev logging, so the test build is no longer running. `sdb` cannot report the running state directly.

## 13. Repository state

**Nothing was committed, pushed, published, released or deployed.**
- No reset or clean, and no existing change discarded.
- Compared with the Stage 0 backup, `git status` has 7 more entries (99):
  - `src/services/playlist-service.ts` (now modified);
  - `docs/STAGE-0-BACKUP-REPORT.md`, `docs/STAGE-9-PERFORMANCE-REPORT.md`;
  - `src/app/input-quiet.ts`;
  - `src/dev/device-selftest-stage9.ts`;
  - `tests/unit/stage9-performance.test.mjs`;
  - `docs/evidence/stage9-performance/`.
- The other files changed in this stage were already in the modified or untracked list (see `docs/STAGE-0-BACKUP-REPORT.md` §7).
