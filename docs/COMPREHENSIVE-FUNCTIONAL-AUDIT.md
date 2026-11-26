# EliteStream — Comprehensive Functional Audit and Root-Cause Investigation

Date: 2026-11-24 (evening). Target: Samsung UE50MU6100 (Tizen 3.0), the user's Xtream provider, Android APK (built, never run on a device).
Type: audit only. No application source code was changed during this audit (see §M).

Evidence labels used throughout:
**[TV-S]** automated run on the real TV with injected key events (not the physical remote) ·
**[TV-L]** TV run against PC-hosted test media (lab) · **[D]** code/data inspection ·
**[W]** workstation unit tests · **[H]** hypothesis, not proven · **NOT TESTED** where nobody looked, listened or pressed a physical key.

---

## A. Executive summary

The app's basic flows work on the TV: Live TV, Movies and Series browsing, VOD playback start, the PIN service, Settings and the TV guide grid. Several Stage 7B.2 features fail with the user's real provider, though not because of their implementation. The cause lies in the media, in data coverage, or in measurements that were not comparable. Some smaller app defects were also found.

The most important findings:

1. **Seeking and resume fail on the provider's movies because the movie files carry no usable seek index (MKV Cues). They do not fail because of the malformed `Accept-Ranges` header or the redirect.**
   - Proven in a controlled lab on the TV [TV-L].
     - The same AVPlay build seeks normally on a 457 MB, 60 Mbit/s MKV served with exactly the provider's malformed header and a 302 redirect. AVPlay then fetches a new byte range at about 231 MB.
     - It reproduces the provider symptom exactly on a copy of the test MKV whose Cues element was disabled: `seekTo` is accepted, never calls back, sends no request, and the position does not move.
   - Not yet proven on the provider file itself: confirming it needs a two-request diagnostic (approval needed, §I).
   - Confidence: high that header and redirect are not the cause; medium-high that the provider files lack Cues.
2. **Resume shares this root cause.** Saving the position works [TV-S]. Applying it fails for the same files. Resume is "functional only for compatible media".
3. **Guide coverage is a data and matching problem, not a grid problem.**
   - Coverage is 189 of 21,986 channels (0.86 %).
   - Only 5,479 channels (24.9 %) carry an `epg_channel_id`.
   - The stored guide keeps only 371 XMLTV channels.
   - The name normaliser deletes Arabic (and every non-Latin/Greek/Cyrillic) letter, so name fallback cannot work for Arabic channel names [D].
   - Per-strategy counts could not be measured without an approved diagnostic (§I).
4. **The "search regression" (0.28 s → 3.5 s) is a measurement artefact.**
   - Stage 6.1/7B.1 measured a common prefix with a 2,000-hit cap, which stops after one or two name pages.
   - The 7B.2 number is a no-hit query that scans all 11 name pages. The search code is unchanged since Stage 6.1 [D].
   - Real users who type rare words do wait about 3 s, and the global Search screen shows nothing until the full scan finishes. That is a real UX defect.
5. **Subtitles: inconclusive on the provider; no external subtitle path exists.**
   - AVPlay listed two text tracks with no language and sent zero cues in 20 s at the start of a movie [TV-S].
   - Opening credits may simply contain no dialogue, so this is not proof of failure.
6. **Audio switching**: AVPlay reports the selection change [TV-S]. Whether the sound changes is NOT TESTED by a human. The language codes `tu`/`po` cannot be interpreted reliably.
7. **The intermittent silent launch is not reproduced, cause unknown.**
   - 2 of 27 launches on 2026-11-24 stopped logging about 0.1 s after start.
   - 0 of 4 launches during this audit.
   - One run shows a 476 s period in which the TV ran no JavaScript at all.
8. **Visual inspection, physical remote input and listening remain NOT TESTED** for all of Stages 6.1–7B.2.

**Overall readiness: NOT READY** (justified in §L).

---

## B. Baseline

| Item | Finding |
|---|---|
| Git branch | `main` |
| HEAD | `5739de1` "Streamora (ScreenShelf) IPTV app for Samsung Tizen 3.0: stages 1-6" (2026-11-24 13:29 +0100) — the only commit |
| Working tree | 40 modified, 2 deleted, 27 untracked paths (94 files incl. directory contents); checksummed before the audit |
| Stage 6.1 changes | Uncommitted. Paged storage (`src/content/vod-pages.ts` untracked, unchanged since 14:17), `catalogue-store.ts`, `vod-service.ts`, browse screen |
| Stage 7B.1 changes | Uncommitted. Home hub, rail, fonts, styles, browse/live/details/player layouts |
| Stage 7B.2 / player changes | Uncommitted. Seek/resume/progress, tracks/subtitles, Search, Settings, PIN dialog, TV guide, plus the TV-test fixes (`seek-failed`, start position on load) and the dev self-test suite `7b2` |
| TV build | Before the audit: release build compiled 21:19 from the current tree. During the audit: dev build of the same tree (self-test suite `7b2`). At the end: release build (21:19) reinstalled |
| Android build | `dist/android/EliteStream-0.2.0-debug.apk` (21:19, debug-signed). Never installed on a device; no evidence |
| Targets | Tizen 3.0 (ES5, CSS gate); Android minSdk 21 / targetSdk 34, Media3 1.3.1 |
| Catalogue format | Paged generation format (Stage 6.1): index + item pages (1,000) + name pages (10,000). Movies 108,565 titles, 143 categories, 109 item pages; series 25,490, 97 categories, 26 pages (TV log `vod: index loaded`) |
| Provider connection | Xtream, works (live, VOD, series, XMLTV, short EPG). Movie files are MKV, served through a redirect with `Accept-Ranges: 0-<size−1>`; ranged requests answer 206 correctly |
| Reports read | STAGE-5.1, 5.2, 6, 6.1, 7B.1 reports; ARCHITECTURE, PROBE, PROBE2, TEST-REPORT; evidence stage5.1-tv-hung-launch, stage6.1-tv-selftest, stage7b.1-tv, stage7b.2-tv; design Handover rev 2 (§13 AVPlay, §16 verify list) |
| Missing | `docs/STAGE-7C-REPORT.md` does not exist (no Stage 7C work exists in the repository) |

