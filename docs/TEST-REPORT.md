# Test Report

Stage 6 (movies and series), 2026-11-24. Earlier: Stage 5.2, 5.1, 5, 4B, 4, 3. Stage 6 results are in §15 and docs/STAGE-6-REPORT.md; §1 is current. Commands run in `C:\Users\imran\Documents\screenshelf` on Windows 11, Node 24.18.0.

Labels: **[W]** automated test on Windows; **[TV]** run on the UE50MU6100. Type checking and compilation are reported separately and are **not** counted as tests.

## 1. Summary

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | pass (0 errors) |
| Source compatibility rules | `npm run compat` | 92 files, 0 findings |
| Unit tests [W] | `npm test` | **232 tests, 232 pass, 0 fail** |
| Build tests [W] | `npm run test:build` | **5 tests, 5 pass, 0 fail** (≈ 5.4 s; real dev and release builds) |
| All of the above | `npm run check` | pass (exit 0) |
| Release check | part of the build tests | OK |
| TV self-test [TV] | dev build with the LAN dev sink | Stage 3 4/4; Stage 4 4/4 (§5); Stage 4B 2/2 (§9); Stage 5 4/4 (§12); Stage 5.1: recovery (3 runs), gzip guides, scale (§14); Stage 6: movies, series, VOD playback, live regression with a real Xtream provider (§15) |

**Total automated tests: 237** (232 unit + 5 build), all passing. Stage 6: +16 unit tests. Stage 5.2: 221 (216 unit + 5 build). Stage 5.1: +17 unit tests. Stage 5: 199 (+27 unit tests). Earlier totals: Stage 4B 172. Stage 4B: +17 unit tests (PIN tests rewritten 14 → 19; new: 9 UI, 3 slicer). Stage 4: 150 + 5. Stage 3: 94 + 5.

The test runner has a per-test timeout (20 s unit, 300 s build), so a test that waits forever fails instead of hanging.

## 2. Stage 4 unit tests (all [W])

Fixtures (synthetic; no real provider data or credentials): `tests/fixtures/m3u/` (provider-style extended M3U with Xtream URLs, VOD/series entries, user agents, catchup, duplicates and a broken entry; plain CRLF playlist with BOM; double-encoded UTF-8 with CR-only line ends; HLS master manifest; HTML error page) and `tests/fixtures/xtream/` (auth ok / refused / expired, live categories, live streams with mixed typing and invalid items, short EPG with base64 text). Generated in tests: hostile playlists, 50,000-entry M3U and JSON lists.

