# Tizen 3.0 Compatibility

Device: Samsung UE50MU6100, Tizen 3.0 TV, WebKit 538.1, ARMv7. Updated Stage 5, 2026-11-23 (Stage 4B, 4 and 3 earlier).

Tags:
- **[TV]** verified on the device (probe 1, probe 2, or the Stage 3 self-test in `docs/evidence/stage3-tv-selftest.jsonl`);
- **[W]** Windows only;
- **[A]** assumption.

## 1. How compatibility is enforced

| Gate | What it checks | Where |
|---|---|---|
| TypeScript `lib` | Only ES5 + ES2015.Promise + ES2015.Collection + DOM; missing APIs don't type-check | `tsconfig.json` |
| Source rules | Rejects syntax the TV can't run (async/await, destructuring, default params, optional chaining, `??`, `**`, for…of, generators), APIs confirmed missing (`Promise.finally`, `Object.values/entries`, `padStart`, `URLSearchParams`, `AbortController`, observers), `fetch`, `eval`, `Function`, `innerHTML`, and `tizen`/`webapis` outside `src/app/platform/` | `scripts/lib/compat-rules.mjs` (`npm run compat`) |
| Bundle gate | Final `app.js` must parse as ECMAScript 5 (acorn), plus banned identifiers/members | `scripts/lib/es5-bundle-check.mjs` (every build) |
| CSS gate | No grid, flex `gap`, custom properties, sticky, `@import`, remote URLs | `scripts/lib/css-check.mjs` (every build) |
| Release gate | Approved config.xml policy; no dev-only code | `scripts/lib/release-check.mjs` |

All gates also have negative tests (`tests/build/build.test.mjs`).

## 2. Platform APIs used by the foundation

| API | Used by | Status |
|---|---|---|
| `tizen.application.getCurrentApplication().exit()` | `Platform.exit` | [TV] (probe 1) |
| `tizen.systeminfo.getCapability` / `getAvailableMemory` / `getTotalMemory` | platform info, memory diagnostics | [TV] |
| `tizen.tvinputdevice.registerKey` | 23 keys registered at start-up | [TV] (Stage 3 boot) |
| Key codes 37–40, 13, 10009, 403/404/406, 427/428 | `navigation/keys.ts` | [TV] physical |
| `tizen.filesystem.resolve('wgt-private','rw')`, `createFile`, `openStream`, `deleteFile` | `TizenFileStore` | [TV] |
| `File.moveTo` (atomic replace), `listFiles` | `TizenFileStore` | **[TV] Stage 3 self-test** |
| `tizen.keymanager.saveData / getData / removeData` | `TizenKeyStore` | [TV], overwrite path **[TV] Stage 3** |
| `crypto.subtle` PBKDF2-SHA256, `crypto.getRandomValues` | `CryptoProvider`, PIN | [TV] 100,000 iterations = 146–170 ms; **600,000 iterations = 796–808 ms (Stage 4B)**; recovery codes from `getRandomValues` [TV] |
| `webapis.avplay` open → setListener → setDisplayRect → setBufferingParam (PLAY, RESUME) → prepareAsync → play; stop/close teardown | `player/avplay-engine.ts` | **[TV] Stage 5**: synthetic LAN MPEG-TS (H.264/AAC, H.264/MP2) plays; picture after ≈ 3.8–4.5 s with the 2 s buffer; 404 and refused connections reported as `CONNECTION_FAILED` after ≈ 11 s |
| `<object type="application/avplayer">` created dynamically + transparent page | player | **[TV]**: video visible behind the transparent layer (the picture start was detected via `oncurrentplaytime`; the picture itself was not visually checked) |
| `setStreamingProperty("USER_AGENT")` | player | [A] not verified |
| `<input>` focus raises the IME | text-entry overlay | [V probe 2]; Stage 5: the dialog focuses the input; typing not exercised |
| `tizen.keymanager` with two PIN slots (save new, remove old, reload) | PIN record (Stage 4B P4) | **[TV]**: rotation, interrupted removal and restart behave as designed |
| `setTimeout(…, 0)` between FileStream chunks | `TizenFileStore` (Stage 4B) | **[TV]**: the stream stays usable across event-loop turns; 1 MB round trip 2.4 s |
| `XMLHttpRequest` (`onprogress`, `timeout`, `responseURL`) | `HttpClient` | [TV]; `responseURL` **[TV] Stage 3**; incremental `responseText` for 31 M-character downloads **[TV] Stage 4** |
| XHR redirect following | `HttpClient` redirect guard | **[TV] Stage 4**: cross-origin 302 is followed by the engine (the follow-up request is sent); `responseURL` shows the final URL, so the guard blocks the response |
| `new URL()` | `checkUrl` (every playlist URL) | [TV] probe 1; exercised for ≈ 100,000 URLs per 50,000-channel import **[TV] Stage 4** |
| `JSON.parse` per element, `String.prototype.indexOf/substring/charCodeAt`, `RegExp` | parsers | [TV] Stage 4 imports |
| `Map`/`Set` | not used by Stage 4 code (plain objects as dictionaries) | [TV] probe 1 (available) |
| `TextDecoder`, `atob` | **not used** (unverified); own UTF-8 and base64 decoders in `content/text.ts` | — |
| `localStorage` | `KeyValueStore` | [TV] (≥ 8 MB) |
| `document.visibilitychange` | lifecycle | [A] fires on Home key (not yet observed by the app) |
| `window` `online`/`offline` events | lifecycle | [A] |
| `window.onerror`, `unhandledrejection` | error boundary | `onerror` [A]; `unhandledrejection` support [A] (handler attached only if available) |

