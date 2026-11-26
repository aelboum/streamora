# Stage 7E — Playback and Live TV improvements: report

Date: 2026-11-25. Target: Samsung UE50MU6100 (Tizen 3.0), Android APK kept in step.
Evidence tags: **[TV-M]** machine-measured on the TV (no one looked at the screen), **[SIM]** simulated keys / unit tests, **[CODE]** from reading the code, **[NT]** not tested.
No physical remote and no visual or audio check were performed for anything in this report.

Stage 7E EPG work (download reliability, matching) stays on hold. The only guide change is a memory guard that the Live TV crash fix needs (§5).

## 1. Starting point

- Branch `main`, commit `5739de1`. The working tree had **73** uncommitted entries (the task text said 96; the measured number is 73). The list is in `docs/evidence/stage7e-playback/git-status-before.txt`.
- All of them are preserved. Nothing was reset, stashed, reverted, committed or pushed.
- `src/dev/device-selftest.ts` was changed for the TV run and restored byte-identical afterwards (checked with SHA-1).

## 2. Results

| Feature | Implemented | Automated tests | TV tested | Physical verification | Status |
|---|---|---|---|---|---|
| Timeline previews | Seek cursor with OK = jump, Back = cancel, playback untouched; **no preview pictures** | yes [SIM] | Preview-frame feasibility only [TV-M] | none | **PARTIAL** — pictures BLOCKED on this TV |
| Audio quality and tracks | Real languages, codec, channels and bitrate from the file; deterministic "best quality"; automatic choice within the language | yes [SIM] | Track discovery [TV-M]; switching via engine [TV-M]; new UI not run on the TV | none; nothing listened to | **PARTIAL** (code complete, TV UI run and listening pending) |
| Subtitle discovery and labels | All embedded tracks with real language names, forced flag, names, numbered duplicates | yes [SIM] | Discovery [TV-M] (18 tracks on one provider movie) | none | **PARTIAL** (external subtitles BLOCKED, needs approval) |
| Live TV crash | Root cause found; memory guard + no automatic re-download | yes [SIM] (guard) | Cause [TV-M]; guard fired and app stayed alive; 400-key Live TV fuzz with 0 errors [TV-M] (run 2, §10) | none (no physical remote) | **FIXED on TV by injected keys**; physical-remote check pending; guide updates now blocked by the guard (§10) |
| Live TV miniature preview | Option (a): the single AVPlay in the 556×313 slot, debounced, released on OK/leave (§11) | yes [SIM] (5 tests) | E8 [TV-M]: plays, rapid moves open 1 stream, handover OK, 30 tunes stable (§11) | none (not seen on screen) | **IMPLEMENTED**, visual check pending |

## 3. Feature A — Timeline previews

**Investigation [CODE].**
- The provider (Xtream) gives no thumbnails, storyboards or thumbnail tracks.
- VOD is plain MP4/MKV over HTTP, not HLS/DASH, so there are no I-frame playlists.
- The app has no backend (approved decision), so there is no server to extract frames.
- No JavaScript video decoder exists in the project. Adding one would be a new dependency, and the High-profile H.264 the provider uses is beyond the small JS decoders.

**TV experiment E3 [TV-M]** (`tv-experiments.jsonl`, `7e E3 preview`). While AVPlay played, a hidden HTML5 `<video>` seeked and was drawn to a canvas:
- **Lab file** (colour-coded 10 s segments, CORS allowed): seeks answered in 128–227 ms, but every frame drawn was **black** (0,0,0).
- **Provider MP4:** seeks answered in 431–463 ms; frames were black again.
- **Effect on the movie:** AVPlay **stopped advancing** as soon as the second video loaded (position frozen at 3,683 ms and 4,379 ms). It was still frozen 4 s after the `<video>` was removed.
- After this run the app stopped logging entirely.

**Conclusion:** this TV cannot decode a second video for previews without breaking the movie. Real timestamp previews need pre-made thumbnails, either from the provider (not available) or from a server (not approved: "no backend").

