# Stage 7D — Diagnostic Investigation and Evidence Collection

Date: 2026-11-24 (22:10–23:00 local). Target: Samsung UE50MU6100 (Tizen 3.0), the user's Xtream provider.
Type: diagnostics only. Temporary code lived in `src/dev/` and has been removed (§F). No production code changed.
Raw evidence: `docs/evidence/stage7d/`.

Evidence labels:
- **[M]** directly measured on the TV;
- **[R]** reproduced in a controlled lab on the TV;
- **[I]** inferred from measurements and code;
- **[H]** hypothesis;
- **[NT]** not tested.

Every TV run used injected key events or direct engine calls, not the physical remote. Nobody looked at the screen or listened.

---

## A. Executive summary

**What was tested:**
- **A** the seek index of 24 provider movies plus 3 controls;
- **B** embedded subtitles (SRT, ASS) in lab files, external SRT/ASS through an app-drawn overlay, and a 10-minute provider playback with subtitles;
- **C** five guide-matching strategies against the provider's full XMLTV file, downloaded again in memory on the TV;
- **D** movie search timings for 8 query types × 2 caps × cold/warm (32 runs);
- **E** 20 consecutive app launches with a boot probe.

**What was confirmed, and how it changes the audit:**

1. **Seeking works for most provider movies.** The audit's "seeking fails on provider movies" generalised from a single file and was wrong for the catalogue as a whole.
   - Of 24 sampled movies, **21 seek normally** on the TV [M].
   - 92 % of the first 5,000 titles are MP4 [M], and every MP4 tested seeks.
   - **The only seek failure is an MKV without a seek index (Cues)**, confirmed directly in the file [M]. It is the movie used in every earlier test.
   - **2 MKVs with a valid index do not play at all** on the TV (a new finding; cause unknown [H]).
2. **Provider subtitles work.** The audit's "no subtitle text" was a test-window artefact: the first cue of that movie arrives at 2:46, after the old 20 s window.
   - In a 10-minute provider playback, subtitle track 3 delivered **45 cues, the first at 2:46**, and track 4 delivered cues after a switch [M].
   - Embedded SRT and ASS deliver text with **5–11 ms timing error**; switching tracks and turning subtitles off work [R].
   - **AVPlay never reports subtitle languages, even when the file contains them** [R].
   - An app-drawn external SRT/ASS overlay keeps time with playback within 23–84 ms (polling at 100 ms) [R].
3. **Guide coverage: the main cause is a truncated stored guide, not the matching rules.** The audit pointed at the normaliser and the 75 % without ids; that was the wrong main cause.
   - The provider's XMLTV has **6,085 channels / 190,304 programmes**; 2,986 channels have programmes in the window [M].
   - Applied to that file, the **existing** matching rule gives **4,265 channels with programmes (19.4 %)**, not 189 (0.86 %) [M].
   - The guide stored on the TV was built by a refresh that kept 3,568 programmes in 4.2 s. Today's download takes 16 s and contains 53× more programmes, which points to a truncated download accepted as complete [I].
   - A later refresh failed (`http`, 178 ms), so the small guide stayed [M].
   - **Arabic channels match 0 in every strategy:** the XMLTV has no entries for them [M]. Unicode normalisation alone cannot help.
4. **Search:** every realistic word query scans all 11 name pages, **3.3–3.5 s**, with no cold/warm difference [M].
   - The first results exist after **0.26–0.42 s** (0.86–1.0 s for Arabic).
   - The **global Search screen shows nothing for 3.3–5.6 s**: it waits for the full scan and then for the title pages [M].
   - The old 0.3 s figure came from a query matching provider tags at the start of titles (e.g. "|EN|"), the only case where the scan stops early [I].
5. **Cold starts: 21 app instances, 0 silent while visible** [M]. Each time the app was hidden (TV standby or screen off; user-confirmed once), its JavaScript stopped immediately. That reproduces the "silent" pattern by a platform mechanism. Twice afterwards, launches were refused until a reinstall.

