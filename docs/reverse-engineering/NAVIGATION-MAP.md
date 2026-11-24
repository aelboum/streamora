# Navigation Map

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. Screen numbers: `SCREEN-INVENTORY.md`.

Screens are CONFIRMED-STATIC (they exist in the manifest). **Transitions are INFERRED** from class names, string resources and screenshots; no method bodies were read and the app was not run. Confidence per edge is Medium unless noted.

## 1. Reference app (Ibo One)

```mermaid
graph TD
  Splash[1 Splash] --> Upd{Update required?}
  Upd -->|yes| AppUpdate[4 AppUpdate]
  Upd -->|no| Lang{Language chosen?}
  Lang -->|no| LangSel[3 LanguageSelect]
  Lang -->|yes| Disc[2 Disclaimer]
  LangSel --> Disc
  Disc --> Reg{Device registered / licence}
  Reg -->|expired| Expired[8 SubscriptionExpired]
  Reg -->|device limit| DevLimit[9 New device registration]
  Reg -->|ok| PL{Playlist selected?}
  Expired --> Products[6 Products/Offers] --> QR[7 ProductQr]
  PL -->|none| Playlists[11 Playlists] --> Add[12 PlaylistAdd]
  PL -->|yes| Home[13 PlaylistHome]
  Add --> Download[14 Content download] --> Home
  Home --> Live[15 LiveStreams]
  Home --> Vod[16 GeneralVod: Movies or Series]
  Home --> Fav[20 Favorites]
  Home --> CW[21 ContinueWatching]
  Home --> Search[22 Search]
  Home --> Catchup[27 PlayerCatchup via Replay]
  Home --> Settings[37 Settings]
  Home --> Playlists
  Home --> Products
  Live -->|OK| Player[25 PlayerVod]
  Live -->|long press| Opt[23 ItemList / 24 MoveAndHideCategory]
  Vod -->|movie| Movie[17 SingleMovie] --> Player
  Vod -->|series| Series[18 SingleSeries] --> Seasons[19 SeriesSeasons] --> EpPlayer[26 PlayerEpisodes]
  CW --> Player
  CW --> EpPlayer
  Player --> ChBrowser[28 ChannelBrowser]
  Player --> EPG[29 EpgDialog]
  Player --> Tracks[31 Tracks]
  Player --> Aspect[32 AspectRatio]
  Player --> Speed[33 Speed]
  Player --> Subs[35 Subtitles]
  EpPlayer --> SeasonBrowser[30 SeasonBrowser]
  Settings --> ParentPw[38 Parent password]
  Settings --> LangSel
  Settings --> Login[5 Login / Google device flow]
  any[Locked stream] -->|OK| ParentPw
  Home -->|Back| Exit[39 ExitDialog]
```

| Edge / rule | Status | Conf. | Basis |
|---|---|---|---|
| Splash is the only launcher | CONFIRMED-STATIC | High | A3 |
| Update gate before use ("UPDATE REQUIRED") | INFERRED | Medium | A3 strings + AppUpdateActivity |
| Language selection at first run and from Settings | INFERRED | Medium | `LanguageSelectActivity` + `LanguageSelectDialog`; "You can switch languages anytime from the settings menu" (A3) |
| Licence/registration gate (expired, device limit) | INFERRED | Medium | Subscription activities and strings (A3, A5) |
| Login is optional ("Skip Login For Now") | CONFIRMED-STATIC (string) | High | A3 |
| Catalogue download before browsing | INFERRED | Medium | "Still downloading content." + `ContentDownloadService` (A3) |
| Players are `singleInstance` activities (separate task) | CONFIRMED-STATIC | High | A3 |
| Up/Down zaps channels in the player | CONFIRMED-STATIC (hint string) | High | "Press Up and Down to change channel" (A3) |
| Locked streams prompt for parent password | CONFIRMED-STATIC (string) | High | A3 |
| Back at home opens exit dialog | INFERRED | Medium | `ExitDialog` (A3) |

## 2. Proposed ScreenShelf IPTV navigation (for Stage 2 review; not approved)

Adapts the approved ScreenShelf router rules (screen stack; roots use `resetTo`; overlays close first on Back; Back at a root focuses the side nav, then the exit dialog; ARCHITECTURE.md §2C). Every function is reachable with arrows, OK and Back only (decision D6). No vendor backend, no licence gate, no login.

```mermaid
graph LR
  Launch --> Gate{Any playlist?}
  Gate -->|no| Onboard[Add playlist: M3U URL or Xtream]
  Gate -->|yes| Home
  Onboard --> Load[Loading playlist: progress, cancel] --> Home
  subgraph Roots[Side-nav roots: resetTo]
    Home; Live[Live TV]; Movies; Series; Search; Settings
  end
  Live -->|OK| LivePlayer[Player: live]
  LivePlayer -->|Up/Down, CH+/-| LivePlayer
  LivePlayer -->|OK| Banner[Info banner: now/next]
  LivePlayer -->|Left| ChList[Channel list overlay]
  LivePlayer -->|Right| Guide[EPG overlay]
  LivePlayer -->|Down| Menu[Audio / subtitles / aspect]
  Movies -->|OK| MD[Movie details] --> VodPlayer[Player: VOD]
  Series -->|OK| SD[Series details: seasons, episodes] --> VodPlayer
  Home -->|Continue card| VodPlayer
  Settings --> Playlists[Playlists: add, edit, refresh, remove, switch]
  Settings --> Parental[Parental: PIN, locked categories]
  Settings --> Appearance[Theme, language]
  Settings --> PlaybackPrefs[Subtitles, audio, aspect, live format]
  Locked[Locked item] -->|OK| PIN[PIN dialog]
  VodPlayer -->|Back| MD
  LivePlayer -->|Back| Live
  Roots -->|Back at root| Nav[Side nav] -->|Back| Exit[Exit dialog]
```

Differences from Ibo One, by design:
- **Long-press is never required.** Ibo One relies on "Long click for options". ScreenShelf gives every list item a visible Options action (e.g. a "⋯" button reached with Right, or the Red key). Long-press (detected by key-repeat timing, first repeat after about 458 ms on the target TV, PROBE-REPORT §6) remains an accelerator.
- Player overlays are mapped to arrow keys instead of separate dialog activities, so the player never loses the video plane.
- No update gate, licence gate, login or device registration.