Note: no `docs/STAGE-7B.2-REPORT.md` was written; the 7B.2 results exist only in chat and in `docs/evidence/stage7b.2-tv.jsonl`.

---

## C. Issue-by-issue findings

### C.1 Investigation A — Movie seeking

**Pipeline traced [D]:**
1. Key handling: `key-router` → `vod-player-screen` `onKey` → `seekBy(±seekStep(heldMs))`.
2. `VodController.seekTo` clamps the target to [0, duration − 1 s], ignores the call when `seekable` is false, calls `engine.seek()` and optimistically shows the new position.
3. The AVPlay engine calls `seekTo(ms, ok, err)`.
   - The success callback is only logged.
   - The error callback, a throw, or no answer within 4 s (and position not within 4 s of the target) sets `seekBroken` and emits `seek-failed`.
4. On `seek-failed` the controller sets `seekable=false` and takes the real position from `getCurrentTime`. The screen shows one toast and greys out ±10.

Before the TV test of 7B.2 the app **did** assume an accepted seek meant success. That was a real defect; it is now fixed in the working tree (uncommitted).

**What AVPlay tells the app:**
- In the failing case, only silence: no success callback, no error callback, no `onerror`, and the state stays `PLAYING`.
- The jump API (`jumpForward`) then throws `PLAYER_ERROR_INVALID_STATE` because the seek is still pending.
- AVPlay offers nothing that distinguishes a missing index, an invalid position or a network failure. The only signals are callbacks and position polling.

**Experiments** (all on the UE50MU6100; evidence `docs/evidence/audit-seek-variants.jsonl`, `docs/evidence/stage7b.2-tv.jsonl`):

| # | Media / delivery | Index (Cues) | `Accept-Ranges` | Redirect | Seek to 30 s | Range request on seek |
|---|---|---|---|---|---|---|
| 1 | local MP4 20 MB | n/a (moov) | `bytes` | no | **done 210–252 ms** [TV-L] | none (already buffered) |
| 2 | local MKV 20 MB | yes | `bytes` | no | **done** [TV-L] | — |
| 3 | local TS 20 MB | n/a | `bytes` | no | **done 685 ms** [TV-L] | — |
| 4 | local MP4 20 MB | n/a | malformed `0-<n>` | no | **done 253 ms** [TV-L] | none (buffered → inconclusive alone) |
| 5 | local TS 20 MB | n/a | malformed | 302 | **done 606 ms** [TV-L] | — |
| 6 | local MP4 20 MB | n/a | `bytes` | 302 | **done 265 ms** [TV-L] | — |
| 7 | local MKV 20 MB, Cues element disabled | **no** | `bytes` | no | **no answer**, position unchanged [TV-L] | **none**; at open AVPlay read `0-`, then the Cues position, then `98304-` |
| 8 | MKV written to a pipe (no Cues, no size) | no | `bytes` | no | **does not open** ("format") [TV-L] | — not comparable to the provider |
| 9 | local MP4 457 MB, 60 Mbit/s | n/a | malformed | no | **done 1,634 ms** [TV-L] | `bytes=231240983-` |
| 10 | local MKV 457 MB, 60 Mbit/s | **yes** | malformed | 302 | **done 1,256 ms** [TV-L] | 302 then `bytes=231222786-` |
| 11 | local MP4 457 MB (control) | n/a | `bytes` | no | **done 1,215 ms** [TV-L] | `bytes=231240983-` |
| 12 | provider movie (MKV, 7.2 GB, 2 h 34 min) | unknown | malformed | yes | **no answer** in 6 runs [TV-S] | unknown (provider side not observable) |
| 13 | provider movie, final redirected URL, seek before play | unknown | malformed | resolved | **timeout** [TV-S] | unknown |

**Conclusion.** Root cause classification: **media/container limitation (provider MKV files without a usable seek index), exposed by an AVPlay behaviour (silent no-op instead of an error).**
- Not the malformed header: tests 4, 5, 9 and 10 seek despite it, with real range requests.
- Not the redirect: tests 5, 6 and 10.
- Confidence: high that header and redirect are excluded. Medium-high for the missing index: the symptom is reproduced exactly (test 7), but the provider file's Cues have not been inspected directly.

Can the app detect it without the timeout? **Yes, partially** [H, not implemented]. The app could read the MKV SeekHead with a few small range requests (it already does a 2-byte probe successfully, [TV-S]) and check whether a Cues entry exists and points to a real Cues element. With that check it could hide seek and resume before the user tries them. The timeout would remain as the fallback for other formats.

### C.2 Investigation B — Resume playback

