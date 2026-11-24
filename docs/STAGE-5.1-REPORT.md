# Stage 5.1 report — Live TV validation, playback recovery, gzip XMLTV

Date: 2026-11-23/24. TV: Samsung UE50MU6100, Tizen 3.0. Nothing was committed, pushed, tagged or released.

## 1. Validation status

| Validation type | Status | Notes |
|---|---|---|
| Automated unit tests | **PASS** | 211 / 211 (Stage 5: 194; +7 gzip, +10 recovery) |
| Build tests | **PASS** | 5 / 5 (dev and release builds, ES5 gate, CSS gate, release check) |
| Compatibility checks | **PASS** | `npm run compat`: 83 files, 0 findings; `npm run typecheck`: 0 errors |
| Simulated TV tests (injected keys, real AVPlay, synthetic LAN streams) | **PASS** | §3, §4, §5 |
| Actual physical remote tests | **NOT TESTED** | checklist ready: `docs/STAGE-5.1-PHYSICAL-TEST-CHECKLIST.md` |
| Actual Samsung keyboard tests | **NOT TESTED** | same checklist, section C |
| Actual TV playback recovery tests | **PASS (simulated input)** | real AVPlay on the TV, but driven by injected keys and synthetic PC streams; with the physical remote: NOT TESTED |
| Gzip XMLTV on actual TV | **PASS** | synthetic gzip guides served from the PC (§4); real provider guide NOT TESTED |
| Real IPTV provider playback | **NOT TESTED** | |

Labels used below: **[W]** Windows automated; **[TV]** on the UE50MU6100 with injected keys and synthetic streams.

## 2. Baseline (before changes)

`npm run check` passed: 194 unit tests and 5 build tests, compatibility 81 files with 0 findings. The Stage 5 TV evidence showed one recovery failure in three runs (timeout after two failed channels).

## 3. Playback recovery

### 3.1 Investigation

Instruments added (kept):
- **AVPlay lifecycle traces** (debug level only; never URLs): `open` with the AVPlay state before it, `prepared`, `prepare error`, `onerror`, `onevent`, `buffering start` and `buffering complete`, `first frame`, and `teardown` with the states before and after and whether stop/close threw.
- **Fixture connection log**: every TV connection to a test stream, with its duration and bytes.

Repeated TV runs (`device-selftest-stage51.ts`), four scenarios:
- **S1**: from a working channel, a 404 channel, a refused channel, then two working channels.
- **S2**: one 404 channel, then a working channel.
- **S3**: leave a 404 channel after 3 s, before its error arrives; check the next channel still plays 10 s later.
- **S4**: three CH+ presses 150 ms apart; leave a channel while it is still opening.

Baseline result, before the fix, on synthetic streams joined mid-packet as in Stage 5 (`docs/evidence/stage5.1-tv-recovery-baseline-midpacket.jsonl`):

| Scenario | Working channel played | Failed |
|---|---|---|
| S1, after 404 + refused | 7 / 8 | 1 timeout |
| S1, the next working channel | 7 / 8 | 1 timeout |
| S2, after one 404 | 3 / 4 | 1 timeout |
| S3, ch2 after leaving a 404 early | 4 / 4 | — (still fine 10 s later 4 / 4) |
| S4, rapid ×3 | 3 / 4 | 1 timeout |
| S4, leave mid-open; then ch2 | 8 / 8 | — |

Repeated with streams that start on a TS packet boundary, at a PAT (`…-baseline-aligned.jsonl`): 37 / 38 played and 1 timed out (S1 recover).

Overall: **5 of 76 opens of working channels timed out**. All 40 dead-channel attempts failed with "connection" in 11.1–12.2 s, as expected (two of them were recorded as 0 ms by a timestamp-collision bug in the test harness, fixed for the later runs).

### 3.2 Cause

