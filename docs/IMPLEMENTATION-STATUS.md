# Implementation Status

Updated: Stage 6 (movies and series), 2026-11-24. Earlier: Stage 5.2, 5.1, 5, 4B, 4, 3. Stage 6 report: `docs/STAGE-6-REPORT.md`; Stage 5.1: `docs/STAGE-5.1-REPORT.md`; Stage 5.2: `docs/STAGE-5.2-REPORT.md`. Architecture: `docs/ARCHITECTURE.md` rev 3 (approved).

Status per item:
- **Implemented**: code exists.
- **Tested [W]**: automated tests on Windows.
- **Simulated**: tested against simulated Tizen APIs.
- **TV**: verified on the UE50MU6100.
- **Not implemented**: later stage.

## A0. Stage 6 scope

| Area | Module(s) | Implemented | Tested [W] | TV (injected keys, real provider) |
|---|---|---|---|---|
| Xtream movie/series API: categories, lists (streamed), `get_vod_info`, `get_series_info` | `src/api/xtream/xtream-client.ts`, `xtream-types.ts` | yes | yes | yes: 108,521 movies, 25,489 series |
| Compact storage and decoding (malformed rows skipped) | `src/content/vod-codec.ts` | yes | yes | yes |
| Index and search | `src/content/vod-index.ts` | yes | yes | yes |
| VodService: download on first use, incremental update, missing-file rewrite, details cache, play-time URLs | `src/services/vod-service.ts`; `PlaylistService.xtreamClient/resolveStream` | yes | yes | yes |
| Browse screen (categories, poster grid, search, update) | `src/screens/vod-browse-screen.ts` | yes | yes (fake DOM) | yes, not visually inspected |
| Details: movie; series with seasons and episodes | `src/screens/vod-details-screen.ts` | yes | yes | yes |
| VOD player screen and controller (shared AVPlay engine) | `src/screens/vod-player-screen.ts`, `src/player/vod-controller.ts`, engine `timing()` / buffer 0 | yes | yes | movie and episode started (1.7 s / 2.0 s) |
| Movies / Series buttons (Xtream playlists) | `playlists-screen.ts`, `playlist-screens.ts`, `bootstrap.ts`, `vod-screens.ts` | yes | yes | yes |
| Styles | `src/styles/vod.css` | yes | CSS gate | not visually inspected |
| Seeking, resume points, subtitles, audio tracks | — | **no** (Stage 7/8; no progress or subtitle system exists) | — | — |
| Movies/series of M3U playlists | — | **no** (counted only, as before) | — | — |

## A1. Stage 5.1 scope

| Area | Module(s) | Implemented | Tested [W] | TV |
|---|---|---|---|---|
| Playback recovery: one reopen when AVPlay reported buffering but has not prepared 3 s later (`player.prepareStallMs`); stale callbacks and cleanup re-verified | `src/player/live-controller.ts`, `src/app/config.ts` | yes | yes (`live-recovery.test.mjs`, 10 tests) | **yes**, repeated runs with real AVPlay on synthetic LAN streams (report §3) |
| AVPlay lifecycle traces (debug level; no URLs) | `src/player/avplay-engine.ts`, `bootstrap.ts`, `main.ts` | yes | yes | used for the diagnosis |
| Streaming gzip/DEFLATE decoder with UTF-8 output and limits | `src/content/gzip.ts` | yes | yes (`gzip-epg.test.mjs`, 7 tests) | **yes** (report §4) |
| Binary XHR downloads (x-user-defined) and the Content-Type hook | `src/api/http-client.ts`, `src/app/platform/platform.ts` | yes | yes | **yes**: x-user-defined works on Tizen 3.0 |
| gzip detection and guide refresh (.gz name, Content-Type, magic bytes, Content-Encoding); errors `bad-gzip`, `gzip-unsupported` | `src/services/epg-service.ts`, `src/i18n/strings.ts` | yes | yes | **yes** |
| Config: `epg.maxGzipMB`, `player.prepareStallMs` | `src/app/config.ts` | yes | yes | defaults |
| Physical test checklist | `docs/STAGE-5.1-PHYSICAL-TEST-CHECKLIST.md` | yes | — | **for the user to perform** |
| Dev-only Stage 5.1 self-test, fixture variants (packet-aligned streams, gzip guides, connection log) | `src/dev/device-selftest-stage51.ts`, `scripts/lib/tv-fixtures-live.mjs` | dev only | — | ran |