The lifecycle was traced from position capture to the verified start position:
- The player saves every 10 s, on Back, on Home and at the end of the title (`progress.<pid>` key-value store, newest first, at most 50).
- Details shows "Resume · time".
- The start position is passed to `engine.load({ startMs })`.
- AVPlay calls `seekTo` in the READY state before `play`, with a 5 s timeout.
- On failure it starts playback at 0 and emits `seek-failed`, so the controller sets `startFailed` and the screen shows "Can't continue where you stopped".

| Check | Result |
|---|---|
| Saved position correct | Yes [TV-S]: saved 35,800–49,051 ms vs position at Back 36,570 ms ("close": true); duration available (9,250,133 ms) |
| Within bounds | Yes (clamped; < 95 % of the duration) |
| AVPlay honours the start position (provider) | **No** [TV-S]: start-at timed out in all runs; playback reported at 4.5–5.6 s afterwards |
| AVPlay honours seeks on compatible media | Yes for local media (C.1); resume itself was not run against local media (the lab only seeks while playing) |
| Callback order | READY → seekTo (no answer) → timeout 5 s → play → `playing`; correct for the design, but **the first picture is delayed by 5 s** on every failed resume |
| Incorrectly reported as resumed | Before the fix: yes ("Resuming at 1:15:12" with playback at 0). Now: no on Tizen. **On Android: yes** [D]. The Android engine seeks after `prepared` but has no failure detection; `startFailed` never becomes true, so "Resuming at…" shows even if ExoPlayer ignores the seek |
| Fallback message accurate | Accurate on Tizen for the failure case |
| Tizen vs Android | Not consistent: see the row above. Android is untested on a device |

**Conclusion:** resume is **functional only for compatible media**, and **fundamentally unsupported for the tested provider streams on AVPlay**. It shares the root cause with seeking (confidence medium-high).

App defects found:
- **B-1.** Details and Continue watching keep offering "Resume" for titles that cannot resume on this TV. The app forgets per title that seeking failed.
- **B-2.** The 5 s delay on every failed resume.
- **B-3.** The "Resuming at…" toast is shown before the outcome is known (it is replaced on failure).
- **B-4.** Android lacks seek-failure detection.

### C.3 Investigation C — Audio-track selection

- **Discovery:** `getTotalTrackInfo` after prepare reports the raw entries `AUDIO#1 {"language":"tu","channels":"2","sample_rate":"48000","bit_rate":"0","fourCC":"mpeg"}` and `AUDIO#2 {"language":"po",…}` [TV-S].
- **Active track:** taken from `getCurrentStreamInfo`.
- **Switch:** `setSelectTrack('AUDIO', index)`. AVPlay accepted it, no exception. After 3 s `getCurrentStreamInfo` reported track 2 active, and playback kept advancing (3.1 s in 3 s) [TV-S].
- **Language codes:** `tu` and `po` are not ISO 639-1 codes. They look like the first two letters of 3-letter codes, and earlier probes already rated AVPlay `extra_info` as unreliable (PROBE-REPORT).
  - `tu` probably means `tur`, but `po` could be `pol` or `por`.
  - The provider's `get_vod_info` was not checked for audio language fields (the app does not store them).
  - **They cannot be interpreted reliably**; showing "TU"/"PO" is the honest choice.
- **Classification: "API selection changes, audible output unverified".** Required human check: on the TV, play the same movie, switch tracks in the Audio & subtitles panel, and confirm that the spoken language changes and that both tracks produce sound.

### C.4 Investigation D — Subtitles

- **Provider metadata [TV-S]:** `TEXT#3`/`TEXT#4` have `track_num "0"`, `track_lang ""`, `subtitle_type "0"`, `fourCC ""`. The tracks don't say whether they are text or image subtitles.
- **Delivery [TV-S]:** the engine logs every `onsubtitlechange` call, whether subtitles are on or off. **No call arrived in any of 8 provider playbacks**, including 20 s with a text track selected (`setSelectTrack('TEXT', 3)` plus `setSilentSubtitle(false)`) at 0:13–0:33 of the movie.
- **Known platform facts (PROBE-REPORT, [V] from earlier probes):** AVPlay delivers HLS WebVTT as text through `onsubtitlechange`. `setExternalSubtitlePath` was refused (`PLAYER_ERROR_INVALID_PARAMETER`). DASH exposed no text track.
- **The app does treat discovery as availability:** it lists the tracks in the panel even though no cue has ever arrived. That is honest about the track list, but not about whether text exists.
- **External subtitles:** **absent.** The app has a JS renderer (`.ss-subs`, used for AVPlay cues) that could draw external SRT/VTT, but there is no fetch, parser or selection path. The architecture defers subtitle search (P7).
- **Classification:** inconclusive.
  - The tracks may be image-based (PGS/VobSub), which a text callback cannot deliver [H].
  - Or this 20 s window simply had no dialogue [H].
- **Can subtitles be made to work?** Separating demonstrated from merely possible:
  - Native AVPlay: works for HLS WebVTT [V, probe]. Unknown for MKV text tracks; image tracks are very likely not deliverable [H].
  - External rendering: technically possible with the existing HTML renderer plus a sidecar parser. Not demonstrated on the UE50MU6100.
  - A different playback architecture (Android/ExoPlayer renders text and PGS): not demonstrated.
  - Provider-side correction: out of the app's control.
- **Needed:** a lab test with a local MKV carrying one SRT text track and one PGS track, plus a 10-minute provider playback with subtitles selected (approval needed, §I).