**Implemented: the safe part.**
- ◀ ▶ and Rewind/FF on the progress bar now move a **seek cursor**: a white marker plus a bubble with the target time and the distance (e.g. `1:11 (+0:10)`) and "OK to jump · Back to cancel".
- The movie keeps playing and nothing is seeked until **OK**. **Back** cancels.
- Holding the key still accelerates (10 → 30 → 60 s steps). One seek is sent on OK, which also avoids AVPlay's dropped overlapping seeks.
- The −10/+10 buttons still jump at once. No cursor appears on a title that cannot seek.
- **No poster or fake picture is shown in place of a preview.**

**Proposed architecture for real previews (needs approval):** an optional user-run thumbnail service (for example on a PC or NAS). It would extract one small JPEG every 10 s per title with ffmpeg and serve a sprite plus an index. The app would request sprites only while the cursor is shown (debounced, bounded LRU cache). This adds a backend, so it is not built.

## 4. Features B and C — Audio and subtitle tracks

**Investigation [TV-M]** (`7e E1`, `7e E2`):
- **AVPlay lists every track.** A lab MP4 with 4 audio + 4 subtitle tracks and a lab MKV with 3 + 5 were all listed, in file order. Audio switching worked for every track (`1->1 2->2 3->3 4->4`).
- **AVPlay cuts audio languages to two letters:** `eng→en`, `fre→fr`, `dut→du`, `tur→tu`, `und→un`. So "tu"/"po" in Stage 7B.2 were Turkish/Portuguese.
- **AVPlay never reports subtitle languages:** `track_lang` is always empty. That is why the app showed "Track 1, Track 2 …".
- **Provider sample, 10 movies:** 8 have one audio track, one has Turkish + Portuguese, and one MP4 has **18 embedded subtitle tracks**: English, Croatian, Czech, Danish, Dutch, Finnish, French, German, Greek, Hungarian, Italian, Norwegian Bokmål, Polish, Portuguese, Romanian, Russian, Spanish, Swedish.
- So the "missing" subtitle languages were present all along, only unlabelled.
- AVPlay reports some bitrates (AC-3/E-AC-3) but `0` for most provider AAC.

**Root cause.** Language metadata is lost inside AVPlay: audio languages are truncated and subtitle languages are dropped. No track was hidden by the app or by the provider.

**Fix: container header probe** (`src/player/media-probe.ts`).
- After the first picture, the app reads the file's own track table with a few HTTP byte-range requests.
- **What it reads:**
  - MP4: `moov/trak` headers (mdhd language, hdlr, elng, stsd with esds/dac3/dec3/btrt, udta name); `mdat` is skipped by its size.
  - MKV: EBML header, SeekHead, Tracks, and the "BPS" tags when present.
- Sample tables and media data are never read.
- **Limits:**
  - at most 24 × 64 KB per title;
  - TV-measured: 1–8 requests and 43–1,086 ms for 9 of 12 files; 21 requests and 5.4 s for the 18-subtitle movie.
- **Network rule:** only a `Range` header is sent, never credentials. Redirects are followed like AVPlay follows them. The URL is never logged.
  - This is a new network behaviour beside the HTTP client's security rules (SECURITY-DECISIONS S5): the client never adds headers. **Please approve or reject it.**
- **Checked against ffprobe:** the probe matches on all three synthetic fixtures (languages, codecs, channels, bitrates, forced flag, names).
- **On the TV** it gave correct results on all lab and provider files, including real languages for "un"/"tu"/"po".

**Merge rule** (`src/player/track-info.ts`).
- Probe data is attached to a kind of track (audio or subtitles) only when the file lists **exactly as many** tracks of that kind as AVPlay.
- For audio, every AVPlay language must also agree with the file (`en` ~ `eng`). Otherwise AVPlay's values stay.
- Without probe data, AVPlay's two-letter value is named only when it cannot be a truncation of another language: "sw" (Swahili or cut "swe") stays "SW", and "tu" stays "TU". No language is invented.

**Best-quality rule (deterministic).**
- Within one language, a track is "best" only if it is **at least as good on bitrate, channels and sample rate, and better on one**, compared with every other track of that language.
- Any unknown figure means undecided: nothing is labelled and nothing is switched. More channels alone, or the codec alone, never decides.
- **Automatic choice, once per title, after the track table is known:**
  - the language is the one picked before (if the title has it), else the language the stream starts with;
  - within it, the best track is chosen;
  - quality never changes the language (French stays French).
- A manual pick before that cancels the automatic choice.

