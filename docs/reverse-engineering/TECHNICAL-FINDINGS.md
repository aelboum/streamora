# Technical Findings

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. [V]/[M]/[A]: ScreenShelf device probe (E10).

## 1. Key findings about Ibo One

| # | Finding | Status | Conf. | Evidence |
|---|---|---|---|---|
| T1 | Native Kotlin/Java Android app, not cross-platform; 5,903 classes, R8-minified (single-letter classes in `com.ora.lib.api`) | CONFIRMED-STATIC | High | A2, A5 |
| T2 | White-label ORA platform: `com.ora.lib` + `com.logicyel.*` libraries, `Theme.OraStb`, "Welcome To ORA", white-label background route | CONFIRMED-STATIC | High | A3, A5, A7 |
| T3 | Xtream Codes is the only playlist protocol in the client. No on-device M3U parser found; backend `Server` = domain/username/password | CONFIRMED-STATIC (absence: Medium) | Medium | A6, A7 |
| T4 | Catalogue cached in a local SQLite DB that mirrors Xtream fields; full reload per type | CONFIRMED-STATIC | High | A7 |
| T5 | Media3 ExoPlayer + FFmpeg extension; HLS module; custom `MediaView` | CONFIRMED-STATIC | High | A4, A5 |
| T6 | EPG per channel via Xtream `get_simple_data_table`; no XMLTV | CONFIRMED-STATIC (absence: Medium) | Medium | A7 |
| T7 | Catch-up via Xtream timeshift for `tv_archive` channels | CONFIRMED-STATIC | High | A7 |
| T8 | Playlists, favourites, history, category order, parent password synced to a vendor backend per device; device registration with hardware identifiers | CONFIRMED-STATIC (routes/models) | High | A6, A7 |
| T9 | Monetisation: trial, annual and lifetime licence, Play Billing with server verification, QR payment, reseller codes, device limit | CONFIRMED-STATIC | High | A3, A7 |
| T10 | "Subtitle translation" is in fact online subtitle **search** via a vendor proxy; no translation code | CONFIRMED-STATIC (search); absence of translation: Medium | Medium | A6, A7 |
| T11 | Parental lock = one parent password, default "0000", with reset-to-default; `is_adult` flags on categories/streams | CONFIRMED-STATIC | High | A3, A7 |
| T12 | Languages: English, Arabic, Portuguese, Spanish (string resources), French (screenshot); RTL enabled. Only the English split was supplied, so the full list is UNDETERMINED | CONFIRMED-STATIC | Medium | A1, A3, E3 |
| T13 | Firebase Analytics/Crashlytics/Remote Config; analytics collection enabled; Ad ID permission | CONFIRMED-STATIC | High | A3 |
| T14 | "Multiple themes" not reflected in strings or resources found | ADVERTISED | Low | E1, A3 |
| T15 | Samsung Tizen version claimed by vendor; no installable artifact or instructions found | ADVERTISED | Low | E4, E6 |

## 2. Security observations about the reference app

Recorded so ScreenShelf avoids the same patterns. Static only; not exploited or tested. **Not to be used against the vendor's service.**

| # | Observation | Status | Conf. | Evidence | ScreenShelf rule |
|---|---|---|---|---|---|
| S1 | IPTV credentials (Xtream password) are part of the backend `Server` model and synced to the vendor | CONFIRMED-STATIC | High | A6, A7 | Credentials never leave the TV except to the user's own provider. |
| S2 | Device registration includes MAC, serial, fingerprint, Google token | CONFIRMED-STATIC | High | A6 | No device identifiers collected. |
| S3 | Play Data safety says "No data collected" while analytics collection is enabled | CONFIRMED-STATIC | High | E1, A3 | No telemetry; nothing to declare. |
| S4 | A key-like literal string is embedded in the dex | CONFIRMED-STATIC | High | A7 | No secrets in the bundle (already a ScreenShelf rule). |
| S5 | SQL statement fragments ending in `VALUES ` and `LIKE '%` suggest string-concatenated SQL with provider- and user-supplied text | INFERRED | Medium | A7 | No query language over untrusted text; JS-side filtering only. |
| S6 | `ContentDownloadService` and `com.ora.lib.CategoryLoadCompleteReceiver` are `exported="true"` without a permission | CONFIRMED-STATIC | High | A3 | Tizen web apps expose no such components; keep `<tizen:app-control>` absent. |
| S7 | `allowBackup="true"` (data, possibly including credentials, can be in device backups subject to the backup rules) | CONFIRMED-STATIC | High | A3 | n/a on Tizen; credentials are documented as stored unencrypted. |
| S8 | Default parental password "0000" with reset-to-default | CONFIRMED-STATIC | High | A3 | No default PIN; reset wipes parental data deliberately. |
| S9 | Cleartext traffic allowed app-wide | CONFIRMED-STATIC | High | A3 | Allowed for IPTV hosts only by necessity; warn the user. |
| S10 | `CAMERA` and `RECORD_AUDIO` permissions (QR scanning library strings; voice use undetermined) | CONFIRMED-STATIC (permissions) | High | A2, A3 | Only `internet` + `tv.inputdevice` (+ filesystem if USB import is approved). |

## 3. Conflicts with the approved ScreenShelf architecture

The approved architecture (`123movies/docs/ARCHITECTURE.md` rev 2) designs a **curated VOD app** with a Mock/HTTPS `ContentProvider` talking to one known backend. The IPTV project changes the product. These conflicts need an explicit decision; none will be changed silently.

