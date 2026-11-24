# Screen Inventory

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. Each Android activity or dialog-activity in the manifest (A3) is a screen. Names are the vendor's class names; responsibilities come from class names, related string resources (A3) and screenshots (E3, E4). Layout details come only from marketing images and are capped at Medium confidence.

All activities are `exported="false"` and landscape-only except the launcher (A3).

## 1. Start-up and account

| # | Screen (class) | Purpose | Status / conf. | Evidence |
|---|---|---|---|---|
| 1 | `SplashActivity` | Launcher entry (MAIN, LAUNCHER, LEANBACK_LAUNCHER), `singleTask` | CONFIRMED-STATIC / High | A3 |
| 2 | `DisclaimerActivity` | Legal notice ("pure media player…") | CONFIRMED-STATIC (class) / Medium (content inferred from E1) | A3, E1 |
| 3 | `LanguageSelectActivity`, `LanguageSelectDialog` | "Please Choose Language … set the display for all menus, settings, and on-screen text." Strings for English, Arabic, Portuguese, Spanish; screenshot also shows French | CONFIRMED-STATIC / High | A3, E3 |
| 4 | `AppUpdateActivity` | Forced update: "UPDATE REQUIRED", "Update Now", "Remind Me Later", "YOUR VERSION: V{version}" | CONFIRMED-STATIC / High | A3 |
| 5 | `subscription.LoginActivity` | "Sign Up Or Login", "Why Sign In With Google?", "Skip Login For Now"; Google device flow: "visit google.com/device or scan the QR code … enter a unique 9-letter code" | CONFIRMED-STATIC / High | A3, A7 (`api/google/start-device-flow`) |
| 6 | `subscription.SubscriptionProductsActivity`, `OffersActivity` | Packages and offers: "Select Your Ideal Entertainment Package", "Per device, Per year", "One-time payment. Lifetime access", "OWN IT FOR LIFE – {n}% OFF" | CONFIRMED-STATIC / High | A3 |
| 7 | `subscription.ProductQrActivity`, `dialog.QrDialog` | Pay by phone: "Scan QR Code … secure payment page", "Enter the payment link … enter the code" | CONFIRMED-STATIC / High | A3 |
| 8 | `subscription.SubscriptionExpiredActivity` | "Your Subscription Has Expired." Reseller activation: "Sending this code allows the reseller to activate your subscription only." | CONFIRMED-STATIC / High | A3 |
| 9 | (device-limit flow) | "It looks like you're using a new device. Please log out one of your registered devices…", "New Device Registration" (models `SecondaryDevice`, `SerialsEligibleForLogout`) | CONFIRMED-STATIC / High | A3, A5 |
| 10 | `WhiteLabelActivity` | White-label branding/background from backend | CONFIRMED-STATIC / Medium | A3, A7 |

## 2. Playlists

| # | Screen | Purpose | Status / conf. | Evidence |
|---|---|---|---|---|
| 11 | `PlaylistsActivity` | "Your Playlists", "{count} playlists", "Add New", "Open playlist", "No Playlists Added", "Add your IPTV playlist to start streaming." | CONFIRMED-STATIC / High | A3 |
| 12 | `PlaylistAddActivity` | "Enter Your Playlists Details": Playlist Name, URL, User Name, Password (Xtream). Alternative: "Open Panel … to enter the Panel to enable adding the server" (web panel, E5) with Device ID/PIN | CONFIRMED-STATIC / High | A3, A6 (Server: domain, username, password, name) |
| 13 | `PlaylistHomeActivity` | Home dashboard for the current playlist: tiles Live TV / Movies / Series with counts, Favorites, Playlists (Manage), Current Playlist, Expiration, Continue Watching row, Device ID/PIN, trial badge, Upgrade Now, Search, Replay, refresh, settings | CONFIRMED-STATIC (class) + CONFIRMED-PUBLIC (layout) / Medium | A3, E3.1, E4 |
| 14 | (download progress) | "Still downloading content.", "Download complete", "Download failed!" while `ContentDownloadService` fills the local DB | CONFIRMED-STATIC / High | A3 |

## 3. Browsing

| # | Screen | Purpose | Status / conf. | Evidence |
|---|---|---|---|---|
| 15 | `LiveStreamsActivity` | Category column (Latest Viewed, Favorites, All, Newly Added, categories with counts) + channel list + preview/EPG pane; "Long click for options" | CONFIRMED-STATIC + PUBLIC / Medium | A3, E3.2, E3.6 |
| 16 | `GeneralVodActivity` | Shared Movies/Series grid screen: sidebar + poster grid with rating and year | CONFIRMED-STATIC + PUBLIC / Medium | A3, E3.3, E3.4 |
| 17 | `SingleMovieActivity` | Movie details: Description, Cast, Trailer (YouTube intent), Watch Now / Resume, Like (favorite) | CONFIRMED-STATIC / Medium | A3 ("Description: {description}", "Cast", "Trailer", "Watch Now"; `<queries>` for `vnd.youtube`) |
| 18 | `SingleSeriesActivity` | Series details (TMDB-enriched: seasons, crew, guest stars) | CONFIRMED-STATIC / Medium | A3, A5 (`tmdb.*` models) |
| 19 | `SeriesSeasonsActivity` | "Seasons & Episodes", "Season {n} {count} Episodes", "Episode {n}" | CONFIRMED-STATIC / High | A3 |
| 20 | `FavoritesActivity` | Favourites across types | CONFIRMED-STATIC / High | A3 |
| 21 | `ContinueWatchingActivity` | "Start watching any movie or series, and it will appear here…" | CONFIRMED-STATIC / High | A3 |
| 22 | `SearchActivity` (`singleTask`) | "Type your search keyword …", "Please enter a search keyword." | CONFIRMED-STATIC / High | A3 |
| 23 | `dialog.ItemListDialog` | Generic picker (long-press options) | CONFIRMED-STATIC / Low (purpose inferred) | A3 |
| 24 | `dialog.MoveAndHideCategoryDialog` | Reorder and hide categories (synced: `/api/end-users/sorted-categories`) | CONFIRMED-STATIC / High | A3, A7 |