## A. Stage 5 scope

| Area | Module(s) | Implemented | Tested [W] | TV |
|---|---|---|---|---|
| Live TV screen: categories, virtualised channel list, logos, names, current programme, details, actions | `src/screens/live-tv-screen.ts`, `src/components/virtual-list.ts` | yes | yes | 1k/10k/50k channels, injected keys |
| Pseudo-categories Search / Favourites / Recently watched / All channels | live-tv-screen + `src/content/channel-index.ts` | yes | yes | search through the IME dialog |
| Favourites and recently watched (per playlist) | `src/services/user-lists.ts` | yes | yes | recent recorded on picture start |
| Channel search (name substring, channel number prefix) | `channel-index.ts` | yes | yes | yes |
| Player screen: banner, CH+/CH−/↑/↓ zapping with wrap, OK = banner / retry, Play-Pause, Back | `src/screens/player-screen.ts` | yes | yes | **real AVPlay, synthetic LAN streams** |
| Player abstraction | `src/player/engine.ts` | yes | yes | — |
| AVPlay engine (verified call order, 2 s buffer, UA property [A], error mapping, safe teardown) | `src/player/avplay-engine.ts` | yes | yes (fake avplay) | **yes** |
| Live controller (zap debounce, watchdog, reconnects, cleanup, suspend/restore) | `src/player/live-controller.ts` | yes | yes | yes |
| XMLTV streaming parser, time zones | `src/content/xmltv-parser.ts` | yes | yes | 11 MB guide (2,000 channels) |
| EPG index, channel mapping, now/next | `src/content/epg-index.ts` | yes | yes | yes |
| EPG service: cache, refresh, staleness, Xtream short-EPG fallback | `src/services/epg-service.ts`; `PlaylistService.shortEpg` | yes | yes | refresh and cache load measured |
| System keyboard (IME) preferred, app keyboard fallback, password input | `src/screens/text-entry-overlay.ts`, `live-screens.ts`, form | yes | yes (fake DOM) | dialog opens; Done path via a dispatched event; **typing with the IME not tested** |
| Wiring: `ctx.epg`, `ctx.lists`, `ctx.engine`, `ctx.textInput`, "Live TV" on the overview | `bootstrap.ts`, `main.ts`, `playlists-screen.ts`, `live-screens.ts` | yes | yes | yes |
| Config: `epg.*`, `ui.keyboard` | `src/app/config.ts` | yes | yes | defaults |
| Catalogue section `epg` | `src/storage/catalogue-store.ts` | yes | yes | yes |
| Styles | `src/styles/live.css` | yes | CSS gate | not visually inspected |
| Dev-only Stage 5 self-test and live fixtures | `src/dev/device-selftest-stage5.ts`, `scripts/lib/tv-fixtures-live.mjs` | dev only | — | ran |

## 0. Stage 4B scope

| Area | Module(s) | Implemented | Tested [W] | TV |
|---|---|---|---|---|
| Playlist overview (root screen) | `src/screens/playlists-screen.ts` | yes | yes | injected keys |
| Add M3U / add Xtream / edit | `src/screens/playlist-form-screen.ts` | yes | yes | — (UI test only) |
| On-screen keyboard (URL helper keys, digit keys, masked secrets) | `src/screens/keyboard-overlay.ts` | yes | yes | not visually inspected |
| Playlist details, set active, remove with confirmation | `src/screens/playlist-details-screen.ts`, `confirm-dialog.ts` | yes | yes | injected keys |
| Import progress and cancellation; error messages; retry | `src/screens/import-dialog.ts` | yes | yes | **50,000 channels, cancel 103 ms** |
| HTTP security warning (once per server) | details screen + `confirm-dialog.ts` | yes | yes | shown once |
| Screen registration; root screen = playlists | `src/screens/playlist-screens.ts`, `src/app/bootstrap.ts` | yes | yes | boots |
| UI building blocks (rows, info list, frame) | `src/components/ui.ts` | yes | via screens | — |
| English + Dutch strings | `src/i18n/strings.ts` | yes | completeness test | — |
| Display formatting (masked URLs, dates, counts) | `src/screens/format.ts` | yes | via screens | — |
| Styles (focus indicators, rows, keyboard, dialogs) | `src/styles/playlists.css` | yes | CSS gate | not visually inspected |
| Time-sliced parsing (≤ 16 ms slices, rev 3 §6.2) | `src/content/slicer.ts`; used by `m3u-source.ts`, `xtream-client.ts` | yes | yes | stalls during parsing ≤ 143 ms |
| Chunked TV file I/O (one chunk per event-loop turn) | `src/app/platform/tizen-file-store.ts` (changed) | yes | simulated | **3.0 s stall → 0.38 s** |
| PlaylistService additions: `meta`, `removeAll`, store-phase progress, running-job abort | `src/services/playlist-service.ts` | yes | yes | yes |
| PIN P1 600,000 iterations / P2 six digits / P3 recovery code and resets / P4 key manager with crash-safe slots | `src/security/pin.ts` (rewritten), `src/app/config.ts`, bootstrap | yes | yes (19 tests) | **yes** (verify 0.80 s; rotation and restart) |
| Dev-only Stage 4B self-test | `src/dev/device-selftest-stage4b.ts`, `dev-hooks.ts`, `main.ts` | yes (dev only) | — | ran: 2/2 pass, twice |

