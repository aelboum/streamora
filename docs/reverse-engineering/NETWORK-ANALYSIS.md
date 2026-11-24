# Network Analysis

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. [V]/[M]/[A]: ScreenShelf device probe (E10).

**No traffic was captured.** Endpoints below are strings and model names in the shipped binary (A5–A7). They prove the client contains these routes, not that or when they are called.

## 1. Ibo One network surface

### 1.1 IPTV provider (Xtream Codes), direct from the device

CONFIRMED-STATIC, High (A7). Paths appear literally:

| Purpose | Path |
|---|---|
| Template | `player_api.php?action={{action}}&username=…` |
| Categories | `action=get_live_categories`, `get_vod_categories`, `get_series_categories` |
| Lists | `action=get_live_streams`, `get_vod_streams`, `get_series` |
| Details | `action=get_vod_info`, `get_series_info` |
| EPG | `action=get_simple_data_table` |
| Catch-up | `streaming/timeshift.php?username=…`, `timeshift/` |
| Account | `UserInfo`, `ServerInfo`, `Status` models |

No `xmltv.php` string and no M3U attribute parsing were found (A7). That Xtream calls go from the device to the provider (not via the vendor) is INFERRED, High: the client builds `player_api.php` URLs itself and stores `domain`/`username`/`password`.

Cleartext HTTP is allowed app-wide (`usesCleartextTraffic="true"`, A3), which IPTV servers generally need.

### 1.2 Vendor backend (ORA platform)

CONFIRMED-STATIC, High (A7). Base host **not recovered**: no plain-text vendor API host appears in the dex strings. It is probably assembled at run time or delivered by Firebase Remote Config (INFERRED, Low).

| Area | Routes |
|---|---|
| Device / account | `api/end-users/authenticate`, `api/google/start-device-flow` |
| Purchases | `api/end-users/products`, `api/end-users/products/offers`, `api/end-users/google/verify-purchase` |
| Playlists | `/api/end-users/servers`, `/servers/{id}`, `/servers/v2` |
| Sync | `/api/end-users/favorites/servers/{serverId}/…`, `/api/end-users/history/servers/{serverId}/…`, `/api/end-users/sorted-categories` |
| Parental | `/api/end-users/devices/parent-password` |
| Branding | `/api/end-users/white-labels/background` |

Device registration model `DeviceInfo` (A6) contains: application name, version, software version, platform, model, real model, serial, **MAC**, **fingerprint**, firmware, OS and TV version, `fromPlayStore`, **Google token**, `localSet`, and `encryptedDeviceInfo`.

A key-like literal string associated with the vendor name is present in the dex (A7). It is not reproduced here. Whether it is used for request signing or for the "encrypted device info" is UNDETERMINED.

### 1.3 Other services

| Service | Evidence | Status / conf. |
|---|---|---|
| Subtitle search proxy `subtitledevui.logicyel.com/api/subtitles/search`, `/extract-vtt?gzUrl=` | A7 | CONFIRMED-STATIC / High |
| TMDB metadata (models, `tmdb_id`); whether via vendor proxy or directly | A5, A7 | CONFIRMED-STATIC / High (models); route UNDETERMINED |
| Firebase Analytics (`app-measurement.com`), Crashlytics, Remote Config, Installations | A3, A7 | CONFIRMED-STATIC / High |
| Google Play Billing, Install Referrer, Ad ID | A2, A3 | CONFIRMED-STATIC / High |
| YouTube (trailers, via intent) | A3 `<queries>` | CONFIRMED-STATIC / High |
| TLS stack: Conscrypt bundled, OkHttp | A4, A7 | CONFIRMED-STATIC / High |

### 1.4 Data-safety declaration vs. binary

| Play Data safety (E1) | Binary (A3, A6, A7) |
|---|---|
| "No data collected" | Firebase Analytics with `firebase_analytics_collection_enabled=true`; `AD_ID` permission; device registration with MAC, serial, fingerprint; playlist credentials, favourites and history synced to the vendor backend |
| "No data shared with third parties" | Firebase (Google) SDKs present |
| "Data is encrypted in transit" | Cleartext allowed app-wide (needed for HTTP IPTV); vendor/Firebase traffic presumably HTTPS |

