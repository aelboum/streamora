# Device Probe 2 (IPTV) Report

Device: Samsung UE50MU6100, Tizen 3.0 TV, WebKit 538.1. Date: 2026-11-22. Probe: `SSProbe002.Probe2` 0.2.0, signed with the Tizen developer profile `probe-tizen`.

Tags: **[TV]** measured by the probe on the physical TV; **[TV, manual]** physical remote pressed by the user; **[PC]** measured on the development PC.

Raw results (unedited JSON from the TV): `probe2/results/run1/` (base + AVPlay matrix + manual keys/IME), `run2/` (persistent live streams + quota, without `unlimitedstorage`), `latest*.json` (run 3: buffer tuning + quota with `unlimitedstorage`).

## 1. Test setup

| Item | Detail |
|---|---|
| LAN server | `probe2/server/media-server.mjs` on the dev PC (192.168.1.180:8099, plain HTTP). Serves files with Range support, continuous live MPEG-TS (per request, and from persistent encoders), rolling live HLS, large text bodies (optionally gzip), images; also collects results. |
| Test media | `probe2/server/make-media.mjs`: ffmpeg `testsrc2` colour bars + 440 Hz sine, 1280x720, 25 fps, GOP 2 s, 60 s. Generated locally; no third-party content. |
| Probe app | `probe2/app/` (ES5). Extra probe-only privileges: `filesystem.read`, `filesystem.write`, `keymanager`, (run 3) `unlimitedstorage`; `<access origin="*">`. |

Limitations:
- Synthetic streams over a LAN, not a real IPTV provider over the internet. Real providers add latency, jitter and different GOP sizes.
- Picture and sound were **not** checked visually or audibly by the probe. "Plays" means AVPlay prepared, played, and the position advanced; codec names come from AVPlay track info.
- All results come from one TV with its current firmware.

## 2. AVPlay format matrix [TV] (run 1)

| Source (all over plain HTTP) | Prepare | Plays | Seek 30 s | Video / audio reported |
|---|---|---|---|---|
| MP4 H.264/AAC | 774 ms | PASS | 213 ms | h264 / AAC |
| TS file H.264/AAC | 512 ms | PASS | 462 ms | h264 / AAC |
| TS file H.264/MP2 | 572 ms | PASS | 710 ms | h264 / MPEG audio |
| MP4 H.264/AC3 | 405 ms | PASS | 215 ms | h264 / ac3 |
| MP4 H.264/E-AC3 | 310 ms | PASS | 244 ms | h264 / eac3 |
| TS H.264/AC3 | 561 ms | PASS | 448 ms | h264 / ac3 |
| MKV H.264/AAC | 374 ms | PASS | 219 ms | h264 / AAC |
| MP4 HEVC/AAC | 338 ms | PASS | 199 ms | h265 / AAC |
| TS HEVC/AAC | 528 ms | PASS | 434 ms | h265 / AAC |
| MKV HEVC/AAC | 370 ms | PASS | 201 ms | h265 / AAC |
| HLS VOD | 473 ms | PASS | 464 ms | h264 / AAC |
| **Live continuous MPEG-TS** H.264/AAC, H.264/MP2, H.264/AC3, HEVC/AAC | 3.8–4.0 s | PASS (all 4) | n/a (duration 0) | as encoded |
| Live HLS, rolling 6×4 s segments | 467 ms | Plays after 5.3 s initial buffering; position started at the live edge (12 s) | n/a | h264 / AAC |

- `setDisplayMethod` LETTER_BOX, FULL_SCREEN and AUTO_ASPECT_RATIO were all accepted on MP4 [TV]. Visual effect not verified.
- Live TS track info reports the audio bitrate as the video bitrate. Track `extra_info` stays unreliable (consistent with probe 1).
- `setDisplayRect` small preview (560×315) accepted while playing live TS [TV].

## 3. Error behaviour [TV] (run 1)

| Case | Result |
|---|---|
| HTTP 404 on a `.ts` URL | `onerror PLAYER_ERROR_CONNECTION_FAILED` after **about 10.2 s**. The `prepareAsync` error callback never fired. |
| Connection refused | Same: `onerror CONNECTION_FAILED` after about 10.2 s; no prepare callback. |

Combined with probe 1 (a missing DASH manifest never errors), the player must treat `onerror` during prepare as a failure and keep its own watchdog.

## 4. Channel change (zap) time [TV]

Time from `open()` to the first `oncurrentplaytime > 0`, live TS H.264, 4 zaps each:

