# Stage 7F — Playback UI, subtitle coverage and audio tracks: report

Date: 2026-11-25. The audit is in `docs/STAGE-7F-AUDIT.md`.

**Your decisions:**
- **D1** playback screen: approved;
- **D2** "Unknown language": approved;
- **D3** one temporary TV test build: approved and done;
- **D4** external subtitles: **not approved**, nothing built.

**Evidence tags**
- **[SIM]** unit tests;
- **[TV-M]** measured on the TV with scripted keys; nobody looked at the screen or listened;
- **[CODE]** from the source.

Evidence: `docs/evidence/stage7e-playback/tv-run4-stage7f.jsonl`, 109 lines. It contains no URLs, credentials or `player_api` calls (checked by search).

## 1. Status

| Item | Status |
|---|---|
| Preview logo hidden during playback | **Implemented and tested** [SIM + TV-M]. Visual check needed |
| Controls hide after 3 s | **Implemented and tested** [SIM + TV-M]. Physical-remote check needed |
| Title / time presentation | **Implemented and tested** [SIM + TV-M]. Visual check needed |
| "Unknown language" labels | **Implemented and tested** [SIM] |
| 60-movie library sample (subtitles, audio, TMDB) | **Investigated** [TV-M] |
| Audio codec support (lab file) | **Investigated** [TV-M]. Nothing listened to |
| External subtitles | **Not implemented** (D4) |
| Track alignment when AVPlay hides a track (§4.4) | **Investigated, not implemented. Needs approval (D5)** |

## 2. Changes

| File | Change |
|---|---|
| `src/screens/live-preview.ts` | The logo is shown and hidden by classes only: `is-live` = picture only, `no-logo` = channel without a logo. The inline `visibility` writes are gone: they beat the `is-live` rule, which is why the logo stayed over the video |
| `src/styles/live.css` | `no-logo` rule |
| `src/screens/vod-player-screen.ts` | `BAR_MS` 5000 → **3000**. The hide timer is armed by keys and by the change **into** `playing` (start, resume, end of buffering), never by the 1 s position updates (the cause: each update restarted the timer, see audit §3). Paused, loading, ended and error keep the controls with no timer. Buffering during playback leaves them as they are. The time-of-day clock is removed. Bottom left shows `elapsed / total` |
| `src/screens/vod-details-screen.ts` | The episode title in the player is `Series · S1 E3 · Episode title` |
| `src/screens/track-sheet.ts`, `src/i18n/strings.ts` | A track without a language reads `Unknown language`; several such tracks read `Unknown language 1, 2, …` (Dutch: `Onbekende taal`). This replaces "Audio n" / "Subtitles n". No language is guessed |
| `src/styles/vod.css` | Clock rule removed |
| `tests/unit/live-ui.test.mjs`, `vod-ui.test.mjs`, `stage7e-tracks.test.mjs` | 5 new tests, 2 existing assertions updated for the intended changes (`1:01` → `1:01 / 1:45:00`, `Audio 2` / `Subtitles 4` → `Unknown language`), plus title and clock checks in the existing episode test |
| `src/dev/device-selftest-stage7f.ts` | **New, dev-only, not referenced** (TV run E9–E12) |

What did not change:
- the remaining-time display (bottom right);
- the seek cursor, the ±10 buttons and the track sheet;
- the preview's one-player design, its 0.7 s (+0.12 s) settle and its memory protections.

No test was removed or weakened.

## 3. Automated tests

- `npm run check`: typecheck OK, **compat 0 findings in 114 files**, **284/284 unit** (5 new) + **5/5 build** tests.
- `npm run build:all`: release `app.js` 316,544 B; `release-check: OK`; no self-test or lab address in the release bundle; **APK rebuilt** (`dist/android/EliteStream-0.2.0-debug.apk`, not run on a device).

**New regression tests:**
- the preview logo disappears on the picture and stays hidden on re-renders;
- the logo and "Preview not available" come back on failure;
- the next channel shows its logo, not the old picture;
- a channel without a logo gets the `no-logo` class;
- the controls hide 3 s after the picture although the position ticks;
- a key shows the controls, and the timer restarts with every key;
- the seek cursor keeps the controls, pause keeps them, resume hides them after 3 s;
- an open sheet keeps the controls, and closing it hides them after 3 s;
- the episode title format and the missing clock;
- "Unknown language" with and without numbering (English and Dutch), and several audio languages with their format.

## 4. TV run (D3) [TV-M]

The dev build was installed once, ran E9–E12 (about 4 minutes), and the **release build was reinstalled afterwards**.