The contradiction between declaration and shipped code is CONFIRMED-STATIC (High) as a difference between declaration and code. Actual transmission at run time is not observed.

## 2. ScreenShelf IPTV network flows (clean-room design)

All flows go device → the user's own provider. **No ScreenShelf backend, no vendor backend, no telemetry.**

| Flow | Request | Response | Size |
|---|---|---|---|
| M3U playlist | `GET <user URL>` | Text: `#EXTM3U`, `#EXTINF` with `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, optional `catchup*`, `url-tvg` | Small to very large |
| Xtream auth | `GET <server>/player_api.php?username=&password=` | `{user_info, server_info}` | Small |
| Xtream categories / lists / details | `…&action=get_*` (as §1.1) | JSON arrays/objects | Medium to very large |
| Xtream EPG | `get_short_epg` / `get_simple_data_table` | JSON, base64 titles | Small |
| XMLTV | user EPG URL or `url-tvg` from M3U, or `<server>/xmltv.php` | XML, possibly `.gz` | Large |
| Streams | `<server>/live/<u>/<p>/<id>.<ts|m3u8>`, `/movie/…`, `/series/…`; M3U entry URLs | AVPlay | — |
| Images | logo / poster URLs | Images | Many small |

The Xtream API has no formal specification. Paths above are public de-facto knowledge (confirmed present in Ibo One, A7). Field types vary by server implementation (numbers as strings, `null`, missing fields), so every field needs tolerant parsing plus validation.

## 3. Target platform constraints

| Constraint | Tag | Impact |
|---|---|---|
| XHR to remote HTTPS and plain HTTP works | [V] | Both technically possible. |
| `fetch` fails for packaged files; remote `fetch` untested; no AbortController | [V] | Keep the XHR-only HttpClient (D4). |
| TLS errors indistinguishable (status 0) | [V] | Generic "could not connect" message. |
| Approved HttpClient `maxChars` default 2,000,000 | E10 code | Too small for playlists and XMLTV. Needs a separate large-download path. |
| `responseText` holds the full body | INFERRED | A 50 MB playlist is ≥ 100 MB as a UTF-16 string. With about 220 MB free [M], incremental parsing over `onprogress` is required. Incremental `responseText` on this engine: **[A] untested**. |
| gzip | INFERRED | `Content-Encoding: gzip` decoded by the engine; `.xml.gz` files are not, and there's no `DecompressionStream` [A]. A small own JS inflate would be needed. |
| `config.xml` `<access origin>` and CSP are static | E10 | User-entered hosts are unknown at build time; requires `*` for http and https (TECHNICAL-FINDINGS C2). |
| Non-standard ports (8080, 25461, 8000…) | [A] | Common for Xtream; the current URL guard rejects them. |

## 4. Security requirements for ScreenShelf IPTV networking

1. Accept only `http:` and `https:` in every playlist-derived URL (streams, logos, posters, EPG). Reject `file:`, `javascript:`, `data:` and others.
2. Warn when a playlist uses plain HTTP (credentials travel in cleartext). Don't block it: most providers only offer HTTP.
3. Credentials go only to the host the user entered. Logo, poster and EPG hosts named inside a playlist never receive them.
4. Cap counts, lengths and sizes: entries per playlist (e.g. 200,000), names 256 chars, URLs 2,048, total download (configurable, e.g. 100 MB), per-phase timeouts.
5. All playlist and EPG text is untrusted: `textContent` only, control characters stripped, never interpreted as HTML.
6. LAN targets (e.g. `192.168.x.x`, TVHeadend) are allowed; the app has no ambient privileges that make that an SSRF concern beyond the user's own network.
7. No telemetry. Logs stay in the on-device ring buffer, redacted.
