# Stage 7F-E — Subtitle track metadata matching: report

Date: 2026-11-25. Scope: Stage 7F-E only (subtitle labels). D5 (audio) is unchanged.

**Evidence tags**
- **[SIM]** unit tests;
- **[TV-M]** measured on the TV with scripted keys. Nobody watched the screen; "drawn" means the app's subtitle overlay contained cue text, read from the DOM.

Evidence: `docs/evidence/stage7e-playback/tv-run6-stage7f-e.jsonl` (988 lines: discovery pass and verification pass). It contains no URLs or credentials (checked by search). Cue text itself is not logged, only script classes (Latin, Arabic, Greek, …), distinct accented letters and lengths.

## 1. Existing subtitle-matching architecture

- **Player list.** `avplay-engine.ts` → `mapAvTracks` turns AVPlay's `TEXT` tracks into `MediaTrack`s.
  - On this TV AVPlay states **nothing** about a subtitle track: `track_lang` is empty and `fourCC` is empty for every track seen (TV runs 1–6).
  - Selection uses AVPlay's ids (`setSelectTrack('TEXT', id)`). AVPlay hands each cue's **text** to the app (`onsubtitlechange`), and the app draws it (`vod-player-screen.ts` → `renderSubs`).
- **File list.** `media-probe.ts` reads the container header with byte ranges and returns every track in file order: language, codec, name and forced flag.
  - MKV codecs: S_TEXT/UTF8 → srt, ASS/SSA, WebVTT, PGS, VobSub, DVB.
  - MP4 codecs: tx3g, wvtt, stpp, c608.
- **Merge.** `track-info.ts` → `mergeProbe`. For subtitles (Stage 7E) file data was attached **only when both lists have the same number of subtitle tracks**, paired by position.
- **Labels.** `track-sheet.ts` → `trackLabels`:
  - the language name, plus "Forced" and "Image" (bitmap formats) and the file's track name;
  - "Unknown language N" when no language is known.

## 2. Root cause of the unknown labels

*NF - Do Not Disturb (2023)* has 1 video + 6 audio + 33 subtitle tracks (40 in total). AVPlay lists 25 subtitle tracks.

- With different counts the Stage 7E rule attached nothing.
- AVPlay's entries carry no language, so every row read "Unknown language 1 … 25".
- D5's audio alignment cannot help. It needs languages or codecs on the player side to tell tracks apart, and AVPlay states neither for subtitles: any 25 of the 33 would fit (C(33,25) placements).

**Discovery: why AVPlay lists 25.** I built three lab MKVs. Each subtitle cue reads "S01", "S02", … so the rendered text shows which file track the player is playing. On the TV, each listed subtitle was selected and the cues it delivered were read [TV-M]:

| File | Tracks in file | Subtitles listed by AVPlay | Which ones (from the cue markers) |
|---|---|---|---|
| `subs40.mkv`: 1 video, 1 audio, 40 subtitles | 42 | **30** | S01…S30, in file order |
| `subsorder.mkv`: 1 video, 15 subtitles, 10 audio, 15 subtitles | 41 | **21** (audio: all 10) | S01…S21, in file order |
| `subsformats.mkv`: 7 subtitles | 9 | 7 | S01…S07 |
| *Do Not Disturb*: 1 + 6 + 33 | 40 | **25** | first 25 (see below) |

In every case video + audio + listed subtitles = **32**. AVPlay on this TV lists **only the first 32 tracks of a file, in file order**, and drops the rest.
- A fixed cap on subtitles (25) does not fit `subs40` (30 listed).
- A subtitle-only cap does not fit `subsorder`: the subtitles after the audio tracks are cut where the 32nd track falls.

*Do Not Disturb* confirms this on real content. Discovery selected each listed track; every track that delivered cues showed text matching the language at the same position among the first 25 file subtitles:
- Arabic script on track 2 and Greek on 10;
- Czech letters (žáěř) on 4, Danish (å) on 5, Finnish (äö) on 7;
- Japanese kana on 15, Korean hangul on 16, Norwegian (åø) on 18, Polish (łóęź) on 19, Portuguese (ã) on 20.

