# Stage 6 report — Movies and Series

Date: 2026-11-24. Target: Samsung UE50MU6100, Tizen 3.0. Nothing was committed, pushed, merged, tagged or released. R3 (the silent-launch incident) was not touched. The physical-remote validation from Stage 5 is still outstanding; nothing here claims it.

## 1. Audit summary (before implementation)

| Item | Found | Action |
|---|---|---|
| Movie/series model | Architecture §4 defined `VodItem`, `SeriesItem`, `Episode`; code had only `Section` and `StreamRef` types | Added the model (`src/models/content.ts`) |
| Xtream API | Only auth, live categories/streams, short EPG | Added `get_vod_categories`, `get_vod_streams`, `get_vod_info`, `get_series_categories`, `get_series`, `get_series_info`; the list streaming and category code were generalised instead of copied (live behaviour unchanged, existing tests pass) |
| Storage | CatalogueStore already knew sections `movie` / `series`; nothing wrote them | New compact codec (`src/content/vod-codec.ts`) through the same store (checksums, ASCII escaping from Stage 5.2) |
| Stream URLs | `buildXtreamStreamUrl` and `resolvePlayback` already handled `movie`/`series` references | Reused via `PlaylistService.resolveStream` |
| Player | AVPlay engine (live subset) and live controller | VOD controller on the same engine; engine: buffer 0 = AVPlay default, optional `timing()` |
| Subtitles / progress (resume) | **Neither exists** (architecture: subtitles Stage 8, VOD rules §5.4 with Stage 7 player) | Not implemented; documented (no second system invented) |
| Navigation / screens / i18n | Router, focus manager (incl. grid), virtual list, button list, IME text entry, EN/NL tables | Reused; new strings EN + NL |

## 2. Features implemented