## 3. Measured constraints the foundation respects

| Measurement | Value | Design response |
|---|---|---|
| Playlist parse | 50 MB in about 3 s; free memory down to 107 MB [TV] | Streaming download API (`HttpClient.stream`) with mandatory size cap; parsing (Stage 4) consumes chunks. |
| Browser databases | ≈ 10 MB quota, `unlimitedstorage` has no effect [TV] | Not used. Catalogues go to `tizen.filesystem` files; localStorage only for small values. |
| File storage | ≈ 1.5 MB/s each way [TV]; 1 MB write+replace+read+remove in 1.9 s [TV] | One file per playlist and section; 5,000,000-character budget (≈ 3 s), 20,000,000 hard limit. |
| Images | 100 HTTP images in 327 ms [TV] | No change needed in Stage 3. |
| Playlist import (Stage 4) | M3U 50,000 channels: 10.0 s (6.8 s download + parse, 3.2 s store); Xtream 50,000: 8.5 s; M3U 150,000: 32.8 s [TV] | Imports run in the background with progress callbacks; never during playback (rule R4). An unchanged catalogue isn't rewritten (saves 3–4 s). |
| Cached catalogue load (Stage 4) | 4.7–4.9 M characters in 3.9–4.0 s; 14.8 M in 11.4 s [TV] | Budget 5 M characters per section ≈ 50,000 channels ≈ 4 s start-up. |
| Memory during imports (Stage 4) | Lowest free: 292 MB (M3U 50k), 201 MB (Xtream 50k), 146 MB (M3U 150k) [TV] | Above the 107 MB probe minimum; no out-of-memory event. |
| PBKDF2 | 100,000 iterations in 157 ms [TV] | PIN work factor 100,000. |
| Live buffer | 2 s stable, 1 s unstable [TV] | Config default `player.liveBufferSec = 2` (used from Stage 7). |
| Key repeat | First repeat 458 ms, then every 108 ms; `event.repeat` always false [TV] | Repeat detected by keydown-before-keyup; arrows throttled at 110 ms. |
| `performance.memory` | Not live [TV] | Memory read through `tizen.systeminfo` only. |

## 4. Build output

| Build | app.js | Gate results |
|---|---|---|
| dev | 243 KB (unminified, includes the dev self-tests) | ES5 gate pass, CSS gate pass |
| release | 113.9 KB JS + 5.5 KB CSS (Stage 4: 80.9 KB; Stage 3: 42.7 KB) | ES5 gate pass, CSS gate pass, release check pass |

Toolchain unchanged: TypeScript 5.9.3, esbuild 0.28.2, acorn 8.19.0 (dev dependencies only). No runtime dependencies.

## 5. On-device status of Stage 3

| Item | Status |
|---|---|
| Dev build installs, launches and starts (530–535 ms to "started") | [TV] |
| Capabilities detected on the TV: lifecycle, key registration, AVPlay, file store, secure key store, WebCrypto | [TV] all true |
| Diagnostics screen renders; Back opens exit dialog; remote navigation | **Not yet checked visually or with the physical remote.** Logic is [W]. |
| Visibility (Home key) and network events reach the lifecycle | [A] |

## 6. Known compatibility risks