All five failures had the same trace:
1. `open` started from a clean AVPlay state (`getState()` NONE).
2. The PC served the stream normally: the TV connected at the usual time, and the server sent ≈ 5 MB in 15 s.
3. AVPlay reported buffering start and, in the cases traced later, buffering complete at ≈ 3.2 s.
4. After that, **neither the `prepareAsync` success nor the error callback arrived**, and the watchdog ended the attempt at 15 s.

Normal opens prepare 0.20–0.42 s after the first buffering report (19 traced opens), 3.2–4.0 s after `open`.

The checks requested in Part C:

| Question | Finding |
|---|---|
| Does a failed channel poison the next one? | **No**: 2 of the 5 stalls followed a channel that had **played normally**; the rate after failures (2 / 16) matched the rate without failures (2 / 22 in the mid-packet run). The Stage 5 interpretation ("after two failed channels") was a coincidence of a random stall. |
| Previous stream cleanup | `stop()` + `close()` ran before every `open`; the state after close was NONE in every trace. |
| Late callbacks of an earlier channel | Filtered by the engine session and the controller generation. S3 (an error arriving after the switch) was fine 4 / 4. |
| The watchdog applies to the right generation | Yes, verified in the code and in tests 4 and 7. |
| Can an old attempt overwrite the newer state? | No; regression tests 3 and 7 cover it. |
| Is it a fixture artefact (streams joined mid-packet)? | **No**: it also stalled with packet-aligned streams starting at a PAT. |

Conclusion: the remaining failure is an **intermittent AVPlay prepare stall** on this TV. The app's state handling is correct. The cause inside AVPlay was not determined.

### 3.3 Correction

The smallest correction found that also keeps dead-channel behaviour unchanged (`src/player/live-controller.ts`):
- When AVPlay has reported buffering (stream data arrives) but has not prepared `player.prepareStallMs` = **3 s** later, the controller closes the stream and opens the same source **once** more.
- This happens inside the **unchanged 15 s limit**. The 2 s buffer is unchanged.
- Dead channels report no buffering, so they are never reopened and keep their "can't be reached" error.

A first version reopened 7 s after `open` regardless of buffering. On the TV it turned every dead-channel error into a timeout at 15.6 s instead of a connection error at 11 s. It was discarded (`docs/evidence/stage5.1-tv-full-run.jsonl`; its recovery counts are also incomplete, because the per-progress traces then overflowed the 200-entry log buffer, which is why progress traces were removed).

### 3.4 Result on the TV after the fix

Final run (`docs/evidence/stage5.1-tv-recovery-fixed.jsonl`, 10 repetitions, streams joined mid-packet):

| Scenario | Played / failed | Time to picture (ms) |
|---|---|---|
| Start ch1, ch2 | 2 / 0 | 4,701; 10,845 (stall reopened) |
| S1: 404, refused → error | 20 "connection" errors, as intended | 11,096–11,408 |
| S1: recover to ch1 | **10 / 0** | 4,243–4,444 |
| S1: then ch2 | **10 / 0** | 4,338–10,687 |
| S2: 404 → error | 5 "connection" errors | 11,302–11,383 |
| S2: recover to ch2 | **5 / 0** | 4,217–10,654 |
| S3: leave the 404 early, ch2 | **5 / 0**; still fine 10 s later 5 / 5 | 4,312–10,989 |
| S4: rapid ×3 to ch1 | **5 / 0** | 4,755–11,093 |
| S4: leave ch2 mid-open, ch1 | **5 / 0** | 4,424–4,568 |
| S4: then ch2 | **5 / 0** | 4,370–4,546 |

**47 of 47 working-channel attempts played, 0 failed.** 6 stalls were detected (6.1 s after the press) and recovered by the reopen. The partial earlier run with the same build: 18 / 18 played, 4 stalls recovered.

With the fix, a stalled channel takes ≈ 10–11 s instead of failing at 15 s.

**Is recovery conclusively fixed?** On this TV with synthetic TS streams: 0 failures in 65 working-channel attempts after the fix, versus 5 in 76 before. A second stall within the same tune would still end at 15 s (not observed). It is **not proven** for HLS or real providers.