| File | Tests | Covers (prompt §7 item) |
|---|---|---|
| `text.test.mjs` | 5 | Cleaning of control/zero-width/bidi characters and caps; UTF-8 decoding incl. 4-byte, overlong, surrogates, truncation; mojibake repair; base64 (standard, URL alphabet, no padding, malformed, size cap); tolerant Xtream scalars (encoding, malformed entries) |
| `m3u-parser.test.mjs` | 7 | Every metadata field (tvg-id, tvg-name, logo, group-title, tvg-chno, catchup, user agent, referrer, radio, #EXTGRP, header EPG URLs); identical results for every chunk size including 1-character chunks and CR/LF splits; BOM, CRLF, CR-only, double-encoded names; quoting variants; hostile metadata; over-long lines skipped without buffering; entry cap; HLS / HTML / JSON / empty verdicts (M3U, M3U8, encoding, metadata, malformed, large) |
| `json-array-stream.test.mjs` | 5 | Elements across arbitrary chunk boundaries (escaped quotes, brackets in strings, nesting, primitives); escaped backslash at a boundary (every cut point); non-array capture; truncated, invalid, stray and oversized elements; 50,000 elements (large) |
| `xtream-client.test.mjs` | 13 | Server normalisation and URL validation; M3U link splitting; authentication with typed account, request goes only to the configured origin with no headers/cookies, echoed password and advertised `server_info.url` not kept; auth failures (auth 0, 401, 403, not Xtream, invalid input, nothing sent); expired status; category validation; streamed live list with field validation and invalid items counted; auth error object on the list endpoint; EPG base64 and timestamp validation; retries on network/5xx only; abort; mid-list connection drop; redirects (cross-origin and https→http blocked, same-origin accepted, no element of a redirected list delivered); errors never contain credentials; URL builders (Xtream authentication, API validation, network failures, credential redaction) |
| `m3u-source.test.mjs` | 10 | Section classification; provider playlist import (counts, categories, adult flag, Xtream refs, placeholders for other hosts, unrelated tokens kept, EPG references); **stored catalogue contains no credentials**; templating and play-time substitution; hostile playlist (javascript:/data:/file:/rtmp:/userinfo/space/over-long URLs dropped, markup inert); not-playlist / single HLS / empty / VOD-only; early stop for non-playlist bodies; network/HTTP/redirect/drop/size/abort errors; codec round trip, prefix sharing, malformed rows; **50,000-channel import** (large, malformed, credential redaction) |
| `playlist-service.test.mjs` | 14 | Add with validation, credentials only in the key store, nothing secret in localStorage, files or logs; playlist limit; key-store failure leaves nothing; update/switch/remove (secret and files removed); M3U refresh end to end and loadLive; **incremental update** (unchanged catalogue not rewritten, change rewritten); Xtream refresh with account status, expired account keeps old catalogue; failed refresh keeps old catalogue; busy and abort; **interrupted import detected after a simulated restart**, temp and orphaned files cleaned, idempotent; **crash between the live and meta writes detected as inconsistent** and repaired by re-import; corrupt/tampered files removed; play-time resolution (Xtream ref, placeholders, plain URL, format, none without the secret); EPG references; cleartext notice; invalid stored list discarded (storage persistence, interrupted imports, credential redaction) |
| `log-redact.test.mjs` | +1 | Xtream M3U stream URLs without a type prefix redacted; ordinary paths not; `carriesCredentials` for such URLs |
| `catalogue-store.test.mjs` | +1 | Checksum reported on save and load; unchanged payload not rewritten |

Stage 3 tests (unchanged, all passing) are listed in §6. One Stage 3 test was updated: `bootstrap.test.mjs` now also expects `ctx.playlists` (present on a capable platform, `null` without file storage and key store, one more start-up warning).

## 3. Mutation check (Stage 4)

To confirm the new tests detect real defects, six rules were disabled one at a time and the related tests run (script in the session scratchpad; each source restored and verified byte-identical by SHA-256):

| Mutation | Failing tests |
|---|---|
| Credential placeholders disabled (credentials would be stored in catalogue files) | 6 |
| Logo URL validation disabled | 1 |
| Xtream server path check disabled | 2 |
| live/meta checksum consistency check disabled | 1 |
| Over-long line limit disabled | 1 |
| JSON element size cap disabled | 1 |

Stage 3 mutation results (redirect guard 2, PIN comparison 4, catalogue checksum 1) are unchanged.

## 4. Performance on Windows [W]

Reported by the tests (Node 24, desktop CPU; for comparison only, not TV figures):

| Measurement | Result |
|---|---|
| 50,000-channel M3U (10.4 M characters), 64 KB chunks, fake XHR | import ≈ 0.8–1.0 s; stored payload 4.96 M characters (48 %); decode of the stored payload ≈ 80 ms |
| 50,000-element JSON list (6.3 M characters) | ≈ 100–140 ms |

## 5. On the TV ([TV], UE50MU6100)

Raw log: `docs/evidence/stage4-tv-selftest.jsonl` (forwarded by the dev-only LAN log sink; contains no credentials, not even the synthetic ones). The sink's request log, including the requests that reached the second origin: `docs/evidence/stage4-dev-sink-requests.txt`.

Set-up: dev build with `SS_DEV_SINK_URL=http://192.168.1.180:8097/ingest`. The PC dev sink served synthetic fixtures (`scripts/lib/tv-fixtures.mjs`): an Xtream-style M3U with n channels in 120 groups (≈ 207 characters per channel), a fake Xtream API with the same channels, and 302 redirects to a second port (a different origin). Measurements went through the real `PlaylistService`, `tizen.filesystem` and `tizen.keymanager`. Playlist definitions were kept in memory; the test playlists, their files and secrets were removed afterwards. Port 8099 was in use by another process on the PC, so 8097/8098 were used.

### 5.1 Redirects (closes SECURITY-DECISIONS O4)

| Request | Result |
|---|---|
| Credentialed URL redirected to another origin | `redirect-blocked`. The TV's XHR had already sent the follow-up request to the second origin (the server logged it) |
| Credentialed URL redirected on the same origin | ok, `redirect=same-origin` |
| URL without credentials redirected to another origin | ok, `redirect=cross-origin` |

Same result in two runs.

### 5.2 Imports and cached loading

Run 3 (final code, after the parser fast paths). Free memory is from `tizen.systeminfo`, sampled at each progress callback.

| Source | Channels | Import total | of which download + parse | of which store | Stored | Cached load (read + decode) | Unchanged re-import | Free memory before → lowest |
|---|---|---|---|---|---|---|---|---|
| M3U (10.4 M chars) | 50,000 | **10.0 s** | 6.8 s | 3.2 s | 4.86 M chars (under the 5 M budget) | **3.9 s** | 7.1 s (store 0.4 s, no rewrite) | 363 → 292 MB |
| Xtream (14.8 M chars JSON) | 50,000 | **8.5 s** | 4.7 s | 3.9 s | 4.71 M chars | **4.0 s** | 5.6 s (store 0.5 s) | 362 → 201 MB |
| M3U stress (31 M chars) | 150,000 | 32.8 s | 21.0 s | 11.8 s | 14.8 M chars (over budget, flagged) | 11.4 s | 20.9 s | 275 → 146 MB |

Run 1 (before the fast paths in `cleanText`, line trimming, attribute parsing and credential templating): M3U 50,000 imported in 12.35 s; Xtream 50,000 in 9.2 s; M3U 150,000 in 35.9 s. Cached loads were the same (4.0 s, 4.1 s, 12.9 s).

Comparison with the prompt's reference figures:
- **50 MB in about 3 s (probe 2)** was a bare download plus line split. The full import does much more per entry: attribute parsing, cleaning, URL validation, credential templating and compact encoding. It processes about 1.5 M characters/s on the TV. A 50 MB playlist (≈ 240,000 channels at this density) would take about 35 s, so imports need a progress screen (Stage 5 UI).
- **Free memory ≈ 107 MB during parsing (probe 2, 50 MB)**: the lowest observed here was 146 MB with 31 M characters and 150,000 channels. No out-of-memory event.
- **Storage ≈ 1.5 MB/s**: store times match. 4.86 M characters took 3.2 s, including encoding and checksum. Cached loads of 4.7–4.9 M characters took 3.9–4.0 s, in line with the architecture's ≈ 3 s read estimate plus decode.

## 6. Stage 3 tests (unchanged)

| File | Tests | Covers |
|---|---|---|
| `bootstrap.test.mjs` | 7 | Context creation, disabled features without capabilities, config, start-up, Back → exit dialog, lifecycle, error boundary |
| `config.test.mjs` | 5 | Defaults, validation, security floor, budgets, load/save |
| `kv-store.test.mjs` | 5 | Envelope, corruption recovery, migrations, quota, namespace |
| `catalogue-store.test.mjs` | 7 (+1 Stage 4) | One file per section, header/checksum, recovery, budget, I/O errors, cleanup |
| `tizen-adapters.test.mjs` | 5 | TizenFileStore/TizenKeyStore against simulated Tizen APIs |
| `secret-store.test.mjs` | 4 | Key-store-only credentials, invalid secrets, generic errors |
| `pin.test.mjs` | 14 | PBKDF2 vectors, record, lockout, change, reset, constant-time compare |
| `url.test.mjs` | 5 | URL policies |
| `http-client.test.mjs` | 18 | Requests, streaming, limits, redirect guard |
| `retry.test.mjs` | 4 | Retry policy |
| `keys.test.mjs` | 8 | Key mapping, repeat throttle |
| `router-focus.test.mjs` | 7 | Router, focus |
| `log-redact.test.mjs` | 5 (+1 Stage 4) | Redaction, logger |

Stage 3 TV self-test steps were re-run with the Stage 4 build: file store 1 MB pass, key store pass, PBKDF2 100,000 iterations 146–170 ms, `responseURL` present.

## 7. Not tested

- On the TV: UI for playlists (not in the Stage 4 scope), responsiveness of the UI during an import (no import screen yet), real provider playlists (Q8), gzip-compressed playlists over a real server, a real Xtream panel.
- Recovery after a real power loss during an import. The protocol is tested with simulated crashes [W]; the TV parts (`moveTo` atomic replace) were verified in Stage 3.
- Playback of resolved stream URLs (Stage 7).

## 8. Earlier reports

The curated-VOD test report is archived at `docs/archive/TEST-REPORT-vod.md`. Probe results: `docs/PROBE-REPORT.md`, `docs/PROBE2-REPORT.md`. Stage 3 TV evidence: `docs/evidence/stage3-tv-selftest.jsonl`.

## 9. Stage 4B (playlist screens, PIN hardening)

### 9.1 New and changed automated tests [W]

| File | Tests | Covers (Stage 4B prompt, Part C) |
|---|---|---|
| `playlist-ui.test.mjs` | 9 | Driven only by remote key codes through the real key router and screen router, against the real PlaylistService and a fake DOM. **Remote navigation** and a single focus indicator; Back to the exit handler. **Playlist creation**: M3U typed on the on-screen keyboard (arrows + OK, digit keys), with the HTTP warning, import and details; Xtream with the password masked while typing and on the form. **Editing**: credentials never pre-filled, name-only change keeps the secret, validation message. **Deletion**: Cancel focused by default, then definition, secret and files deleted. **HTTP warnings**: Cancel sends nothing; https never warns; shown once. Import errors in plain language, and Try again. **Import progress and cancellation** with 50,000 channels: progress text, focus on Cancel, Back cancels, the previous list is kept, cancelled changes are not saved, event-loop lag < 150 ms with the whole list arriving in one progress event. Translations complete (English/Dutch). |
| `pin.test.mjs` | 19 (was 14) | PBKDF2 vectors; **P1** record = PBKDF2(pin, salt, 600,000), floor cannot be lowered; **P4** key-manager storage, nothing in localStorage; **P2** 6–8 digits, migration of a Stage 3 4-digit record with upgrade flag and re-hash; **failed attempts and lockout** (verify, change and reset all locked); **PIN changes** need the current PIN and keep the code; **recovery codes**: shown once, verifier only, 150 codes all distinct, all 32 symbols, roughly uniform, regeneration invalidates the old code, guesses share the lockout; **authenticated reset** (PIN, code); **unauthenticated reset**: exact phrase, content deleted before the PIN, failure keeps the PIN, interrupted wipe resumed on load; **crash-safe PIN replacement**: power loss before each of the 3 steps leaves exactly one valid PIN; highest generation wins; corrupt, tampered or unreadable record fails closed |
| `slicer.test.mjs` | 3 | Synchronous mode; yielding after the budget with order preserved and other timers running between slices; stop and cancel |
| `config.test.mjs` | 5 (updated) | Default 600,000; 100,000 now rejected as below the floor |
| `bootstrap.test.mjs` | 7 (updated) | Root screen is the playlist overview; without secure storage it is the diagnostics screen |

Mutation check (each rule disabled, related tests run, source restored and verified by SHA-256):

| Mutation | Failing tests |
|---|---|
| PIN replacement written into the same slot (not crash-safe) | 3 |
| Unauthenticated reset removes the PIN before the content | 1 |
| Recovery-code check skipped | 3 |
| Six-digit minimum removed | 1 |
| Corrupt PIN slot treated as "no PIN" (fail open) | 1 |
| Password shown in clear on the form | 1 |
| HTTP warning skipped | 2 |
| Import time-slicing disabled | 1 |

Windows performance (`playlist-ui.test.mjs`, fake XHR, whole 10.4 M-character list in one progress event): 50,000 channels imported through the UI in ≈ 0.9–1.05 s. The maximum event-loop lag was 16–28 ms (the slicer works). Cancel was acknowledged in 6–18 ms.

### 9.2 On the TV [TV]

Raw log: `docs/evidence/stage4b-tv-selftest.jsonl` (two runs; contains no PIN, recovery code or playlist credential). Dev build with the LAN dev sink on port 8097 and the synthetic fixtures of Stage 4.

**Key events were injected** into the real key router by the dev self-test (`src/dev/device-selftest-stage4b.ts`). The physical remote was **not** used.

**PIN on the real key manager and WebCrypto** (both runs passed; run 2 values):

| Step | Result |
|---|---|
| Set first PIN (PIN verifier + recovery-code verifier: 2 × 600,000 iterations) | 1,706 ms |
| Verify (600,000 iterations) | **796 ms** (run 1: 808 ms) |
| Wrong PIN | rejected |
| Change with a simulated power loss before the old slot is removed | 1,714 ms; 2 slots left |
| Restart (new service instance, `load()`) | new PIN valid, old PIN rejected, stale slot removed (1 slot left) |
| Reset with the recovery code | 816 ms; 0 slots left |

**Playlist UI, 50,000-channel M3U (10.4 M characters, http://, synthetic credentials)**, driven by injected keys: overview → details → Update now → HTTP warning → Continue → import → Close; then Update now again and Back after 3 s.

| Measurement | Run 1 (file I/O in one loop) | Run 2 (final code: file I/O one chunk per turn) |
|---|---|---|
| HTTP warning shown first time / second time | yes / no | yes / no |
| Import through the UI | 12.9 s | **13.3 s** |
| Longest event-loop stall during the import (50 ms probe) | **3,024 ms** | **382 ms** |
| Stalls over 100 ms during the import | 3 | 2 (both in the save phase: encoding and checksum of 4.9 M characters) |
| Longest stall during the cancelled run (download + parse only) | 22 ms | 143 ms |
| Cancel (Back) acknowledged on screen | 103 ms | **103 ms** |
| Channel list after the cancelled run | 50,000 kept | 50,000 kept |
| Cached load after the runs | 4.7 s | 3.9 s |
| Free memory before → lowest during import → after | 180 → 157 → 120 MB | 213 → 172 → 138 MB |

Finding and fix: run 1 showed a 3 s freeze. Parsing was already time-sliced, so the cancelled run, which never saves, stalled at most 22 ms. The freeze came from `TizenFileStore`, which wrote and read the whole file in one synchronous loop (≈ 1.5 MB/s). It now writes 100 K and reads 128 K characters per event-loop turn. The 1 MB file self-test still passes (2.4 s, previously 1.9 s). Remaining stall: ≈ 0.4 s while the 4.9 M-character catalogue is encoded and checksummed (synchronous `JSON.stringify` and FNV-1a).

Import duration through the UI (13.3 s) is longer than the Stage 4 service-only measurement (10.0 s). That is the cost of yielding to the UI: slices plus chunked file I/O. Measured, not estimated.

## 10. Stage 4B: not tested

- **Physical remote**: every TV interaction above used injected key events. Focus visibility, text size and readability from the sofa, and the on-screen keyboard were **not visually inspected** on the TV.
- Event-loop stalls during a cached load (`loadLive`: 3.9 s, of which decode is synchronous) were not probed.
- PIN screens don't exist yet (Stage 8); the PIN was exercised through the service only.
- The unauthenticated reset (content wipe) was tested on Windows only, not on the TV.
- Dutch strings are tested for completeness, not reviewed by a native speaker.

## 11. Stage 5 automated tests [W]

Fixture: `tests/fixtures/xmltv/guide.xml`, a synthetic guide with several time-zone offsets, entities, CDATA, skipped elements, an unmapped channel and invalid programmes. Large playlists and guides are generated inside the tests.

| File | Tests | Covers (Stage 5 prompt, Part H) |
|---|---|---|
| `epg.test.mjs` | 9 | **Time-zone conversion** (+hhmm, −hhmm, Z, `+hh:mm`, no seconds, no offset with a configurable default, invalid). **EPG parsing**: channels, programmes, entities, CDATA, skipped elements, invalid programmes; identical results for every chunk size (incremental); gzip bytes, HTML and huge tags rejected; markup in titles never kept. **EPG mapping**: tvg-id case-insensitive, display-name match, unmapped channels; window filter; now/next before, during and after; **missing programme data**. **EPG refresh**: from the playlist sources (header XMLTV with credentials resolved, `.gz` source rejected); cache written without credentials; reload from cache after a restart without network; failures keep the old guide; staleness; abort; no source; source change replaces the guide; Xtream short-EPG fallback, cached |
| `live-player.test.mjs` | 10 | **Channel switching**: 2 s buffer passed; 400 ms zap debounce (only the last of rapid presses opens); old stream stopped at once; callbacks of an old channel ignored. **Player state management**: loading → playing → buffering → playing, start-up time, pause/resume, suspend/restore, stop, destroy. **Error recovery**: dead channel shows the error without looping, Retry reloads; 15 s watchdog; a drop during playback reconnects 3 times (2/5/10 s) then errors; a successful reconnect resets the counter; no engine; no source; URLs never logged. AVPlay engine against a fake `webapis.avplay`: verified call order, buffering parameters, user agent, error mapping, stale sessions ignored, teardown never throws, video object removed |
| `live-ui.test.mjs` | 8 | Driven by remote key codes. **Channel navigation**: logos, names, current programme, channel details with times, description, next programme, missing EPG; ↑/↓, end of list, CH+ paging. **Category navigation**: list follows the focused category, OK jumps to the channels, Back steps left and then leaves. **Favourites** (add/remove, star, category) and **recently watched** (recorded on picture start). Player: CH+/CH−/↑/↓ zapping with wrap and debounce, banner, Play/Pause, error text and OK to retry, Home-key suspend/restore, transparent page while playing. **Channel search** by name and by channel number, no-results message. **Keyboard strategy**: IME preferred, arrows/OK go to the IME, Back closes the IME first, Done and Cancel keys, fallback keeps the text, password input type and clearing. **Performance** with 1,000, 10,000 and 50,000 channels (below) |
| other changes | — | `bootstrap.test.mjs` (Stage 5 services, warnings), `config.test.mjs` (new keys), fake DOM extended with events, focus, `insertBefore` |

Mutation check (Stage 5 rules disabled one at a time; sources restored and verified by SHA-256):

| Mutation | Failing tests |
|---|---|
| Zap debounce removed | 1 |
| Stale-channel guard removed | 1 |
| Reconnect limit removed | 1 |
| XMLTV offset sign flipped | 5 |
| EPG window filter removed | 1 |
| Display-name mapping removed | 2 |
| IME: Back cancels instead of closing the IME first | 1 |
| Category switch keeps the old list position | 2 |

Windows performance (`live-ui.test.mjs`; fake DOM and fake XHR, for comparison only):

| Channels | Screen ready | Guide refresh | Key press | Category switch | Search | Heap |
|---|---|---|---|---|---|---|
| 1,000 | 6 ms | 241 ms (26,000 programmes) | 0.03 ms | 19 ms | 1 ms | +40 MB |
| 10,000 | 52 ms | 444 ms (52,000) | 0.03 ms | 12 ms | 1 ms | +110 MB |
| 50,000 | 250 ms | 493 ms (52,000) | 0.03 ms | 16 ms | 10 ms | +35 MB |

The list keeps 11 pooled row nodes regardless of the channel count (asserted).

Bug found by these tests and fixed: switching category while the category column had focus left the channel list scrolled, and visually focused, at the old position.

## 12. Stage 5 on the TV [TV]

Raw log: `docs/evidence/stage5-tv-selftest.jsonl` (final run; contains no credentials). Dev build with the LAN dev sink on port 8097.

Conditions:
- **Synthetic streams**: ffmpeg test pattern encoded live by the PC (probe 2 encoder settings), served over the LAN.
- **Synthetic guide**: generated XMLTV.
- **Injected key events** through the real key router. The physical remote was **not** used, and nothing was visually inspected.

### 12.1 Playback with the real AVPlay (synthetic LAN streams; not a real provider)

Three runs. Values are from the final run, with the range over all runs.

| Step | Result |
|---|---|
| OK on "Test H.264 AAC" → picture (`oncurrentplaytime` > 0) | **3.9 s** (runs: 3.9–4.2 s); 2 s buffer |
| Stable for the next 8 s | yes (no drop, no buffering message) |
| CH+ → "Test H.264 MP2" picture | **4.2 s** including the 400 ms debounce (start-up 3.8 s; runs 3.8–4.5 s) |
| CH+ → channel with HTTP 404 | error "connection" after **11.2 s**, OK-to-retry hint shown |
| CH+ → connection refused | error "connection" after **11.1 s** |
| CH+ (wraps) → first channel again | picture after 4.3–4.4 s in 2 of 3 runs; **in 1 run it hit the 15 s watchdog** (timeout) right after two failed channels |
| Back | returns to Live TV; page no longer transparent |

### 12.2 Live TV at scale

Guide for 2,000 channels (26 programmes each, 11 MB XMLTV) for the 10k and 50k lists; 1,000 channels for the 1k list. Stalls = lateness of a 50 ms timer.

| Measurement | 1,000 | 10,000 | 50,000 |
|---|---|---|---|
| Playlist import | 0.45 s | 2.6 s | 13.2 s |
| Screen ready (push → list rendered) | **0.20 s** | **1.0 s** | **4.9 s** |
| of which catalogue load (file read + decode) | 0.13 s | 0.87 s | 4.3 s |
| of which index + first render | 11 ms | 39 ms | 196 ms |
| Guide refresh (download + parse + save) | 4.8 s (26,000 programmes) | 9.2 s (52,000) | 8.3 s (52,000) |
| Guide cache load (later opens) | 2.0 s | 4.2 s | 4.9 s |
| Longest stall while opening and refreshing the guide | 712 ms | 520 ms | **1,263 ms** |
| Key press (↓) handling | 1.4 ms | 1.2 ms | 1.1 ms |
| Category switch (after the 150 ms debounce) | 20 ms | 29 ms | 33 ms |
| Search "999" (Done in the system-keyboard dialog → results shown) | 18 ms | 36 ms | 89 ms |
| Longest stall while navigating and searching | 74 ms | 28 ms | 19 ms |
| Lowest free memory | 177 MB | 136 MB | 142 MB |

The guide cache load is reported as the elapsed time of `epg.load()` alone; that includes a file read of 2.6–5.3 M characters.

Not reproduced: in one earlier run the app stopped logging right after the 10k guide refresh. It is unclear whether the app hung or only the log forwarding stopped. A complete rerun of all four suites passed. Recorded as a risk.

## 13. Stage 5: not tested

- The physical remote; on-screen appearance (focus, logos, banner, video behind the transparent page); typing with the Samsung IME, and its Done/Cancel key codes (only a dispatched Done event was used).
- Real provider streams, HLS live, HEVC/AC3 streams in the player (formats were verified in probe 2, not through the Stage 5 player).
- Compressed `.gz` guides (not supported).
- Long-running playback (only 8–10 s per channel), memory over hours.

## 14. Stage 5.1 [W] and [TV]

Details, tables and evidence locations: `docs/STAGE-5.1-REPORT.md` (§3 recovery, §4 gzip, §5 performance). Physical tests: `docs/STAGE-5.1-PHYSICAL-TEST-CHECKLIST.md` (not yet performed).

| File | Tests | Covers |
|---|---|---|
| `live-recovery.test.mjs` | 10 | Part C items 1–7 (one / two failed channels then a working one, late error of an earlier channel, rapid changes while opening, 20 failure/recovery cycles, cleanup after timeout, no stale callback changes the current channel) and the prepare-stall reopen (once, 3 s after buffering, inside 15 s; never for dead channels, prepared streams, a left channel or when disabled) |
| `gzip-epg.test.mjs` | 7 | Decoder identical to zlib for all strategies, piece sizes and multi-member files; bad header, truncation, corruption fuzz, CRC/ISIZE, empty, bomb, size limits; EPG refresh with .gz name, Content-Type, magic bytes, Content-Encoding, uncompressed regression; failures keep the previous guide; no overrideMimeType; credentials never logged; 13.8 MB guide with event-loop gaps ≤ 66 ms |
| other changes | — | `epg.test.mjs` (gzip source now decodes; a truncated one fails), fake HTTP server (binary bodies, headers, Content-Encoding), fake engine (late settlement of abandoned loads) |

Mutation check: 10 of 10 Stage 5.1 rules caught (report §7).

TV summary [TV] (injected keys, synthetic LAN streams):

| Run | Working channels played | Notes |
|---|---|---|
| Before the fix, streams joined mid-packet | 34 / 38 | 4 timeouts (AVPlay prepare stall) |
| Before the fix, packet-aligned streams | 37 / 38 | 1 timeout |
| After the fix (final) | **47 / 47** | 6 stalls reopened and recovered; dead channels 25 / 25 "connection" after 11.1–11.4 s |
| After the fix (partial run, sink stopped) | 18 / 18 | 4 stalls recovered |
| gzip guides (2,000 channels) | valid ×3 ok, corrupt and truncated → bad-gzip with guide kept, uncompressed ok | refresh 10.4–11.4 s vs 8.9 s uncompressed |

## 15. Stage 6 [W] and [TV]

Details: `docs/STAGE-6-REPORT.md`. Physical remote and visual checks: NOT TESTED.

| File | Tests | Covers |
|---|---|---|
| `vod.test.mjs` | 10 | Xtream movie/series categories, lists, `get_vod_info`, `get_series_info` (tolerant typing, ratings, years, durations, extensions, unsafe images, invalid entries, episode layouts, missing seasons); codec; index/search; persistence on a TV-like file store with Unicode; restart; details cache; movie and episode URLs; no credentials in logs or files; incremental updates; missing-file rewrite; empty/malformed/auth/truncated/network responses keep the stored list; M3U not supported; one refresh at a time; state removed with the playlist; 50,000 movies |
| `vod-ui.test.mjs` | 6 | Movies/Series buttons (Xtream only); browse, grid navigation, category switch, IME search, posters/placeholders; movie details, Play, pause/resume, Back chain; series seasons/episodes and episode playback; failed and empty series info; player errors and Retry, progress bar, Home suspend/restore; VodController watchdog and stale callbacks; Live TV ↔ VOD regression on the shared engine |

TV [TV] (real Xtream provider, injected keys): movies 108,521 (download 34.5 s, open 11.8 s, 3.3 s freeze while parsing, lowest free memory 71 MB), series 25,489 (11.0 s / 3.0 s); a movie started in 1.7 s and an episode in 2.0 s; Live TV after VOD started in 1.3 s. Evidence: `docs/evidence/stage6-tv-selftest.jsonl`.

Mutation check (rules disabled one at a time, sources restored and verified by SHA-256): malformed row hides the catalogue 1 failing; unsafe image URLs accepted 1; episodes unsorted 2; no default extension 1; VOD state kept after playlist removal 1; empty provider list replaces the stored list 1; VOD uses the live buffer 2; stale-generation guard removed 1; Movies/Series for M3U 1; Back without stop 0 (equivalent: closing the player screen destroys the controller, which also stops playback). 9 of 10 caught, 1 equivalent.