## 1. Stage 4 scope

| Area | Module(s) | Implemented | Tested [W] | TV |
|---|---|---|---|---|
| Content model (Playlist, Channel, Category, StreamRef/PlaybackSource, EPG reference, Programme, CatalogueMeta) | `src/models/content.ts` | yes | yes (via services) | — |
| Text helpers for untrusted metadata (cleaning, UTF-8, base64, mojibake repair) | `src/content/text.ts` | yes | yes | via imports |
| Streaming M3U/M3U8 parser | `src/content/m3u-parser.ts` | yes | yes | 50,000 and 150,000 entries |
| Incremental JSON array reader | `src/content/json-array-stream.ts` | yes | yes | 50,000 Xtream streams |
| Credential templating (no credentials in stored data) | `src/content/credential-template.ts` | yes | yes | via M3U import |
| Compact live catalogue codec and builder | `src/content/catalogue-codec.ts` | yes | yes | 4.7–14.8 M chars stored and loaded |
| M3U source (download → parse → catalogue) | `src/content/m3u-source.ts`, `import-types.ts` | yes | yes | **10.0 s for 50,000 channels** |
| Xtream API client (auth, server info, live categories, live streams, short EPG, EPG table, XMLTV URL, stream URL builder) | `src/api/xtream/xtream-client.ts`, `xtream-types.ts` | yes | yes | auth, categories, streams against a fake panel |
| Xtream source | `src/content/xtream-source.ts` | yes | yes | **8.5 s for 50,000 channels** |
| PlaylistService (add/update/remove/switch, refresh, journal, incremental save, cached load, play-time and EPG resolution, cleartext notice state) | `src/services/playlist-service.ts` | yes | yes | yes (with the real file store and key manager) |
| CatalogueStore: checksum on save/load, skip unchanged | `src/storage/catalogue-store.ts` (extended) | yes | yes | unchanged re-import skips the write |
| Redaction of `/user/pass/id` stream URLs | `src/utils/redact.ts` (extended) | yes | yes | log evidence contains no credentials |
| Bootstrap wiring (`ctx.playlists`, recovery at start-up) | `src/app/bootstrap.ts` | yes | yes | boots |
| Dev-only Stage 4 self-test and PC fixtures | `src/dev/device-selftest-stage4.ts`, `scripts/lib/tv-fixtures.mjs`, `scripts/dev-sink.mjs` | yes (dev only) | — | ran: 4/4 pass |

## 2. Stage 3 scope (unchanged unless noted)

| Area | Module(s) | Implemented | Tested [W] | TV |
|---|---|---|---|---|
| Bootstrap, AppContext | `src/app/bootstrap.ts`, `main.ts` | yes | yes | boots, 530–605 ms |
| Lifecycle | `src/app/lifecycle.ts` | yes | yes | events not observed yet |
| Error handling | `src/app/errors.ts` | yes | yes | — |
| Configuration | `src/app/config.ts` | yes | yes | defaults used |
| Logging | `src/utils/log.ts`, `redact.ts` | yes | yes | entries forwarded by the dev sink |
| Router, key router, focus | `src/navigation/*` | yes | yes | 23 keys registered |
| Components / screens (foundation) | `src/components/button-list.ts`, `src/screens/*` | yes | yes (fake DOM) | not visually inspected |
| Platform interfaces and adapters | `src/app/platform/*` | yes | via doubles | capabilities all detected |
| File store, key store, crypto | `tizen-file-store.ts`, `tizen-key-store.ts`, `common.ts` | yes | simulated | **yes** (re-run in Stage 4) |
| KV store, catalogue store, secret store | `src/storage/*` | yes | yes | catalogue store as a whole: **yes** (Stage 4) |
| PIN service | `src/security/pin.ts` | **rewritten in Stage 4B** (see §0) | yes | yes |
| URL policies, HTTP client, retry | `src/api/url.ts`, `http-client.ts`, `retry.ts` | yes, unchanged | yes | **real redirect observed** (Stage 4) |