### 3.5 Regression tests [W] (`tests/unit/live-recovery.test.mjs`)

1. One failed channel, then a working one; the old stream is stopped before the new open.
2. Two consecutive failed channels, then a working one.
3. A late error from an earlier channel (controller promise and AVPlay engine callbacks).
4. Rapid changes while a channel is opening; only the last opens; the old watchdog does not fire.
5. 20 cycles of failures and recovery.
6. Cleanup after a timeout: stopped, no timers left, no reload; the next channel plays.
7. No stale callback (late success, late failure, old watchdog) changes the current channel.

Plus three stall tests: reopen once 3 s after buffering; at most one reopen, with the timeout still at 15 s; never for dead channels, prepared streams, a channel already left, or with the setting at 0.

## 4. Gzip XMLTV

### 4.1 Design

- **Runtime:** Tizen 3.0 has no `DecompressionStream` and no streaming fetch. A dependency (pako, fflate) was not introduced. Rev 3 §8 already planned an own inflate; the bundle must stay ES5 with no runtime dependencies; the decoder is ≈ 9 KB of the release bundle (156.9 → 165.8 KB in total, including the recovery changes).
- **Decoder:** `src/content/gzip.ts` is a streaming gzip/DEFLATE decoder: stored, fixed and dynamic blocks, multiple members, CRC-32 and ISIZE checks, UTF-8 output. It resumes at symbol granularity when input ends mid-unit and uses a 32 KiB window.
- **Download:** compressed guides are downloaded as binary strings through the existing XHR client (`overrideMimeType('text/plain; charset=x-user-defined')`, **verified on the TV**). Each 2 KiB piece is decoded and parsed inside the existing 16 ms slices. The decompressed guide is never held whole.
- **Memory limit (documented):** the compressed bytes accumulate inside the XHR object, because there is no streaming XHR, the same as for text guides. They are capped at `epg.maxGzipMB` = 30 MB; the decompressed output is capped at `network.maxPlaylistChars` (100 M).
- **Detection:**
  1. a `.gz`/`.gzip` URL path;
  2. a gzip Content-Type;
  3. first byte 0x1f in a text download (restart once as binary).

  In binary mode the magic bytes decide, so uncompressed data and Content-Encoding (which the browser decodes) are also read correctly.
- **Errors:** `bad-gzip` (bad header, bad data, truncated, checksum, empty), `too-large`, `gzip-unsupported` (an engine without `overrideMimeType`). The previous guide stays in every failure case.

### 4.2 Tests [W] (`tests/unit/gzip-epg.test.mjs`)

- Valid gzip identical to zlib for every strategy (default, best, stored, fixed, Huffman-only, RLE), multi-member files, pieces of 1 byte to 4 MB, and every optional header field.
- Incorrect header (method, reserved flags); truncation at 7 points; corrupted data (≈ 60 flipped bytes, all detected); CRC and ISIZE damage; empty file.
- Decompression bomb (50 MB of zeros stopped at 1 MB); plain data over the limit.
- End to end through `EpgService`: `.gz` name, Content-Type, magic bytes, Content-Encoding, a `.gz` URL served uncompressed, and the uncompressed regression.
- Truncated, corrupt, bad-header, empty and oversized guides each keep the previous guide.
- An engine without `overrideMimeType`; credentials never logged or cached.
- **Responsiveness:** a 13.8 MB guide (0.72 MB gzip, 78,000 programmes) refreshed in 1.7–3.3 s with the longest event-loop gap 32–66 ms.

### 4.3 TV [TV] (2,000 channels; 11 MB XMLTV = 0.54 MB gzip, 52,000 programmes)

