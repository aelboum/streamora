# Implementation Recommendations

Status: **proposal for review. Stage 2 has not started.** Nothing here changes the approved ScreenShelf architecture until you approve it. Evidence IDs: `APPLICATION-OVERVIEW.md` §3.

## 1. Clean-room principles

1. Reproduce behaviour, not code. No Ibo One code, layouts, images, strings, colours, names or backend protocol are reused. Its findings only tell us *which* user-facing features exist and *which* public protocols (M3U, Xtream, XMLTV) the market expects.
2. No vendor backend, no account, no licence gate, no telemetry, no device identifiers.
3. Credentials stay on the TV and go only to the provider the user entered.
4. The app ships no content, no playlist URLs and no credentials.
5. Every compatibility claim needs device evidence: [V] verified on the TV, [M] measured, [A] assumed.

## 2. Recommended architecture (proposed revision 3 of ARCHITECTURE.md)

Keeps the approved foundation (shell, platform, router, focus manager, HttpClient, KV store, player engine abstraction, build gates). Replaces the curated-catalogue content layer with IPTV sources.

```
Screens       Home · LiveTV · Movies · Series · Details · Search · Player · Settings
              (Playlists, Parental, Appearance, Playback prefs) · Onboarding
   ↓
Components    SideNav · CategoryColumn · VirtualList · PosterGrid · ChannelRow ·
              EpgStrip · Keyboard · PinPad · Dialog · Toast · Spinner · PlayerOverlays
   ↓
Navigation    Router · KeyRouter · FocusManager          Player   PlaybackController
                                                                 LiveController (zapping)
                                                                 SubtitleManager · AudioTracks
   ↓
Services      PlaylistService · CatalogueService · EpgService · SearchService ·
              FavouritesService · HistoryService · ParentalService · SettingsService ·
              I18nService · ThemeService
   ↓
ContentProvider   IptvSource (interface)
                  ├─ M3uSource     (streaming M3U/M3U8 parser)
                  └─ XtreamSource  (player_api.php client)
                  EpgSource: XmltvSource (streaming), XtreamEpgSource
   ↓
Storage       KeyValueStore (localStorage) · CatalogueStore (chunked; IndexedDB/WebSQL/
              files per spike result) · SecretStore (playlists; keymanager if available)
   ↓
Platform      TizenPlatform · BrowserPlatform · AVPlayEngine · Html5VideoEngine (dev)
              HttpClient (strict policy + user-source policy, streaming mode)
```

Rules (prompt §5 plus approved rules):
- Screens never touch AVPlay, `tizen.*`, `webapis.*` or storage directly.
- Components hold no business logic: they render view models and emit intents.
- Services and sources have no DOM dependency, so they are testable in Node on Windows.
- Only `platform/avplay-engine.ts` calls `webapis.avplay`.
- Interfaces between layers; no DI library (single `AppContext`, as approved).

Key interfaces (design contracts, not code yet):

```ts
interface IptvSource {
  kind: 'm3u' | 'xtream';
  validate(): Promise<SourceStatus>;            // auth / reachability / expiry
  load(onProgress: (p: LoadProgress) => void, signal: CancelToken): Promise<CatalogueSnapshot>;
  resolveStream(ref: StreamRef, prefs: FormatPrefs): PlaybackSource; // URL built at play time
  vodInfo?(id: string): Promise<VodDetail>;
  seriesInfo?(id: string): Promise<SeriesDetail>;
  catchup?(ref: StreamRef, start: number, minutes: number): PlaybackSource;
}
interface EpgService {
  nowNext(channelKey: string): ProgrammePair | null;
  schedule(channelKey: string, from: number, to: number): Programme[];
  refresh(onProgress: (p: LoadProgress) => void): Promise<void>;
}
interface ParentalService {
  isLocked(item: { categoryId: string; adult?: boolean }): boolean;
  verify(pin: string): Promise<boolean>;      // PBKDF2 compare, rate-limited
  setPin(oldPin: string | null, newPin: string): Promise<void>;
  reset(confirmation: ResetConfirmation): void; // wipes parental data
}
```

Parsers (M3U, Xtream JSON normalisation, XMLTV, channel→EPG matching, timezone math) are pure functions over strings/chunks: the core of the Windows test suite.

## 3. Proposed stages (prompt numbering)

