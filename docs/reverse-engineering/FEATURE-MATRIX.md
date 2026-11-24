# Feature Matrix and Parity Plan

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. Platform tags from the ScreenShelf device probe (`123movies/docs/PROBE-REPORT.md`, E10): [V] verified on the UE50MU6100, [M] measured, [A] assumed/untested.

Columns:
- **Ibo One**: status / confidence (labels defined in the overview).
- **Tizen 3.0 feasibility** for ScreenShelf on the target TV.
- **Parity**: P1 initial release, P2 later, X deliberately not reproduced.
- **Stage**: the prompt's 10-stage plan.

No ScreenShelf column says "implemented": no IPTV code exists.

## A. Playlist management

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Xtream Codes login (server, user, password) | CONFIRMED-STATIC / High | A6 Server model; A7 `player_api.php` paths | XHR JSON [V], plain HTTP via XHR [V] | P1 | 4 |
| Xtream account info (status, expiry, server info) | CONFIRMED-STATIC / High | A5 `UserInfo`, `ServerInfo`; "Playlist Expirty" (A3) | Yes | P1 | 4 |
| M3U / M3U8 playlist URL parsed on device | **Not found**; ADVERTISED / Low | E1 claims it; A7 has no `tvg-`/`group-title` handling; Server model lacks an M3U URL | Feasible (streaming text parser) | **P1** (ScreenShelf exceeds Ibo One here) | 4 |
| Multiple playlists, switch current | CONFIRMED-STATIC / High | `PlaylistsActivity`, "{count} playlists", "Current Playlist" (A3) | Yes | P1 | 4 |
| Add / edit / remove playlist | CONFIRMED-STATIC / High | `/api/end-users/servers`, `/servers/{id}` (A7); "Add New Playlist" (A3) | Yes, local only | P1 | 4 |
| Playlist stored on vendor backend, editable on web panel | CONFIRMED-STATIC / High | A6, A7, E5 | Needs a backend | X | — |
| Catalogue downloaded into a local DB, refreshed manually | CONFIRMED-STATIC / High | `ContentDownloadService`, SQL in A7, refresh icon (E4) | IndexedDB/WebSQL/files untested [A] | P1 (manual refresh) | 4 |
| Automatic refresh | UNDETERMINED | — | Timer at start-up if older than N hours | P2 | 9 |
| Local playlist file (USB) | UNDETERMINED | `READ_EXTERNAL_STORAGE` (A2) only | `tizen.filesystem` untested [A] | P2 | 4 spike |
| Live and VOD output format preference (ts / m3u8) | CONFIRMED-STATIC / High | "Live streaming default format", "Movies and series default format" (A3) | Required: TS vs HLS support on AVPlay must be probed | P1 | 4/7 |
| Connection error handling | CONFIRMED-STATIC (error strings) / Medium | "Invalid Password.", `ErrorResponse` (A3, A5) | HttpClient error kinds exist (E10) | P1 | 4 |

## B. Live TV

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Categories with counts | CONFIRMED-STATIC / High | `GROUP BY category_id` count query (A7) | Yes | P1 | 5 |
| Channel list, logos, names | CONFIRMED-STATIC / High | `live_streams(name, stream_icon, …)` (A7) | Remote image loading untested [A] | P1 | 5 |
| Adult flag per category/stream | CONFIRMED-STATIC / High | `is_adult` columns (A7) | Yes | P1 (feeds parental) | 5/8 |
| Recently watched ("Latest Viewed") | CONFIRMED-STATIC / High | `LiveStreamHistory`, `/history/…/live-streams` (A5, A7) | Yes, local | P1 | 5 |
| Favourites | CONFIRMED-STATIC / High | `/favorites/…/live-streams` (A7) | Yes, local | P1 | 5 |
| Recently added | CONFIRMED-STATIC / High | `ORDER BY added DESC LIMIT 100` (A7) | Xtream `added`; M3U: none | P2 | 5 |
| Search | CONFIRMED-STATIC / High | `name LIKE` queries (A7) | Yes | P1 | 5 |
| Reorder / hide categories | CONFIRMED-STATIC / High | `MoveAndHideCategoryDialog`, `/sorted-categories` (A3, A7) | Yes, local | P2 | 5 |
| Channel up/down, same-category zapping | CONFIRMED-STATIC / High | "Press Up and Down to change channel", "Same Category" (A3) | Arrows [V]; CH keys registered, not pressed physically [A] | P1 | 7 |
| In-player channel browser | CONFIRMED-STATIC / High | `PlayerChannelBrowserDialog` (A3) | Overlay on video plane | P1 | 7 |
| Catch-up / Replay | CONFIRMED-STATIC / High | `PlayerCatchupActivity`, `timeshift.php`, `tv_archive > 0` (A3, A7) | Depends on TS/HLS timeshift playback [A] | P2 | 7+ |
| Channel descriptions | UNDETERMINED | — | Only via EPG | P2 | 5 |