## 3. Interfaces added in Stage 4

| Interface | File | Notes |
|---|---|---|
| `PlaylistDef`, `Channel`, `Category`, `StreamRef`, `PlaybackSource`, `EpgSource`, `Programme`, `CatalogueMeta`, `LiveCatalogue` | `models/content.ts` | §4 of the architecture plus the additions in ARCHITECTURE.md §12a |
| `M3uParser`, `M3uEntry`, `M3uSummary` | `content/m3u-parser.ts` | push/end streaming API |
| `JsonArrayStream` | `content/json-array-stream.ts` | push/end streaming API |
| `XtreamClient`, `XtreamAccount`, `XtreamCategory`, `XtreamLiveStream`, `XtreamEpgListing`, `Raw*` provider shapes | `api/xtream/*` | provider shapes do not leave `api/xtream` and `content/xtream-source.ts` |
| `ImportHandle`, `ImportResult`, `SourceImport` | `content/import-types.ts` | shared by both sources |
| `LiveBuilder`, `LivePayload` | `content/catalogue-codec.ts` | compact stored form |
| `PlaylistService`, `RefreshJob`, `LiveLoad` | `services/playlist-service.ts` | `ctx.playlists` |
| `CatalogueStore.save(…, {unlessChecksum})`, `checksum` in results | `storage/catalogue-store.ts` | additive |

Reused without duplication: `HttpClient.request/stream`, `withRetry`, `checkUrl`/`originOf`, `KeyValueStore`, `CatalogueStore`, `SecretStore`, `fnv1a32`, `Logger`/redaction, memory stores and test fakes.

## 4. Decisions taken while implementing (no architecture change)

- **M3U URL always in the SecretStore.** The definition keeps only the origin. Rev 3 §4 allowed `url` in the definition when it carries no credentials; storing it uniformly as a secret is stricter and simpler.
- **Secret alias derived from the id** (`ss_pl_<id>`, Stage 3) instead of a stored `secretRef` field.
- **Only the live section is stored in Stage 4.** Movie and series entries are classified and counted (`counts.movie`, `counts.series`), not stored; movie/series catalogues are Stage 6 (out of scope).
- **Consistency between live and meta** uses the live file's header checksum (`meta.liveHash`) instead of an import id inside the payload. The same checksum drives the incremental "skip unchanged" save.
- **Xtream has no delta API**, so "incremental" means: the import always downloads, and the catalogue file is rewritten only if its content changed (saves ≈ 3–4 s per 50,000 channels on the TV).
- **Parsing is not time-sliced.** It runs inside the XHR progress events. On the TV the 50,000-channel import spends 6.8 s in download + parse; UI responsiveness during an import is untested (there is no import screen yet).
- Recorded in ARCHITECTURE.md §12a: StreamRef `cred` placeholders, `Channel.userAgent/referrer`, EpgSource `cred`, flat file names, the compact codec.

## 5. Known limitations