**What remains unknown:**
- Why two indexed MKVs do not play.
- Why the earlier guide refresh kept so little.
- Image-based subtitles: no test file could be produced here.
- Whether subtitles and focus look right on screen [NT].
- The cause of the historical silent launches (see §B.E).

---

## B. Investigation results

### B.A Provider movie seek-index detection

**Method:**
- The TV read each provider movie's first 64 KB with an HTTP range request.
- It then parsed the EBML header, the Segment and the SeekHead. If a Cues entry existed, it read 4 KB at that position and checked that a Cues element with CuePoints is there. If not, it searched the last 2 MB for a Cues element.
- It then played each movie with AVPlay, sought +60 s and checked the reported position after 6 s.
- In total, about 70 KB to 2 MB was read per movie. No file was downloaded in full; URLs were held only in memory.
- Movie selection:
  - sample 1: one title from each of 10 categories spread over the list, plus 2 non-MKV titles;
  - sample 2: the first title of "All movies" (the one used in all earlier tests), plus MKVs spread over the first 5,000 titles.

**Container survey (first 5,000 titles of All, by extension) [M]:** MP4 4,613 (92.3 %) · MKV 386 (7.7 %) · AVI 1.

| Movie | Container | Size | Cues present | Index usable | TV seeking result | Conclusion |
|---|---|---|---|---|---|---|
| S1-M1 | MP4 | 1.90 GB | n/a | n/a (moov) | **seeked** 3.4 → 74.6 s | works |
| S1-M2 | MKV | 5.92 GB | yes (SeekHead, verified, 247 KB) | yes | **seeked** 3.5 → 76.6 s | works |
| S1-M3 | MP4 | 0.34 GB | n/a | n/a | **seeked** | works |
| S1-M4 | MP4 | 1.98 GB | n/a | n/a | **seeked** | works |
| S1-M5 | MKV | 2.39 GB | yes (67 KB) | yes | **seeked** | works |
| S1-M6 | MKV | 2.03 GB | yes (56 KB) | yes | **seeked** | works |
| S1-M7 | MKV | 4.62 GB | yes (88 KB) | yes | **seeked** | works |
| S1-M8 | MKV | 1.72 GB | yes (86 KB) | yes | **seeked** | works |
| S1-M9 | MP4 | 2.36 GB | n/a | n/a | **seeked** | works |
| S1-M10 | MKV | 2.44 GB | yes (103 KB) | yes | **seeked** | works |
| S1-M11 | MP4 | 2.09 GB | n/a | n/a | **seeked** | works |
| S1-M12 | MP4 | 2.23 GB | n/a | n/a | **seeked** | works |
| **S2-M1** (first of All; all earlier tests) | MKV | 7.20 GB | **no**: the SeekHead lists only a 2nd SeekHead, Attachments and Tags; no Cues in the last 2 MB (which contains that 2nd SeekHead) | **no** | **no-op** (seek-failed) | **missing index → not seekable** |
| S2-M2 | MKV | 2.26 GB | yes (51 KB) | yes | **seeked** | works |
| S2-M3 | MKV | 9.57 GB | yes (187 KB) | yes | **did not play** within 20 s | playback problem, not seeking |
| S2-M4 | MKV | 5.54 GB | yes (436 KB) | yes | **seeked** | works |
| S2-M5 | MKV | 5.19 GB | yes (393 KB) | yes | **did not play** within 20 s | playback problem |
| S2-M6 | MKV | 0.87 GB | yes (52 KB) | yes | **seeked** | works |
| S2-M7 | MKV | 1.49 GB | yes (115 KB) | yes | **seeked** | works |
| S2-M8 | MKV | 6.31 GB | yes (121 KB) | yes | **seeked** | works |
| S2-M9 | MKV | 9.56 GB | yes (138 KB) | yes | **seeked** | works |
| S2-M10 | MKV | 5.84 GB | yes (171 KB) | yes | **seeked** | works |
| S2-M11 | MKV | 4.05 GB | yes (93 KB) | yes | **seeked** | works |
| S2-M12 | MKV | 6.11 GB | yes (381 KB) | yes | **seeked** | works |
| Control: lab MKV with Cues | MKV | 20 MB | yes | yes | **seeked** (target 40 s) | works |
| Control: lab MKV, Cues disabled | MKV | 20 MB | SeekHead entry, but no Cues element at the target | **no** | **no-op** (seek-failed) | reproduces S2-M1 |
| Control: lab MP4 | MP4 | 20 MB | n/a | n/a | **seeked** | works |