| Risk | Status |
|---|---|
| `fetch` remote behaviour untested | Not used (banned) |
| Text-input focus and Back on the IME | Key router passes only Back while a text field is active; behaviour with the TV IME open still to be checked (Stage 4 onboarding) |
| Fonts and visual rendering of the diagnostics screen | Not visually inspected |
| UI responsiveness during an import | **Measured (Stage 4B) [TV]**: longest stall 382 ms (save phase), parsing ≤ 143 ms; cancel acknowledged in 103 ms. The cached-load decode isn't sliced. |
| On-screen keyboard and focus rendering | Not visually inspected; only injected keys were used |
| gzip-compressed playlists from a real server | Probe 2: transparently decoded [TV]; not re-tested with the Stage 4 import |

## 7. Stage 5.1 findings [TV]

Measured on the UE50MU6100 with injected keys and synthetic LAN streams (not a real provider). Evidence: `docs/evidence/stage5.1-*.jsonl`, report `docs/STAGE-5.1-REPORT.md`.

| Topic | Finding |
|---|---|
| AVPlay `prepareAsync` stall | In 6–15 % of opens of a working MPEG-TS channel (5 of 76; later 10 of 65), AVPlay reports buffering start and often buffering complete at ≈ 3.2 s, then neither the prepare success nor the error callback ever arrives. The stream data keeps arriving (the PC sent ≈ 5 MB in 15 s). This happened from a clean state (`getState()` = NONE before `open`), after working channels as well as after failed ones, and also with streams that start on a TS packet boundary (PAT). A fresh `open` + `prepareAsync` of the same URL then plays normally. The app reopens once (Stage 5.1). |
| Normal AVPlay timings (2 s buffer, TS over LAN) | First buffering report 3.0–3.9 s after `open`; prepared 0.20–0.42 s later (3.2–4.0 s after `open`); first frame 3.7–4.6 s. |
| Dead channels | HTTP 404 and refused connections: no buffering events; `onerror` `PLAYER_ERROR_CONNECTION_FAILED` ≈ 10.1–10.3 s after `open`. `stop()`+`close()` after such an error took ≈ 0.5 s (blocking). |
| Teardown | `stop()`+`close()` from PLAYING ≈ 0.14 s. AVPlay state after `close()` is NONE. Neither call threw in any observed state (IDLE, PLAYING). |
| Late callbacks | Callbacks of an abandoned session did not reach the new session (engine session guard); a 404 left after 3 s never disturbed the next channel (13 of 13 checks). |
| Binary XHR | `overrideMimeType('text/plain; charset=x-user-defined')` works on Tizen 3.0: the bytes arrive progressively as a binary string. Used for `.gz` guides. |
| `Content-Encoding: gzip` | Still decoded by XHR before the app sees it (also with the binary MIME override). |
| gzip guide cost | 11 MB XMLTV as 0.54 MB gzip: refresh 10.4–11.4 s vs 8.9 s uncompressed; longest event-loop stall 437–660 ms (uncompressed 425 ms); lowest free memory 168 MB. |
| Silent launches | Once, the app stopped logging during the start-up self-test's 1 MB file write; the following launches stayed silent before the logger started, even after a reinstall. After a TV restart, one more reinstall and launch was still silent; the next reinstall (a dev build with temporary boot markers) started normally, and so did every later launch. Not reproduced since; cause unknown (the Stage 5 "silent after the 10k guide refresh" may be the same). |

## 8. Stage 5.2 finding: FileStream and non-ASCII text [TV]

Measured on the UE50MU6100 (2026-11-24):
- Tizen 3.0's `FileStream` (opened with `'UTF-8'`) miscounts multi-byte characters.
- Pure ASCII round-trips exactly.
- 90,000 characters containing 1,800 "é" in one `write()` read back as 91,800 characters.
- In 300,000 characters, the text is shifted at the 102,400-character write chunks.
- Emoji (surrogate pairs) come back as U+FFFD.

Consequence: a real Xtream list (21,986 channels, ≈ 4,800 non-ASCII characters such as Arabic, ᴴᴰ and ™) imported fine. Its catalogue file then failed its checksum and was discarded, so Live TV showed "The channel list couldn't be read" and later no channels.

Fix: `CatalogueStore.save` writes pure ASCII JSON; every non-ASCII character becomes a `\uXXXX` escape, which `JSON.parse` restores. Verified on the TV: the same list was written (2.35 M characters), read back identical and loaded with 21,986 channels. An unchanged update now rewrites a section file that is missing on disk.
