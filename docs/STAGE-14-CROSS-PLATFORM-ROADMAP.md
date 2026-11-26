# Cross-platform IPTV migration: implementation roadmap

Date: 2026-11-26. This is the plan only; nothing in it has been started. Background and evidence: `docs/STAGE-14-CROSS-PLATFORM-AUDIT.md`.

The steps are named R0–R6. Stage numbers are your decision (audit D1).

## Rules for every step

1. **Samsung stays working:**
   - `npm run check` passes: all unit tests, build tests and the ES5 gate;
   - `release-check` passes;
   - a short Samsung TV regression with the physical remote before the step is accepted: Live zap and CH±, the number entry, VOD playback with audio and subtitle choice, My List, Manage categories, restart.
2. **Additive changes only** in shared code: new interfaces get defaults that keep today's behaviour.
3. **Tests first:** new adapters get unit tests with fakes, as `fake-tizen` does today.
4. **Device proof:** nothing counts as supported until it is tested on the real device, clearly separating physical tests from scripted ones.
5. **No commit, push, store submission or purchase** without your approval in that step.

## Dependency overview

```text
R0 decisions & hardware
  └─► R1 contract hardening (Samsung unchanged)
        ├─► R2 Android device validation ──────────────┐
        └─► R3 LG webOS adapter ─► R4 HTML5 engine hardening ─► R5 Titan OS PoC (gated by R0 Titan answers)
                                                         └──────────────┴─► R6 release engineering & stores
```

R2 and R3 can run in parallel once R1 is done, if both devices are available.

---

## R0 — Decisions and hardware (no code)

**Content:**
- Answer the decisions in audit §20: D1 numbering, D2 architecture, D3 order, D4 credentials, D5 memory, D6 Titan hosting, D7 sync, D8 name.
- Arrange the devices:
  - an Android TV box with AC-3 passthrough, and/or a Philips Google TV;
  - an LG webOS TV, ideally webOS 4–6 plus one 22+;
  - later, a Philips Titan TV.
- LG developer account.
- Titan: ask the Partner team about
  - IPTV-player acceptance;
  - hosting requirements;
  - whether HTTP (non-TLS) provider APIs and streams are allowed from the app;
  - DevView access.

**Acceptance:**
- Decisions recorded in a short decision note.
- At least one non-Samsung device is available.

## R1 — Platform contract hardening (shared code, no visible change)

Depends on: R0 (D2, D4, D5).

**Content:**
1. **`PlaybackEngine.capabilities()`:** `multiDecoder`, `trackSwitching`, `embeddedSubtitles`, `bufferControl` and known containers.
   - The AVPlay values reproduce today's behaviour exactly.
   - The live preview and zapping read the flags instead of assuming a single decoder.
2. **Per-platform key map:**
   - `keys.ts` gets a platform table;
   - the Samsung table is byte-for-byte today's;
   - action names unchanged;
   - hints in the UI ("CH▲▼ page") become per platform.
3. **Memory policy object:**
   - `availableMB` plus `floorMB` plus a fallback cap for platforms without a memory API;
   - Samsung and Android keep 150 MB.
4. **IndexedDB `FileStore`:**
   - implements the existing interface (paged writes, atomic replace by record swap);
   - unit-tested in Node with a fake IndexedDB;
   - not used on Samsung.
5. **Build flag `--platform`:**
   - `build.mjs` builds per platform, so release bundles contain one platform's adapter;
   - default `tizen` gives an identical output; the build tests compare the bundle hash, or a functional equivalence where the hash must change.

**Acceptance:**
- All existing tests pass unchanged, plus the new tests.
- The Samsung release bundle behaves identically on the TV (regression list above).
- The memory floor is unchanged at 150 MB.

## R2 — Android TV / Google TV validation (existing hybrid)

Depends on: R1 (key map, capabilities); an Android device.

**Content:**
1. Install the existing APK (sideload) on the device.
2. Measure and verify:
   - start-up time; WebView rendering at 1080p and on 720p boxes;
   - focus and keys (D-pad, Back, colour, CH±, digits);
   - lifecycle (Home, return, screen off);
   - Live TS zap times;
   - HLS; VOD MKV/MP4 with seek and resume;
   - audio-track switching including AC-3/E-AC-3 (decoder vs passthrough);
   - embedded and external subtitles;
   - credentials in the Android Keystore; storage of large catalogues;
   - the memory guard with `ActivityManager`.
3. Fix what fails in the Android adapter and bridges only. Media3 may be upgraded from 1.3.1 with approval.
4. Optional, only if needed and approved: the FFmpeg audio extension (D11); tunnelled playback.

**Acceptance:**
- Live, Movies, Series, search, favourites, My List, categories, progress and next episode work on the device with its remote, tested physically.
- Zap time and VOD start time are recorded.
- Audio and subtitle choice works for at least one multi-track MKV and one TS channel.
- Samsung regression passes.