The 8 hidden ones are the last 8: sv, th, tr, tr (forced), uk, vi, zh, zh.

## 3. Files changed

| File | Change |
|---|---|
| `src/player/track-info.ts` | New `AVPLAY_TRACK_LIMIT = 32` and `alignTrackLimit()`. `mergeProbe` uses it for **subtitles only** when the player lists fewer than the file; it also copies the new `sdh` flag |
| `src/player/media-probe.ts` | Reads MKV `FlagHearingImpaired` (0x55AB) into `ProbeTrack.hearingImpaired`; recognises the `D_WEBVTT/SUBTITLES` codec id (written by ffmpeg) as WebVTT |
| `src/player/engine.ts` | `MediaTrack.sdh?: boolean` (CRLF kept) |
| `src/screens/track-sheet.ts` | Subtitle rows: "SDH" only from the flag, "CC" only for a CEA-608 track, and the stated format (SRT, ASS, WebVTT, TTML, MP4 Timed Text, PGS, VobSub, DVB). A file name equal to the language code ("ara"), or "SDH" when the flag is set, is not repeated |
| `src/i18n/strings.ts` | `vod.sdh` "SDH", `vod.cc` "CC" (EN and NL; CRLF kept) |
| `tests/unit/stage7f-e-subtitles.test.mjs` | **New**, 12 tests |
| `tests/fixtures/media/subs-flags.mkv` | **New**, 5.6 KB fixture: SDH flag, "SDH" name without the flag, forced WebVTT, ASS |
| `tests/unit/stage7e-tracks.test.mjs` | Two label expectations now include the format (`French · Forced · ASS`, `English · Image · PGS`) |
| `src/dev/device-selftest-stage7f.ts` | Dev-only (not referenced by any build): E14 discovery and panel checks |

Unchanged:
- `src/dev/device-selftest.ts`: changed for the runs, restored byte-identical (SHA-1 `07584df…`);
- the player engine's behaviour, subtitle selection and rendering, the probe's byte-range behaviour and request budget, and audio matching (D5).

## 4. Matching algorithm and safeguards

**Equal counts:** the Stage 7E rule is unchanged (pair by position). The TV lab file confirms it: all 7 tracks rendered the cue of their own position.

**The player lists fewer subtitles than the file** (`alignTrackLimit`). File data is attached only when **all** of these hold:

1. The file has **more than 32 tracks**, so the proven limit applies at all.
2. The file's first 32 tracks contain **exactly as many** subtitle tracks as the player lists.
3. Player audio tracks + player subtitle tracks + video tracks in that window = **exactly 32**. Any other cause of hiding breaks this equality, for example an audio codec AVPlay hides (TrueHD, Stage 7F) or a firmware with a different limit, and then nothing is attached.
4. Any language the player states (none so far on this TV) must agree with the file track at that position; one disagreement rejects the whole list.

When it holds, player subtitle *n* gets the metadata of the file's *n*-th subtitle: language, format, name, forced and SDH. Otherwise every row keeps the player's label ("Unknown language N").

**Guarantees:**
- Ids, order, selected flags and the list itself stay the player's.
- File tracks beyond the limit are never added.
- No index equality is assumed except the one proven on the TV: the order of the listed tracks inside the 32-track window.

**Indicators:**
- "Forced" only from FlagForced;
- "SDH" only from FlagHearingImpaired (a name such as "English SDH" stays a name);
- "CC" only for a CEA-608 track.

## 5. Duplicate and ambiguous track handling