| Stage | Scope | Exit criteria | Depends on |
|---|---|---|---|
| **1 Reverse engineering** | This folder | **Done, awaiting approval** | — |
| **2 Architecture + plan** | ARCHITECTURE.md rev 3 (IPTV); resolve C1–C4; **device probe 2** (see §4); storage spike | Approved rev 3; probe report with TS/HTTP/codec/storage results | Your decisions in §5 |
| **3 Foundation** | Re-scope shell; side nav; router/focus (existing design); KV store; HttpClient user-source policy + streaming mode; i18n and theme plumbing; `tests/` folder created | `npm run check` green; focus/router tests; browser render at 1920×1080; on-TV navigation pass | 2 |
| **4 IPTV core** | PlaylistService; M3U streaming parser; Xtream client; catalogue store; add/edit/remove/switch/refresh; onboarding with own keyboard; error states | Parser and client unit tests with fixtures (incl. malicious metadata); 50k-entry synthetic playlist parse time and memory measured on TV | 3 |
| **5 Live TV + EPG** | Category column, virtualised channel list, logos, favourites, recents, search; XMLTV streaming parser; Xtream EPG; now/next; mapping; time zones | EPG tests; on-TV scroll performance with 5,000 channels | 4 |
| **6 VOD** | Movies, series, details, seasons, episodes, continue watching, history, sorting/filtering | Service tests; on-TV pass | 4 |
| **7 Player** | AVPlayEngine (existing design) + live controller, zapping, overlays, tracks, aspect, buffering, recovery | FakeEngine tests; every format class from the probe tried on the TV | 2 (probe), 5, 6 |
| **8 Advanced** | Subtitles (embedded, sidecar), parental (PIN, locked categories, adult flag, protected settings), themes (2), languages | Sanitiser and parental tests; on-TV pass | 7 |
| **9 Hardening** | Performance, memory soak, security review, error recovery, catch-up (P2 if probe allows), auto-refresh | Soak report; review findings closed | 8 |
| **10 Device validation** | Full on-TV checklist with physical remote | TEST-REPORT.md: each item marked implemented / tested / simulator / physical device | 9 |

## 4. Device probe 2 (needed before the IPTV design is final)

Re-use the existing probe app and collector (`123movies/probe`). All streams must be legally usable test content (self-encoded samples served from a LAN PC, or public test streams).

| # | Test | Why |
|---|---|---|
| P1 | AVPlay: continuous MPEG-TS over **HTTP** (LAN server), H.264/AAC and H.264/MP2 audio | K1, K2 |
| P2 | AVPlay: HLS over plain HTTP | K2 |
| P3 | AVPlay: HEVC (TS and MP4), AC3/E-AC3 audio, MKV container | K3 |
| P4 | AVPlay: `setDisplayMethod` modes; small `setDisplayRect` preview; close→open zap time | K10, zapping |
| P5 | XHR: incremental `responseText` during `onprogress` for a 50 MB text file; peak memory | K4 |
| P6 | Storage: IndexedDB, WebSQL, `tizen.filesystem`, `tizen.keymanager` availability; write/read 20 MB | K5 |
| P7 | `crypto.subtle` / `webkitSubtle` availability; PBKDF2 timing (JS fallback timing too) | Parental PIN |
| P8 | Remote images from HTTP hosts; 100 logo loads | K13 |
| P9 | CH+/CH− physical keys (if present on the remote) | K9 |
| P10 | Tizen IME for text input | K11 |

## 5. Outstanding questions and blockers (your decisions)

| # | Question | Default if you don't decide |
|---|---|---|
| Q1 | Approve re-scoping ScreenShelf from curated VOD to IPTV player (C1)? Keep the existing `123movies` repo or start a new one (C9)? | Blocker for Stage 2. |
| Q2 | Approve the user-source network policy: http + any host/port, wildcard `<access>`, CSP `http: https:` for data/media/images (C2)? | Blocker for Stage 4. |
| Q3 | Approve storing playlist credentials on the TV, documented as not encrypted at rest unless keymanager works (C3)? | Blocker for Stage 4. |
| Q4 | Initial UI languages: English only, or English + Dutch (or another)? Arabic/RTL in P2? | English + one more after you choose. |
| Q5 | Subtitle search / translation: drop from the roadmap, or keep as P2 with a user-supplied provider? | Dropped from initial release. |
| Q6 | Catch-up (timeshift): P2 after probe? | P2. |
| Q7 | USB playlist import (needs filesystem privilege): include in P2? | P2 after probe. |
| Q8 | Do you have a legal IPTV/Xtream test source (e.g. your own provider account or a self-hosted test server) for device testing? Without one, Stages 4–7 can only be tested against local fixtures and self-made streams. | Local fixtures + LAN test server built from self-encoded samples. |
| Q9 | Should the docs move into the ScreenShelf repo (`123movies/docs/reverse-engineering/`)? They are currently in `IboOne/docs/reverse-engineering/` so no ScreenShelf file was touched. | Stay where they are. |