**Labels** (Audio & subtitles panel).
- Language names are shown in the UI language (English / Dutch). The table covers 85 ISO 639 languages with 639-1 and 639-2 T/B codes.
- Audio rows show channels (Mono / Stereo / 5.1 / 7.1), codec (AAC, Dolby Digital, Dolby Digital Plus, DTS…), bitrate and "Best quality" where determinable.
- Subtitle rows show "Forced", "Image" (PGS/VobSub) and the file's track name.
- Rows that would read the same get a number: "English (1)", "English (2)". Unknown tracks read "Audio n" / "Subtitles n".
- Subtitle preference now picks a full track before a forced one of the same language.

**External subtitles: BLOCKED.**
- The repository has no subtitle provider, client or resolver (confirmed again; the Stage 7D report says the same).
- Subtitle search was deferred by an approved decision, and sources such as OpenSubtitles need an account and an API key.
- This needs your approval of a source before anything is built. All tracks shown today are embedded.

**Sync [CODE].** Rendering and timing code is unchanged (Stage 7D measured 5–11 ms). Choosing a track does not restart playback.

## 5. Feature D — Live TV crash

**Reproduction.**
- **Simulated [SIM]:** 6 random-key runs of 250 keys and one scripted run on the 10-channel fixture found no error. The crash is not in the focus logic.
- **TV [TV-M], real playlist (21,986 channels):** the app went silent each time shortly after Live TV opened. A 3 s heartbeat showed free memory falling 419 → 344 → 281 → 147 → 174 → 121 MB within about 15 s while the guide was "refreshing". Then the app stopped responding (no heartbeat).
- Afterwards, `sdb` install/kill commands to the TV hung, although the TV still answered ping.

**Root cause [CODE + TV-M].**
- Opening Live TV starts a guide download automatically when the stored guide is older than 12 h (`live-tv-screen.ts`, `isStale()`).
- The HTTP client streams with XHR `responseText`, which **keeps the whole response in memory while it grows**. The limit is 100 M characters, up to about 200 MB as JavaScript text.
- The provider's full guide (190,304 programmes, Stage 7D) exhausts the TV's memory. The app then freezes or is killed. Any key pressed then, such as moving off the channel list, meets a dead app, which looks like a crash on navigation.
- This also explains Stage 7D's "truncated stored guide": earlier downloads were cut off.

**Fix (smallest safe change, no EPG redesign).**
1. **Memory guard** (`epg-service.ts`, set up in `bootstrap.ts`). While a guide streams, free memory is checked at most every 300 ms. Below **200 MB** on Tizen, the download stops with the new code `low-memory` ("too large for this TV's memory"). The stored guide is kept and a warning is logged. Android: memory unknown, so no guard.
2. **No automatic re-download** (`live-tv-screen.ts`). A guide that failed as `low-memory` or `too-large` is not started again automatically on each visit; "Update guide" still tries on request.

The real cure for the guide size (streaming without keeping the whole text, or a smaller guide source) is Stage 7E EPG work, on hold.

**Not yet verified on the TV.** The experiment that measures the guard (E6) is ready but could not run because the TV stopped accepting `sdb` commands. Required TV checks:
- Live TV opens, the guide download stops near 200 MB free, and the app keeps responding;
- the channel list, categories, rail and Back work afterwards;
- repeated visits;
- **physical remote**.

## 6. Feature D — Live TV miniature preview: BLOCKED

- `webapis.avplay` is one player per app, so a second simultaneous live decoder is not available.
- The safe design is to use the **same** AVPlay in a 556×313 rectangle on the right while browsing. This is not a second stream. The page needs a transparent hole there; zapping debounced about 0.8 s; stopped when leaving Live TV; OK goes full screen.
- Experiment E4 (rectangle playback, rapid zapping) is written but never got to run: the guide memory problem froze the app first, then the TV wedged.
- It is **not built.** It would also keep a decoder and buffers busy while browsing, on the screen that just ran out of memory. Build it only after E4 and the memory fix pass on the TV.

## 7. Files changed (Stage 7E)