| Variant | Result | Refresh | Longest stall | Lowest free memory |
|---|---|---|---|---|
| `.gz` via M3U url-tvg (application/gzip) | ok, 52,000 programmes | 10.4 s | 437 ms | 227 MB |
| gzip without a `.gz` name (octet-stream) | ok (restarted once as binary) | 11.4 s | 456 ms | 214 MB |
| gzip with Content-Encoding | ok | 10.6 s | 660 ms | 168 MB |
| corrupt gzip | `bad-gzip`, guide kept (52,000) | 5.7 s | 42 ms | 166 MB |
| truncated gzip | `bad-gzip`, guide kept (52,000) | 4.6 s | 18 ms | 216 MB |
| uncompressed XMLTV (regression) | ok | 8.9 s | 425 ms | 200 MB |

Decompression costs ≈ 1.5 s more than plain XMLTV for this guide, with similar stalls. Real provider gzip guides (often 10–50 MB compressed): **NOT TESTED**.

## 5. Performance [TV] (Stage 5 scale suite, Stage 5.1 build)

| Measurement | 1,000 | 10,000 | 50,000 | Stage 5 (50,000) |
|---|---|---|---|---|
| Import | 0.60 s | 2.8 s | 12.6 s | 13.2 s |
| Screen ready | 0.29 s | 1.07 s | 5.08 s | 4.86 s |
| of which catalogue load | 0.17 s | 0.89 s | 4.39 s | 4.27 s |
| Guide refresh | 4.3 s | 9.7 s | 9.4 s | 8.3 s |
| Guide cache load | 2.1 s | 4.1 s | 4.4 s | 4.9 s |
| Longest stall, opening + guide | 194 ms | 733 ms | 1,400 ms | 1,263 ms |
| Key press | 1.05 ms | 1.18 ms | 2.03 ms | 1.13 ms |
| Category switch | 19 ms | 27 ms | 26 ms | 33 ms |
| Search (system-keyboard dialog) | 18 ms | 32 ms | 127 ms | 89 ms |
| Longest stall, navigation and search | 360 ms | 15 ms | 614 ms | 19 ms |
| Lowest free memory | 166 MB | 227 MB | 135 MB | 142 MB |

The navigation stalls at 1k and 50k (360 / 614 ms) are larger than in Stage 5 (74 / 19 ms). This run followed the gzip suite in the same session, and garbage collection is the likely cause, but this was not proven. Recorded as a risk.

Player: picture 4.2–4.6 s after OK or CH+ (including the 400 ms debounce); a stalled open recovers in 10–11 s; a dead channel reports its error after 11.1–11.4 s.

## 6. Incident: silent launches

During the run with the first stall rule, the app stopped logging during the start-up self-test's 1 MB file write. Later launches stayed silent before the logger started, even after reinstalling.

After you restarted the TV, one more launch was still silent. The next reinstall, a dev build with temporary boot markers (removed again; `src/app/main.ts` restored and verified), started normally, and so did every later launch.

The cause was not determined; it may be the same as the Stage 5 "silent after the 10k guide refresh". Evidence: `docs/evidence/stage5.1-tv-hung-launch.jsonl`. **Risk R3.**

## 7. Files

**Created:**
- `src/content/gzip.ts`
- `src/dev/device-selftest-stage51.ts`
- `tests/unit/gzip-epg.test.mjs`
- `tests/unit/live-recovery.test.mjs`
- `docs/STAGE-5.1-REPORT.md`
- `docs/STAGE-5.1-PHYSICAL-TEST-CHECKLIST.md`
- `docs/evidence/stage5.1-*.jsonl` and `docs/evidence/stage5.1-pc-fixture-log-baseline-midpacket.txt`

**Modified, application:**
- `src/player/live-controller.ts`: stall reopen.
- `src/player/avplay-engine.ts`: traces.
- `src/services/epg-service.ts`: gzip path and error codes.
- `src/api/http-client.ts`: `binary`, `onHeaders`.
- `src/app/platform/platform.ts`: `overrideMimeType`.
- `src/app/config.ts`: `player.prepareStallMs`, `epg.maxGzipMB`.
- `src/app/bootstrap.ts`: engine logger, limits.
- `src/app/main.ts`: engine logger.
- `src/screens/live-screens.ts`: stall setting.
- `src/i18n/strings.ts`: `epg.err.bad-gzip`, `epg.err.gzip-unsupported`, and the `not-xmltv` text.