| Case | Result |
|---|---|
| Same language twice (pt, pt; es, es) | position is proven, so both are labelled; told apart by the file's names ("Portuguese · SRT · Brazilian Portuguese", "Spanish · SRT · European Spanish"), otherwise numbered "(1)", "(2)" |
| Same language, different formats | the format is part of the row (English · SRT / English · ASS) |
| File track without a language | stays "Unknown language", only the format is added |
| Player track without metadata (all of them on this TV) | the normal case, handled by the rules above |
| Player states a language that disagrees | whole list rejected, player labels kept |
| Different order (player FR, EN; file EN, FR) | rejected |
| Fewer listed for another reason (file within 32 tracks, or the window equality fails) | rejected, player labels kept |
| File tracks the player hides | never shown |
| Listed but not drawn (image subtitles) | still listed, labelled "Image · VobSub"; see §11 |

## 6. Automated test results

`npm run check`:
- typecheck OK;
- **304/304 unit tests** pass, 12 of them new;
- **5/5 build tests** pass.

New tests in `tests/unit/stage7f-e-subtitles.test.mjs`. The numbers refer to your list.

1. **(1)** *Do Not Disturb*: the 25 listed tracks get the first 25 file languages. Also both TV lab layouts (30 of 40; 21 around 10 audio tracks).
2. **(2)** Rejections:
   - the window does not add up (one audio track hidden as well);
   - a file within the limit with fewer listed subtitles;
   - a listed count that differs from the window's.
3. **(3)** A missing file language stays "Unknown language · SRT".
4. **(4)** A player language that agrees is accepted; one that disagrees is rejected.
5. **(5)** Duplicate languages: names distinguish them, otherwise they are numbered.
6. **(6)** Formats: SRT, ASS, WebVTT, PGS (image), MP4 Timed Text, CEA-608 (CC).
7. **(7)** Different order is rejected.
8. **(8 + 12)** No hidden file track is added; ids and the list length are the player's; inputs are not modified.
9. **(9)** Fallback with no probe, an empty probe, or a probe without subtitles.
10. **(10)** Forced, SDH and CC come only from explicit flags (probe of the new fixture). The name "SDH" alone does not set the flag.
11. **(11)** Through the real `VodController`: ids, order and selection are identical after the probe, and `selectTrack('text', 16)` asks the engine for id 16 (Greek).

## 7. ES5 compatibility

`compat-check: 114 files, 0 finding(s)`. The merge allocates one small index array per call, and only when the limit rule applies.

`npm run build:all`:
- release `app.js` 318,706 B;
- `release-check: OK (no development logging code or origins)`;
- no self-test or lab address in the release bundle;
- APK rebuilt: `dist/android/EliteStream-0.2.0-debug.apk` (not run on a device).

## 8. Samsung TV test results [TV-M]

A temporary dev build was installed twice: a discovery pass (§2), then a verification pass with the new matching.