**New files**
- `src/player/media-probe.ts`
- `src/player/track-info.ts`
- `src/i18n/languages.ts`
- `tests/unit/stage7e-tracks.test.mjs`
- `tests/fixtures/media/lang-end.mp4`, `lang-fast.mp4`, `lang.mkv`: synthetic (colour + sine tone), about 180 KB each
- `docs/evidence/stage7e-playback/*`
- `src/dev/device-selftest-stage7e.ts`: dev-only, **not referenced**, kept for the pending TV run

**Modified files**
- `src/player/engine.ts`: optional `MediaTrack` fields
- `src/player/avplay-engine.ts`: `mapAvTracks`
- `src/player/vod-controller.ts`: `probe` option, `tracksFinal()`
- `src/screens/vod-screens.ts`, `src/app/bootstrap.ts`: wiring, guide memory guard
- `src/screens/vod-player-screen.ts`: seek cursor, automatic track choice
- `src/screens/track-sheet.ts`: labels
- `src/services/track-prefs.ts`: delegates to `languages.ts`, `preferredText`
- `src/screens/settings-screen.ts`: UI-language names
- `src/services/epg-service.ts`: guard, `low-memory`
- `src/screens/live-tv-screen.ts`
- `src/i18n/strings.ts`, `src/styles/vod.css`
- `tests/fakes/fake-engine.mjs`: a new source clears its tracks, as AVPlay does

**Tests updated for intended behaviour changes**
- Language names are now in the UI language ("Dutch" in English, "Nederlands" in Dutch).
- AVPlay tracks now carry channels/codec/bitrate.
- ◀▶ now moves a cursor confirmed with OK.

No test was removed or weakened.

## 8. Verification

- `npm run check`: typecheck OK, compat (ES5) **0 findings** in 112 files, **274/274 unit** + **5/5 build** tests pass.
- `npm run build:all`: release `app.js` 313,153 B. `release-check: OK (no development logging code or origins)`. No `selftest7e`/lab address in the release bundle. APK rebuilt at `dist/android/EliteStream-0.2.0-debug.apk`.
- No credentials, tokens or URLs in the evidence files (checked by search).
- Nothing committed, pushed, tagged or published.
- **The TV currently has the dev build installed. The release build must be reinstalled after a TV restart.**

## 9. Remaining limitations and next steps

1. **Restart the TV**, then reinstall the release build.
2. Run E6/E4 (guide memory guard, mini-window playback) on the TV.
3. Physical-remote check of Live TV: open, browse, leave, come back.
4. On the TV, open the 18-subtitle movie's panel and check the names visually. Switch audio on the Turkish/Portuguese movie and listen.
5. Approvals needed:
   - the probe's `Range` requests (§4);
   - an external subtitle source (§4);
   - a thumbnail service for real previews (§3).
6. Then build the Live TV mini preview, and do the EPG streaming fix in the held EPG stage.

## 10. Addendum — TV run 2 (2026-11-25, after the TV restart)

The TV answered `sdb` again. The dev build ran E6 → E5 → E4 from `src/dev/device-selftest-stage7e.ts` against the real playlist (21,986 channels). Evidence: `docs/evidence/stage7e-playback/tv-run2-e4-e6.jsonl` (no URLs or credentials; checked by search). All results are **[TV-M]**: injected keys, nobody watched the screen, nothing was listened to.

- `src/dev/device-selftest.ts` and `src/dev/device-selftest-stage7e.ts` were changed for the run and restored byte-identical afterwards (SHA-1 `07584df…` and `059963d…`). The release build was reinstalled on the TV.
- `npm run check`: typecheck OK, compat 0 findings in 112 files, 274/274 unit and 5/5 build tests. `npm run build:all`: release-check OK, APK rebuilt at `dist/android/EliteStream-0.2.0-debug.apk`.

**E6, guide memory guard.**
- Free memory at the start was 213 MB.
- The guard stopped the download after 319 ms at 180 MB free, with code `low-memory` and 0 characters received. The stored guide was kept.
- The app kept answering: the heartbeat continued and free memory went back to 194 MB 5 s later.
- **New limitation.** Free memory on this TV with this playlist is often already below the 200 MB floor (the heartbeat showed 167–376 MB). As a result **the guide cannot be updated on the TV at the moment**. The crash is gone, but guide updates are effectively off. The real fix is the streaming guide parser in the paused EPG stage.