### C.5 Investigation E — EPG coverage and channel matching

**Mapping process [D]:**
1. The refresh downloads the provider's XMLTV and passes **all** 21,986 channels to `createEpgBuilder`.
2. The builder keeps an XMLTV channel only if its id equals a channel's `epg_channel_id` (case-insensitive), or if one of its display names, normalised, equals a channel's normalised name. Everything else is discarded. The **XMLTV's total channel count is never recorded**.
3. The stored index held 371 XMLTV channels and 3,386 programmes in the window from now − 2 h to now + 24 h [TV-S].
4. Lookup (`epgKeyFor`) tries the exact id first, then the normalised name through the alias table.

**Counts [TV-S]:**
- 21,986 channels; 5,479 (24.9 %) have an `epg_channel_id`.
- 189 channels (0.86 %) find programmes within ±3 h.
- The first channel with data is number 6,123.
- The provider short EPG returned 0 programmes for the first 3 channels.

**Structural causes [D]:**
1. **75 % of channels have no EPG id at all.** Only name matching could cover them.
2. **`normaliseName` keeps only `0-9a-z`, Latin-extended, Greek and Cyrillic.** Arabic, Hebrew, Persian, CJK and similar names normalise to "" (or just digits), so they can never match by name.
3. **Country/language prefixes and decorations are not stripped.** `UK: BBC One`, `AR| …`, `|NL| …` and `ᴴᴰ` become e.g. `ukbbcone`, while XMLTV display names are usually `BBC One`. Only the tokens `hd`, `fhd`, `uhd`, `sd`, `4k`, `hevc`, `h265` and `+1` are removed.
4. **The XMLTV probably covers only part of the provider's id space** [H]. The 5,479 ids resolved to at most 371 XMLTV channels. Possible reasons: the XMLTV lists few channels, many channels share an id, or programmes fall outside the window. The cause can't be told apart without counting XMLTV channels.
5. **Unexplained:** 371 stored XMLTV channels but only 189 provider channels with data. Each kept XMLTV channel was wanted by at least one provider channel, so it should be ≥ 371. Possible reasons:
   - the ±3 h window of the measurement;
   - the guide being built from an older channel list;
   - a name alias kept for one XMLTV id while another provider channel wanted a different one [H].

**Why the first 6,122 channels don't match:** the measurement shows they have no data. The likely reason is that the provider lists categories with no EPG ids first (e.g. regional, 24/7 or event channels) [H]. Per-category counts would settle this.

**Matching experiments:** **not performed.** The required data (channel list, XMLTV ids and display names) exists only on the TV:
- `sdb` on this retail TV allows push only (`filesync_support: push`), so the app's private files cannot be read out.
- The provider credentials exist only in the TV's key manager.
- Measuring the six strategies therefore needs a temporary dev-only diagnostic in the app (approval needed, §I).

**Recommended architecture (not implemented):**
1. Exact `epg_channel_id` → XMLTV id first.
2. Normalised exact name match, with:
   - Unicode-aware normalisation (Arabic ؀–ۿ and other scripts kept, diacritics folded);
   - country/language prefix stripping (`XX:`, `XX|`, `|XX|`, `[XX]`);
   - quality and decoration token removal (`ᴴᴰ`, `FHD`, `HEVC`, `+1`, `RAW`, `(backup)`).
3. Accept a name match **only when it is unique on both sides**: one XMLTV channel for the name, and the provider channel has no conflicting id. Ambiguous means no match.
4. Learn aliases from confirmed id matches: same logo URL and normalised name.
5. Short EPG on demand for the rows on screen only (already the case in the guide grid).
6. Never fuzzy-match automatically. Weak candidates may at most be offered as a user-confirmed "link guide" action.
7. Record the XMLTV channel total and per-strategy counts in diagnostics, so coverage can be measured.

### C.6 Investigation F — Movie search performance

**The search path [D]:**
1. `VodView.search(query, max)` scans name pages one at a time: `loadPage` (read → checksum → `JSON.parse`) → `split('\n')` → `indexOf` per word.
2. It **stops early only when `starts` (prefix matches) reaches `max`**. Results that merely contain the query never stop the scan.
3. Browse search shows growing results through `onProgress`.
4. The global Search screen runs `search(q, 40)` and waits for the **whole** scan plus `ensure()` before it shows anything.

**Comparable or not:**

| Run | Query | Cap | Hits | Pages scanned | Time |
|---|---|---|---|---|---|
| Stage 6.1 (×4) [TV-S] | first 4 chars of the first title (common prefix) | 2,000 | 2,000 | ≈ 1–2 | 281–337 ms |
| Stage 7B.1 [TV-S] | same | 2,000 | 2,000 | ≈ 1–2 | 281–303 ms |
| Stage 7B.2 / audit (×4) [TV-S] | first 3 chars of the first *channel* name | 40 | 0 | **all 11** | 2,851–3,677 ms |

**Conclusion:** **measurement methodology, not a regression.** `vod-pages.ts` is unchanged since Stage 6.1 (mtime 14:17, before 7B.1).
- A full scan costs about 260–330 ms per name page on the TV, so a rare-word or no-result search takes about 3 s in **every** stage since 6.1.
- **Real defects:**
  - **F-1.** The global Search screen shows no movie or series results until the full scan ends (about 3 s for rare words, possibly longer for series plus movies).
  - **F-2.** Contains-only queries always scan everything.