**Modified, dev and tests:**
- `src/dev/device-selftest.ts`: suites `5.1` and `5.1r`; `SUITE` is left at `5.1r`.
- `src/dev/device-selftest-stage5.ts`: scale-only option.
- `scripts/lib/tv-fixtures-live.mjs`: packet-aligned streams, connection log, gzip guide variants.
- `tests/fakes/fake-http-server.mjs`: binary bodies, headers, Content-Encoding.
- `tests/fakes/fake-engine.mjs`: settle abandoned loads.
- `tests/unit/epg.test.mjs`: the `.gz` source now decodes, so the expectation changed from "not XMLTV" to "truncated gzip fails".

**Docs:** `ARCHITECTURE.md` §12e, `IMPLEMENTATION-STATUS.md`, `TEST-REPORT.md` §14, `TIZEN-COMPATIBILITY.md` §7, `SECURITY-DECISIONS.md` S14 / O12.

**Mutation check** (rules disabled one at a time; files restored and verified by SHA-256): all **10 of 10 caught**:
1. stall reopen off;
2. stall armed at open (dead channels reopened);
3. more than one reopen;
4. generation guard;
5. engine session guard;
6. CRC check;
7. output limit;
8. input rollback;
9. restart on the gzip magic;
10. truncated input accepted.

## 8. Architecture and security

**Architecture:** no decision changed (ARCHITECTURE §12e). New config keys: `player.prepareStallMs` (3 s) and `epg.maxGzipMB` (30). Interfaces extended: `XhrLike.overrideMimeType`, and `StreamOptions.binary` / `onHeaders`.

**PIN:** the PIN implementation was not touched. F5–F7 stay open in `SECURITY-PIN-FOLLOWUP.md`.

**URL and credential handling:** unchanged; gzip URLs follow S12. New security notes are in S14:
- the hardened decoder;
- bomb and size limits;
- CRC checks;
- traces without URLs.

## 9. Known limitations

- AVPlay prepare stalls persist (the app works around them). A second stall in one tune still ends at 15 s.
- Dead channels report after ≈ 11 s, because AVPlay gives up only then. Closing AVPlay after an error blocks the UI ≈ 0.5 s.
- The stall rule was calibrated on MPEG-TS over the LAN; HLS and real providers were not measured.
- Compressed guides are held compressed in the XHR while downloading (≤ 30 MB).
- 50,000-channel opening still stalls up to 1.4 s, and the screen is ready only after 5.1 s.
- Every TV run used injected keys and synthetic streams; nothing was inspected visually.

## 10. Remaining risks

| # | Risk |
|---|---|
| R1 | Real providers (HLS, HEVC/AC3, slow servers) may stall differently, or prepare more slowly after buffering than 3 s, which would cause an unnecessary reopen. |
| R2 | Physical remote and Samsung IME behaviour are unverified (checklist pending). |
| R3 | Silent launch / hang (§6) not understood; it happened twice across Stages 5 and 5.1. |
| R4 | Larger navigation stalls in the 5.1 scale run (§5), not explained. |
| R5 | Large real gzip guides (tens of MB compressed) are unmeasured for time and memory. |

## 11. Physical tests needing you

All of `docs/STAGE-5.1-PHYSICAL-TEST-CHECKLIST.md`:
- **A:** remote navigation (15 checks);
- **B:** playback, including Home pause/resume (14);
- **C:** the Samsung keyboard, password masking and diagnostics (14);
- **D:** an optional real `.gz` guide (2).

## 12. Readiness

Stage 5 is ready for final acceptance **on the automated and simulated evidence**. Acceptance with the physical remote and keyboard depends on the checklist. Real-provider playback remains NOT TESTED.