**E5, Live TV focus/crash.**
- 400 random remote keys on Live TV: left/right between the categories, channel list and rail, up/down, OK (plays a channel), Back, Channel Down, and reopening Live TV after Back.
- **0 errors and 0 uncaught exceptions.** The app answered throughout and ended on `home>live-tv`.
- Free memory per 50 keys: 179, 296, 278, 271, 181, 346, 173, 178 MB. It swings, but does not keep falling.
- Earlier runs went silent within about 15 s of opening Live TV. Not checked: the physical remote, and whether the current channel is visibly kept.

**E4, mini live window (feasibility).**
- The single AVPlay was placed in a 556×313 rectangle while Live TV was shown. Five real channels each reached `playing`, in 178–1,290 ms.
- **Rapid zapping failed.** Five loads 300 ms apart, without waiting for each other, never reached `playing` within 15 s.
- So a preview must wait for the focus to settle (≥ 0.8 s) and must never start a new load while one is open.
- Whether a picture appeared in the rectangle was not seen by anyone.
- **This TV has no second decoder.** The "preview" can only be the main player moved into the window. While browsing it replaces the full-screen channel; it cannot run beside it.
- Not built. Options for your decision:
  - (a) the main player in the window, debounced 0.8 s and serialised, stopped when Live TV is left;
  - (b) the provider's channel logo only, labelled as a static image;
  - (c) no preview.
- Memory note for (a): it keeps the decoder busy on the screen that already runs near 170 MB free.

**External subtitles (correction to §4).**
- This repository still has no subtitle resolver.
- A SubDL client does exist in the **separate** curated-VOD project `Documents\123movies` (`api/movies/subdl.ts` and `resolver.ts`, plus a key file). That is a different app, which the earlier text did not mention.
- It could be ported if you approve SubDL as the source and the key handling. Nothing was copied, and the key file was not opened.

**Still outstanding (manual):**
1. Physical remote on Live TV: open it, move between the categories, channel list and rail 20+ times, play a channel, press Back, then reopen Live TV.
2. Visual check of the subtitle names on the 18-subtitle movie.
3. Listen to an audio switch on the Turkish/Portuguese movie.
4. Approvals:
   - the probe's `Range` requests;
   - the subtitle source (SubDL port?);
   - a thumbnail service;
   - mini-preview option (a), (b) or (c).

## 11. Addendum — your decisions and TV run 3 (2026-11-25)

**Decisions (from you):**
- Physical-remote check of Live TV: **done by you, OK**.
- Container probe `Range` requests: **approved** (no code change; it was already active).
- External subtitles from SubDL: **rejected**. Nothing was ported.
- Thumbnail service for timeline previews: **rejected**. The seek cursor stays as it is.
- Mini preview: **option (a)**, built as described below.

### 11.1 "I don't get 18 subtitles"

Only **one** movie in the 10-movie sample carries 18 subtitle tracks. Most provider movies have **no** subtitle tracks at all: 8 of 10 in the sample had none; one had Turkish + English, and this one had 18. The report did not name the movie, which made the check impossible. It is:

> **NF - An Irish Story: This Is My Home (2020)** (position 52,000 of "All" movies, category id 561)

**TV run 3, E7 [TV-M]:** the app opened this movie in the real VOD player. After the file probe it opened the real Audio & subtitles panel with remote keys (Info, ↓, →, →, OK) and read the rows from the screen's DOM. UI language: Dutch. The panel had **20 rows**:
- 1 audio: `Engels · 5.1 · AAC · 145 kb/s`
- `Uit` (off)
- **18 subtitles:** Engels, Kroatisch, Tsjechisch, Deens, Nederlands, Fins, Frans, Duits, Grieks, Hongaars, Italiaans, Noors (Bokmål) · Norwegian Bokmal, Pools, Portugees, Roemeens, Russisch, Spaans · European Spanish, Zweeds.

No errors were logged. Nobody looked at the screen. Please open this movie, wait about 10 s after the picture appears (the probe needs about 5 s on this file), then open the panel.

If another movie shows fewer subtitles than you expect, tell me its name. The panel can only list what the file contains: there is no external subtitle source (SubDL rejected).

### 11.2 Mini live preview (option a): implemented

