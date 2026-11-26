# Stage 7F-D5 — Audio track metadata matching: report

Date: 2026-11-25. Scope: D5 only (approved after your physical Stage 7F checks passed).

**Evidence tags**
- **[SIM]** unit tests;
- **[TV-M]** measured on the TV with scripted keys; nobody watched or listened.

Evidence: `docs/evidence/stage7e-playback/tv-run5-d5.jsonl`, 64 lines. It contains no URLs or credentials (checked by search).

## 1. Root cause and previous behaviour

- **Discovery.** AVPlay lists the tracks that can be selected (`avplay-engine.ts` → `mapAvTracks`). The file probe (`media-probe.ts`, byte ranges) reads what the file states. `vod-controller.ts` merges the two with `mergeProbe` (`track-info.ts`) once the probe answers.
- **Selection.** Selection uses AVPlay's own track ids (`engine.selectTrack(kind, id)`).
- **Display.** `track-sheet.ts` → `trackLabels` turns the merged tracks into rows: language name, channels, codec, bitrate, name.
- **Previous rule (Stage 7E):** file data was attached only when the file and AVPlay list **the same number** of audio tracks, in order, with agreeing languages. That left two gaps, both seen on the TV.

**Gap 1: hidden tracks.**
- AVPlay **hides tracks it cannot decode** (TrueHD; Stage 7F run 4).
- With 7 tracks in the file and 6 in AVPlay, the counts differ, so nothing was attached.
- The panel showed AVPlay's own values: `ES · Stereo`, `Italian` with no format, `English · Stereo` without AAC.

**Gap 2: two-letter codes in the file.**
- Some MKVs state languages as two-letter codes (`pl`, `pt`, `tr`), while AVPlay cuts three-letter codes to two (`pol` → `po`, `tur` → `tu`).
- The old check only compared AVPlay's two letters with the start of a **three-letter** file code. `po` vs `pl` failed, so the whole list kept AVPlay's values.
- Seen on *NF - Do Not Disturb (2023)*: `PO (1) · Stereo`, `PO (2) · Stereo`, `ES · Stereo`, `TU · Stereo` (TV run 5, first pass).

## 2. Files changed

| File | Change |
|---|---|
| `src/player/track-info.ts` | New `alignHidden()` (unique in-order placement) and `strictPair()`. `mergeProbe` uses them for **audio only** when AVPlay lists fewer tracks than the file. `sameLanguage` also accepts the two-letter file code case (via `cutMatches`) |
| `src/i18n/languages.ts` | New `cutMatches(two, fileCode)`: is `two` the file language's ISO 639-1 code, or the start of its ISO 639-2 T/B code |
| `tests/unit/stage7f-d5-align.test.mjs` | **New**, 8 tests |
| `src/dev/device-selftest-stage7f.ts` | Dev-only (not referenced): E13 added for the TV check |

Unchanged:
- `src/dev/device-selftest.ts`: changed for the run, restored byte-identical (SHA-1 `07584df…`);
- the player, selection, the probe's byte-range behaviour and subtitle matching.

## 3. Matching algorithm and safeguards

**Equal counts.** The Stage 7E rule is unchanged: order plus language agreement. The only addition is that `pl` ↔ `po`, `pt` ↔ `po` and `tr` ↔ `tu` now count as agreeing.

**AVPlay lists fewer audio tracks than the file** (new, `alignHidden`):