- **Not measured** (needs the diagnostic in §I): time to first, 20 and all results per query type; UI lag during the scan; cold vs warm cache; free memory per query.

### C.7 Investigation G — Catalogue browsing and update performance

**Writes [D]:** the Tizen file store writes 100 K-character chunks, yielding between chunks (`nextTurn`). Each `FileStream.write()` is a **synchronous native call** that blocked 515–810 ms per call regardless of chunk size (Stage 6.1, 16 K chunks gave the same result). `createFile`, delete and close add more. This is a **platform characteristic**; the app already avoids long JS loops.

**Browse stalls vs free memory [TV-S, existing evidence]:**

| Run (2026-11-24) | Section | Free before (MB) | Min free while browsing (MB) | Browse max stall (ms) |
|---|---|---|---|---|
| 11:16 (Stage 6 build) | movies | 238 | 148 | 3,278 |
| 13:09 | movies | 386 | 164 | 461 |
| 13:15 / 13:21 / 13:25 | movies | 422–493 | 317–351 | 105–138 |
| 16:32 (7B.1) | movies | 165 | 141 | **322** |
| 17:09 (7B.1) | movies | 183 | 166 | **90** |
| 13:11 / 13:17 / 13:27 | series | 421–530 | 312–430 | 135–164 |
| 16:34 (7B.1) | series | 247 | 128 | 200 |

**Conclusion:**
- The 322 ms 7B.1 value is not a consistent regression: a second 7B.1 run measured 90 ms.
- The worst stalls coincide with low free memory (min free < 170 MB), consistent with garbage collection or memory pressure [H, correlation only].
- Poster loading, search competing with browsing, and avoidable page copies were **not separately measured**.
- Update stalls 0.5–2.7 s remain (platform write call). The smallest safe mitigation is to defer page writes while keys are being pressed, or to batch fewer, larger files, written at idle or launch. Not implemented.
- No full catalogue download was triggered during this audit.

### C.8 Investigation H — Intermittent silent first launch

**Evidence [TV-S]:**

| Occurrence | Last log entry | Time after start | Then |
|---|---|---|---|
| Stage 5.1 (2026-11-23, 14:14 UTC) | `boot marker: app started` | 0.9 s | nothing for 8 h |
| 2026-11-24 12:33 UTC (Stage 6.1 baseline) | `parental state` | 0.02 s | nothing for 34 min until relaunch |
| 2026-11-24 16:11 UTC (Stage 7B.1) | `parental state` | 0.15 s | nothing for 11 min until relaunch |
| Stage 7B.1 movie run 16:32 UTC | (inside a run) | — | **lag probe: 476 s without any JS timer running**, then the run continued |

**Interpretation:**
- In a normal launch, the next entry (`vod: index loaded`) follows about 1.4 s later, after the first catalogue file reads.
- In both 2026-11-24 occurrences the app went silent between context creation and the first file read.
- The dev log sink cannot by itself block later batches: each flush is independent with a 5 s timeout. That points to the JS thread not running, or to a native call that never returns [H].
- The 476 s gap shows the TV can suspend the app's JavaScript and later resume it.

**Launch statistics:**
- 2026-11-24: 27 launches, 2 silent.
- This audit: 4 launches (fresh install plus 3 controlled relaunches), 0 silent.
- Not attempted: launch without remote input after a cold TV start, and repeated cold starts. These need more cycles and boot markers (approval, §I).

**Classification: not reproduced in this audit; historically reproduced, cause unknown (insufficient evidence).**

### C.9 Investigation I — Visual and physical remote validation

Nothing has been checked visually, with the physical remote, or by ear in any stage since 6.1. All results so far are [TV-S] or [TV-L]. **NOT TESTED:** screen rendering, text readability, focus visibility, dialog positioning, overlays above AVPlay video, colour-key delivery on the user's remote (Green for the guide, Yellow for Find), number keys for the PIN, physical key-repeat behaviour, long-running stability, and audible audio switching.

**Handover §16 "VERIFY" items:**

| # | Item | Evidence |
|---|---|---|
| 01 | Viewport 1920 vs 3840 | 1920×1080 reported [TV-S] |
| 02 | Live preview window | NOT TESTED (not built) |
| 03 | HTML overlays above native subtitles | Not applicable as designed: the app renders AVPlay cues in HTML. Visually NOT TESTED |
| 04 | Native subtitle styling/offset | Superseded by app rendering; no cues observed (C.4) |
| 05 | Focus ring/scale frame rate | NOT TESTED (key handling 1.4 ms per press in the guide [TV-S] says nothing about rendering) |
| 06 | Colour/number/media key registration | Keys registered [TV-S]; red/green/blue codes physically verified in earlier probes; Yellow, Guide (458), digits and media keys physically NOT TESTED |
| 07 | IME voice search | NOT TESTED |
| 08 | Update write stall | Unresolved (C.7) |
| 09 | Image memory, 20 posters + 8 pages | Not measured separately; free memory reached 122–166 MB in some runs |
| 10 | Audio gap on track switch | Playback advanced 3.1 s in 3 s during the switch [TV-S]; audible gap NOT TESTED |
| 11 | Network-settings deep link | Not built |
| 12 | Progress storage at scale | Resolved by design: bounded list of 50 per account [D] |
| 13 | PBKDF2 PIN check time | 821–974 ms at 600,000 iterations [TV-S] (5 runs) |

### C.10 Investigation J — Other functionality and compatibility