**Lab files (verification pass, labels from the app's own merge and label code):**
- `subs40.mkv`:
  - labels "English · SRT · S01", "Arabic · SRT · S02", … for all 30 listed tracks;
  - the 19 tracks that delivered a cue inside the window each showed the marker of their own position (player id *n* → S*n−1*), and none contradicted it.
- `subsorder.mkv`: 21 listed, labelled S01…S21. All 13 tracks that delivered a cue matched their position (id *n* → S*n−10*).
- `subsformats.mkv`:
  - all 7 tracks rendered their own marker;
  - labels "English · SRT", "English · ASS", "French · WebVTT", "English · Forced · SRT", "English · SDH · SRT", "Unknown language · SRT" and "Dutch · SRT".

**Provider movies, real VOD player:** the Audio & subtitles panel was opened with keys, the subtitle row was chosen with keys, and the rows were read from the DOM (UI language Dutch).

| Movie | Subtitle rows | Row chosen | Player track selected | Drawn on screen |
|---|---|---|---|---|
| *Do Not Disturb* | 25 rows: Engels · SRT, Arabisch · SRT, Kroatisch · SRT, … Portugees · SRT, Portugees · SRT · Brazilian Portuguese, Roemeens, Russisch, Spaans · SRT, Spaans · SRT · European Spanish. **No "Onbekende taal" rows** | Arabisch | 8 | Arabic script |
| | | Grieks | 16 | Greek script |
| | | Koreaans | 22 | Hangul |
| | | Spaans · European Spanish | 31 | Latin with é |
| *The Hitman's Bodyguard* | Arabisch · SRT, Deens · SRT, Engels · SRT (before: "Arabisch · ara" etc.) | Arabisch | 2 | Arabic script |
| *Les Malvenus* | Frans · SDH · SRT (SDH from the file's flag) | Frans | 3 | Latin with ù |
| *Zohan* | Duits · ASS · German Forced Subs [SRT], Engels · ASS · English Forced Subs [SRT], 3 × "Afbeelding · … [VobSub]" | Duits VobSub | 5 | **nothing** (0 cues in 25 s) |

- No errors were logged in either pass.
- Playback stayed in `playing` throughout.
- The *Do Not Disturb* panel shows exactly the 25 tracks AVPlay lists, and every listed track was selectable during discovery.

## 9. Memory

Free memory during the verification pass was **232–271 MB** (heartbeat every 5 s), ending at 251 MB, with no downward trend.

## 10. Release build restored

- `src/dev/device-selftest.ts` restored (SHA-1 verified); `npm run check` and `npm run build:all` were rerun afterwards.
- The **release build was installed** ("Tizen application is successfully installed") and **launched** ("successfully launched").
- After that launch the dev log sink received no new lines. The release build has no dev logging, so the temporary build is no longer running. `sdb` cannot report the running state directly.
- The lab server is stopped. The lab files live in the session scratchpad and are not part of the repository.

## 11. Remaining limitations

- **8 *Do Not Disturb* subtitles cannot be offered:** Swedish, Thai, Turkish (×2, one forced), Ukrainian, Vietnamese and Chinese (×2).
  - AVPlay does not list them, so they cannot be selected.
  - They could only be reached by reading the subtitle data from the file ourselves. That would be a new subtitle path and is outside this stage.
- **The 32-track limit is proven on this TV and firmware only.**
  - Any other behaviour breaks the window equality, and labels then fall back to "Unknown language N". No wrong language is shown.
- **Image subtitles (VobSub, also PGS and DVB) are listed but nothing was drawn.**
  - AVPlay hands over cue *text*, and an image subtitle has none. *Zohan*'s VobSub track gave 0 cues in 25 s at 10:00.
  - This is one sample at one position, so "never renders" is not proven.
  - The rows stay as before, labelled "Image". Hiding or marking them as unsupported changes the list and **needs your decision**.
- **Coverage of the *Do Not Disturb* checks:**
  - In the panel, 4 of the 25 tracks were chosen and drawn (Arabic, Greek, Korean, Spanish 2).
  - Discovery checked positions 1–20 by cue script, except 11 (Hebrew), which delivered no cue in its window. Positions 21–25 are cut off in the log line.
  - Latin-script languages without distinctive letters (English, Dutch, German, Indonesian, Italian, Malay) are matched by position only, a position proven by the lab files.
- **Track names come from the file as written:** for example "German Forced Subs [SRT]" on an ASS track in *Zohan*.
- **SDH comes only from the MKV flag.** MP4 files have no equivalent flag in the probe, so an SDH MP4 track shows only its name.

## 12. Repository state

**Nothing was committed, pushed, published or released.**

All earlier uncommitted work is preserved. `git status` shows 91 entries:
- the 89 from the end of D5;
- `tests/unit/stage7f-e-subtitles.test.mjs`;
- this report.

The new fixture and the new evidence file are inside folders that git already lists as untracked.

Not touched:
- the 123movies project;
- EPG;
- SubDL, OpenSubtitles and SubSource; no external subtitles were downloaded;
- thumbnails;
- unrelated playback features.