The previous audit's header and redirect variants (malformed `Accept-Ranges`, 302 redirect) all seeked; see `docs/evidence/audit-seek-variants.jsonl`.

**Conclusions:**
- **Seek failure = MKV without a usable Cues element** [M on the provider file + R in the lab].
- All 21 movies that played and had an index (or were MP4) seeked [M].
- The sample is 24 of 108,565 titles, so the share of index-less MKVs in the catalogue is **not known**. In the sample it was 1 of 15 MKVs.
- **The detection works:** two range requests (head + Cues position) per MKV distinguished every case correctly, in 0.1–1.1 s [M].
- The **lab control's +60 s target was beyond the end** of the 60 s file in the first run. AVPlay then also gave no answer, so **a seek past the end looks the same as a missing index**. The second run used the correct target [M].
- **New finding:** S2-M3 and S2-M5 (indexed MKVs) did not start playing within 20 s. The codec was not captured; HEVC/4K or a larger profile is possible [H].

### B.B Subtitles

**Part 1 — local lab files** (made with ffmpeg and checked independently with ffprobe and ffmpeg extraction; one cue every 2 s, "Line k EN" / "Regel k NL" / "Ligne k FR"):

| Subtitle type | Track detected | Text received | Displayed | Timing correct | Notes |
|---|---|---|---|---|---|
| Embedded SRT (eng, title "English") | yes (TEXT, **language not reported**) | yes, 6 cues / 12 s | DOM only [NT visually] | yes, **+5 to +10 ms** | text ends in `\r` (stripped by the app) |
| Embedded SRT (nld, "Nederlands"), switched while playing | yes (**language not reported**) | yes, switch effective within 1 cue | DOM only [NT] | yes, +5 to +11 ms | — |
| Embedded ASS (fra, italic tags) | yes (**language not reported**) | yes, 6 cues / 12 s; AVPlay strips the `{\i1}` tags | DOM only [NT] | yes, +5 to +7 ms | — |
| Subtitles off (`setSilentSubtitle(true)`) | — | 0 cues in the next 5 s | — | — | works for every track |
| Image-based (PGS/VobSub) | **NT** | **NT** | **NT** | **NT** | ffmpeg cannot convert text to bitmap subtitles; no sample available here |
| External SRT (app-drawn overlay) | n/a | parsed 29 cues | 10 shown in 20 s, DOM only [NT] | yes, +23 to +24 ms (100 ms polling) | no AVPlay involvement, no restart |
| External ASS (app-drawn overlay) | n/a | parsed 29 cues | 10 shown, DOM only [NT] | yes, +83 to +84 ms (polling phase) | tags stripped by the dev parser |
| Language metadata in general | — | — | — | — | AVPlay `track_lang` empty even for tagged tracks; audio `un` |

**Part 2 — provider movie, 10 minutes [M]:**
- Tracks: audio #1 `tu`, audio #2 `po`, text #3, text #4 (no language).
- Track 3 selected from 0:00: **45 cues**, the first at **2:46** (2:46, 2:49, 2:52, 2:56, 3:00 …), up to 69 characters.
- Track 4 selected at 5:00: **9 cues** (5:09, 5:09, 5:11, 5:12, 5:16 …), up to 36 characters.
- At 21:30:56 **another person started using the TV**: they opened a movie with resume, sought with the remote, then opened Live TV and switched channels. That ended the diagnostic playback, so the position at 10:00 was 0. Track 4 was therefore observed for only about 20 s.
- So **the earlier "no cues in 20 s" was a test-window artefact**: the film has no dialogue before 2:46.