| Area | Status | Class |
|---|---|---|
| Live TV channel switching / playback | Works [TV-S] (live after VOD on the shared engine, Stage 6) | Existing, works |
| VOD playback start | Works, 1.3–2.8 s startup (5.9 s once) [TV-S] | Existing, works |
| PIN set/verify/lockout/recovery | Unit-tested [W]; PIN check cost measured [TV-S]; dialog rendered (8 cells, 12 keys) [TV-S]; setting a real PIN on the TV deliberately not done | Built, TV interaction NOT TESTED |
| Adult lock in Live/Movies | Unit-tested [W] only | Built, NOT TESTED on TV |
| Settings language switch | Unit-tested [W]; Settings opens in 24–43 ms [TV-S] | Built |
| Catalogue counts / missing entries | Index and page counts consistent across runs (108,565 movies); invalid entries counted at import (Stage 6/6.1) | Existing, works |
| Incomplete-page detection | "—" cards for unreadable pages, placeholders 0 after a 60-row scroll (Stage 6.1) [TV-S] | Existing, works |
| Incremental update detection | Content hash per section; "unchanged" path (Stage 6.1) | Existing |
| Memory | Free memory 122–493 MB across runs; lowest after repeated dev launches | Monitor |
| Track languages from AVPlay | Unreliable 2-letter codes | Platform/provider limitation |
| Global Search waits for the full scan | F-1 | Existing new feature, incomplete |
| Resume offered where impossible | B-1 | New feature defect |
| Android seek/resume failure detection | B-4 | New feature defect |
| Seek/resume, external subtitles, sort, VOD favourites, catch-up | Deferred or never built (Architecture P7, Handover §18) | Not defects |

---

## D. Root-cause matrix

| Issue | Severity | Reproducibility | Evidence | Expected | Actual | Root cause | Confidence | Platform | Provider dep. | App fix possible | Recommended fix | Regression risk | Verification |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A. Seek on provider movies | High | Consistent (6/6 runs) | C.1 table, audit-seek-variants.jsonl | Position jumps ±10 s | Silent no-op | Provider MKV without usable Cues + AVPlay silent no-op | Header/redirect excluded: High · missing index: Med-High | Tizen (Android expected similar [H]) | Yes | Partially (detect + explain; cannot make files seekable) | Pre-check the MKV SeekHead/Cues via range requests; hide ±10 when absent | Low | Lab files 2/7/10 + provider movie |
| B. Resume on provider movies | High | Consistent | C.2 | Starts at the saved position | Starts at 0 after a 5 s delay | Same as A | Med-High | Tizen; Android unverified | Yes | Partially | Same pre-check; don't offer Resume when not seekable; remember per title | Low | Resume test on lab + provider |
| B-4. Android claims resumed | Medium | Not run (code) | `android-engine.ts` | Failure reported | No detection | Missing failure check | High [D] | Android | Media-dependent | Yes | Compare position after `prepared` + seek; emit `seek-failed` | Low | Android device test |
| C. Audio switch audibility | Medium | — | C.3 | Spoken language changes | API reports the change | Unknown (human check missing) | — | Tizen | Unknown | — | Human listening test | — | Listen on TV |
| C-2. Language codes `tu`/`po` | Low | Consistent | raw `extra_info` | ISO names | 2-letter fragments | AVPlay metadata truncation [H] | Medium | Tizen | Yes | Partially (use provider metadata if it has any) | Keep showing codes; investigate `get_vod_info` | Low | Compare with provider info |
| D. Subtitles no text | High | Consistent (8 runs, 20 s window) | C.4 | Cues appear | None | Unknown: image-based track [H] or no dialogue in window [H] | Low | Tizen | Likely | Unknown | Lab test (SRT/PGS) + 10-min provider run | — | Lab + provider |
| D-2. No external subtitles | Medium | — | [D] | — | Absent | Never built (deferred) | High | Both | No | Yes (renderer exists) | Separate stage: SRT/VTT parser + sidecar source | Medium | Lab |
| E. Guide coverage 0.86 % | High | Consistent | C.5 | Most channels have a guide | 189 / 21,986 | 75 % of channels lack ids; normaliser drops non-Latin scripts and keeps prefixes; XMLTV coverage unknown | Medium | Both | Yes | Yes (partially) | Unicode-aware, prefix-stripping, uniqueness-checked name matching + stats | Medium (false matches) | Per-strategy counts on TV |
| F. Search "regression" | — | — | C.6 | — | Not comparable | Measurement methodology | High | Tizen | No | — | — | — | Comparable re-measurement |
| F-1. Global search waits for full scan | Medium | Consistent [D] | `search-screen.ts` | Results appear progressively | Up to about 3 s blank for rare words | Uses only the final result | High | Both | No | Yes | Use `onProgress` + `ensure` per batch | Low | TV timing |
| G-1. Update stalls 0.5–2.7 s | Medium | Consistent | Stage 6.1 | < 100 ms | 0.5–2.7 s | Synchronous native `FileStream.write` | High | Tizen | No | Partially | Defer writes while keys active; fewer files | Medium | TV lag probe |
| G-2. Browse stalls 90–461 ms | Low-Med | Variable | C.7 | < 100 ms | 90–461 ms | Correlates with low free memory [H] | Low-Med | Tizen | No | Partially | Measure GC/posters before changing code | Low | Repeated runs at controlled memory |
| H. Silent launch | Medium | Intermittent (2/27 today, 0/4 in audit) | C.8 | Logs continue | Silent after 0.1 s | Unknown (JS suspended or native call hung [H]) | Low | Tizen | Unknown | Unknown | Boot markers + repeated cold-start test | Low | 20 cold starts |
| I. Visual/physical validation | High (release gate) | — | C.9 | Checked | NOT TESTED | Not performed | — | Both | No | — | Physical checklist | — | Human |

