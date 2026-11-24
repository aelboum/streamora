# Playback Analysis

Evidence IDs: `APPLICATION-OVERVIEW.md` §3. [V]/[M]/[A]: ScreenShelf device probe on the UE50MU6100 (`123movies/docs/PROBE-REPORT.md` §7, E10).

## 1. Ibo One playback architecture

| Finding | Status | Conf. | Evidence |
|---|---|---|---|
| Engine is AndroidX Media3 ExoPlayer (control strings, `HlsMediaSource$Factory`, DASH/HLS parser strings) | CONFIRMED-STATIC | High | A3, A5, A7 |
| FFmpeg decoder extension bundled (`libffmpegJNI`, libavcodec, libswresample, libswscale): software audio (and possibly video) decoding for codecs the hardware lacks | CONFIRMED-STATIC | High | A4 |
| Custom player view `com.logicyel.mediaview.MediaView` with `AspectRatioSurfaceView` and `MediaViewSeekBar` | CONFIRMED-STATIC | High | A5 |
| Live, VOD, episodes and catch-up each have their own `singleInstance` player activity | CONFIRMED-STATIC | High | A3 |
| Output-format preference per content type ("Live streaming default format", "Movies and series default format"); `format=m3u8-aapl` string | CONFIRMED-STATIC | High | A3, A7 |
| Catch-up through Xtream timeshift (`streaming/timeshift.php?username=…`, `timeshift/`, `getCatchupUrl`, `hasCatchup`; channels with `tv_archive > 0`) | CONFIRMED-STATIC | High | A7 |
| Resume prompt (Resume / Start Over) and history per item | CONFIRMED-STATIC | High | A3, A5 |
| Track selection: audio, video, subtitles | CONFIRMED-STATIC | High | A3 |
| Aspect ratio, playback speed, brightness/volume dialogs | CONFIRMED-STATIC | High | A3 |
| Cleartext HTTP allowed app-wide (`usesCleartextTraffic="true"`) | CONFIRMED-STATIC | High | A3 |
| `largeHeap="true"` (large catalogues kept in memory) | CONFIRMED-STATIC | High | A3 |
| Retry / reconnect policy, buffer sizes, timeouts | UNDETERMINED | — | Method bodies not read |

**Consequence for ScreenShelf:** Ibo One leans on ExoPlayer + FFmpeg to play almost anything an IPTV server sends. ScreenShelf has only AVPlay, which uses the TV's hardware decoders. Format coverage will be **narrower** than Ibo One's, and the gap must be measured on the TV, not assumed.

## 2. Target platform facts that drive the player design

| Fact | Tag | Consequence for IPTV |
|---|---|---|
| AVPlay 1.0 present; one instance | [V] | One player; `close()` on every exit path. Zapping = `stop`/`close` then `open`. |
| HLS TS and fMP4, MP4 H.264/AAC, DASH H.264 play, pause, seek | [V] | Covers HLS-delivered IPTV and most VOD. |
| Continuous HTTP MPEG-TS (`/live/<u>/<p>/<id>.ts`) | **[A] untested** | The most common Xtream live format. **Must be probed before Stage 7.** Fallback: `.m3u8` output (Ibo One exposes the same choice as a setting). |
| AVPlay over plain HTTP | **[A] untested** (XHR over HTTP [V]) | Most IPTV servers are HTTP. Must be probed. |
| HEVC, AC3/E-AC3, MKV containers | [A] untested | Common in IPTV VOD. No software fallback exists on Tizen. Surface "format not supported" cleanly. |
| RTMP, UDP/RTP | [A] untested; likely unsupported | Not offered until tested. |
| Missing manifest: no `onerror`, `prepareAsync` hangs | [V] | **Prepare watchdog is mandatory**; dead channels are frequent. 15 s default (prepare 0.6–5.4 s [M]). |
| `stop()` can throw after failed `setSpeed`; `setSpeed` inconsistent | [V] | Defensive teardown. **No playback-speed feature** (Ibo One has one). Simulated scrub on VOD. |
| HLS WebVTT cues via `onsubtitlechange` with raw HTML | [V] | Sanitiser mandatory (ARCHITECTURE.md module I). |
| `setExternalSubtitlePath` refused (packaged path) | [V] | Sidecar subtitles via JS renderer. Remote path untested [A]. |
| DASH exposes no text track | [V] | Sidecar only for DASH. |
| Track `extra_info` unreliable | [V] | Labels from metadata or language code. |
| Buffering events | [V] | Spinner after 300 ms; stall watchdog. |
| Video on a hardware plane behind the web layer | [V] | Player overlays need transparent backgrounds; preview pane = `setDisplayRect`. |
| Suspend/restore on Home key | [A] | Untested; live simply reopens. |
| About 220 MB free system memory | [M] | No `largeHeap` equivalent. Catalogue and EPG must not be held in memory while playing. |