`src/dev/device-selftest.ts` was changed for the run and restored byte-identical (SHA-1 `07584df…`). The lab server ran only for the test and is stopped.

Memory: free memory stayed at **214–273 MB** during the 60-movie sample and **206–256 MB** during the rest. No error was logged and the app stayed responsive throughout.

### 4.1 Mini preview (E11)

| Moment | Slot | Logo (computed visibility) |
|---|---|---|
| Picture on the first channel | `ss-preview is-live` | **hidden** |
| After a re-render (focus → actions → back) | `is-live` | **hidden** |
| 300 ms after ↓ (next channel loading) | `ss-preview` | visible (the new channel's logo) |
| Next channel's picture | `is-live` | **hidden** |
| 10 × ↓ at 150 ms, then 6 s | `ss-preview` (still loading) | visible |
| Leave Live TV | — | engine `idle`, home |

- **Rapid moves:** 0 pictures and 0 failures within the 6 s. The last channel was still opening; in run 3 it had a picture.
- I can't tell from this whether that channel is slow or dead. The prepare limit is 15 s, after which it would show "Preview not available".
- Not checked: whether a picture actually appears in the box (**visual check by you**).

### 4.2 Movie controls (E12)

- Movie: *EN - MK Ultra (2022)*. Title shown: `EN - MK Ultra (2022)`. Time shown: `0:03 / 1:37:21`. No clock.
- Sequence: `1.5s=shown 3.6s=hidden cursor=shown cursor+3.6s=shown cancel+3.6s=hidden paused+3.6s=shown resumed+3.6s=hidden`. Every rule behaved as designed.
- Not checked: the look on screen, and the physical remote.

### 4.3 Library sample: 60 movies spread evenly over "All" (E9)

**Method**
- For each movie: the raw `get_vod_info` key names, then the container probe.
- Byte ranges only, median **2** requests per movie (1–9), probe time 83 / 276 / 1,856 ms (min / median / max).
- **No movie was played or downloaded.**
- Probe result: 57 of 60 files read. 3 could not be read: 2 MP4s and 1 MKV (*EN - Beau Is Afraid*, *Królewski świąteczny balet*, *NL - Paddington 2*). The cause was not established.

**Provider metadata (Xtream `get_vod_info`, 60 of 60 answered):**
- `tmdb_id` is present on **57 of 60** (56 numeric). **TMDB ids are available from this provider.** The app does not store them yet.
- There is **no** `subtitles` field on any movie. The provider supplies no subtitle metadata.
- `audio`, `video` and `bitrate` fields (ffprobe-style) are present. `audio` is non-empty on 46 of 60. Its first codec agrees with the file on 41 of 57.
- Other keys:
  - on every movie: `actors`, `age`, `backdrop_path`, `cast`, `country`, `cover_big`, `description`, `director`, `duration`, `duration_secs`, `genre`, `movie_image`, `name`, `o_name`, `plot`, `rating`, `releasedate`, `youtube_trailer`;
  - on some: `runtime` 57, `status` 57, `kinopoisk_url` 13, `mpaa_rating` 13, `episode_run_time` 13, `rating_count_kinopoisk` 13.

**Subtitles in the files:**
- **16 of 60 movies (27 %) carry embedded subtitles. 44 (73 %) carry none.**
  - Per movie: 1 track 7, 2 tracks 2, 3 tracks 2, 4 tracks 1, 5 tracks 3, 33 tracks 1 (*NF - Do Not Disturb (2023)*).
  - The earlier 10-movie sample (2 of 10) was on the low side.
- **Languages** (number of movies with at least one track): English 6, French 5, Spanish 5, Danish 4, Finnish 3, Norwegian 3, Swedish 3, German 2, Arabic 2, and one each for Chinese, Croatian, Czech, Dutch, Greek, Hebrew, Hungarian, Indonesian, Italian, Japanese, Korean, Malay, Polish, Portuguese, Romanian, Russian, Thai, Turkish, Ukrainian, Vietnamese.
  - 3 tracks have no language (they read "Unknown language").
- **Formats** (75 tracks):
  - SRT 59, ASS 4 (2 movies), tx3g 3 (2 movies);
  - **VobSub image subtitles 3** (1 movie, *DE - Leg dich nicht mit Zohan an*). Listed and labelled "Image", but **not drawn**: AVPlay passes text cues only.
- Text subtitles from the files are already shown and selectable (Stage 7E). Rendering of this sample was **not** checked.

**Audio in the files:**
- One track: 46 movies. Two tracks: 9. Three: 1 (*RU - The Green Mile*, Russian / Ukrainian / English AC-3). Six: 1 (*NF - Do Not Disturb*: English, German, Polish, Portuguese, Spanish, Turkish AAC). None readable: 3 (the unprobed files).
  - **11 of 60 (18 %) have more than one audio track.**
- Codecs, 73 tracks: **AAC 57, AC-3 10, E-AC-3 3, MP3 2, DTS 1.**
- 25 of 73 tracks state no language: "Unknown language" for single-track movies. An unknown track in a two-track movie reads e.g. `Unknown language · 5.1 · AAC`.
- Example multi-language titles:
  - *DE - Leg dich nicht mit Zohan an*: German + English, AC-3 5.1;
  - *ES - El amor está en el aire*: English + Spanish, E-AC-3 5.1 640 kb/s;
  - *FR - Les Malvenus*: French E-AC-3 384 kb/s + French AAC 194 kb/s.

### 4.4 Audio codec support on this TV (E10, lab file)

The lab file is `codecs.mkv`: one video track and 7 audio tracks, each a tone at a different pitch.

| Track in file | Listed by AVPlay | Selected | Playback kept running |
|---|---|---|---|
| English AAC 2.0 | yes (`en`, codec not given) | yes | yes (+2.5 s) |
| French AC-3 5.1 | yes | yes | yes |
| Dutch E-AC-3 5.1 | yes | yes | yes |
| German DTS 5.1 | yes | yes | yes |
| Spanish MP3 2.0 | yes (codec not given) | yes | yes |
| Italian Opus 2.0 | yes (codec not given, 0 ch) | yes | yes |
| Turkish **TrueHD** 5.1 | **not listed** | — | — |

**What this shows:**
- AVPlay **hides tracks it cannot decode** (TrueHD here).
- It accepts selection of AAC, AC-3, E-AC-3, DTS, MP3 and Opus without an error, and playback keeps running.
- **Whether each one is actually audible (for example DTS on a 2017 set, or Opus) is not known:** nobody listened, and the TV does not report audio output.

**Consequence (found, not fixed).**
- The file has 7 audio tracks and AVPlay lists 6, so the Stage 7E merge rule ("same number of tracks") withholds the file's data.
- The panel then shows AVPlay's own values: two-letter languages, which are still named, and no codec for AAC, MP3 or Opus.
- A **safe fix** would align the two lists **in order by language**, AVPlay's being a sub-list of the file's. The file's data would be used only when that alignment is unique, and otherwise not at all. Tracks AVPlay does not list are not offered anyway.
- None of the 60 provider movies had a TrueHD track, so this affects remuxes rather than this library today. **Approval needed (D5).**

## 5. Known limitations

- **External subtitles:** none (D4). 73 % of the sampled movies have no subtitles at all.
  - TMDB ids are available on 95 % of them, so a later external-subtitle stage could match reliably.
- **Image subtitles** (VobSub, PGS): listed, not drawn.
- **Audio:** audible switching and codec audibility are not verified. TrueHD is not supported by this TV's player. The merge limitation is described above (D5).
- **3 of 60 files** could not be probed. Their tracks show AVPlay's values.
- **Preview:** a channel that is slow or dead shows its logo until the 15 s limit.

## 6. For you to check (physical remote, screen, sound)

1. **Live TV:** rest on a channel. The picture plays in the box with **no logo on top**. Move ↓: the next logo shows, then its picture. Rest on a dead channel: logo + "Preview not available" (up to 15 s).
2. **Movie:**
   - start one: the title and controls disappear after about 3 s;
   - press ◀ or ▶: they reappear, and stay while the seek cursor is shown;
   - OK = pause: they stay; OK again: they disappear after 3 s;
   - check the bottom left reads `elapsed / total`, and there is no clock at the top.
3. **Episode:** the title reads `Series · S1 E3 · Episode title`.
4. **Audio, listening:**
   - *DE - Leg dich nicht mit Zohan an* (German / English);
   - *RU - The Green Mile* (Russian / Ukrainian / English);
   - *NF - Do Not Disturb (2023)* (6 languages; also 33 subtitle tracks).

   Switch the audio and confirm the language changes.

## 7. Decisions still open

| # | Question |
|---|---|
| D5 | Align audio and subtitle tracks in order by language when AVPlay hides a track it cannot decode (§4.4)? Small change, with tests |
| D4 (later) | External subtitles, now that TMDB ids are known to be available (57 / 60) |

Nothing was committed, pushed or published. The EPG stage was not started.

Follow-up: D5 audio track matching, `docs/STAGE-7F-D5-REPORT.md`.