**Part 3 — external subtitle feasibility [I, from code]:**
- **Retrieval sources:** none in the repository (no subtitle provider, no API client; the architecture defers subtitle search, P7).
- **Resolver/controller:** none for external tracks. The player screen has a renderer (`.ss-subs`, `subtitleLines`) fed by AVPlay cue events.
- **AVPlay external path:** `setExternalSubtitlePath` was refused in probe 1 (`PLAYER_ERROR_INVALID_PARAMETER`, packaged path). It was not re-tested: the TV API may only be called from the AVPlay engine, a compatibility rule that dev code must not bypass.
- **Overlay:** the existing HTML overlay can show external cues. The lab showed timing within one 100 ms poll and no playback restart.
- **What external support needs:**
  - SRT/VTT/ASS parsers (text only);
  - a source (URL from the provider's VOD info, or a user-chosen file/URL);
  - a time source (`timing()`, ≈100 ms polling, or AVPlay `oncurrentplaytime`);
  - a sync offset;
  - a selection row in the Audio & subtitles panel.
- **Recommendation: native AVPlay for embedded text subtitles (already working), plus app-rendered external subtitles later (hybrid).**
  - Native gives correct timing (≤ 11 ms) and needs no download.
  - External covers titles without embedded tracks.
  - Image subtitles remain unknown.
  - Required in either case: a label fallback ("Subtitles 1/2"), because AVPlay never reports the language.

### B.C EPG matching measurements

**Information-loss points in the pipeline [I, code + M]:**
1. **XMLTV download:** the refresh accepts a response that ends early. The parser has no check for the closing `</tv>`, and the HTTP stream does not check `Content-Length`. The stored guide holds 3,568 programmes against 190,304 in the full file.
2. **Builder:** keeps only XMLTV channels matched to a provider channel. Correct, but it never records the XMLTV totals, so the truncation stayed invisible.
3. **A failed refresh keeps the previous guide.** Correct by design, but the old guide was the truncated one.
4. **Name normalisation:** removes non-Latin/Greek/Cyrillic scripts. It does not matter for this provider (no Arabic XMLTV names), but it would for others.

**Data [M]:**
- 21,986 provider channels; 5,479 with a guide id; 3,939 distinct ids; 1,009 ids shared by several channels.
- XMLTV: 6,085 channel entries, 3,989 distinct ids, 2,986 with programmes from now − 2 h to now + 24 h, 190,304 programmes. Downloaded in 16.0 s, plain text, 1 of 2 sources has a URL.
- 5,473 of the 5,479 provider ids (99.9 %) exist in the XMLTV.
- 330 channels have Arabic names; 2,327 normalised provider names are duplicated; 348 XMLTV names are shared by several ids.
- First 6,122 channels: 1,226 have an id. Largest categories: `|EU| FRANCE GÉNÉRAL` 327 · `|AR| ARABIC FULL SD` 321 · `|IT| CINEMA` 219 · `|ES| ESPAÑA HEVC` 205 · `|EU| FRANCE CARRIBEAN` 202 · `|EU| FR SOCCER PPV` 200 · `|AR| SHAHID. VIP` 199 · `|IT| SPORT` 168. Their missing guide data was caused by the truncated stored guide, not by a matching problem: 1,220 match by exact id against the full file.

**Strategy comparison** (all against the full XMLTV; "with programmes" = programmes in the window):

| Strategy | Confirmed | With programmes | Coverage (with programmes / 21,986) | Ambiguous (rejected) | Conflicts (rejected) | In first 6,122 | Arabic matched |
|---|---|---|---|---|---|---|---|
| Stored guide today (for reference) | — | 189 | 0.86 % | — | — | 0 | 0 |
| 1 Existing rule (id, else legacy name, first alias wins) | 5,819 | 4,265 | **19.4 %** | 0 (not detected) | 71 *accepted* by the existing rule | 1,483 | 0 |
| 2 Exact provider id | 5,473 | 4,039 | 18.4 % | 0 | 0 | 1,220 | 0 |
| 3 Unicode-safe name (unique only) | 5,661 | 4,161 | 18.9 % | 283 | 1 | 1,421 | 0 |
| 4 Prefix-stripped Unicode name (unique only) | 4,674 | 3,434 | 15.6 % | **2,261** | 2 | 1,174 | 0 |
| 5 Combined: exact id, else prefix-name (unique) | **6,197** | **4,527** | **20.6 %** | 740 | 2 | 1,518 | 0 |

**False-positive analysis [M + I]:**
- The **existing rule accepts 71 conflicting name matches**: channels whose own id differs from the name-matched XMLTV id, e.g. `ES - LA 1 HD (id laotra.es) → la1.es`, `ES - DAZN 2 HD (id dazn2.es) → elevensports2.pt`. These are likely wrong.
- **Prefix stripping creates collisions:** country prefixes are often what tells `CNN (US)` from `CNN (UK)`. 2,261 names became ambiguous, e.g. `|4K| CNN UHD 4K → cnn.us | uk.cnn | ca.cnn`, `QVC → qvc.us | qvc.it | qvc.de`, `FR - DAZN 1 FHD → dazn1.es | elevensports1.pt`. A uniqueness rule must reject these, and it did.
- Prefix matches that were unique include `|4K| TF1 UHD/4K → tf1.fr`, `|4K| M6 UHD/4K → m6.fr` and `|4K| RTL UHD → rtl.de` (plausible).
- `|4K| SKY SPORTS DARTS UHD → skysportsf1.uk` needs a manual check: the XMLTV id may carry several display names [H].

**Arabic examples [M]:** channels such as `عبد الرحمن السديس`, `AR - سعيد الغامدي` and `AR - علي الحذيفي` (Quran recitation channels) normalise correctly with the Unicode rule (`عبدالرحمنالسديس`; the legacy rule gives `∅` or `ar`). They have no counterpart in the XMLTV, and no Arabic channel has a display name there. **Unicode-safe normalisation is necessary for correctness but brings no coverage for this provider.**

**Recommended matching design (not implemented):**
1. **Make guide refresh trustworthy first.** Reject a download that ends before `</tv>`, or is shorter than `Content-Length`. Record the XMLTV totals (channels, programmes, bytes). Retry once. Only then replace the stored guide.
2. Exact id first.
3. Then a Unicode-safe name match **keeping the country prefix as part of the key**, with prefix stripping used only to break ties *within the same country* (country from the prefix vs the XMLTV id suffix, e.g. `.fr`). Accept only unique matches.
4. Reject a name match when the channel has its own id that differs (the 71 conflicts).
5. Report coverage and rejections in diagnostics.

The expected realistic ceiling is about 4,300–4,500 channels with programmes (19.6–20.6 %). It is limited by the 75 % of channels without ids, with no XMLTV counterpart.

### B.D Search performance

Real catalogue, 108,565 titles, 49,228 distinct words. Each query was run cold, then warm. The two caps are 2,000 (browse) and 40 (global Search).

| Query (length, frequency) | Cap | First result | 5 | 20 | Complete | Name pages scanned | Results | Max main-thread stall | Title load for 40 | Global screen shows |
|---|---|---|---|---|---|---|---|---|---|---|
| very common (3 ch, 19,339 titles) | 2000 | 294–338 ms | same | same | 3,453–3,550 ms | 11 | 2,000 | 118–122 ms | 0–448 ms | 3,550–3,901 ms |
| very common | 40 | 260–276 | same | same | **260–276** | 1 | 40 | 73–78 | 0–361 | 260–637 |
| common (4 ch, 558) | 2000/40 | 263–292 | 263–292 | 571–630 | 3,333–3,473 | 11 | 558 / 40 | 117–150 | 1–518 | 3,334–3,876 |
| less common (5 ch, 42) | 2000/40 | 273–392 | 596–695 | 1,865–1,894 | 3,394–3,502 | 11 | 43 / 40 | 102–137 | **1,902–2,164** | **5,387–5,562** |
| exact title (25 ch) | 2000/40 | 276–375 | — | — | 3,351–3,449 | 11 | 1 | 111–135 | 0–117 | 3,423–3,562 |
| partial title (6 ch) | 2000/40 | 268–415 | same | same | 3,321–3,560 | 11 | 2,000 / 40 | 112–143 | 0–1 | 3,321–3,561 |
| no results (7 ch) | 2000/40 | — | — | — | 3,341–3,474 | 11 | 0 | 92–128 | 0 | 3,341–3,474 |
| Arabic (4 ch, 1,141) | 2000/40 | **864–1,003** | same | same | 3,339–3,461 | 11 | 1,219 / 40 | 105–145 | 1–308 | 3,393–3,750 |
| rare | — | **invalid test**: the selector found no all-letter word with frequency 2 and passed an empty query (0 ms) | | | | | | | | |

Free memory was 189–242 MB throughout. Cold and warm runs differ by at most about 150 ms, so the per-page read and parse dominates, not caching.

**Bottleneck [M + I]:**
- Each name page costs about 300 ms (read, checksum, `JSON.parse`, split), and all 11 pages are always read, except when ≥ cap titles *start with* the query.
- Provider titles mostly start with tags, so for real words this almost never happens. The "very common" 40-cap case stopped after 1 page only because 40 titles start with that word.
- Results are **available** after the first page (0.26–0.42 s), but the global Search screen calls `search()` without `onProgress` and renders only after `result` and `ensure()`. That is **3.3–5.6 s** of a blank screen.
- `ensure()` for 40 hits spread over many item pages adds up to 2.2 s.
- Main-thread stalls of 92–150 ms per page are perceptible but short; the UI is not blocked for the whole search.

**Recommended progressive approach (not implemented):**
- Use `onProgress` in the global Search screen; render each batch after an `ensure()` limited to the visible cards.
- Stop the scan when the visible rows are full (cap 40 counting *contains* matches, not only prefix matches), and let a "more" action continue it.
- Keep the 11-page full scan for "no results", but show "Searching… page k of 11".

### B.E Repeated cold starts

**Definitions:**
- **kill** = app process ended with `sdb shell 0 was_kill`, 3 s pause, then `tizen run`. This is a cold app start: the TV itself is not restarted.
- **again** = `tizen run` while the app is already running.
- A full TV restart cannot be triggered remotely, so none was performed.

**Probe:** a dev-only module that runs when the bundle is evaluated, before the app starts. It POSTs straight to the LAN sink:
- an entry beacon;
- milestones: app context ready, first screen and its DOM size, and one injected key handled;
- a heartbeat every 2 s (visibility, app log length);
- window errors, unhandled rejections and visibility changes.

Runs are identified by a run id; the PC's clock is not used for matching.

**Results: 21 app instances on the TV, 22:41–23:05 local** (evidence: `docs/evidence/stage7d/E-coldstart.jsonl`, `E-coldstart-pc-launcher.jsonl`):

| # | Start | Entry beacon | Context ready | First screen (Home, 83 nodes) | Injected key handled | Heartbeats | Hidden at | Result |
|---|---|---|---|---|---|---|---|---|
| 1–4 | kill | 1–2 ms | 2.27–2.36 s | +3 ms | 5.09–5.17 s | 15 each | 31.1–31.3 s (= kill) | normal |
| 5 | kill | 1 ms | 2.28 s | yes | 5.09 s | 7 | **14.9 s** | **hidden by the TV/user**; the next 2 launch commands were refused ("Could not launch the null application") |
| — | — | — | — | — | — | — | — | user reported the TV was off/standby; **reinstall needed** before launches worked again |
| 6 | kill | 2 ms | 2.37 s | yes | 5.18 s | 7 | **15.0 s** | hidden early |
| 7 | kill | 2 ms | 2.41 s | yes | 5.22 s | 15 | 31.4 s | normal |
| 8 | kill | 3 ms | 2.32 s | yes | — | 1 | **3.6 s** | hidden early; then launch refused again; reinstall needed |
| 9 | (after reinstall) | 5 ms | 2.63 s | yes | 5.44 s | 5 | **11.8 s** | hidden early (when the dev build was reinstalled) |
| 10–15 | kill | 1–3 ms | 2.24–2.69 s | yes | 5.05–5.49 s | 15 each | ≈31 s (= kill) | normal |
| 16 | kill + **again** | 1 ms | 2.53 s | yes | 5.34 s | 30 | 65.4 s | relaunch of a running app: launch command refused; the running instance continued |
| 17–20 | kill | 1–3 ms | 2.46–2.69 s | yes | 5.27–5.51 s | 15 each | ≈31 s (= kill) | normal |
| 21 | kill | 1 ms | 2.36 s | yes | 5.17 s | 23+ | — | normal (left running; ended by the cleanup) |

**Findings:**
- **0 of 21 instances went silent while visible** [M]. Every instance reached the entry beacon (1–5 ms), app context (2.2–2.7 s), the Home screen and, where it got that far, handled the injected key.
- **Whenever the app was hidden, its JavaScript stopped**: heartbeats stopped at the visibility change [M]. A hidden app therefore looks exactly like the historical "silent" launches: logging ends abruptly with no error.
- Four instances were hidden early (3.6–15 s), not by the script. The user confirmed at least once that **the TV was off/standby**.
- After such an event, **`tizen run` was refused until the app was reinstalled** (twice) [M]. The same message appears when relaunching an app that is already running (#16).
- **The historical silent launches are explained by the app being hidden or the TV entering standby**, which suspends JavaScript, rather than by an app defect [I/H]. The earlier occurrences stopped 0.02–0.15 s after start, consistent with a launch while the TV was off or switching. This is not proven, because the earlier runs had no visibility probe. Classification: **not reproduced as an app fault; a matching platform mechanism was reproduced.**
- Not tested: a full TV power cycle, return from background via the Home key, and physical remote input.

---

## C. Evidence quality

| Conclusion | Quality |
|---|---|
| Seek failure = MKV without Cues | Measured on 1 provider file + reproduced in the lab |
| 21/24 provider movies seek | Measured |
| Share of index-less MKVs in the catalogue | Unknown (1 of 15 MKVs sampled) |
| Two indexed MKVs do not play | Measured; cause hypothesis |
| Embedded text subtitles work, timing ≤ 11 ms | Reproduced (lab) + measured (provider) |
| AVPlay reports no subtitle languages | Reproduced |
| Image subtitles | Not tested |
| External overlay timing | Reproduced (DOM only, not seen) |
| Guide truncation as the main cause of 0.86 % | Inferred (stored 3,568 vs 190,304 programmes; 4.2 s vs 16 s) |
| Strategy coverage numbers | Measured (against today's XMLTV) |
| Which name matches are truly correct | Not verified by a human |
| Search bottleneck = full 11-page scan | Measured + code |
| Global Search blank 3.3–5.6 s | Measured (components) + code; not seen on screen |
| 21 launches, none silent while visible | Measured |
| Hidden app = JS stops (the silent pattern) | Measured |
| Historical silent launches caused by standby/hidden | Hypothesis (consistent with the evidence, not proven) |
| Launch refused until reinstall after standby | Measured (twice); cause unknown |

## D. Recommended implementation sequence

| # | Problem | Root cause | Proposed change | Files likely affected | Tizen | Android | Risks | Acceptance | Physical TV check |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Guide covers 0.86 % | Truncated XMLTV download accepted; totals never recorded | Completeness check (`</tv>`, length), totals, one retry, replace only when complete | `services/epg-service.ts`, `content/xmltv-parser.ts`, `api/http-client.ts` | yes | yes (shared) | rejecting a valid feed without `</tv>`; storage size of a 20× larger guide (check the section budget) | ≥ 4,000 channels with programmes for this provider; a truncated feed is rejected in tests | guide grid shows data for common channels |
| 2 | Wrong name matches (71) / Unicode | Name match ignores own id; Latin-only normaliser | Reject conflicts; Unicode-safe key with country; uniqueness rule; coverage stats | `content/epg-index.ts` | yes | yes | lower coverage in edge cases | 0 conflicts accepted; coverage ≥ the strategy-5 figure minus conflicts | spot-check 30 matched channels by eye |
| 3 | Seek/resume on index-less MKV | Missing Cues | Pre-check the SeekHead/Cues (2 range reads) before offering ±10/Resume; remember per title | `player/vod-controller.ts`, new `player/mkv-probe.ts`, `vod-details-screen.ts`, `vod-player-screen.ts` | yes | yes (Media3 also needs Cues [H]) | extra requests at start; providers rejecting ranges | S2-M1 class: no Resume or ±10 offered; indexed titles unaffected | resume a movie with the remote |
| 4 | Global Search blank 3–5 s | Final-result-only rendering | Progressive rendering with `onProgress` + visible-only `ensure` | `screens/search-screen.ts` | yes | yes | flicker while rows grow | first row visible ≤ 0.5 s for common words | type a word, watch results appear |
| 5 | Subtitle labels | AVPlay gives no language | "Subtitles 1/2" fallback label; keep Off first | `screens/track-sheet.ts` | yes | ExoPlayer has languages | — | labels never "?" | read the panel |
| 6 | Two MKVs don't play | Unknown (codec/profile [H]) | Diagnose first: log VIDEO track info / AVPlay error for the failing titles | `src/dev` only | yes | — | — | cause identified | — |
| 7 | External subtitles | Not built | Separate feature stage (sources, parser, overlay, sync) | new | yes | yes | scope | — | visual timing check |

## E. Remaining gaps

- **TV limitations:** `sdb` allows push only (no file pull); TV API calls are confined to the AVPlay engine (external `setExternalSubtitlePath` not re-tested); a full TV restart cannot be triggered remotely.
- **Provider limitations:** the share of index-less MKVs is unknown; 2 indexed MKVs don't play; the XMLTV has no Arabic channels; 75 % of channels have no guide id.
- **Missing data:** the codec of the two non-playing MKVs; why the earlier guide refresh kept so little (the provider's response at that time cannot be reconstructed).
- **Missing test media:** image-based subtitles (PGS/VobSub).
- **Insufficient reproduction:** the historical silent launch was not reproduced as an app fault (0/21). The standby mechanism explains it, but the earlier runs had no visibility data. The guide truncation can't be reproduced now, because the provider serves the full file today.
- **Human verification:** subtitles on screen, overlay legibility, audio-track switch audibility, focus visibility, physical remote. All NOT TESTED.
- **Interference:** another person used the TV during Investigation B (21:30–21:35). Their actions are in the log and were excluded from the measurements.

## F. Cleanup and verification

| Item | Result |
|---|---|
| Baseline before the stage | branch `main`, HEAD `5739de1`; 71 status entries (96 files) checksummed; nothing staged; release build 21:19 (`app.js` 290,984 B), version 0.2.0 |
| Temporary code | `src/dev/boot-probe-7d.ts` and `src/dev/device-selftest-stage7d.ts` **removed**; `src/dev/device-selftest.ts` restored byte-identical from the pre-stage backup (SUITE `7b2` again) |
| Production code changed | **None.** All 96 baseline files match their pre-stage SHA-1 |
| Files added | this report and `docs/evidence/stage7d/` only (`A-B-tv-log.jsonl`, `A-B-lab-server-requests.jsonl`, `C-epg-matching.jsonl`, `D-search-timing.jsonl`, `E-coldstart.jsonl`, `E-coldstart-pc-launcher.jsonl`) |
| Checks | `npm run check`: 262 unit tests + 5 build tests pass; ES5 compatibility check 0 findings |
| Release build | `npm run build:all`: release OK (`app.js` 290,984 B, identical size), `check:release` OK, 0 diagnostic strings; APK build OK (up to date) |
| TV | release build reinstalled (after 4 dev builds used for the investigations); dev build output in `dist/dev` rebuilt without the sink or diagnostics |
| Processes | the Stage 7D lab server exited; the dev sink on :8097 was stopped. A separate `node scripts/dev-sink.mjs` on :8099 (not started by this stage) was left running |
| Data | no catalogue, guide, PIN, progress, preference or playlist change. The 10-minute provider playback ran through the engine directly, so no progress was saved |
| Sensitive data in evidence | checked: no provider URLs, usernames, passwords or tokens (automated check plus a URL scan; only the LAN lab address appears). Channel and category names from the provider appear in the EPG examples |
| Scratchpad | lab files and tools remain in the session scratchpad (outside the repository); not deleted, as instructed |
| Commit / push / merge / tag / release / deploy | none |