---

## E. Performance findings

| Measure | Value | Conditions |
|---|---|---|
| Movies screen ready | 18–130 ms (index read 241 ms at app start) | [TV-S], 108,565 titles |
| Movie search, common prefix, 2,000 cap | 281–337 ms | Stage 6.1/7B.1, 11 runs |
| Movie search, no hits, full scan | 2,851–3,677 ms | 2026-11-24 evening, 4 runs, free 239–316 MB |
| Live channel search ("first 3 chars") | 26 ms (83 hits) | [TV-S], 21,986 channels in memory |
| Live catalogue load | 2.2–2.5 s | [TV-S] |
| Settings / Search screen open | 24–43 ms / 6–11 ms | [TV-S] |
| TV guide open / key | 17–28 ms / 1.4 ms per press, max stall 5 ms | [TV-S], 6 rows |
| PIN PBKDF2 600,000 | 821–974 ms | [TV-S], 5 runs |
| VOD start (provider) | 1.3–2.8 s (5.9 s once) | [TV-S] |
| Seek on local media | 0.2–0.8 s (20 MB) · 1.2–1.6 s (457 MB, new range) | [TV-L] |
| Update stalls | 0.5–2.7 s | Stage 6.1 |
| Browse stalls | 90–461 ms (3.3 s Stage 6 build) | see C.7 |

---

## F. EPG matching analysis

| Strategy | Matches | Unmatched | Duplicates / ambiguous | Potentially wrong |
|---|---|---|---|---|
| Current combined (exact id, then normalised name) | **189** channels with data (±3 h) | 21,797 | not measured | not measured |
| 1. Exact provider EPG id | not measured (≤ 5,479 candidates) | — | — | — |
| 2. Normalised exact name | not measured | — | — | — |
| 3. Alternative display names | not measured | — | — | — |
| 4. Alias matching | not measured | — | — | — |
| 5. Constrained fuzzy | not measured (and not recommended for automatic use) | — | — | — |
| 6. Short EPG fallback | 0 programmes for the first 3 channels | — | — | — |

The per-strategy numbers require reading the stored channel list and the XMLTV channel ids and display names. These exist only on the TV and can't be pulled with `sdb` (push only). A temporary dev-only diagnostic is needed. It would log aggregated counts plus at most 20 anonymised example pairs with hashed names, to the LAN sink only. Request in §I.

False-match risk:
- The current algorithm is conservative: exact normalised equality only. It can still mis-assign when two XMLTV channels normalise to the same name (the first one wins in `alias`).
- Fuzzy matching across 21,986 channels with heavy duplication (HD/FHD/backup/country variants) would produce many plausible but wrong pairs. It should stay manual or user-confirmed.

---

## G. Player compatibility matrix

| Feature | Local MP4/MKV/TS (Tizen) | Local MKV without Cues (Tizen) | Provider MKV (Tizen) | Android (any) |
|---|---|---|---|---|
| Play | Works [TV-L] | Works [TV-L] | Works [TV-S] | No evidence |
| Seek ±10 s / to 30 s | Works, incl. malformed header + redirect [TV-L] | **Silent no-op** [TV-L] | **Silent no-op** [TV-S] | No evidence (Media3 treats MKV without Cues as unseekable [H, library behaviour, not verified]) |
| Resume (start position) | Not run against local media | Expected to fail (same mechanism) [H] | **Fails, plays from 0 after 5 s** [TV-S] | No evidence; app would show "Resuming at" wrongly (B-4) |
| Audio track switch | Not tested (single track) | — | API selection changes [TV-S]; audible NOT TESTED | No evidence |
| Subtitles | Not tested locally | — | 2 tracks, no cues in 20 s [TV-S] | No evidence |
| HLS WebVTT subtitles | Works (earlier probe [V]) | — | — | No evidence |

---

## H. Regressions

| Suspected | Finding |
|---|---|
| Search 0.3 s → 3.5 s | **Not a regression**: a different query type (C.6). Search code unchanged since 6.1 |
| Browse stall 105–164 → 322 ms (7B.1) | **Not consistent**: 90 ms in the second 7B.1 run; correlates with free memory |
| Seek "accepted = success" (7B.2 before the TV test) | Real defect introduced in 7B.2 part 1, **fixed** in the working tree (`seek-failed`) |
| Resume toast before outcome | Present since 7B.2 part 1; partly mitigated (replaced on failure) |
| 5 s first-picture delay on failed resume | Introduced by the 7B.2 start-position change (trade-off) |
| Dev-only diagnostics in the AVPlay engine | 7B.2 added info-level logs (`avplay: tracks`, `seek done/no answer`, `start-at`, `subtitle cue`). They contain no URLs or credentials, but `subtitle cue` logs on every cue. Release builds keep them in the local log only |
| Silent launch | Pre-dates 7B (Stage 5) |

---

## I. Recommended fixes (smallest safe corrections, not implemented)