| Condition | Times (ms) |
|---|---|
| Run 1: encoder started per request | 6983, 6890, 6937, 6899 |
| Run 2/3: already-running streams, default buffering | 6459, 6364, 6381, 6389 / 6489, 6362, 6413, 6351 |
| Run 3: `setBufferingParam` PLAY+RESUME **2 s** | **3990, 3848, 3868, 3842** |
| Run 3: `setBufferingParam` **1 s** | 3839, **timeout**, **timeout**, 3830 (unstable) |

- About 6.4 s of the default zap time is on the TV side (AVPlay start buffering), not server start-up.
- A 2 s buffer reduces zap time by about 40 % and was stable. 1 s was not.
- The remaining time includes the test stream's 2 s GOP; real channels with shorter GOPs may be faster, longer GOPs slower. [A]

## 5. Networking and parsing [TV] (run 1)

| Test | Result |
|---|---|
| XHR 10 MB M3U-like text, incremental parse in `onprogress` | PASS. 722 ms total, parse 216 ms, 57,999 entries, 11 progress events, text grew on each. |
| XHR 10 MB **gzip** (`Content-Encoding`) | PASS. Transparently decoded; 221 ms; full length. |
| XHR 50 MB, parse at end | PASS. 3.0 s total, parse 378 ms, 283,719 entries. |
| XHR 50 MB, incremental parse | PASS. 2.9 s total, parse 1.57 s; **lowest system free memory 107 MB** (from 220–290 MB). |
| `DecompressionStream` | absent. `.gz` files need a JS inflate. |
| 100 logo images over HTTP, 4 concurrent | PASS. 100/100 in 327 ms. |

`performance.memory.usedJSHeapSize` stayed at 10 MB throughout, even during the 50 MB download. It is evidently not a live value on this engine. **Use `tizen.systeminfo.getAvailableMemory()` for memory tracking.**

## 6. Storage [TV]

| Store | Result |
|---|---|
| IndexedDB | Present. Quota error at about **10 MB** of characters (run 2: 10 MB stored, cursor read 10 MB in 332 ms). Run 3, after earlier failed writes on the same origin: 0 MB accepted. |
| WebSQL | Present. Quota error at about **10 MB** in runs 2 and 3. |
| `unlimitedstorage` privilege | Installs, but **does not lift** the IndexedDB/WebSQL quota (run 3). |
| `tizen.filesystem` `wgt-private` | PASS. 20 MB written in 13.3–14.1 s and read in 12.7–14.7 s (about 1.5 MB/s each way). |
| `tizen.keymanager` saveData/getData/removeData | PASS (runs 1–3). Synthetic value only. |
| localStorage | ≥ 8 MB (probe 1). |

The run 3 IndexedDB result suggests the roughly 10 MB quota may be shared per origin and was partly consumed by data the earlier failed tests did not clean up. **Treat the browser-database budget as < 10 MB total.**

## 7. Crypto [TV]

| Test | Result |
|---|---|
| `crypto.getRandomValues` | present |
| `crypto.subtle` PBKDF2-SHA256, 10,000 iterations | PASS, **97 ms** |
| Pure-JS PBKDF2 (own SHA-256), test vector | PASS; 1,000 iterations 78 ms, 10,000 iterations 499 ms |

## 8. Remote and text input [TV, manual] (run 1)

| Test | Result |
|---|---|
| CH+ / CH− | **Received: keyCode 427 / 428** after `registerKey('ChannelUp'/'ChannelDown')`. |
| Tizen IME on `<input type="text">` | Works. OK focused the field; the system keyboard produced `keydown 229` + `input` events; final value "abc". |

## 9. Answers to the Stage 1 risk list

| Risk | Answer |
|---|---|
| K1 continuous MPEG-TS | **Resolved: works** (H.264 and HEVC, AAC/MP2/AC3). |
| K2 plain HTTP | **Resolved: works** (TS, MP4, MKV, HLS). |
| K3 HEVC/AC3/E-AC3/MKV | **Resolved: all play** (synthetic samples). |
| K4 large playlist memory | 50 MB parsed incrementally; system free memory fell to 107 MB. Must not be combined with playback. Mitigated. |
| K5 large-data storage | Browser databases ≈ 10 MB; filesystem works at about 1.5 MB/s. **Design must use compact, chunked files.** |
| K10 aspect / preview | APIs accepted; visual check pending. |
| K11 IME | Works. |
| K13 remote images | Works over HTTP. |
| New: zap time | 6.4 s default; 3.85 s with a 2 s buffer. |
| New: error latency | Connection errors arrive after about 10 s via `onerror`. |

## 10. Environment after the probe

- The probe app `SSProbe002.Probe2` was uninstalled from the TV after the report (see `probe2/tools/` to reinstall).
- The LAN server was stopped. Generated media remain in `probe2/media/` (git-ignored, regenerable).
