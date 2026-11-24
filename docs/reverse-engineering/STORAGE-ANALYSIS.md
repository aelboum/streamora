# Storage Analysis

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. [V]/[M]/[A]: ScreenShelf device probe (E10).

## 1. Ibo One storage

### 1.1 Local catalogue database (SQLite)

CONFIRMED-STATIC, High (A7: literal SQL statements in `classes.dex`). Tables and columns as they appear in INSERT statements:

| Table | Columns seen |
|---|---|
| `categories` | `category_id`, `category_name`, `parent_id`, `type` (`live` / `vod` / `series`), `is_adult` |
| `live_streams` | `name`, `stream_id`, `stream_icon`, `epg_channel_id`, `is_adult`, `category_id`, `tv_archive`, `added` |
| `vod_streams` | `name`, `stream_id`, `stream_icon`, `rating`, `rating_5based`, `is_adult`, `category_id`, `tmdb`, `container_extension`, `added` |
| `series` | `name`, `series_id`, `cover`, `rating`, `rating_5based`, `tmdb`, `category_id`, `releaseDate`, `last_modified` |

Observed query patterns (A7):
- Full reload per type: `DELETE FROM live_streams` / `vod_streams` / `series`, then bulk INSERT. No incremental update.
- Counts per category in one query: `SELECT category_id, COUNT(*) … GROUP BY category_id UNION SELECT 'all', COUNT(*)`.
- "Recently added": `ORDER BY added DESC LIMIT 100` (series: `last_modified`).
- Search: `WHERE name LIKE '%…'`.
- Catch-up list: `WHERE tv_archive > 0`.
- The statements appear as string fragments ending in `VALUES ` and `LIKE '%`, which **suggests** SQL is built by string concatenation (INFERRED, Medium; method bodies not read, so escaping can't be confirmed).

The schema mirrors the Xtream API fields one-to-one: it is an Xtream cache, not a generic playlist store. Stream URLs are **not** stored; they are rebuilt from server + credentials + id (INFERRED, High: no URL column).

Room (`androidx.room.MultiInstanceInvalidationService`) is also present; which data uses Room vs. the raw SQL above is UNDETERMINED.

### 1.2 Server-side (vendor backend) storage

CONFIRMED-STATIC, High (A6, A7). Per device/account, the vendor backend stores:

| Data | Route / model |
|---|---|
| Playlists ("servers"): `name`, `domain`, `username`, **`password`**, `expiryDate`, `verified` | `/api/end-users/servers`, `/servers/{id}`, `/servers/v2`; model `Server` |
| Favourites per server and type | `/api/end-users/favorites/servers/{serverId}/{live-streams|vod-streams|series}` |
| Watch history per server and type; clear | `/api/end-users/history/servers/{serverId}/…`, `/clear` |
| Category order and hidden categories | `/api/end-users/sorted-categories` |
| Parent password | `/api/end-users/devices/parent-password` |
| Device registration: model, real model, serial, MAC, fingerprint, firmware, OS/TV version, app name/version, Play-Store flag, Google token, an "encrypted device info" blob | model `DeviceInfo`; `api/end-users/authenticate` |

Implication: **users' IPTV credentials and viewing history leave the device and are held by the vendor.** That this happens at runtime is INFERRED, High (models and routes exist; traffic not captured).

### 1.3 Other local storage

| Item | Status | Evidence |
|---|---|---|
| `allowBackup="true"` with backup and data-extraction rules | CONFIRMED-STATIC, High | A3 |
| DataStore (`libdatastore_shared_counter`) for preferences | CONFIRMED-STATIC, Medium | A4 |
| Firebase Analytics local event queue (standard SDK tables) | CONFIRMED-STATIC, High | A7 |
| Picasso image cache | CONFIRMED-STATIC, High | A3 |
| Credential encryption at rest | UNDETERMINED | — |

## 2. What ScreenShelf must store

| Data | Sensitivity | Size estimate | Notes |
|---|---|---|---|
| Playlist definitions: name, type (M3U / Xtream), URL or server + username + password, EPG URL, preferred live format | **Secret** | < 10 KB | Conflicts with the approved rule "never stores tokens, credentials or stream URLs" (TECHNICAL-FINDINGS C3). Stays on the TV only. |
| Catalogue cache per playlist: categories, channels, VOD, series | Medium (M3U stream URLs may embed credentials) | 1–50+ MB per playlist (provider-dependent; not measured) | Too large for comfortable `localStorage` use. Store compact records; for Xtream, rebuild URLs at play time as Ibo One does. |
| EPG window (now − 2 h … now + 24 h, channels in the playlist only) | Low | Bounded by window | Full XMLTV is often tens of MB or more uncompressed. |
| Favourites, recently watched, continue watching, watched flags, category order/hidden | Low | < 300 KB with caps | Existing KV-store design fits. |
| Parental: PIN hash + salt + iterations, locked categories, adult-flag policy, protected-settings flag | Medium | < 10 KB | Never plaintext; no default PIN. |
| Settings: theme, language, subtitle/audio prefs, aspect, time offset | Low | < 5 KB | Existing design fits. |

## 3. Tizen 3.0 storage options

| Option | Status on target | Fit |
|---|---|---|
| `localStorage` | [V] ≥ 8 MB written (test cap; limit not reached) | Settings, user lists, playlist definitions, small catalogues. Synchronous: large writes block the UI. |
| IndexedDB | **[A] untested** | Would suit large catalogues (async, indexed search). Old WebKit 538 IndexedDB may be slow; must be measured. |
| WebSQL (`openDatabase`) | [A] untested | Closest to Ibo One's SQLite model; deprecated but often present in WebKit 538. Probe as fallback. |
| `tizen.filesystem` (`wgt-private`) | [A] untested | JSON chunk files; needs filesystem privileges. |
| `tizen.keymanager` | [A] untested; TV-profile availability unknown | Candidate for passwords. |
| Web Crypto (`crypto.subtle` / `webkitSubtle`) | [A] untested | PIN hashing; fallback is a small own JS SHA-256/PBKDF2 (no dependency). |

## 4. Recommendations

1. **Credentials stay on the TV.** No sync service. Stored in the app's private storage, which other apps can't read. Without keymanager this is access-controlled, **not** encrypted at rest; docs and UI will say so plainly. Bundled-key "encryption" adds nothing and won't be claimed.
2. **Never log** credentials or full stream URLs. Extend the existing `utils/redact.ts` for `/live|movie|series|timeshift/<user>/<pass>/` path segments and `username=`/`password=` parameters.
3. **Catalogue cache:** compact per-section chunks per playlist (so Live TV loads without parsing VOD); Xtream URLs rebuilt at play time; M3U URLs stored once per entry with a shared-prefix table to save space.
4. **Search** runs in JS over an in-memory name index for the active section only, with no query language at all, so injection is not possible.
5. **EPG:** rolling window, channels in the playlist only; discard everything else while parsing.
6. **Parental PIN:** PBKDF2-SHA256, random 16-byte salt, iterations tuned to about 200 ms on the TV. No default PIN. A 4-digit PIN is brute-forceable offline by anyone with storage access; it protects against casual access, not a technical attacker. Documented.
7. **Schema:** reuse the versioned KV store (`stv:v1:<name>`, validator per key, migrations).
8. **Spike before Stage 4:** IndexedDB, WebSQL, `tizen.filesystem`, keymanager and `crypto.subtle` availability and timings for a 20 MB catalogue on the TV.