**Application fixes:**
1. **Seekability pre-check (A, B):** before offering seek/resume on MKV, read the SeekHead with one or two small range requests and confirm a Cues element. When it is absent: no ±10 buttons, no Resume, a one-line note in Details ("This video can't be skipped on this TV"). Remember the outcome per title.
2. **Resume UX (B-1..B-3):** remember per title that seeking failed; don't show "Resuming at" until `seek done`; keep the 5 s fallback only when the pre-check is inconclusive.
3. **Android failure detection (B-4):** after a seek or start position, compare the reported position within 2 s; emit `seek-failed`.
4. **Global Search progress (F-1):** show movie/series results as name pages are scanned (`onProgress` + `ensure` per batch), as the browse search already does.
5. **EPG matching (E):** Unicode-aware normalisation, prefix and decoration stripping, a uniqueness rule, aliases learned from id matches, and coverage statistics. After the diagnostic in step 9 has measured each strategy.
6. **Update stalls (G-1):** defer page writes while keys were pressed within the last 1–2 s; write fewer, larger page files.

**Provider/platform limitations (not app-fixable):** non-indexed MKV files; AVPlay's silent seek no-op; truncated track languages; the synchronous `FileStream.write`.

**Diagnostics needing your approval (dev-only code under `src/dev/`, removed afterwards):**
7. Provider MKV Cues probe: SeekHead parse via 2–3 range requests; logs only "Cues present yes/no" and sizes.
8. Subtitle lab: local MKV with SRT + PGS tracks served from the PC, plus a 10-minute provider playback with a text track selected; count cues.
9. EPG matching statistics per strategy on the TV (aggregate counts, hashed examples), plus the XMLTV channel total.
10. Search timing matrix: common, rare and no-result queries; first, 20 and all results; lag during the scan; free memory.
11. Repeated cold-start test (about 20 launches) with boot markers.

---

## J. Prioritized implementation roadmap

| Stage | Content | Depends on | Validation on the TV |
|---|---|---|---|
| R1 (P1) | Diagnostics 7–11 (approval) | — | [TV-S]/[TV-L] |
| R2 (P1) | Seekability pre-check + resume UX + Android detection (fixes 1–3) | R1 (Cues probe confirms the cause) | Lab files + provider movie |
| R3 (P1) | EPG matching redesign (fix 5) | R1 (EPG statistics) | Coverage + spot-check of 50 matched channels by eye |
| R4 (P1) | Subtitles: decide native-only vs external sidecar | R1 (subtitle lab) | Lab + provider + visual |
| R5 (P2) | Global Search progress (fix 4) | — | TV timing |
| R6 (P2) | Update write deferral (fix 6) | — | Lag probe during update |
| R7 (P2) | Silent launch: act on the boot-marker results | R1 | Cold starts |
| R8 (P3, but a release gate) | Physical/visual/audio checklist (§K) | R2–R5 | Human |

---

## K. Remaining validation gaps

- **Physical TV inspection:** every screen since Stage 6.1. Home, rail, grids, details, player bar and toasts, audio/subtitle panel, subtitle lines, PIN dialog, guide grid, Settings, Search.
- **Physical remote:** arrows and OK with key repeat, Back, CH±, Green (guide), Yellow (Find), number keys (PIN), Play/Pause/FF/RW if present on the user's remote, Guide key (458).
- **Human listening:** audio track switch (C.3), audio after Home/return.
- **Human visual:** focus visibility on every screen, overlays above video, subtitle readability, text truncation in Arabic/long names.
- **Additional provider testing:** a second movie (different encoder or size), series episodes (seek/resume/tracks), movies with known subtitles; whether any provider VOD is served as MP4/TS/HLS.
- **Android:** no device test at all.
- **Long-running stability:** not tested (the longest automated run was about 10 min).

---

## L. Overall readiness

**NOT READY.**
- **What works:** live TV, browsing and VOD playback on the user's provider.
- **What doesn't, for that provider on the target TV:**
  - seeking and resume (media limitation, now reported honestly);
  - subtitles (no text delivered, cause unproven);
  - the TV guide (under 1 % coverage).
- **What has never been checked by a person:** the whole interface since Stage 6.1, including focus visibility, overlays above video, and the physical keys the new features rely on (Green, Yellow, digits).
- The working tree also holds three stages of uncommitted changes.

A controlled release validation would be reasonable after R2, R3 and R8.

---

## M. Repository integrity

| Check | Result |
|---|---|
| Application source modified during the audit | **No.** All 94 pre-existing changed/untracked files have the same SHA-1 as before the audit (verified after writing this report) |
| Files added by the audit | `docs/COMPREHENSIVE-FUNCTIONAL-AUDIT.md` (this report) and `docs/evidence/audit-seek-variants.jsonl` (designated evidence; TV log lines and PC test-server request log, no URLs other than the LAN test server, no credentials) |
| Existing uncommitted changes lost | No |
| Commits / pushes / merges / tags / releases / deployments | None |
| TV state | Dev builds installed temporarily for the lab runs; the release build (from the 21:19 tree) reinstalled at the end; viewing history restored by the self-test (raw snapshot) |
| Provider credentials exposed | No (none in logs, evidence or this report) |
| Production data altered | No catalogue download, no PIN, language or preference change, no playlist change |
| Temporary files | Kept in the session scratchpad outside the repository (test server script, two 20 MB MKV variants, request log). The 457 MB files were deleted. The final cleanup command was blocked by a local safety hook, so the small scratchpad files remain there (never in the repository); they can be deleted at any time |
| Claude Design project | Read only (Handover §13, §16) |