## 3. Live behaviour (ScreenShelf design, informed by Ibo One)

| Behaviour | Ibo One evidence | ScreenShelf design |
|---|---|---|
| Zapping | Up/Down changes channel (A3) | Up/Down (and CH± if present) within the current category; 400 ms debounce; banner shows immediately, stream opens after the debounce. |
| Channel browser in player | `PlayerChannelBrowserDialog` (A3) | Left opens a channel-list overlay; video keeps playing behind it. |
| EPG in player | `EpgDialog` (A3) | Right opens now/next + schedule for the current channel. |
| Dead channel | — | Prepare watchdog → "Channel not available" with Retry. No infinite retries. |
| Mid-stream drop | — | Up to 3 reopens (2/5/10 s backoff) at the live edge. |
| Catch-up | timeshift (A7) | P2. Xtream timeshift URL pattern is public; depends on TS/HLS probe results. |

## 4. VOD behaviour

Already designed in ScreenShelf ARCHITECTURE.md §4 (resume rules 60 s / 95 %, history saves every 15 s, simulated scrub, error classes). Ibo One's Resume / Start Over prompt (A3) maps onto the existing Details actions (Play/Resume and Restart).

## 5. Platform abstraction

The approved `PlaybackEngine` interface (ARCHITECTURE.md §4.1) already isolates AVPlay. IPTV additions:
- `load(src, { live: boolean, startMs })`: live disables seek and resume.
- `setAspect(mode: 'fit' | 'fill' | 'zoom' | 'original')` [A, needs probe].
- `PlaybackSource.type` gains `'ts'`.
- No other layer may call `webapis.avplay` (unchanged rule).

## 6. Subtitle "translation" feasibility

| Aspect | Finding |
|---|---|
| What Ibo One actually ships | An **online subtitle search**: the app queries a vendor proxy (`subtitledevui.logicyel.com/api/subtitles/search?search_query=`) and converts downloaded gz subtitle files to VTT (`extract-vtt?gzUrl=`). The `Subtitle` model fields (movie hash, IMDb id, download link, language ISO-639) match a well-known community subtitle database (INFERRED, Medium). **No machine-translation code, strings or endpoints were found** (A7). The marketing claim "Universal Accurate Translation" is not backed by the binary (ADVERTISED, Low). |
| Can ScreenShelf do subtitle search? | Technically yes (XHR + JS VTT/SRT renderer), but it needs a third-party subtitle service with its own terms and an API key. A key can't be embedded (no hardcoded credentials). Only viable as an optional feature with a user-supplied account. |
| Machine translation on the TV | Cue text is available to JS for HLS WebVTT [V] and sidecar files. In-stream cues arrive at display time (about 15 ms accuracy [V]), so online translation would always be late. Sidecar files can be translated ahead. Needs a user-supplied translation endpoint and key; sends viewing-related text to a third party (opt-in only). |
| "Even when missing from the source" | Would require speech-to-text on the audio. AVPlay doesn't expose decoded audio to JS. **Not feasible on the device.** |
| Recommendation | Exclude from the initial release. Later, optionally: sidecar subtitle search and/or translation through a user-configured provider. |