| # | Approved decision | IPTV requirement | Severity | Proposed resolution (Stage 2, needs approval) |
|---|---|---|---|---|
| C1 | Product = curated Netflix-style catalogue; home rows from `getHomeLayout()`; screens Home, Movies, Series, Search, MyList, Settings | Playlist-driven IPTV: Live TV + EPG, playlists, parental, per-playlist data | **High** | Re-scope ARCHITECTURE.md to revision 3 (IPTV). Keep shell, router, focus, player, storage, HttpClient; replace content model and screens. |
| C2 | HttpClient URL guard: `https:` only, host allowlist, port 443 only, no credentials in URL (`src/api/url.ts`); CSP `connect-src` limited to the API host; `config.xml` access list without `*` | User-entered hosts, mostly `http:`, non-standard ports, credentials in paths/queries | **High** | Two policies: (a) existing strict policy for packaged/known hosts; (b) **user-source policy**: http/https, any host/port the user entered, no userinfo, size/time caps. `config.xml` `<access origin="*" subdomains="true"/>` and CSP `connect-src`/`media-src`/`img-src` `http: https:`. Script sources stay `'self'` only. |
| C3 | Storage "never stores tokens, credentials or stream URLs" | Must persist Xtream passwords and M3U URLs (often containing credentials) | **High** | Amend rule: credentials allowed in one dedicated, validated `playlists` key, never logged, never exported; documented as not encrypted at rest unless keymanager proves available. |
| C4 | HttpClient `maxChars` default 2 MB, single `responseText` | Playlists and EPG of tens of MB | High | Add a streaming download mode (`onprogress` chunk callback to an incremental parser, hard byte cap). Needs a device probe. |
| C5 | Models `MediaSummary`, `MovieDetail`, `Episode`, `RowDescriptor` (ARCHITECTURE.md §5.1) | Channels, categories, EPG programmes, playlists, Xtream/M3U sources | Medium | New models; keep `PlaybackSource`, `WatchEntry`, `FavouriteEntry` shapes where they fit. |
| C6 | `PlaybackSource.type` = hls / dash / mp4; prepare watchdog 15 s | Raw TS live, live (no duration), catch-up | Medium | Add `'ts'`, `live` flag; live-specific retry and zapping (PLAYBACK-ANALYSIS §3). |
| C7 | Layering in the approved doc: Services → API (ContentProvider) with Storage beside it | Prompt's layering: Services → ContentProvider → Storage → Platform | Low | Compatible: ContentProvider (M3U/Xtream) uses Storage for its cache. Document the order. |
| C8 | Stage numbering: approved roadmap Stages 2–7 (UI, Remote, Player, Integration, Device, Release) | Prompt's Stages 1–10 | Low | Adopt the prompt's numbering for the IPTV project; map in IMPLEMENTATION-RECOMMENDATIONS §3. |
| C9 | Repo folder `123movies` (risk R10) | Same repo | Medium | Rename or new repo before any release; ask the user. |
| C10 | `package.json` `test` scripts reference `tests/unit` and `tests/build`, but no `tests/` folder exists in the repo | — | Low (pre-existing) | `npm test` currently has nothing to run. Note for Stage 3; not changed now. |

## 4. Tizen 3.0 compatibility risks for IPTV

| # | Risk | Evidence | Impact | Mitigation / next step |
|---|---|---|---|---|
| K1 | **AVPlay with continuous HTTP MPEG-TS** (main Xtream live format) is untested | PROBE-REPORT §7 tested HLS TS segments only | **High**: live TV may not play | Probe before Stage 7 with a legal TS test stream; fallback `.m3u8` output. |
| K2 | **AVPlay over plain HTTP** untested | Probe used HTTPS streams | **High** | Probe with a LAN HTTP server serving test streams. |
| K3 | HEVC, AC3/E-AC3, MKV untested; no software decoder fallback (Ibo One has FFmpeg) | PROBE-REPORT §7; A4 | High for VOD coverage | Probe with legally obtained samples; show clear "format not supported". |
| K4 | Large playlist download and parse memory (about 220 MB free) | PROBE-REPORT §9 [M] | High | Streaming parser; compact records; per-section chunks; caps. Measure with a synthetic 50k-entry playlist. |
| K5 | Large-data storage (IndexedDB/WebSQL/filesystem) untested | — | High | Storage spike (STORAGE-ANALYSIS §4.8). |
| K6 | DOM performance with thousands of channels; 41 fps measured with 121 nodes | PROBE-REPORT §9 [M] | Medium | Virtualised lists with node pooling; no per-item listeners. |
| K7 | XMLTV `.gz` needs JS inflate; parse time on ARMv7 | — | Medium | Own small inflate + SAX-style parser over chunks; window by time and channel. |
| K8 | Static `config.xml` access/CSP vs. arbitrary hosts | E10 | Medium | Wildcard access for http/https data and media only; no remote script. |
| K9 | Channel keys (CH±) not pressed physically; remote has no media keys | PROBE-REPORT §6 | Low | Arrows always work. |
| K10 | AVPlay `setDisplayMethod` (aspect) and `setDisplayRect` preview pane untested for live | — | Low | Probe. |
| K11 | Tizen IME behaviour for URL/password entry untested | — | Medium (UX) | Own keyboard first. |
| K12 | Samsung-signed packages fail (`install failed[118]`) on this TV | PROBE-REPORT §3 | Release-only | Unchanged from R14. |
| K13 | Remote images (channel logos, posters) from arbitrary HTTP hosts untested | PROBE-REPORT §9 "Remote image loading NOT TESTED" | Medium | Probe; lazy loading with a 4-request queue. |