## R3 — LG webOS adapter

Depends on: R1; D4 (credentials); an LG TV with Developer Mode; webOS CLI installed (D10).

**Content:**
1. **`webos-platform.ts`:**
   - info and capabilities;
   - localStorage, the IndexedDB FileStore, and a KeyStore per D4;
   - an XHR factory;
   - lifecycle (`visibilitychange`, `webOSRelaunch`) wired to `suspend` / `restore`;
   - memory per D5.
2. **`html5-engine.ts`** (first version):
   - `<video>`: load, play, pause, seek and timing;
   - events mapped to `EngineEvent`;
   - buffering via `waiting` / `canplay` / `progress`;
   - `audioTracks` / `textTracks` mapped to `MediaTrack`, matching languages by base code (known webOS behaviour);
   - `setRect` positioning;
   - capabilities.
3. **webOS key map:**
   - Back 461, colour keys, digits;
   - CH± verified on the TV; if they are unavailable, CH-based hints are hidden and ▲▼ zapping stays.
4. **Packaging:** `appinfo.json`, icons, `scripts/webos.mjs` (package, install, launch through `ares-*`).
5. **Tests:** engine against a fake `<video>`; platform against fake `webOS` / IndexedDB.

**Acceptance (physical, webOS TV):**
- The app installs through Developer Mode and starts.
- Playlists import (Xtream and M3U) and survive a restart.
- Live zap works; VOD plays with seek and resume; track choice works where the TV allows it.
- Navigation, Back and colour keys work; categories, My List and search work.
- A large catalogue (about 22,000 channels) loads without a crash.
- Behaviour on the webOS version tested is recorded.
- Samsung regression passes.

## R4 — HTML5 engine and track hardening (shared by webOS, Titan, browser)

Depends on: R3.

**Content:**
- Live recovery parity with AVPlay (stall reopen, reconnect delays) through the controllers' existing rules.
- Optional MSE path (for example `mpegts.js`) for MPEG-TS where the native pipeline cannot play TS. It is used only where `capabilities()` says so, needs ES5-compatible packaging, and is a dependency decision for you.
- Track metadata: reuse `media-probe.ts` (range requests) to name audio and subtitle tracks the engine reports poorly.
- Subtitle rendering: the shared renderer for external SRT/VTT; in-band text tracks where available.
- A diagnostics page per platform: capabilities, last error, track list.

**Acceptance:**
- Automated tests for the recovery and track mapping.
- On the webOS TV: a TS live channel, an HLS channel, a multi-audio MKV and an external subtitle all work, or the documented device limit is shown cleanly.
- Samsung regression passes.

## R5 — Philips Titan OS proof of concept (gated)

Depends on: R4; positive Titan answers from R0; D6 (hosting) approved; a Titan TV; DevView access.

**Content:**
1. **`titan-platform.ts`:** the webOS adapter minus the webOS lifecycle, plus the Titan key map from `docs.titanos.tv/remote-control`.
2. **Static hosted build:**
   - no server code, no logging of user data, strict CSP;
   - HTTPS unless Titan allows HTTP.
3. **Mixed-content test (first):**
   - HTTP Xtream API and HTTP TS/HLS streams from the hosted app on the TV;
   - if they are blocked, report back before any further work.
4. **Media:** HLS v3 native; MSE TS remux if needed (R4); track behaviour.

**Acceptance:**
- In DevView on the TV: import, Live and VOD playback, navigation, restart persistence.
- A clear statement of which provider types work (HTTPS only, or also HTTP).
- Samsung regression passes.

**Stop point:** if HTTP is blocked and Titan cannot allow it, stop Titan and report, with the options (HTTPS-only providers, a user-run relay outside the app) for your decision.

## R6 — Release engineering and distribution

Depends on: the platforms accepted in R2, R3 and R5; D8 (name); D12 (distribution).

**Content:**
- A platform build matrix in `npm run build:all`:
  - Tizen `.wgt`;
  - webOS `.ipk`;
  - Android release APK/AAB with a release key stored outside the repository;
  - Titan static bundle.
- Store assets per platform: name, icons, TV banner, privacy text stating that the app ships no content and keeps data on the device.
- Store submissions (LG Content Store, Google Play, Titan Partner Portal) only with your approval per store.
- Version scheme and changelog per platform.

**Acceptance:**
- One command builds every approved platform.
- The release checks pass for each (no dev code, ES5 gate for web builds).
- Each artefact installs and starts on its device.

---

## Effort summary (rough, one developer, device access assumed)

| Step | Effort |
|---|---|
| R0 | Days (decisions); hardware lead time separate |
| R1 | 1–2 weeks |
| R2 | 2–4 weeks |
| R3 | 3–5 weeks |
| R4 | 1–3 weeks |
| R5 | 2–4 weeks technical, plus the Titan partner and QA lead time |
| R6 | 1–2 weeks, plus store review times |