## 4. Player

| # | Screen | Purpose | Status / conf. | Evidence |
|---|---|---|---|---|
| 25 | `PlayerVodActivity` (`singleInstance`) | VOD/live player; resume prompt "You've previously watched this video…" Resume / Start Over; "Continue From" | CONFIRMED-STATIC / High | A3 |
| 26 | `PlayerEpisodesActivity` (`singleInstance`) | Episode playback with next-episode context | CONFIRMED-STATIC / Medium | A3 |
| 27 | `PlayerCatchupActivity` (`singleInstance`) | Catch-up (Xtream timeshift); "No Catchup Available"; Replay entry point | CONFIRMED-STATIC / High | A3, A7 (`streaming/timeshift.php`, `tv_archive > 0` queries) |
| 28 | `dialog.player.PlayerChannelBrowserDialog` | In-player channel list; "Same Category"; "Press Up and Down to change channel" | CONFIRMED-STATIC / High | A3 |
| 29 | `dialog.player.EpgDialog` | "TV Guide", "Now Playing Program", "Loading EPG...", "No EPG Available", "Invalid EPG" | CONFIRMED-STATIC / High | A3 |
| 30 | `dialog.player.PlayerVodBrowserDialog`, `PlayerSeasonBrowserDialog` | Browse VOD / seasons without leaving the player | CONFIRMED-STATIC / Medium | A3 |
| 31 | `dialog.player.PlayerTrackDialog` | "Audio Tracks", "Video Tracks", "Available Subtitles" | CONFIRMED-STATIC / High | A3 |
| 32 | `dialog.player.PlayerAspectRatioDialog` | "Screen Ratio" (e.g. 16:9) | CONFIRMED-STATIC / High | A3 |
| 33 | `dialog.player.PlayerPlaybackSpeedDialog` | Playback speed | CONFIRMED-STATIC / High | A3 |
| 34 | `dialog.player.BrightnessAndVolumeDialog` | Brightness and volume (phone-oriented) | CONFIRMED-STATIC / High | A3 |
| 35 | `PlayerSubtitlesActivity` (transparent) | Online subtitle search/selection ("Ora Subtitles"), "Subtitle Enabled", "Subtitle Size" | CONFIRMED-STATIC / Medium | A3, A6, A7 |
| 36 | `PlayerSettingsActivity` (transparent) | Per-player settings | CONFIRMED-STATIC / Low (contents) | A3 |

## 5. Settings and system

| # | Screen | Purpose | Status / conf. | Evidence |
|---|---|---|---|---|
| 37 | `SettingsActivity` | Account Info, Change Language, Parent Lock (change/reset parent password), "Live streaming default format", "Movies and series default format", "Start on boot", clear watched channels/movies/series, Subscription, Servers, Feedback, Help, Log Out | CONFIRMED-STATIC / High (items exist as strings; exact grouping Medium) | A3 |
| 38 | Parent password dialogs | "Parent Password", "Please enter parent password to unlock this stream.", "Stream Locked", "Reset Parent Password", reset "to it's default value (0000)", "Master PIN" | CONFIRMED-STATIC / High | A3, A7 (`/api/end-users/devices/parent-password`) |
| 39 | `dialog.ExitDialog` | "Are you sure you want to exit the Application?", "Cancel and Exit" | CONFIRMED-STATIC / High | A3 |
| 40 | `BootCompleteReceiver` (not a screen) | Auto-start on boot when enabled ("works on android 9 or earlier") | CONFIRMED-STATIC / High | A3 |

## 6. External

| # | Screen | Status / conf. | Evidence |
|---|---|---|---|
| W1 | Web panel `euser.iboonetv.com`: Device Id + Pin code login → device page (servers, subscription) | CONFIRMED-PUBLIC / High | E5; strings "Open Panel", "The Master PIN allows full control: view existing servers, add new ones, view device details, and manage subscription payments" (A3) |

## 7. Not found in the binary

- No dedicated full-screen **EPG grid** activity; EPG is a dialog in the player and a pane in Live TV. (CONFIRMED-STATIC absence of a class, Medium: could be a fragment with an obfuscated name.)
- No **theme picker** strings, despite "multiple professional themes" (E1). ADVERTISED, Low.
- No **M3U URL** field label distinct from "URL"/"Website URL"; see `FEATURE-MATRIX.md` A.