**Movies:**
- Categories (Search, Update list, All movies, then the provider's categories with counts).
- A virtualised poster grid (7 columns; pooled rows; posters load only for visible cards; the title is shown when the artwork is missing or broken).
- Name search through the Samsung keyboard (all words, prefix matches first).
- Details: title, year, genre, duration, rating, description, director, cast, from `get_vod_info`. The list entry is shown at once, so playback works even if the details fail.
- Play.

**Series:**
- The same browsing.
- Details with seasons and episodes from `get_series_info`, plus the focused episode's description.
- Episode playback.
- Missing seasons, untitled episodes, invalid episode ids and inconsistent shapes are handled: episodes arrive keyed by season, as an array of arrays or as a flat array.

**Storage and updates:**
- **Download on first use:** the list downloads the first time Movies or Series is opened.
- **Update list:** an entry in the category column downloads it again.
- **Incremental:** an unchanged list is not rewritten unless its file is missing (the Stage 5.2 rule).
- **On failure:** if a download fails, is empty or is malformed, the stored list stays.

**Playback:**
- **Engine:** the same AVPlay engine as Live TV.
- **States:** loading, buffering, playing, paused, ended, error with "OK to retry".
- **Safety:** a 15 s watchdog, and callbacks from an abandoned title are ignored.
- **Display:** a progress bar showing position and duration.
- **Keys:** OK or Play/Pause pauses and resumes; Back stops and returns to the details screen; Home suspends and restores.

**Entry points:** "Movies" and "Series" buttons on the Playlists screen for an active Xtream playlist.

## 3. Xtream API integration

| Call | Use | Handling |
|---|---|---|
| `get_vod_categories`, `get_series_categories` | category column | same parser as live; duplicates and invalid entries dropped |
| `get_vod_streams`, `get_series` | the lists | streamed element by element (existing JSON array reader, 16 ms slices); id, name, image, category, rating (0–10, or `rating_5based` × 2), year (field, date or "(2019)" in the name), extension, adult flag, genre (series); invalid entries counted |
| `get_vod_info` | movie details | plot or description, genre, director, cast or actors, release date, `duration_secs` or "hh:mm:ss", poster, backdrop; cached; an unusable answer gives "no further details" |
| `get_series_info` | seasons / episodes | see §2; at most 5,000 episodes and 200 seasons; cached |

Security:
- Requests go only to the configured server origin (`credentialOrigin`).
- Image URLs must pass the userSource URL policy (`javascript:` and similar are dropped).
- Credentials never appear in logs, catalogue files or errors (tested).
- Stream URLs are built at play time only.

## 4. Storage and data flow

1. **Download:** Movies opened, then `VodService.refresh`:
   - `XtreamClient.vodCategories()`;
   - `vodStreams()`, streamed and parsed into `createVodBuilder` rows.
2. **Save:** `CatalogueStore.save(pid, 'movie', payload, {unlessChecksum})` writes an ASCII-escaped, checksummed file `cat.<pid>.movie.json`.
3. **State:** `vod.<pid>` in the KeyValueStore holds the time, counts and checksum.
4. **Load:** `VodService.load`, then `decodeVod`, which skips malformed rows rather than losing the whole list, then `createVodIndex`, then the grid.
5. **Details:** fetched on demand. **Playback:** `resolveStream`, then the AVPlay engine.

**Memory:** only the section being opened is loaded, and the last loaded list per section is kept for the session.

## 5. Playback integration

**One engine:** the VOD controller and the live controller share the single AVPlay engine. Each player screen creates its controller and destroys it when it closes.

**Live unchanged:** live still passes the 2 s buffer. VOD passes 0, which means AVPlay's default. A test checks the sequence live → movie → live, and the TV run did the same (§8).

**URLs:**
- movies: `<server>/movie/<user>/<pass>/<id>.<ext>`;
- episodes: `<server>/series/<user>/<pass>/<id>.<ext>`;
- the extension comes from the list or the details, and falls back to `mp4`.

**Not implemented (no existing system to reuse):**
- seeking;
- resume points ("continue watching"): architecture §5.4, Stage 7;
- subtitles and audio-track selection: Stage 8.

These features were not invented here.

## 6. Performance

**Windows** (`vod.test.mjs`; fake XHR, for comparison only), 50,000 synthetic movies:
- import 5.6–6.1 s;
- stored 3.77 M characters;
- load and decode 0.10–0.12 s;
- index, category and search 16–18 ms.

**TV [TV]** — your real Xtream provider, injected keys, dev build, 2026-11-24:

| Measurement | Movies | Series |
|---|---|---|
| Titles / categories | **108,521 / 143** | **25,489 / 98** |
| Invalid entries | 0 | 0 |
| Download + parse + store | 34.5 s | 11.0 s |
| Stored size | 12.6 M characters (**over the 5 M budget**) | (within budget) |
| Longest UI stall during the download | 1.94 s (21 stalls > 100 ms) | 0.56 s |
| Lowest free memory during the download | **71 MB** | 131 MB |
| Opening the screen (read + decode + first render) | 11.8 s (render 33 ms) | 3.0 s (render 6 ms) |
| Longest stall while opening / browsing | **3.3 s** (parsing the 12.6 M list) | 0.48 s |
| Posters bound after 1.5 s | 28 (visible cards only) | 28 |
| Key handling (16 presses) | 1.06 ms per press | 1.75 ms per press |
| Category switch (incl. 150 ms debounce) | ≈ 0.4 s wall | ≈ 0.4 s wall |
| Index + search (2,000 hits) | 212 ms | 138 ms |
| Details request | 330 ms (`get_vod_info`) | 1.9 s (`get_series_info`) |
| Playback start (picture) | **1.7 s**, no failure in the next 8 s | **2.0 s** (first episode), no failure in 8 s |
| Back from the player | details screen | details screen |
| Live TV after VOD (shared engine) | channel started in 1.3 s | — |

## 7. Automated tests [W]

- `npm run check` passes:
  - typecheck 0 errors;
  - compatibility check **92 files, 0 findings**;
  - **232 unit tests** (Stage 5.2: 216; +16);
  - **5 build tests**;
  - release check OK.
- **Release bundle:** JS 203 KB (Stage 5.2: 166 KB), CSS 15.3 KB.

| File | Tests | Covers |
|---|---|---|
| `vod.test.mjs` | 10 | movie/series category, list, vod-info and series-info parsing (tolerant typing, ratings, years, durations, extensions, unsafe images, invalid entries, episodes keyed or arrays, missing seasons); codec round trip and malformed-row skipping; index/search; persistence on a TV-like file store (Unicode, ASCII on disk), reload after a restart, details caching, movie and episode URL construction, credentials never logged or stored; incremental updates, missing-file rewrite, empty/object/auth/truncated/network responses keep the stored list; M3U not supported, one refresh at a time, state removed with the playlist; 50,000 movies |
| `vod-ui.test.mjs` | 6 | Movies/Series buttons for Xtream only; browse (download on first open, categories, grid navigation, category switch, IME search, posters and placeholders), details, Play, pause/resume, Back chain (player → details → grid → categories → playlists); series seasons/episodes, episode playback, failed and empty series info; player errors with Retry, progress bar, Home suspend/restore; VodController watchdog, stale callbacks, ended, no engine/source; **Live TV regression** live → movie → live on the shared engine |

**Mutation check:** see §11. **Existing Live TV tests:** all pass unchanged.

## 8. Samsung TV results

| Validation | Status |
|---|---|
| Simulated TV test (injected keys, real AVPlay, **real Xtream provider**) | **PASS**: movies and series downloaded, stored and opened; details fetched; one movie and one episode played; Back returned to details; Live TV played afterwards |
| Physical remote | **NOT TESTED** |
| Visual inspection (layout, posters, focus, readability) | **NOT TESTED** |
| Seeking / resume / subtitles | not implemented |
| Home key suspend/restore during VOD on the TV | **NOT TESTED** |
| Long VOD playback (> 8 s) | NOT TESTED |

Evidence: `docs/evidence/stage6-tv-selftest.jsonl` (counts and timings only; no titles, URLs or credentials).

## 9. Compatibility

- ES5 output; the compatibility gate covers 92 files with 0 findings.
- No new runtime dependency.
- `webapis` is used only in `avplay-engine.ts`, as before.
- The CSS gate passes (flexbox and margins only).
- Catalogue writes are ASCII-escaped, as required by the Stage 5.2 correction. They are verified on the TV with real provider titles (Arabic, accents and symbols) through the same store.

## 10. Remaining issues and risks

| # | Issue / risk |
|---|---|
| S6-1 | **Large movie catalogues:** 108,521 movies → 12.6 M characters, 11 s to open, a 3.3 s UI freeze while parsing, and free memory down to 71 MB during the download. A larger provider could run out of memory. The architecture's "index only" storage for over-budget sections is not implemented; it is the recommended follow-up. |
| S6-2 | No seeking, resume or subtitle/audio-track selection (Stage 7/8). |
| S6-3 | Physical remote, visual layout and poster loading behaviour on screen are unverified. |
| S6-4 | VOD Home-key suspend/restore uses AVPlay suspend/restore, unverified on the TV. |
| S6-5 | Adult content is flagged, not hidden (parental UI in Stage 8). |
| S6-6 | M3U playlists' movies/series are not stored (Xtream only). |
| S6-7 | Container formats other than those played in the test (e.g. AVI) are untested; unsupported formats show the error message. |

## 11. Mutation check

Each rule below was disabled in turn; the tests were run; the file was restored and verified by SHA-256.

1. a malformed row hides the whole catalogue;
2. unsafe image URLs accepted;
3. episodes unsorted;
4. no default extension;
5. VOD state not removed with the playlist;
6. an empty provider list replaces the stored list;
7. VOD uses the live buffer;
8. stale-generation guard removed;
9. Movies/Series offered for M3U;
10. Back does not stop playback.

Result: **9 of 10 caught**. "Back does not stop playback" is an equivalent mutation (closing the player screen destroys the controller, which stops playback as well). Details: `docs/TEST-REPORT.md` §15.