**Files:**
- `src/screens/live-preview.ts` (new);
- `src/screens/live-tv-screen.ts`, `src/screens/live-screens.ts`, `src/app/bootstrap.ts` (wiring);
- `src/styles/live.css`;
- `src/i18n/strings.ts` (2 strings, EN + NL);
- `tests/unit/live-ui.test.mjs` (5 tests), `tests/fakes/fake-engine.mjs` (records `setRect`).

**How it works:**
- The TV has one AVPlay decoder. The preview **is** the app's only player, shown in the 556×313 slot at the top of the details column (measured on the TV: x=1268, y=156).
- Nothing plays full screen at the same time. This is not a second stream.
- **Tuning** uses a `LiveController`, the same one the full-screen player uses:
  - the stream opens only after the focus has rested 0.7 s (plus the existing 0.12 s info delay);
  - every change stops the old stream before the next load;
  - callbacks from older channels are ignored.
- **No reconnect loop while browsing.** A failed channel shows its logo and "Preview not available".
- **OK:** the preview stops, the video rectangle goes back to full screen, then the full-screen player opens the channel (and the PIN dialog where needed).
- **Back from the player:** the preview resumes.
- Any screen on top of Live TV (player, guide, another screen) stops the preview. Leaving Live TV releases the decoder and makes the page opaque again.
- **Not previewed:**
  - locked adult channels (logo only; the PIN is asked when the channel is opened);
  - during a guide download (rule R4).
- A preview is **not** added to "Recently watched".
- When the app is hidden (Home key), the preview stream is released and reopened when the app is visible again.
- **Display:**
  - AVPlay draws behind the page. While the preview is active the page background is transparent, and four background strips repaint the app background around the slot.
  - The slot has square corners while live, because the video plane is rectangular.
- Without an engine, and in the existing tests, the screen is unchanged: the logo stays in the details column.

**TV run 3, E8 [TV-M]** (real playlist, injected keys; evidence `tv-run3-preview-subtitles.jsonl`):

| Check | Result |
|---|---|
| Preview after opening Live TV | picture (`playing`) for the first channel; slot 1268,156 556×313; page transparent |
| 10 × ↓ at 150 ms | **1** load reached a picture (the channel the focus rested on), 0 failures |
| OK then Back | full-screen player on top and playing; back on Live TV, preview playing again |
| 30 channels, focus resting 2.5 s each | 11 reached a picture within the 2.5 s, 0 failures, 0 errors; free memory 278–309 MB (no decline) |
| Leave Live TV | engine `idle`, page opaque, top = home |

The 11 of 30 is not a failure. Most channels need more than about 1.7 s after the debounce to show a picture (Stage 5 measured 0.2–1.3 s, plus buffering). When you rest longer on a channel, its picture appears.

**Not verified:**
- **Nobody has seen the preview picture on the screen.** Whether the video appears exactly inside the slot, and whether the background strips line up, needs a visual check.
- Android: the APK has the same code; not run on a device.

### 11.3 Verification (run 3)

- `npm run check`: typecheck OK, compat **0 findings in 113 files**, **279/279 unit** (5 new) + **5/5 build** tests.
- `npm run build:all`:
  - release `app.js` 316,435 B;
  - `release-check: OK`;
  - no `selftest7e` or lab address in the release bundle;
  - APK rebuilt at `dist/android/EliteStream-0.2.0-debug.apk`.
- **Dev-only changes:**
  - `src/dev/device-selftest-stage7e.ts` gained E7/E8 (dev only, not referenced).
  - `src/dev/device-selftest.ts` was changed for the run and restored byte-identical (SHA-1 `07584df…`).
- The **release build is installed on the TV again**.
- `git status`: 84 entries (83 before plus `src/screens/live-preview.ts`). Nothing committed or pushed.

### 11.4 Manual checks for you

1. Open Live TV and rest on a channel for about 2 s. The picture should play inside the box at the top right, with no black or misplaced area around it. Move ↑↓ quickly: nothing should play until you stop. Press OK for full screen, then Back.
2. Open **An Irish Story: This Is My Home (2020)**, wait about 10 s, then open Audio & subtitles. You should see 18 subtitle languages.

## 12. Stage 7F

Investigation (no code changes): `docs/STAGE-7F-AUDIT.md`.
Report (implementation, TV run 4): `docs/STAGE-7F-REPORT.md`.
