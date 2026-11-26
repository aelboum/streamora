# Stage 8 — EliteStream application audit and development roadmap

Date: 2026-11-25. Audit and planning only: no source, configuration, provider setting or design file was changed. This roadmap replaces the older one in `docs/COMPREHENSIVE-FUNCTIONAL-AUDIT.md` §J (most of its items are now done or decided).

Target: Samsung UE50MU6100, Tizen 3.0 (ES5, one AVPlay decoder per app, about 170–400 MB free memory with the user's catalogue). Provider: Xtream, 21,986 live channels, about 108,500 movies, 25,489 series.

**Sources**
- The code in `src/` (24,086 lines including dev-only suites); 32 unit-test files (304 tests) and 5 build tests;
- the earlier reports `docs/COMPREHENSIVE-FUNCTIONAL-AUDIT.md`, `STAGE-7D`, `7E`, `7F`, `7F-D5`, `7F-E`;
- the TV evidence in `docs/evidence/`.

**Evidence tags**
- **[CODE]** read in the source;
- **[TV]** measured on the TV in an earlier stage (file named);
- **[DOC]** stated in an earlier report;
- **[NT]** never tested.

---

## 1. Current application status

The application is **functionally complete for its core IPTV use** on the target TV:
- add an Xtream or M3U account;
- browse and play live TV;
- browse and play movies and series;
- search, Continue watching, favourites, PIN-protected adult content, and settings.

Since Stage 7F, the user has physically checked the remote handling on Live TV and the Stage 7F player changes.

What holds it back from feeling finished is **speed at a few specific points**, a few **missing everyday conveniences** (VOD favourites, channel-number entry, sorting), and **untested long-run stability**. Every one of these is measured or checked in the code below.

There is one structural risk outside the code. **The repository has a single commit (Stages 1–6); all work from Stage 6.1 to 7F-E is uncommitted (91 `git status` entries).** One disk or tooling mistake could lose two weeks of work. This is your decision, but it is the cheapest risk reduction available.

## 2. Completed functionality (checked in the code, not assumed)

| Area | What exists | Evidence |
|---|---|---|
| Accounts | Up to 20 playlists (Xtream, M3U); add/edit/remove/set active; credentials only in the TV key manager; HTTP warning; account expiry shown in details | [CODE] `playlist-service.ts`, `playlist-*-screen.ts`; [TV] Stage 4/4B |
| Import | Streaming M3U and Xtream import, time-sliced; incremental "skip unchanged" save; ASCII-safe storage (Stage 5.2) | [TV] 50,000 channels in 10 s |
| Home | Hub with Live TV / Movies / Series / Settings tiles, Continue watching row, provider chip, bottom bar (Home, Search, Favourites, TV) | [CODE] `home-screen.ts`, `sections.ts` |
| Live TV | Categories, virtual channel list, Search / Favourites / Recently watched / All pseudo-categories, mini preview in the side panel (Stage 7E/7F), info panel, guide actions | [CODE] `live-tv-screen.ts`; [TV] 400-key fuzz, 0 errors; physical remote checked by you |
| Live player | CH±/▲▼ zapping with wrap, banner, retry, 3 reconnects with back-off, prepare-stall reopen, watchdog | [TV] Stage 5.1 |
| Movies & Series | Paged index-only storage (opens in 0.1–0.2 s), category grid, posters, details, seasons/episodes, browse search with progressive results | [TV] Stage 6.1 |
| VOD player | Seek (where the file allows), seek cursor, resume with honest failure, Continue watching (50 per account), auto-hiding controls, elapsed/total | [TV] Stage 7D/7F |
| Tracks | Audio and subtitle selection; container probe by byte ranges; audio metadata matching (D5); subtitle metadata matching (7F-E) | [TV] Stage 7F, D5, 7F-E |
| Search | Global search across channels, movies and series | [CODE] `search-screen.ts` |
| Parental | 6–8 digit PIN, PBKDF2 600k (0.8–1.0 s), lockout, recovery code, adult categories locked in Live and VOD | [TV] PIN cost; the lock flow on the TV [NT] |
| Guide | XMLTV + gzip, EPG index, now/next, guide grid (Green/Guide key), memory guard | [TV] grid works; **coverage and updates limited** (EPG paused) |
| Settings | UI language EN/NL at runtime, preferences | [CODE] |
| Diagnostics | Diagnostics screen, local log ring with redaction, dev-only LAN log sink | [CODE] |
| Android | Same code base, Media3 engine, APK builds | **never run on a device** [DOC] |

## 3. Outstanding issues

### 3.1 Measured defects and weaknesses

| # | Issue | Measured | Root cause | Impact |
|---|---|---|---|---|
| O1 | **Global Search shows nothing for 3.3–5.6 s** | [TV] Stage 7D §B.D | `search-screen.ts` uses only the final result; the first results exist after 0.26–0.42 s | High: the main search feels broken for real words |
| O2 | **Entering Live TV takes 2.5–2.8 s every time** | [TV] `live tv ready loadMs 2498 / 2791` (7E run 2) | The screen is rebuilt on each visit (the router destroys screens) and `loadAll()` re-reads and decodes the 21,986-channel file | High: the most used screen, every visit |
| O3 | **Catalogue updates freeze the UI 0.5–2.7 s at a time** | [TV] Stage 6.1 | Synchronous native `FileStream.write` per page file | Medium: during updates only |
| O4 | **Movie/series search always scans all 11 name pages (≈ 3.4 s)** for "contains" queries | [TV] Stage 7D | The scan stops early only on ≥ cap *prefix* matches; provider titles start with tags ("\|EN\|") | Medium (browse search already shows results progressively) |
| O5 | **MKV without a seek index**: ±10 s and Resume silently do nothing until the 10 s / 5 s fallbacks | [TV] 1 of 15 sampled MKVs | Missing Cues; detected only after a failed seek | Low–medium (most titles are MP4 and seek) |
| O6 | **2 of 24 sampled indexed MKVs do not play at all** | [TV] Stage 7D | Unknown (codec/profile suspected) | Medium for those titles; the message the user sees is not specific |
| O7 | **The guide cannot update on this TV** (the memory guard stops it below 200 MB free; free memory is often 167–376 MB) | [TV] 7E run 2 | XHR `responseText` keeps the whole guide in memory | High for guide users; **EPG is paused by your decision** |
| O8 | **Browse stalls of 90–461 ms** correlate with low free memory | [TV] audit §C.7 | Garbage collection / memory pressure (correlation only) | Low–medium |
| O9 | **Launch refused until reinstall** after the TV went to standby (twice) | [TV] Stage 7D §B.E | Platform behaviour; cause unknown | Medium, if it also happens to normal remote launches [NT], not only to `sdb` launches |

### 3.2 Missing everyday features (checked in the code)

| # | Feature | State |
|---|---|---|
| M1 | Favourites for movies and series ("My list") | **Absent.** Favourites exist for live channels only (`user-lists.ts`); the Favourites shortcut opens Live TV |
| M2 | Channel number entry with the digit keys in the live player | **Absent.** Digits are mapped (`keys.ts` → `digit`) and used only by the PIN dialog |
| M3 | Previous-channel toggle | **Absent** |
| M4 | Movie/series sorting (A–Z, year, rating) and "recently added" | **Absent.** Year, rating and genre are stored per title. The provider's `added` date is parsed (`xtream-types.ts`) but **not stored** in the VOD pages, so "recently added" needs a storage change and one re-download |
| M5 | Series: "next episode" from Continue watching | Not built (Continue watching resumes the stored episode) |
| M6 | Catch-up (replay) for channels with `tv_archive` | Data present (`catchupDays` shown in the info panel); **playback absent** |
| M7 | Category management (hide, reorder) for 374 live categories | **Absent** |
| M8 | Account health: expiry warning, "too many connections" explained | Expiry shown in the details only; the connection limit is parsed but never used to explain playback errors |
| M9 | Automatic catalogue refresh | Manual only (no schedule) [CODE] |
| M10 | Movies/series of M3U playlists | Counted, not stored (Stage 6 decision) |

### 3.3 Not verified by a person (release gate)

[NT]:
- visual rendering of every screen since Stage 6.1, except where you checked it in Stage 7F;
- focus visibility;
- the colour keys Yellow and Guide on the physical remote;
- digit keys for the PIN;
- the adult lock flow on the TV;
- IME typing;
- long-running playback (the longest automated run was about 15 minutes);
- return from the Home key during VOD;
- Android on any device.

## 4. Architectural observations

**Strengths (keep):**
- Clear layering: `api` → `content`/`storage` → `services` → `screens`, with platform adapters behind interfaces.
- One shared player engine with a controller per use (live, VOD, preview). Stale-callback protection is everywhere and tested.
- Storage designed for Tizen's real limits: paged, checksummed, ASCII-escaped, chunked writes.
- A real test base: 304 unit tests, an ES5 compat gate on every build, and a release check that strips dev code.
- Strict privacy: no backend, credentials only in the key manager, redacted logs.

**Technical debt:**

| # | Item | Risk | Note |
|---|---|---|---|
| T1 | **Uncommitted work** (§1) | High | Your decision; no code change needed |
| T2 | `docs/IMPLEMENTATION-STATUS.md` stops at Stage 6 | Medium: it misleads future work | Update as part of the next stage's report |
| T3 | Large dev-only suites in `src/dev/` (7 files, about 3,000 lines), selected by a hand-edited `SUITE` constant | Low (release builds exclude them) | Could become a single parameterised dev runner; clean up later |
| T4 | Info-level engine logs on every subtitle cue and track read (`avplay-engine.ts`) | Low (local ring buffer only in release) | Lower to debug level when touching the engine |
| T5 | Screens are rebuilt on every visit (the router destroys them); there is no in-memory cache of loaded catalogues | The cause of O2 | A small, explicit cache with a memory limit, rather than keeping screens alive |
| T6 | No time-slicing for the cached live-catalogue decode and the EPG index build | UI stalls on entry | Part of the O2 fix |
| T7 | Android path unverified (APK built each time, never run) | Unknown | Keep building; test only when Android becomes a goal |
| T8 | Large single-purpose files: `playlist-service.ts` 772, `vod-browse-screen.ts` 694, `live-tv-screen.ts` 607 lines | Low | Split only when a stage already changes them |

**State management:**
- Per-screen state plus services is adequate. There is no global store, and none is needed.
- Preferences and lists are in the KV store (localStorage); catalogues are in the file store.
- The PIN attempt counter in localStorage can be reset by someone with storage access (known, `SECURITY-PIN-FOLLOWUP.md` F5).

**Error logging:**
- Local only, by design (no telemetry). The Diagnostics screen is the user-facing view.
- For support, a "share diagnostics" option is impossible without a backend; showing a short code on screen is the compatible alternative, if ever wanted.

## 5. Performance and stability observations

| Measure | Value | Source |
|---|---|---|
| App start to Home | 2.2–2.7 s (context ready), Home +3 ms | [TV] 7D, 21 launches |
| Live TV entry | 2.5–2.8 s, each time | [TV] 7E run 2 |
| Movies screen ready | 0.1–0.2 s; first titles 0.2–0.7 s | [TV] 6.1 |
| Global Search blank | 3.3–5.6 s | [TV] 7D |
| VOD start | 1.3–2.8 s (5.9 s once) | [TV] audit |
| Mini preview start | 0.2–1.3 s per channel, 0.7 s debounce | [TV] 7E/7F |
| Update stalls | 0.5–2.7 s | [TV] 6.1 |
| Free memory | 122–493 MB across runs; typical 170–280 MB with the catalogue loaded | [TV] all stages |
| Errors in automated runs | 0 in the 400-key Live TV fuzz and in every 7F/D5/7F-E run | [TV] |

**Memory risks:**
1. The guide download (O7; guarded, not fixed).
2. Posters while browsing (not separately measured).
3. The mini preview keeps the decoder busy while Live TV is open.
4. Any future in-memory caching (the O2 fix) must respect a floor: about 200 MB free, as the guide guard does.

**Stability gaps:**
- No run longer than about 15 minutes.
- No overnight standby/resume cycle.
- No test of the Home key during playback and back.

## 6. Recommended next stages

Ordered by user impact, reliability and implementation risk. Each stage is small enough to verify on the TV in one session. None touches subtitles, audio tracks, EPG or AI.

### Stage 9 — Speed where it is felt (recommended next)

1. **Objective:** remove the three measured waits the user meets most often.
2. **User-visible improvements:**
   - Global Search shows its first results in under 0.5 s and fills in progressively, with a "Searching…" state (today it is blank for 3.3–5.6 s).
   - Returning to Live TV is near-instant after the first visit (today 2.5–2.8 s every visit). The first visit's load does not block the UI.
   - No 0.5–2.7 s freezes while a catalogue update runs and the user is pressing keys.
3. **Technical changes:**
   - `search-screen.ts`: use the existing `onProgress` path (already used by browse search); `ensure()` only the visible cards; stop when the visible rows are full and offer "more".
   - A small live-catalogue cache in `playlist-service` / `live-screens`:
     - keep the decoded catalogue and channel index for the active account while free memory stays above the floor;
     - drop it on account switch, on refresh, and when memory falls below the floor;
     - time-slice the first decode.
   - Catalogue updates: defer page writes while a key was pressed in the last 1–2 s, and write at idle (`vod-service` / file store).
4. **Dependencies:** none.
5. **Risks:**
   - Memory: a cached 21,986-channel index costs memory (to be measured, likely 10–30 MB).
   - A stale cache after a refresh (handled by clearing on every refresh).
   - Search results growing while visible (keep the focused row stable).
6. **Tizen 3:**
   - ES5 only; no new APIs. Memory read through the existing `platform.memory()`.
   - Deferred writes still use the chunked FileStream path.
7. **Testing:**
   - Unit tests for progressive search, cache invalidation and the memory floor, and write deferral.
   - TV timing before and after: search for common, rare and Arabic queries; Live TV entry three times; key lag during an update; free memory over a 30-minute session.
8. **Complexity:** medium-low (3 contained changes, existing building blocks).
9. **Physical TV verification:** yes: type a search and watch results appear; enter and leave Live TV repeatedly; browse during an update.

### Stage 10 — Live TV everyday controls

1. **Objective:** make zapping work the way TV viewers expect.
2. **User-visible improvements:**
   - Type a channel number on the remote in the player (on-screen "1 2 _", jump after 1.5 s or OK).
   - A previous-channel key.
   - A quick channel list over the video (OK in the player) without leaving playback.
3. **Technical changes:**
   - `player-screen.ts`: a digit buffer and a channel-number lookup (`channel-index.ts`).
   - A last-channel memory (in memory, per session).
   - An overlay list reusing `virtual-list.ts`.
4. **Dependencies:** none. Stage 9's cache makes the overlay cheaper.
5. **Risks:**
   - Provider channel numbers may be missing or duplicated. Fall back to the list position and show which number was used.
   - Overlays above AVPlay video must be checked visually.
6. **Tizen 3:**
   - Digit keys 48–57 are already mapped.
   - Which key serves as "previous channel" on your remote must be chosen. The candidates are a colour key or Back from the banner; **your decision**.
7. **Testing:** unit tests for the digit buffer, duplicates and wrap; TV zapping with injected keys; **physical remote** for the digit keys.
8. **Complexity:** medium-low.
9. **Physical TV verification:** yes (digit keys and the overlay were never pressed or seen).

### Stage 11 — Movies & Series library comfort

1. **Objective:** make the 134,000-title library easier to use day to day.
2. **User-visible improvements:**
   - "My list" (favourites) for movies and series: add from Details; a My list category; a Home row.
   - Sorting within a category: A–Z, year, rating.
   - Series: Continue watching offers the **next** episode when the last one was finished.
   - Optional: "Recently added" (needs one catalogue re-download, see Risks).
3. **Technical changes:**
   - Extend `user-lists.ts` to VOD keys (bounded, per account).
   - Details/browse actions; a Home row.
   - Sorting inside the paged view, per category. Category sizes are bounded; sorting all 108k titles at once is **not** proposed.
   - Next-episode logic from `get_series_info` (already cached).
   - Recently added: store `added` in the page rows. This is a format change with a version bump and re-download.
4. **Dependencies:** none. Recently added depends on your approval of the storage change.
5. **Risks:**
   - Sorting a large category (thousands of titles) in memory costs memory and time, so it must be measured.
   - The storage format change for `added` forces a full re-download (about 2–3 minutes).
6. **Tizen 3:** ES5 sort with a stable comparator (`Array.prototype.sort` is not guaranteed stable in old engines); keep lists bounded.
7. **Testing:** unit tests for list bounds, sort stability and next-episode; TV timing for sorting the largest category; memory.
8. **Complexity:** medium.
9. **Physical TV verification:** yes (new rows and actions must be seen and reached with the remote).

### Stage 12 — Playback reliability and long-run stability

1. **Objective:** prove and harden stability over a real evening of use, and give clear answers when a title cannot play or seek.
2. **User-visible improvements:**
   - Titles that cannot skip (MKV without an index) say so up front and hide ±10/Resume, instead of failing after 5–10 s.
   - Titles that cannot play get a specific message.
   - Fewer surprises after the Home key or standby.
3. **Technical changes:**
   - The MKV seek-index pre-check: SeekHead/Cues via the existing byte-range probe, no extra service. It reuses `media-probe.ts`, which already reads the header, so it may need no extra requests.
   - Diagnose the two non-playing MKVs first (dev-only).
   - A soak test: 2–3 h of live playback with zapping, VOD playback, Home key and return, standby and wake, with memory logging.
   - Fixes only for what the soak finds.
4. **Dependencies:** none. Better after Stage 9, because the cache changes memory behaviour.
5. **Risks:**
   - The soak may find platform behaviour that the app cannot fix (for example the launch refusal after standby).
   - Report it rather than work around it.
6. **Tizen 3:** standby and visibility behaviour is platform-specific (JavaScript stops while hidden, Stage 7D).
7. **Testing:** a long dev-sink run with heartbeats; lab files with and without Cues; a provider sample.
8. **Complexity:** medium (most of the effort is measurement).
9. **Physical TV verification:** yes (Home key, standby and wake are physical actions).

### Stage 13 — Account health and catalogue freshness

1. **Objective:** keep the catalogue current and explain provider-side problems.
2. **User-visible improvements:**
   - An expiry warning on Home (for example 7 days before).
   - When a stream fails while the account is at its connection limit, say so instead of a generic error.
   - An optional automatic catalogue refresh at launch when older than N days; when and how often is **your decision**.
3. **Technical changes:**
   - Use the parsed `expiresAt` / `maxConnections` / `activeConnections` (`xtream-types.ts`).
   - A refresh policy in `playlist-service` with the Stage 9 write deferral.
4. **Dependencies:** Stage 9's write deferral, because an automatic refresh must not freeze the UI.
5. **Risks:**
   - Extra provider requests: one `player_api` call at launch.
   - A refresh at launch costs memory and time on a 100k-title account.
6. **Tizen 3:** none new.
7. **Testing:** unit tests for the policy; a TV run with a refresh at launch, measuring stalls and memory.
8. **Complexity:** low-medium.
9. **Physical TV verification:** yes, a short visual check of the warning.

### Stage 14 (optional, later) — Live category management and catch-up

- **Category management:** hide/reorder for 374 live categories. Medium complexity; physical TV verification yes.
- **Catch-up playback:** for channels with `tv_archive`. It needs the guide to pick a programme, and **EPG is paused**. Without the guide, a time-based "go back N hours" could work on Xtream (`timeshift` URL). It is listed so it is not forgotten; it should wait for the EPG decision.

## 7. Prioritized implementation order

| Order | Stage | Why here |
|---|---|---|
| 0 | (Your action) commit or back up the working tree | Protects all completed work; no development needed |
| 1 | **Stage 9 — Speed where it is felt** | Highest measured user pain, lowest risk, no dependencies |
| 2 | Stage 10 — Live TV everyday controls | Live TV is the most used area; small and self-contained |
| 3 | Stage 11 — Library comfort | Biggest functional gap (no VOD favourites) |
| 4 | Stage 12 — Reliability and soak | Should measure the app after 9–11 have changed it |
| 5 | Stage 13 — Account health and freshness | Builds on Stage 9's write deferral |
| later | Stage 14, EPG, AI | Decisions pending |

Each stage ends with `npm run check`, `npm run build:all`, a TV run, the release build restored, and a report.

## 8. Deferred features (by your decision or by dependency)

| Feature | Why deferred | Revisit when |
|---|---|---|
| Subtitles (external, VobSub/PGS rendering, hidden tracks) | Your decision | AI integration stage |
| EPG (streaming parser, matching, coverage, updates) | Your decision | When unpaused. O7 (guide cannot update) is the first item |
| Catch-up playback | Needs the guide | With EPG |
| M3U movies/series | Stage 6 decision; few M3U users expected | On request |
| Android device testing | Not the target | When Android becomes a goal |
| Thumbnails / timeline previews | Rejected (no thumbnail service; a second video element freezes AVPlay) | — |

## 9. Future AI architecture (identification only, nothing built)

**Hard constraints from this platform and your earlier decisions:**
- Tizen 3 cannot run a language model on the device: memory is about 170–400 MB free, the engine is ES5, and there is no GPU compute API.
- Any AI therefore needs a remote model. The project decision so far is **"no backend/telemetry"**. AI integration requires an explicit new decision about a relay or backend, about which data leaves the TV (search text, viewing history?), and about cost and keys. **The TV must never hold a model provider's API key**, so a relay would be needed.
- Requests must be small. The 108k-title catalogue cannot be sent; only the query and a small candidate list.

**Candidate capabilities, with a compatible design:**

| Capability | Compatible approach | Non-AI groundwork that helps now |
|---|---|---|
| Natural-language search ("Turkish comedy from the 90s") | The relay turns the query into structured filters (language tag, genre, year range); the TV runs them on its local index | Parse provider title tags ("\|EN\|", "TR -") into a language/country field; genre and year are already stored |
| Intelligent discovery / recommendations | Ranking from local history (Continue watching, favourites) plus title metadata; the relay ranks a small candidate set | Stage 11's My list and sorting, and the stored history |
| Content categorisation | Cluster or clean the provider's 374 live categories and VOD genres into a consistent set | Stage 14 category management |
| Voice navigation | The Samsung IME's voice input already produces text [NT]; the text goes into natural-language search | IME voice search physical test |
| Multilingual interaction | UI is EN/NL today; AI could translate queries or titles | `i18n` is already structured for more languages |
| Subtitles (later) | Translation or generation of subtitles via the relay | Kept out of scope by your decision |

**Recommendation:** before any AI stage, decide the backend/relay question and the data policy. The non-AI groundwork (title tag parsing, VOD favourites, history) makes the later AI features cheaper and is useful on its own.

## 10. Risks and dependencies

| Risk | Affects | Mitigation |
|---|---|---|
| Loss of uncommitted work | Everything | Commit or back up (your decision) |
| Memory floor on this TV (often < 200 MB free with the catalogue loaded) | Stages 9, 11, 12; EPG | Every stage measures free memory on the TV and respects a floor |
| Single AVPlay decoder | Preview, overlays, any picture-in-picture idea | Designs keep one stream; no second decoder |
| Synchronous FileStream writes | Updates, automatic refresh | Stage 9 write deferral before Stage 13 |
| Provider data quality (missing channel numbers, tags in titles, index-less MKVs) | Stages 10, 11, 12 | Fallbacks that say what they used; no guessing |
| Physical checks only you can do | Every stage | A short checklist in each report |
| TV wedging after standby (launch refused until reinstall) | TV test sessions | Tests avoid standby unless the stage is about it (Stage 12) |

## 11. Recommendation

**The single best next development stage is Stage 9 — "Speed where it is felt".**

It removes the three waits that are measured on your TV and met in normal use:
- the blank global Search (3.3–5.6 s);
- the 2.5–2.8 s Live TV load on every visit;
- the 0.5–2.7 s freezes during catalogue updates.

It needs no new feature decisions, no new APIs and no provider changes. It touches no subtitle, audio, EPG or AI code, and each part can be verified on the TV with before/after timings.

Separately, and before any further development, I recommend committing or backing up the current working tree. That is your decision and needs no code.

Waiting for your review and explicit authorisation before implementing anything.
