# UX Analysis

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. Layout observations come from marketing images (E3, E4) and are capped at Medium confidence. Behaviour observations come from string resources and class names (A3, A5).

## 1. Observed Ibo One UX patterns

| # | Pattern | Status / conf. | Evidence | Take for ScreenShelf? |
|---|---|---|---|---|
| U1 | **Dashboard home** with three large section tiles (Live TV, Movies, Series), each with item count and "Last updated" time | CONFIRMED-PUBLIC / Medium | E4 | Yes, adapted: tiles plus counts and last refresh; our own visual design. |
| U2 | Side cards: Favourites count; Playlists (count, current playlist, expiration, Manage) | CONFIRMED-PUBLIC / Medium | E4 | Yes (playlist status card). |
| U3 | Continue Watching row with progress bar and "min left" | CONFIRMED-PUBLIC + STATIC / Medium | E4, A3 ("48 min watched" sample) | Yes (already in ScreenShelf design). |
| U4 | **Three-column browse**: category list → content list/grid → preview/info (Live TV) | CONFIRMED-PUBLIC / Medium | E3.2–E3.7 | Yes. Well suited to D-pad: Left/Right moves between columns. |
| U5 | Virtual categories at the top of every section: Latest Viewed / Continue Watching, Favorites, All (count), Newly Added | CONFIRMED-PUBLIC + STATIC / Medium | E3, A7 queries | Yes. |
| U6 | Category counts in the sidebar | CONFIRMED-STATIC / High | A7 count query | Yes (computed at parse time). |
| U7 | "Long click for options" for item actions | CONFIRMED-STATIC / High | A3 | **Change:** visible Options action; long-press only as accelerator. |
| U8 | Reorder/hide categories | CONFIRMED-STATIC / High | A3 | P2. |
| U9 | Resume prompt: Resume / Start Over | CONFIRMED-STATIC / High | A3 | Yes, as Details buttons (no modal). |
| U10 | Player sub-dialogs for channels, EPG, tracks, aspect, speed, seasons | CONFIRMED-STATIC / High | A3 | Yes as overlays on arrow keys (no speed). |
| U11 | Hint text in player: "Press Up and Down to change channel" | CONFIRMED-STATIC / High | A3 | Yes, shown once. |
| U12 | Empty states: "No items in this category!", "No Playlists Added", "Your recent streams will appear here…" | CONFIRMED-STATIC / High | A3 | Yes, with a call-to-action button each. |
| U13 | Footer status: playlist name, expiration; Device ID/PIN; clock | CONFIRMED-PUBLIC / Medium | E3, E4 | Playlist + expiry + clock yes; Device ID/PIN no. |
| U14 | Language picker with flags at first run; RTL support flag | CONFIRMED-STATIC / High | A3, E3.5 | Language yes; flags no (languages ≠ countries). |
| U15 | Trial badge, "Upgrade Now", offers with discounts on home | CONFIRMED-PUBLIC + STATIC / High | E4, A3 | **No.** ScreenShelf has no paywall. |
| U16 | Web panel / QR for entering long URLs and passwords from a phone | CONFIRMED-STATIC + PUBLIC / High | A3, E5 | Problem is real (see §3); solution needs a backend. Not in P1. |
| U17 | Single dark green theme in all imagery, despite "multiple themes" claim | CONFIRMED-PUBLIC / Medium | E3, E4 | Our own palette; 2 themes. |
| U18 | Phone-oriented controls on TV (brightness/volume dialog, touch features declared optional) | CONFIRMED-STATIC / High | A3 | No: TV handles volume. |

## 2. Remote-control model for ScreenShelf

Fixed by the ScreenShelf probe: the user's Smart Remote has **no media keys**; Back = 10009; arrows and OK only (D6). `event.repeat` is always false; repeat starts after 458 ms then every 108 ms [M].

| Context | Up / Down | Left / Right | OK | Back | Optional keys |
|---|---|---|---|---|---|
| Side nav | Move | Right enters content | Open root | Exit dialog | — |
| Category column | Move | Right → content | Select category | Side nav | — |
| Content list/grid | Move (grid: rows) | Move / Left at edge → categories; Right at edge → Options/preview | Open/play | Categories | Red = Options, Green = Favourite |
| Live player | Channel −/+ (debounced) | Left: channel list; Right: EPG | Info banner | Close overlay, then back to Live TV | CH±, colour keys |
| VOD player | Show controls | Seek ±10 s; hold = accelerating scrub | Play/pause | Show controls, then Details | Media keys if present |
| Dialogs / keyboard | Move | Move | Activate | Close | — |

Focus rules carry over from ARCHITECTURE.md §2D (zone graph, one focused element, remembered index per zone, fallback on removal, 110 ms held-key throttle, animations off while held).

## 3. Text entry is the hard part

Adding a playlist means typing a long URL or a server, username and password with a D-pad. Ibo One solves this with its web panel and QR codes, which require the vendor backend (U16).

Options for ScreenShelf, none needing a cloud service:

| Option | Effort | Notes |
|---|---|---|
| Own on-screen keyboard with URL helpers: keys for `http://`, `https://`, `.com`, `:8080`, `/`, `.m3u`, paste-free | Low | P1. Already planned (ARCHITECTURE.md module F keyboard). |
| Tizen system IME | Low | Varies by firmware; must be tested [A]. Could be offered as an alternative. |
| Import from USB file (`.m3u` or a small JSON with credentials) | Medium | Needs `tizen.filesystem`; untested [A]. P2. |
| LAN pairing (phone sends the playlist to the TV over the home network) | High | A Tizen web app can't run an HTTP server, so something else on the LAN would have to host the page. Not feasible without extra infrastructure. |
| Phone keyboard via Samsung SmartView/remote apps | n/a | Depends on the TV's own features; outside the app. |

## 4. Layout budget for 1920×1080 (target facts)

- Fixed 1080p pixels, DPR 1 [V]; flexbox + margins, no grid/gap/variables/sticky [V].
- Three-column browse: category column 380 px, content list 760 px (live) or poster grid 5 columns (VOD), preview/info 640 px. Safe areas per ARCHITECTURE.md §6.1.
- Long lists are virtualised (render visible rows + small buffer). Thousands of channels must never be in the DOM at once.
- Minimum text 20 px; channel rows 64 px high; posters 240×360.