1. A player track and a file track are a **strict pair** only when all of these hold:
   - both languages are missing, or both are stated and agree (including AVPlay's two-letter cut);
   - a codec stated on **both** sides is the same;
   - a channel count stated on **both** sides is the same.
   - A language missing on only **one** side never pairs.
2. Every way of placing the player's tracks **in their order** onto the file's tracks with strict pairs is counted. The count is capped at 2 (dynamic programming, at most n × m steps; n, m ≤ a few dozen).
3. File data is attached **only if there is exactly one placement**. With zero or several placements, nothing is attached and AVPlay's own values and labels stay.
4. Only labels change: language, codec, channels, sample rate, bitrate and name from the file.
   - Track **ids, order, selected flags and the list itself** stay AVPlay's.
   - File tracks AVPlay hides are **never added**.
   - Track indexes are never assumed to be equal.
5. AVPlay lists **more** tracks than the file: nothing is attached.
6. Subtitles: unchanged. They still use only the equal-count rule; D5 is about audio.

## 4. Ambiguous and duplicate tracks

| Case | Result |
|---|---|
| Two file tracks with the same language, and the player's track could be either (no codec stated) | 2 placements → **rejected**, player label kept |
| Same language, player states the codec (e.g. E-AC-3) | unique → matched |
| Same language **and** same codec twice | rejected |
| Same codec, different languages | language decides → matched |
| Different order (player FR, EN; file EN, FR) | no in-order placement → rejected |
| Codec or channel conflict | rejected |
| Missing language on one side only | rejected |
| Neither side states a language, codec tells them apart | matched; reads "Unknown language · 5.1 · Dolby Digital" |
| Neither side states a language and nothing differs | rejected |
| `po` with Polish and Portuguese both present and one hidden | rejected |

## 5. New unit tests (`tests/unit/stage7f-d5-align.test.mjs`)

The numbers refer to your list.

1. **(1 + 8)** Lab case: 7 file tracks, TrueHD hidden.
   - All 6 matched; labels "English · Stereo · AAC" … "Italian · Stereo · Opus".
   - TrueHD is not offered.
   - A hidden track in the middle is skipped.
2. **(2 + 5)** Duplicate French (E-AC-3 + AAC), one hidden, no player codec → rejected, with the original labels shown. A stated codec makes it unique.
3. **(6)** Duplicate codecs: language decides; the same language and codec twice is rejected.
4. **(3 + 4)** Missing file language, missing player language, both missing (codec decides or nothing differs), and a player track with no codec or channels.
5. **(7)** Different order, codec conflict, channel conflict: all rejected.
6. **(9)** More player than file tracks; the equal-count rule is unchanged; subtitles are not aligned; inputs are not modified.
7. **(10)** Through the real `VodController`: after the probe, ids, order and selected flags are identical, and `selectTrack('audio', 4)` asks the engine for id 4.
8. ***Do Not Disturb* case:** `pl` / `pt` / `tr` vs `po` / `po` / `tu` are matched in order. `po` with one of Polish/Portuguese hidden is rejected. `po` never matches Russian.

## 6. Test results

- `npm run check`: typecheck OK; **ES5 compat: 0 findings in 114 files**; **292/292 unit tests** (8 new) and **5/5 build tests** pass.
- `npm run build:all`:
  - release `app.js` 317,623 B;
  - `release-check: OK (no development logging code or origins)`;
  - no self-test or lab address in the release bundle;
  - APK rebuilt: `dist/android/EliteStream-0.2.0-debug.apk` (not run on a device).

## 7. Samsung TV results [TV-M]

The temporary dev build was installed and run twice. The first pass found the two-letter case; the second ran after that fix.

**Lab file** `codecs.mkv` (file: 7 audio tracks; AVPlay: 6, TrueHD hidden):

| Before (AVPlay only) | After D5 |
|---|---|
| English · Stereo | English · Stereo · AAC |
| FR · 5.1 · Dolby Digital · 448 kb/s | French · 5.1 · Dolby Digital · 448 kb/s |
| DU · 5.1 · Dolby Digital Plus · 448 kb/s | Dutch · 5.1 · Dolby Digital Plus · 448 kb/s |
| German · 5.1 · DTS · 1411 kb/s | German · 5.1 · DTS · 1411 kb/s |
| ES · Stereo · 128 kb/s | Spanish · Stereo · MP3 · 128 kb/s |
| Italian | Italian · Stereo · Opus |

Each of the 6 tracks was selected: AVPlay reported it as selected and playback kept advancing (+2.0–2.2 s). No errors. TrueHD was not offered.

**Provider movies:** the real VOD player, the Audio & subtitles panel opened with keys, and the rows read from the screen (UI language Dutch).

| Movie | Audio rows | Switch in the panel | Notes |
|---|---|---|---|
| *DE - Leg dich nicht mit Zohan an* | Duits · 5.1 · Dolby Digital · 640 kb/s · "German TrueHD 5.1 @ 1561 kbps"; Engels · … · "English TrueHD 5.1 @ 1578 kbps" | track 1 → 2, playing | equal counts, already matched before D5 |
| *RU - The Green Mile* | Russisch · Stereo · Dolby Digital · 384 kb/s · Dub; Oekraïens · … · 192 kb/s · MVO (ICTV, NLO); Engels · … · 192 kb/s | 3 → 2, playing | unchanged by D5 |
| *NF - Do Not Disturb (2023)* | **Engels, Duits, Pools, Portugees (Brazilian Portuguese), Spaans, Turks**, each "Stereo · AAC · 128 kb/s" | 1 → 2, playing | **before D5: `Engels · Stereo`, `Duits · Stereo`, `PO (1)`, `PO (2)`, `ES`, `TU`** |
| *FR - Les Malvenus* (two French tracks) | Frans · Stereo · Dolby Digital Plus · 384 kb/s · Beste kwaliteit; Frans · Stereo · AAC · 194 kb/s · AD | 1 → 2, playing | duplicate language, equal counts: told apart by codec, bitrate and name |

No errors were logged in any run, and playback kept advancing after every switch (+3.4–3.5 s).

**Not verified:** whether the audio actually changed audibly (nobody listened in this run; you confirmed switching by ear in Stage 7F), and the look of the panel.

## 8. Memory

Free memory during the second run: **202–250 MB** (heartbeat every 5 s), with no downward trend. It ended at 250 MB.

## 9. Release build restored

- After the run, `src/dev/device-selftest.ts` was restored and checks and `build:all` were rerun.
- The **release build was installed** ("Tizen application is successfully installed") and **launched** ("successfully launched").
- After the release launch the dev log sink received no new lines. That is expected, because the release build contains no dev logging, and it shows the temporary build is no longer running.
- `sdb` on this TV cannot report the running state directly (`is_runapp` → "closed"), so "running" rests on the launch result.
- The lab server used for the test is stopped.

## 10. Remaining limitations

- **Subtitles are outside D5:**
  - *NF - Do Not Disturb* has 33 subtitle tracks in the file, but AVPlay lists 25. With different counts the subtitle rows keep AVPlay's values: "Onbekende taal 1 … 25".
  - The same in-order alignment could be applied to subtitles, but D5 did not authorise it. **This needs your decision.**
- **Track names come from the file as written:**
  - *Zohan*'s AC-3 tracks are named "German TrueHD 5.1 @ 1561 kbps" by whoever made the file.
  - The app's own codec label is correct (Dolby Digital). The misleading name is the file's and is shown as stated.
- **Audibility of DTS, Opus and MP3** on this TV is not verified by listening.
- **3 of 60 sampled files** cannot be probed (Stage 7F). Their tracks keep AVPlay's values.

## 11. Repository state

**Nothing was committed, pushed, published or released.**

All earlier uncommitted work is preserved: `git status` shows 89 entries. They are the 87 from the end of Stage 7F plus `tests/unit/stage7f-d5-align.test.mjs` and this report; `src/player/track-info.ts` and `src/i18n/languages.ts` were already untracked Stage 7E files.

Not touched:
- the 123movies project;
- EPG;
- external subtitle services;
- thumbnails.

Stage 7F-E (subtitles): see `docs/STAGE-7F-E-REPORT.md`.