| # | Limitation |
|---|---|
| L1 | Redirects can't be approved before they are followed. On the TV the redirected request is sent before the app sees it (observed); the response is blocked (SECURITY-DECISIONS S5). |
| L2 | Closed in Stage 4B for reset (PIN or recovery code; otherwise everything is wiped). A 6-digit PIN can still be brute-forced offline by someone with access to the key-manager data (SECURITY-DECISIONS S2). |
| L3 | Key-manager overwrite isn't atomic (remove, then save). |
| L4 | The browser development platform keeps files and secrets in memory only. |
| L5 | `visibilitychange`, `online`/`offline` and `unhandledrejection` haven't been observed on the TV. |
| L6 | The diagnostics screen hasn't been visually inspected or navigated with the physical remote. |
| L7 | Import speed on the TV ≈ 1.5 M characters/s: 10 s for 50,000 channels, ≈ 33 s for 150,000. A 50 MB playlist would take about 35 s. Cached start ≈ 4 s per 50,000 channels (file throughput bound). |
| L8 | Sections above the 5 M character budget (≈ 50,000 channels) are stored and flagged; the "index only" fallback of rev 3 §7 isn't implemented. Above 20 M characters (≈ 200,000 channels) saving fails with `too-large`. |
| L9 | Per-stream tokens the app can't recognise as the playlist credentials are stored as part of the URL (SECURITY-DECISIONS S8/O7). |
| L10 | Credentials embedded in an M3U URL other than as `username`/`password` query parameters (for example `/get/<user>/<pass>/m3u`) can't be recognised, so its stream URLs are stored as given. |
| L11 | `rtp://`, `udp://`, `rtmp://` and userinfo stream URLs are dropped (URL policy). |
| L12 | Closed in Stage 4B (playlist screens). Still missing: the system IME option (rev 3 §9 offers it beside the own keyboard), long lists with scrolling beyond 20 playlists (not needed: max 20), PIN screens (Stage 8). |
| L14 | One ≈ 0.4 s UI stall while a 50,000-channel catalogue is encoded and checksummed on save; the cached-load decode (part of 3.9 s) isn't sliced and wasn't probed. |
| L15 | Import through the UI takes longer than without slicing (TV: 13.3 s vs 10.0 s for 50,000 channels). |
| L16 | Every TV interaction used injected key events; nothing has been visually inspected on the TV. |
| L17 | The PIN attempt counter is in localStorage; someone with storage access can reset it. Recorded as F5 in `docs/SECURITY-PIN-FOLLOWUP.md`. |
| L18 | Closed in Stage 5.1: `.gz` XMLTV guides are supported (streaming decoder). The compressed download is held inside the XHR object while it arrives (no streaming XHR on Tizen 3.0); capped at 30 MB. |
| L19 | Player: no audio/subtitle track selection, aspect modes, "last channel" toggle, or channel-list/EPG overlays inside the player (Stage 7). |
| L20 | Playback was tested only with synthetic LAN streams (ffmpeg test pattern), not with a real provider. |
| L21 | IME typing, focus rendering and readability were not checked with the physical remote. |
| L22 | The cached-load decode of a large channel list and the EPG index build are not time-sliced (see TEST-REPORT §11 for the measured stalls). |
| L23 | AVPlay sometimes never completes `prepareAsync` after buffering completed (TV: 5 of 76 opens of working synthetic streams before the fix; 10 detected and reopened in 65 opens after it). The app reopens such a stream once; a second stall in the same tune still ends at the 15 s limit. Root cause inside AVPlay not determined. |
| L24 | Dead channels (HTTP 404, refused) report their error only after AVPlay gives up (≈ 10–11 s on the TV); closing AVPlay after such an error blocks the UI for ≈ 0.5 s. |
| L25 | The stall rule was calibrated on MPEG-TS streams (normal prepare 0.20–0.42 s after the first buffering report). HLS and real providers were not measured. |
| L26 | During Stage 5.1 the TV once stopped running the app after a self-test file write and launches stayed silent until the TV was restarted; the cause was not determined (report §6). |
| L27 | Fixed in Stage 5.2: catalogue files with non-ASCII text were corrupted by the TV FileStream (Xtream list could not be opened); now stored as ASCII-escaped JSON. Other FileStore users must not write non-ASCII text (TIZEN-COMPATIBILITY §8). |
| L28 | Movies/series: no seeking, no resume points, no subtitle or audio-track selection (Stage 7/8). The Home key uses AVPlay suspend/restore for VOD (position kept) — unverified on the TV. |
| L29 | A provider with ~108,000 movies produces a 12.6 M character section (over the 5 M budget): download 34.5 s, opening Movies 11 s, one UI freeze of ≈ 3.3 s while the list is parsed, lowest free memory 71 MB during the download. The architecture's "index only" fallback is not implemented. |
| L30 | Adult categories/titles are flagged but not hidden (parental UI is Stage 8, as for Live TV). Movies/series of M3U playlists are not stored. |
| L13 | Real provider playlists and a real Xtream panel are untested (synthetic fixtures only; Q8). |

## 6. Not implemented (later stages)

EPG engine and XMLTV parser (Stage 5), live TV screens (Stage 5), movie and series catalogues (Stage 6), AVPlay player (Stage 7), parental UI and PIN changes (Stage 8), cloud sync (never; P3). Stage 5 starts only after approval.