## C. EPG

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Per-channel EPG via Xtream (`get_simple_data_table`) | CONFIRMED-STATIC / High | A7, `EpgResponse` (A5), `epg_listings` | Small JSON per channel | P1 | 5 |
| Now playing / guide dialog | CONFIRMED-STATIC / High | `EpgDialog`, "Now Playing Program", "TV Guide" (A3) | Yes | P1 | 5 |
| Channel-to-EPG mapping | CONFIRMED-STATIC / High | `epg_channel_id` (A7) | Yes | P1 | 5 |
| XMLTV file parsing | **Not found** / Medium | no `xmltv`/`<programme` strings in A7 | Large files vs about 220 MB free RAM [M]; streaming parser needed | P1 (M3U playlists need it) | 5 |
| Time-zone handling | UNDETERMINED | — | XMLTV offsets; Xtream `server_info.timezone` | P1 | 5 |
| Full-screen grid guide | Not found / Medium | no grid activity (A3) | DOM-heavy; virtualise | P2 | 5 |

## D. Movies

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Categories, poster grid, rating, year | CONFIRMED-STATIC / High | `vod_streams(… rating, rating_5based, tmdb, container_extension, added)` (A7) | Yes | P1 | 6 |
| Details: description, cast, trailer | CONFIRMED-STATIC / High | `SingleMovieActivity`, `get_vod_info`, YouTube intent (A3, A7) | Trailer: no YouTube app intent on Tizen; skip | P1 (no trailer) | 6 |
| TMDB enrichment | CONFIRMED-STATIC / High | `tmdb.*` models, `tmdb_id` (A5, A7) | Needs a TMDB API key; can't ship one | X (use Xtream metadata only) | — |
| Continue watching, resume / start over | CONFIRMED-STATIC / High | "Resume", "Start Over", `VodStreamHistory` (A3, A5) | Yes | P1 | 6 |
| Favourites | CONFIRMED-STATIC / High | `/favorites/…/vod-streams` (A7) | Yes | P1 | 6 |
| Clear watched history per type | CONFIRMED-STATIC / High | "Clear your watched movies history." (A3) | Yes | P1 | 6 |
| Sort by language, year | ADVERTISED / Low | E1 only | Year yes; language only if metadata | P1 (name, year, added) | 6 |

## E. Series

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Series grid, details, seasons, episodes | CONFIRMED-STATIC / High | `get_series_info`, `SeriesSeasonsActivity`, `seriesInfo.*` (A3, A5, A7) | Yes | P1 | 6 |
| Episode history / continue | CONFIRMED-STATIC / High | `EpisodeHistory`, `SeriesHistory` (A5) | Yes | P1 | 6 |
| Season browser inside player | CONFIRMED-STATIC / High | `PlayerSeasonBrowserDialog` (A3) | Overlay | P2 | 7 |
| Watched status, next episode | INFERRED / Medium | history models | Yes | P1 | 6 |
| Series from M3U playlists | n/a in Ibo One | — | Heuristic name parsing (`S01E02`) | P2 | 6 |

