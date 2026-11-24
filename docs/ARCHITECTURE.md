# ScreenShelf IPTV: Architecture (revision 3)

Status: **draft for approval, 2026-11-22.** Supersedes the curated-VOD architecture (revision 2, kept at `docs/archive/ARCHITECTURE-vod.md`). Stage numbering follows the IPTV project plan (`docs/reverse-engineering/IMPLEMENTATION-RECOMMENDATIONS.md` §3).

Target: Samsung UE50MU6100 (2017), Tizen 3.0 TV, ARMv7, 3840×2160 panel, 1920×1080 logical UI at DPR 1.

Evidence:
- Probe 1: `docs/PROBE-REPORT.md` (engine, CSS, keys, AVPlay over HTTPS, TLS, signing).
- Probe 2: `docs/PROBE2-REPORT.md` (IPTV formats over HTTP, live TS, zap, errors, storage, crypto, IME, CH keys).
- Reference analysis: `docs/reverse-engineering/`.

Tags: **[V]** verified on the TV; **[M]** measured on the TV (valid for the probe's conditions); **[A]** assumed, not yet tested.

## 0. Product decisions (approved 2026-11-22)

| # | Decision |
|---|---|
| P1 | ScreenShelf is a **playlist-driven IPTV player**. Users supply M3U/M3U8 URLs or Xtream Codes accounts. The app ships no content, playlists or credentials. |
| P2 | New repo `screenshelf`; the old `123movies` folder is not used further. |
| P3 | No backend of any kind: no account, licence, sync, telemetry or device identifiers. |
| P4 | User-entered sources may use **http and https on any host and port**, under a separate network policy (§6). |
| P5 | Playlist credentials are stored **on the TV only**, in `tizen.keymanager` [V]. |
| P6 | Initial UI languages: English + Dutch. RTL later. |
| P7 | Not in the initial release: subtitle search/translation, catch-up, USB import, playback speed, trailers, TMDB enrichment. |

## 1. Platform facts that shape the design

| Fact | Tag | Design consequence |
|---|---|---|
| ES5 target; partial ES2015; missing `Promise.finally`, `Object.values`, `URLSearchParams`, AbortController, observers | [V] P1 | Unchanged from revision 2: tsc ES5 → esbuild IIFE → acorn ES5 gate. |
| No CSS grid, flex `gap`, custom properties, sticky | [V] P1 | Flexbox + margins; themes are class swaps over pre-generated CSS. |
| AVPlay plays MP4, TS, MKV, HLS; H.264, **HEVC**; AAC, MP2, **AC3, E-AC3**; all over **plain HTTP**; continuous **live MPEG-TS** | [V] P2 | Default live format **TS**; HLS as alternative. No codec fallback needed for these. |
| Live TS: prepare ≈ 3.9 s, first frame ≈ 6.4 s by default; **≈ 3.85 s with `setBufferingParam` 2 s**; 1 s unstable | [M] P2 | Live buffer 2 s (configurable); zap UX built around about 4 s (§5.3). |
| Connection errors: `onerror CONNECTION_FAILED` after ≈ 10 s; prepare error callback never fires; missing manifest never errors | [V] P1, P2 | Treat `onerror` in prepare as failure; app watchdog 15 s for prepare. |
| `setSpeed` unreliable; `stop()` may throw | [V] P1 | No speed feature; defensive teardown; simulated scrub. |
| HLS WebVTT via `onsubtitlechange` with raw HTML; `setExternalSubtitlePath` refused | [V] P1 | Subtitle sanitiser; JS sidecar renderer later. |
| XHR: 50 MB text in ≈ 3 s; incremental `responseText` grows per progress event; gzip transfer-encoding decoded | [M] P2 | Streaming playlist parser over `onprogress`. |
| No `DecompressionStream` | [V] P2 | `.gz` XMLTV needs an own small inflate (Stage 5). |
| IndexedDB and WebSQL quota ≈ **10 MB** per origin; `unlimitedstorage` does not lift it | [M] P2 | Not used for catalogues. |
| `tizen.filesystem` wgt-private: works, ≈ 1.5 MB/s write and read | [M] P2 | Catalogue cache in compact chunk files (§7). |
| `tizen.keymanager` save/get/remove | [V] P2 | Credential store (P5). |
| `crypto.subtle` PBKDF2-SHA256 10k iterations 97 ms | [M] P2 | Parental PIN hashing. |
| Lowest free system memory 107 MB during a 50 MB incremental parse; ≈ 220 MB idle | [M] P1, P2 | Never refresh large playlists during playback; compact in-memory model. |
| `performance.memory` doesn't update | [V] P2 | Memory diagnostics via `tizen.systeminfo.getAvailableMemory()`. |
| Keys: arrows, OK, Back; **CH+ 427 / CH− 428** [V]; colour keys [V]; no media keys on this remote | [V] P1, P2 | Everything works with arrows/OK/Back; CH± and colours are accelerators. |
| System IME works on `<input>` (keyCode 229 + `input` events) | [V] P2 | Offered for text entry beside the own keyboard. |
| 100 HTTP images in 327 ms | [M] P2 | Logos/posters lazy-loaded, 4 concurrent. |
| Samsung-signed packages fail with 118 | [V] P1 | Development uses the Tizen profile; store release unresolved (R14). |

## 2. Layers

```
Screens       Onboarding · Home · LiveTV · Movies · Series · Details · Search ·
              Player · Settings (Playlists · Parental · Appearance · Playback · About)
   ↓
Components    SideNav · CategoryColumn · VirtualList · PosterGrid · ChannelRow · EpgStrip ·
              Keyboard · PinPad · Dialog · Toast · Spinner · PlayerOverlays
   ↓
Navigation    Router · KeyRouter · FocusManager      |  Player   PlaybackController · LiveController
   ↓                                                 |           SubtitleManager · AudioTracks
Services      PlaylistService · CatalogueService · EpgService · SearchService · FavouritesService ·
              HistoryService · ParentalService · SettingsService · I18n · Theme
   ↓
ContentProvider  IptvSource ← M3uSource | XtreamSource;  EpgSource ← XtreamEpg | Xmltv (Stage 5)
   ↓
Storage       KeyValueStore (localStorage) · CatalogueStore (chunk files) · SecretStore (keymanager)
   ↓
Platform      TizenPlatform | BrowserPlatform · HttpClient · FileStore · KeyStore · AVPlayEngine | Html5Engine (dev)
```

Rules:
1. Dependencies point downward only.
2. Screens never touch `tizen.*`, `webapis.*`, `localStorage` or XHR directly.
3. Components render view models and emit intents; no business logic.
4. Services, sources and parsers have no DOM dependency, so they run under `node --test` on Windows.
5. Only `platform/avplay-engine.ts` calls `webapis.avplay`; only `platform/*` calls `tizen.*`.
6. One `AppContext` built at boot (manual DI, as in revision 2).
7. Interfaces at every layer boundary; no speculative abstractions.

## 3. Reused from the foundation (already in the repo)

| Module | Status | Change for IPTV |
|---|---|---|
| Build pipeline, compat check, ES5/CSS gates, release check | Implemented, gates pass | `config-xml` gets the IPTV access/CSP policy (§6). |
| `app/platform/*` | Implemented | Add `FileStore`, `KeyStore`, `registerKeys` for ChannelUp/Down. |
| `api/http-client.ts` + `api/url.ts` | Implemented (strict HTTPS policy) | Add user-source policy and streaming mode (§6). |
| `utils/log.ts`, `utils/redact.ts`, dev log sink | Implemented | Redaction extended to Xtream paths and query credentials. |
| Router, KeyRouter, FocusManager designs | Designed in revision 2 §2C–D | Unchanged design; implemented in Stage 3. |
| Player engine and controller designs | Designed in revision 2 §4 | Extended for live (§5). |

There are **no tests yet** (`tests/` doesn't exist; `npm run test:all` runs 0 tests). Stage 3 creates it.

## 4. Domain model (`src/models/`)

```ts
type SourceKind = 'm3u' | 'xtream';
type Section = 'live' | 'movie' | 'series';

interface PlaylistDef {               // stored in localStorage (no secrets)
  id: string; name: string; kind: SourceKind;
  url?: string;                       // m3u: URL WITHOUT credentials if they can be split; else keyStore ref
  server?: string;                    // xtream: scheme://host:port
  secretRef: string;                  // keymanager alias holding username/password or the full m3u URL
  epgUrl?: string; liveFormat: 'ts' | 'm3u8';
  addedAt: number; lastLoadedAt?: number; lastStatus?: SourceStatus;
}
interface SourceStatus { ok: boolean; message?: string; expiresAt?: number; maxConnections?: number }

interface Category { id: string; name: string; section: Section; count: number; adult: boolean }
interface Channel { id: string; num: number; name: string; logo?: string; categoryId: string;
  epgKey?: string; adult: boolean; catchupDays?: number; streamRef: StreamRef }
interface VodItem { id: string; name: string; poster?: string; categoryId: string; year?: number;
  rating?: number; added?: number; adult: boolean; ext?: string; streamRef: StreamRef }
interface SeriesItem { id: string; name: string; cover?: string; categoryId: string; year?: number;
  rating?: number; adult: boolean }
interface Episode { id: string; season: number; episode: number; title: string; durationMs?: number;
  plot?: string; streamRef: StreamRef }
type StreamRef = { kind: 'xtream'; type: 'live' | 'movie' | 'series'; id: string; ext?: string }
               | { kind: 'url'; url: string };
interface Programme { start: number; end: number; title: string; desc?: string }  // epoch ms, UTC
interface PlaybackSource { url: string; type: 'ts' | 'hls' | 'mp4' | 'mkv' | 'dash'; live: boolean;
  subtitles: SubtitleRef[] }
```

Xtream stream URLs are **built at play time** from `server` + credentials + `StreamRef` and never stored or logged.

## 5. Player

### 5.1 Engine interface (revision 2, extended)

```ts
interface PlaybackEngine {
  load(src: PlaybackSource, opts: { startMs: number; bufferSec?: number }): Promise<void>;
  play(): void; pause(): void; stop(): void;
  seekTo(ms: number): Promise<void>;
  position(): number; duration(): number; state(): EngineState;
  audioTracks(): AudioTrack[]; selectAudio(id: string): void;
  textTracks(): TextTrack[]; selectText(id: string | null): void;
  setRect(r: Rect): void; setAspect(m: 'fit' | 'fill' | 'auto'): void;
  suspend(): void; resume(): void;
  on(ev: EngineEvent, cb: (e: unknown) => void): () => void;
  destroy(): void;
}
```

### 5.2 AVPlay rules

- Order: `open → setListener → setDisplayRect → setBufferingParam (live: 2 s PLAY + RESUME) → prepareAsync → play` [V].
- Prepare watchdog **15 s**; `onerror` before prepare completes = failure (connection errors arrive at about 10 s [V]).
- Teardown always `try stop` then `try close`; never throws.
- `setDisplayMethod`: fit = LETTER_BOX, fill = FULL_SCREEN, auto = AUTO_ASPECT_RATIO (accepted [V]; visual check in Stage 7).
- No `setSpeed`. VOD scrub simulated.

### 5.3 Live behaviour (`LiveController`)

| Behaviour | Design |
|---|---|
| Zap | Up/Down or CH±: banner (number, logo, name, now/next) shows immediately. Stream opens after a **400 ms** debounce, so rapid presses open only the last channel. Expected time to picture ≈ 4 s [M]; a spinner with the channel name covers it. |
| Last channel | Toggle via the info banner (OK, then "Previous channel") and Green key. |
| Overlays | Left: channel list (current category). Right: EPG for the channel. Down: audio, subtitles, aspect. OK: info banner. Back: close overlay, then leave to Live TV. |
| Dead channel | Watchdog or `onerror` → "Channel not available" with Retry/Back. No automatic loop. |
| Drop during play | Up to 3 reopens (2/5/10 s backoff) at the live edge, then the error panel. |
| Format | Per playlist: `ts` (default, verified) or `m3u8`. |

### 5.4 VOD behaviour

Revision 2 rules carry over: resume shown when position > 60 s and < 95 %; finished at ≥ 95 % or within 60 s of the end; history saved on pause/stop/error/hide and every 15 s; seek ±10 s, hold for accelerating scrub; single `seekTo` on release.

## 6. Network

### 6.1 Two URL policies in `api/url.ts`

| Policy | Used for | Rules |
|---|---|---|
| `strict` (existing) | Fixed hosts, if any | https, allowlisted host, port 443, no userinfo |
| `userSource` (new) | Playlists, Xtream API, EPG, streams, logos, posters | `http:` or `https:` only; any host/port; no userinfo; length ≤ 2,048; control characters rejected |

Credentials are attached only for the playlist's own host. URLs found inside a playlist (logos, EPG) never receive credentials.

### 6.2 `HttpClient` streaming mode (new)

```ts
interface StreamRequest { url: string; policy: 'userSource'; timeoutMs: number; maxBytes: number;
  onChunk(text: string, done: boolean): void }   // new text since the last call
```

- Built on XHR `onprogress`: slices `responseText` from the last offset [V incremental growth].
- Hard caps: `maxBytes` default 100 MB, timeout per phase.
- Same single-settle, abort and error classification as the existing client.
- Parsing runs in time-sliced batches (≤ 16 ms per slice) so the UI stays responsive.

### 6.3 `config.xml`

- `<access origin="*" subdomains="true"/>` (required for user-entered hosts).
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: http: https:; media-src http: https:; connect-src http: https:`.
- No remote scripts, no `eval`, no inline scripts (existing build greps stay).
- Privileges: `internet`, `tv.inputdevice`, `filesystem.read`, `filesystem.write`, `keymanager`. Not `unlimitedstorage` (no effect [V]).
- A plain-HTTP playlist shows a one-time notice that its credentials travel unencrypted.

## 7. Storage

| Data | Store | Budget |
|---|---|---|
| Settings, playlist definitions (no secrets), favourites, history, parental policy, category order | `KeyValueStore` on localStorage (`ss:v1:<name>`, validated, migrated) | < 1 MB |
| Playlist secrets (Xtream username/password, M3U URL with embedded credentials) | `SecretStore` on `tizen.keymanager`, alias per playlist | small |
| Catalogue per playlist | `CatalogueStore` on `tizen.filesystem` wgt-private: one file per section (`<pl>/live.json`, `movie.json`, `series.json`) plus `meta.json`; compact arrays, short keys, shared URL prefixes | Target < 5 MB per section → about 3 s to read [M at 1.5 MB/s] |
| EPG window | Memory only, now−1 h … now+12 h, channels in the playlist | bounded |
| Images | Engine cache only | — |

Load strategy:
- At start, read only `meta.json` plus the section being opened.
- Sections load lazily; a cached section is shown immediately, and refresh is manual or on a staleness timer while not playing.
- If a section file exceeds the budget, keep only an index (id, name, category) on disk and fetch details on demand from Xtream.

Parental PIN: PBKDF2-SHA256 via `crypto.subtle` [V], 100,000 iterations (≈ 1 s estimated from 97 ms per 10k [M]; tune in Stage 8), 16-byte random salt, no default PIN. Five wrong attempts → 60 s lockout. Reset wipes the parental policy after an explicit confirmation sequence. Documented limit: a short PIN protects against casual use, not a technical attacker with storage access.

## 8. Parsers (pure, tested on Windows)

| Parser | Input | Notes |
|---|---|---|
| M3U/M3U8 | text chunks | `#EXTM3U` with `url-tvg`; `#EXTINF` duration, attributes (`tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, `tvg-chno`, `catchup*`), title; URL line; `#EXTGRP`; tolerant of CRLF, BOM, missing attributes and quotes; caps per field; drops non-http(s) URLs. Section detection: Xtream-style paths (`/movie/`, `/series/`), extension, group heuristics. |
| Xtream JSON | parsed JSON | Tolerant field typing (strings vs numbers, nulls); validation per field; `user_info.status`, `exp_date`, `max_connections`, `allowed_output_formats`; `server_info.timezone`. |
| Xtream EPG | `get_short_epg` JSON | base64 title/description decoding, UTC timestamps. |
| XMLTV (Stage 5) | text chunks (+ own inflate for `.gz`) | SAX-style, windowed by time and known channels; timezone offsets `YYYYMMDDhhmmss ±hhmm`. |

Malicious-metadata tests: script/HTML in names, huge attributes, control characters, `javascript:` URLs, millions of lines, broken UTF-8.

## 9. UI and remote

- Layout per `docs/reverse-engineering/UX-ANALYSIS.md` §2 and §4: side nav; three-column browse (categories → list/grid → info); virtualised lists with node pooling; fixed 1080p pixels.
- Focus manager per revision 2 §2D (zone graph, memory per zone, fallback on removal, 110 ms held-key throttle, animations off while held).
- Text entry: own keyboard with URL keys (`http://`, `https://`, `:`, `/`, `.m3u`, `:8080`) **and** a "system keyboard" option, since the IME works [V].
- Every action reachable with arrows/OK/Back; Options via a visible button; long-press, colour keys and CH± are accelerators only.
- Themes: dark (default) and light, as body classes; tokens generated at build time.
- i18n: English + Dutch string tables; no string concatenation for sentences; layout ready for RTL later.

## 10. Testing

| Layer | Where | What |
|---|---|---|
| Unit | PC, `node --test` | Parsers (M3U, Xtream, XMLTV), URL policies, redaction, PIN hashing (JS reference), stores (fake backends), services, focus/router. |
| Integration | PC | Sources against a local fixture server (M3U, fake Xtream API); playback controller against `FakeEngine`; storage against fake `FileStore`/`KeyStore`. |
| Simulated platform | PC/browser | `BrowserPlatform` + `Html5Engine` for UI work; labelled "browser". |
| Device | TV | The probe 2 LAN server is reused as the test source (TS, HLS, VOD, fake Xtream to be added in Stage 4). Every TV result is logged in `docs/TEST-REPORT.md` with build hash and labelled physical or injected key presses. |

Status labels in reports: **implemented**, **unit-tested**, **verified in browser**, **verified on TV (physical)**. Nothing is reported as verified on the TV unless it ran there.

## 11. Risks

| # | Risk | Status | Mitigation |
|---|---|---|---|
| R1 | Real provider streams differ from synthetic ones (GOP, codecs, DRM-less but odd muxing) | Open | Test with your own provider account in Stage 7 (Q8). |
| R2 | Zap ≈ 4 s feels slow | Open, measured | 2 s buffer, banner first, debounce; consider a 1.5 s buffer test with real streams. |
| R3 | Filesystem throughput 1.5 MB/s → slow cold start with big catalogues | Open | Per-section files, compact format, lazy loading, index-only fallback. |
| R4 | Memory pressure during refresh | Open | No refresh during playback; streaming parse; caps. |
| R5 | Wildcard access/CSP widens attack surface | Accepted | No remote script; text-only rendering; URL policy; sanitiser. |
| R6 | keymanager availability on other firmware | Low | Fallback to localStorage with a clear notice (decision needed only if it fails). |
| R7 | Samsung store signing (error 118) | Open, release-only | Unchanged. |
| R8 | Visual checks pending (aspect modes, preview pane, fonts) | Open | Stage 3/7 TV checklist. |

## 12. Stages

| Stage | Scope | Exit criteria |
|---|---|---|
| 1 | Reverse engineering | Done (`docs/reverse-engineering/`) |
| 2 | This architecture + probe 2 | Probe 2 done; **this document approved** |
| 3 | Foundation: `tests/`, KeyValueStore, FileStore/KeyStore platform wrappers, URL policies + streaming HttpClient, router, key router, focus manager, side nav, i18n/theme plumbing, onboarding shell | `npm run check` green with real tests; browser render 1920×1080; TV navigation pass |
| 4 | IPTV core: M3U + Xtream sources, PlaylistService, CatalogueStore, add/edit/remove/switch/refresh UI | Parser/source tests incl. malicious fixtures; 50k-entry playlist load measured on TV |
| 5 | Live TV + EPG | Virtualised 5,000-channel list smooth on TV; EPG tests |
| 6 | Movies + series | Service tests; TV pass |
| 7 | Player | FakeEngine tests; format matrix and zap re-measured with real streams on TV |
| 8 | Subtitles, parental, themes, languages | Sanitiser + parental tests; TV pass |
| 9 | Hardening | Soak (memory via systeminfo), security review |
| 10 | Device validation | Full TEST-REPORT with physical remote |

## 12a. Implementation notes (Stage 3)

Small discrepancies found while implementing. None changes an approved decision.

| Section | Note |
|---|---|
| §7 catalogue file layout | Implemented as flat names `cat.<playlistId>.<section>.json` (plus `meta`) instead of per-playlist folders, so `createDirectory` (unverified on the TV) isn't needed. Same one-file-per-section rule. |
| §7 PIN cost | 100,000 PBKDF2 iterations measured at **157 ms** on the TV (Stage 3 self-test), not the ≈ 1 s estimated. The iteration count is unchanged; raising it is an open question. |
| §6.2 streaming interface | Implemented as `HttpClient.stream({url, policy, credentialOrigin?, maxChars, idleTimeoutMs, totalTimeoutMs, onChunk(text)})`; completion is the result promise rather than an `onChunk(…, done)` flag. |
| §6.1 redirects | Pre-send redirect validation is impossible with XHR; detection at headers plus discard is implemented (SECURITY-DECISIONS.md S5). `responseURL` verified present on the TV. |
| §6.3 config.xml | Implemented exactly; enforced by the release check and build tests. |

## 12b. Implementation notes (Stage 4)

Additions and discrepancies found while implementing Stage 4. None changes an approved decision. Items marked "needs approval" are recorded for review.

| Section | Note |
|---|---|
| §4 domain model | Implemented in `src/models/content.ts`. Additive fields: `Channel.userAgent` / `Channel.referrer` (M3U `#EXTVLCOPT` and attributes); `StreamRef {kind:'url'}` and `EpgSource {kind:'xmltv'}` may carry `cred: true` (the URL holds `{U}`/`{P}` placeholders for the playlist's own credentials, filled in at play time). `PlaylistDef.server` holds the origin for both kinds, and `secretRef` is derived from the id (`ss_pl_<id>`). The M3U URL is always a secret. `PlaybackSource.subtitles` is deferred to Stage 7. |
| §4 "never stored" rule | Extended to M3U: stream URLs at the playlist origin with the Xtream layout are stored as Xtream references; other URLs repeating the playlist credentials are stored with placeholders (SECURITY-DECISIONS S8). |
| §7 catalogue | Stage 4 stores the **live** section plus `meta`. Movie/series entries of an M3U are counted, not stored (Stage 6). The compact format (arrays, category indexes, shared URL-prefix table) is described in `src/content/catalogue-codec.ts`. Live/meta consistency uses the live file's checksum. The "index only" fallback for over-budget sections is **not** implemented: such sections are stored and flagged. |
| §6.2 time slicing | Parsing runs inside the XHR progress events, not in ≤ 16 ms slices. Measured on the TV: 6.8 s of download + parse for 50,000 channels. Revisit when the import screen exists (Stage 5) if the UI stalls. |
| §12 Stage 4 scope | Rev 3 lists an "add/edit/remove/switch/refresh UI" for Stage 4. The Stage 4 brief covered the engine and client only, so the service API exists (`ctx.playlists`) but no screens do. **Needs a decision**: build the playlist screens with Stage 5, or as a separate step. |
| §12 Stage 4 exit criterion | "50k-entry playlist load measured on TV": done. M3U 10.0 s import / 3.9 s cached load; Xtream 8.5 s / 4.0 s (TEST-REPORT.md §5). |
| §10 device testing | The dev sink now also serves synthetic IPTV fixtures (`scripts/lib/tv-fixtures.mjs`) instead of extending the probe 2 media server. |

## 12c. Implementation notes (Stage 4B)

| Section | Note |
|---|---|
| §7 PIN | Superseded by the approved P1–P4 (Stage 4B): 600,000 iterations, 6–8 digits for new PINs, a recovery code, resets that need the PIN or the code (otherwise every playlist is deleted), and the record in the key manager with two generation-numbered slots. Details: SECURITY-DECISIONS.md S2. The "≈ 1 s" estimate now matches the measurement (verify 0.80 s on the TV). |
| §6.2 time slicing | Now implemented (`content/slicer.ts`: 8 K-character pieces, 16 ms budget). The Stage 4 note "not time-sliced" no longer applies. |
| §7 file I/O | `TizenFileStore` reads and writes one chunk per event-loop turn (found on the TV: a single loop froze the UI for ≈ 3 s). No interface change. |
| §9 text entry | The own on-screen keyboard is implemented. The "system keyboard" option (IME) is **not** yet; the own keyboard is enough to operate everything with the remote. |
| §9 i18n | English and Dutch tables in `i18n/strings.ts`; the language follows `config.ui.language`. There is no language setting screen yet. |
| §2 root screen | The playlist overview is the root; the diagnostics screen is reachable from it (and is the root when secure storage is missing). |

## 12d. Implementation notes (Stage 5)

| Section | Note |
|---|---|
| §2 Player | `src/player/engine.ts` (PlaybackEngine, live subset of §5.1), `src/player/avplay-engine.ts` (the only `webapis.avplay` user), `src/player/live-controller.ts` (§5.3). Audio/subtitle tracks, aspect modes and VOD seeking from §5.1 are not part of Stage 5 (Stage 7). |
| §5.2 / §5.3 | Implemented as designed: 2 s PLAY/RESUME buffer, 15 s watchdog, 400 ms zap debounce, error panel without an automatic loop, 3 reconnects (2/5/10 s) after a drop during playback. The app suspends by stopping the stream on hide and reopening at the live edge on show (no AVPlay `suspend`), because a live position can't be resumed anyway. "Last channel" toggling (Green key) is not implemented. |
| §5.3 overlays | The player has one banner (number, logo, name, now/next, state). The channel-list, EPG and track overlays are not in Stage 5; Back returns to the Live TV list, which is the channel list. |
| §7 EPG window | Stored per playlist as catalogue section `epg` (window −2 h … +24 h, at most 300 programmes per channel and 400,000 in total), not memory-only. This is needed for "EPG caching". Only the open playlist's guide is in memory. |
| §8 XMLTV | Streaming parser and channel mapping are implemented. **Compressed `.gz` guides are not supported** (no inflate yet; rev 3 planned "own small inflate"). Servers that send gzip as `Content-Encoding` work (decoded by XHR [V probe 2]). A raw `.gz` file is reported as "not an XMLTV guide". *(Superseded in Stage 5.1: gzip guides are supported, see §12e.)* |
| §9 text entry | The system IME is now preferred on the TV (`config.ui.keyboard = auto`); the app keyboard is the fallback and is used where there is no IME. |
| §9 lists | Channel and category lists are virtualised with pooled nodes (`components/virtual-list.ts`). |

## 12e. Implementation notes (Stage 5.1)

No architecture decision changed. Details and evidence: `docs/STAGE-5.1-REPORT.md`.

| Section | Note |
|---|---|
| §8 XMLTV, gzip | The "own small inflate" planned in rev 3 is `src/content/gzip.ts`: a streaming gzip/DEFLATE decoder with UTF-8 output, with no dependency. Tizen 3.0 has neither `DecompressionStream` nor streaming `fetch`. Compressed guides are therefore downloaded through the existing XHR client as binary strings (`overrideMimeType('text/plain; charset=x-user-defined')`, new `StreamOptions.binary`). They are decoded piece by piece inside the existing time-sliced consumer, so the decompressed guide is never held whole. Detection: `.gz` URL path, then a gzip `Content-Type`, then the first byte 0x1f of a text download (restart once as binary); in binary mode the magic bytes decide. Limits: `epg.maxGzipMB` (compressed, default 30) and `network.maxPlaylistChars` (decompressed). The compressed bytes accumulate inside the XHR object, as text downloads already do (no streaming XHR on this engine). |
| §5.3 watchdog | New `player.prepareStallMs` (default 3 s). When AVPlay reported buffering but has not prepared that long afterwards, the controller closes the stream and opens it once more, inside the unchanged 15 s limit. Dead channels report no buffering and are not reopened. Evidence: on the TV `prepareAsync` sometimes never calls back although the stream data arrives (Stage 5.1 report §3). The 2 s buffer and the 15 s limit are unchanged. |
| §6 HTTP client | `XhrLike` gained the optional `overrideMimeType`; `StreamOptions` gained `binary` and `onHeaders` (Content-Type). Credentials and redirect rules are unchanged. |
| §5.2 diagnostics | The AVPlay engine takes an optional logger and writes debug-level lifecycle traces (session number, AVPlay state, error type names, elapsed times; never URLs). They are off at the default log level. |

## 12f. Implementation notes (Stage 6)

No architecture decision changed. Details and measurements: `docs/STAGE-6-REPORT.md`.

| Section | Note |
|---|---|
| §4 domain model | `VodItem` (movies and series in one list type; `ext` for movies, `genre` for series), `VodCatalogue`, `MediaDetails`, `Season`, `Episode` in `src/models/content.ts`. List entries hold only what browsing needs; plot, genre, cast and duration are fetched per title (`get_vod_info`, `get_series_info`) and cached for the session. |
| §7 storage | Catalogue sections `movie` and `series` (compact rows, shared image-URL prefixes; `src/content/vod-codec.ts`), written through the same CatalogueStore (checksums, ASCII escaping from Stage 5.2). Per-playlist state (count, time, checksum) in the KeyValueStore under `vod.<id>`, removed with the playlist. Sections load lazily on the first open of Movies or Series (download on first use); the Live TV import is unchanged. The "index only" fallback for over-budget sections is still not implemented: a real provider's 108,521 movies take 12.6 M characters (over the 5 M budget) and 11 s to open on the TV. |
| §5.1 / §5.4 player | VOD reuses the AVPlay engine: `LoadOptions.bufferSec = 0` keeps AVPlay's default buffering (live keeps 2 s); optional `timing()` gives position and duration. `src/player/vod-controller.ts` handles open, 15 s watchdog, pause, ended, errors with Retry, stale-callback guard and Home suspend/restore. Seeking, resume points and audio/subtitle tracks (§5.4 rules) are **not** implemented: Stage 7/8. |
| §6 / §4 URLs | Movie and episode URLs `<server>/movie|series/<user>/<pass>/<id>.<ext>` are built at play time by `PlaylistService.resolveStream` (existing `buildXtreamStreamUrl`); never stored or logged. `PlaylistService.xtreamClient(id)` gives the VOD service an API client without exposing credentials. |
| §9 UI | Browse: categories (Search, Update list, All, provider categories) and a virtualised 7-column poster grid (pooled rows; posters load only for bound cards; title placeholder when an image is missing or broken). Details and VOD player screens follow the Live TV look (same tokens). M3U playlists: VOD entries are still only counted, not stored, so Movies/Series are offered for Xtream playlists only. |

## 13. Open questions

1. Q8 from Stage 1: is there a legal provider account available for Stage 7 real-stream tests?
2. Production package ID / app ID (needed before Stage 10).
3. PIN iteration count: 100k (≈ 1 s per check) or lower for snappier unlock?