## F. Player

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Engine | Media3 ExoPlayer + FFmpeg decoders: CONFIRMED-STATIC / High | A4, A5 | AVPlay only (ARCHITECTURE.md §4) | — | 7 |
| HLS | CONFIRMED-STATIC / High | `HlsMediaSource` (A5) | [V] | P1 | 7 |
| Continuous MPEG-TS over HTTP | INFERRED / Medium (Media3 supports it; "ts" format option) | A3 | **[A] untested** | P1 after probe | 7 |
| Software decoding of exotic codecs (FFmpeg) | CONFIRMED-STATIC / High | A4 | Not possible: AVPlay uses hardware decoders only; HEVC/AC3 untested [A] | X | — |
| Pause, seek, resume | CONFIRMED-STATIC / High | media3 control strings (A3) | [V] | P1 | 7 |
| Audio / video / subtitle track selection | CONFIRMED-STATIC / High | `PlayerTrackDialog` (A3) | Audio [V]; video-track switching untested [A] | P1 audio+subs, P2 video | 7/8 |
| Aspect ratio | CONFIRMED-STATIC / High | `PlayerAspectRatioDialog`, `AspectRatioSurfaceView` (A3, A5) | `setDisplayMethod` untested [A] | P1 | 7 |
| Playback speed | CONFIRMED-STATIC / High | `PlayerPlaybackSpeedDialog` (A3) | `setSpeed` unreliable [V] | X | — |
| Brightness / volume | CONFIRMED-STATIC / High | `BrightnessAndVolumeDialog` (A3) | TV handles volume; no brightness API needed | X | — |
| Buffering indicator, error, retry | CONFIRMED-STATIC (Retry string) / Medium | A3 | Events [V]; prepare watchdog required [V] | P1 | 7 |

## G. Subtitles

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Embedded subtitle tracks | CONFIRMED-STATIC / High | "Available Subtitles" (A3) | HLS WebVTT [V]; DASH none [V]; TS DVB/teletext untested [A] | P1 | 8 |
| Online subtitle search and download (gz → VTT via vendor proxy) | CONFIRMED-STATIC / High | `subtitledevui.logicyel.com/api/subtitles/search`, `extract-vtt?gzUrl=` (A7); Subtitle model (A6) | Needs a third-party service and account/key | X initial; P2 optional with user-supplied provider | 8+ |
| Machine translation of subtitles | ADVERTISED / Low; no code found | E1; A7 | See PLAYBACK-ANALYSIS §6 | X initial | — |
| Subtitle size | CONFIRMED-STATIC / High | "Subtitle Size" (A3) | CSS class | P1 | 8 |
| Sync offset | UNDETERMINED | — | Sidecar only | P2 | 8 |

## H. Parental controls

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| Parent password to unlock streams | CONFIRMED-STATIC / High | "Please enter parent password to unlock this stream.", "Stream Locked" (A3) | Yes | P1 | 8 |
| Default password 0000, reset to default | CONFIRMED-STATIC / High | "reset your parent password to it's default value (0000)" (A3) | ScreenShelf: no default; user sets PIN on first use | P1 (different) | 8 |
| Password stored/changed on vendor backend | CONFIRMED-STATIC / High | `/api/end-users/devices/parent-password` (A7) | Local hashed PIN | P1 (local) | 8 |
| Adult content flag | CONFIRMED-STATIC / High | `is_adult` columns (A7) | Yes | P1 | 8 |
| Master PIN for web panel | CONFIRMED-STATIC / High | "Master PIN allows full control…" (A3) | No panel | X | — |
| Protected settings | UNDETERMINED | — | Yes | P1 | 8 |

## I. User experience and platform

| Feature | Ibo One | Evidence | Tizen 3.0 feasibility | Parity | Stage |
|---|---|---|---|---|---|
| UI languages (EN, AR, PT, ES; FR in screenshot) | CONFIRMED-STATIC / High | A3, E3; `supportsRtl="true"` | RTL needs mirrored layout | P1 EN (+1 language TBD), P2 RTL | 8 |
| Multiple themes | ADVERTISED / Low; no theme strings | E1, A3 | Class swap with pre-built CSS (no CSS variables [V]) | P1 (2 themes) | 8 |
| Google sign-in / device flow, cross-device sync | CONFIRMED-STATIC / High | `api/google/start-device-flow`, history/favourites routes (A7) | Needs a backend | X (export/import file as P2) | — |
| Licence, trial, Play Billing, QR payment, resellers | CONFIRMED-STATIC / High | A3, A7 | — | X | — |
| Forced app update | CONFIRMED-STATIC / High | `AppUpdateActivity` (A3) | — | X | — |
| Start on boot | CONFIRMED-STATIC / High | `BootCompleteReceiver` (A3) | Tizen web apps can't auto-start on boot | X | — |
| Exit confirmation | CONFIRMED-STATIC / High | `ExitDialog` (A3) | Yes | P1 | 3 |
| Empty / loading / error states | CONFIRMED-STATIC (strings) / High | "No items in this category!", "No data available.", "Loading EPG..." (A3) | Yes | P1 | 3+ |
| Analytics, crash reporting, ads ID | CONFIRMED-STATIC / High | Firebase, `AD_ID` (A3) | — | X (no telemetry) | — |
