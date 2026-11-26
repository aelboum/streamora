# Stage 7F — Audit: preview overlay, subtitles, control bar, title/time, audio tracks

Date: 2026-11-25. Step 1 (investigation only): **no code was changed and no build was installed.** The release build stays on the TV.

**Evidence tags**
- **[CODE]** read in the source;
- **[TV-M]** measured on the TV earlier (Stage 7E runs 1–3, `docs/evidence/stage7e-playback/`);
- **[PC]** measured on the PC;
- **[ASSUMPTION]** not verified.

**Read for this audit**
- `docs/STAGE-7E-PLAYBACK-IMPROVEMENTS-REPORT.md` §1–§11;
- the evidence files `tv-experiments.jsonl`, `tv-run2-e4-e6.jsonl`, `tv-run3-preview-subtitles.jsonl`;
- the files named below;
- in the separate `Documents\123movies` project, read only: `src/api/movies/subdl.ts`, `resolver.ts`, `scripts/relay.mjs` (SubDL routes), `scripts/lib/subdl.mjs`, `bench-subdl.json`, `bench-ost.json`, `bench-subsource.json`, `docs/TEST-REPORT.md`.
  - Nothing there was modified.
  - The key file `subdl.key` was **not** opened.

---

## 1. Live TV mini preview: logo over the video

**Root cause [CODE], confirmed.** In `src/screens/live-preview.ts` → `setLogo()`, the logo is shown with an **inline style**: `logo.style.visibility = 'visible'`.
- The rule that should hide it while live is a CSS class rule: `.ss-preview.is-live .ss-preview__logo { visibility: hidden }` in `src/styles/live.css`.
- An inline style always beats a class rule, so the logo is never hidden.
- `setLogo()` runs on every `renderInfo()`: focus moves, guide updates, Back from the player. So the logo stays drawn over the picture for the whole time the preview plays.
- The logo is a separate `<img>` inside the slot `<div>`. It is not a poster, a background image or part of the video plane.
- The "Loading preview…" / "Preview not available" note is hidden by the same rule and works, because it is not given an inline visibility.

**Other states [CODE]:**
- **Loading:** logo + note. Correct.
- **Failure:** logo + "Preview not available". Correct.
- **Locked adult channel:** logo only, controller released. Correct.
- **Channel change:** `select()` stops the old stream at once and the state goes to `tuning`, so the slot is opaque with the new logo. No old picture stays under a new logo.

**Fix (small).**
- Drive the logo only by classes: `is-live` hides it, and a new `no-logo` class covers a channel without a logo.
- Remove the inline `visibility` writes.
- Unchanged: one decoder, the 0.7 s settle (+0.12 s), the controller, the memory protections.

**Tests to add:**
- picture → logo hidden;
- error → logo + message shown;
- re-render while live (focus move, guide update) → logo stays hidden;
- new channel while live → new logo, not live;
- locked channel → logo only.

## 2. Subtitles across the movie library

### 2.1 Embedded subtitles: why most movies have none

- **[TV-M, run 1, E2] The files themselves contain no subtitle tracks.** For the 10 sampled provider movies, the container probe read each file's own track table (MP4 `moov/trak`, MKV `Tracks`). The track table is the authority on what the file holds.
  - **8 of 10** have **zero** subtitle tracks in the file. This is not a detection failure: AVPlay listed zero subtitle tracks for them as well.
  - 1 MKV has Turkish + English (SRT).
  - 1 MP4 (*NF - An Irish Story: This Is My Home*) has 18 (tx3g).
- **[TV-M] AVPlay lists every embedded track** in file order. Lab MP4 4 + 4 and lab MKV 3 + 5 tracks were all listed, and the 18 provider tracks were all listed. The app shows all of them with names (run 3, E7: 18 named rows in the real panel).
- **When tracks become known [CODE]:**
  - AVPlay's list comes after prepare.
  - The file probe runs **after the first picture** and took 0.04–1.1 s on 9 of 12 files and 5.4 s on the 18-track file.
  - Until `tracksFinal()`, the panel shows AVPlay's tracks without names, so a panel opened in the first seconds can show unnamed rows. This is the only case where the app can show fewer names than the file has.
- **Merge rule [CODE]** (`src/player/track-info.ts`). File names are attached only when the file and AVPlay list the **same number** of tracks of that kind.
  - If AVPlay ever drops a track it cannot handle (for example an image subtitle), the names fall back to "Subtitles n".
  - **[ASSUMPTION]** No such file was seen yet. The 60-movie sample (§6) would show whether it happens.
- **Fallback label [CODE]:** unknown tracks currently read "Audio n" / "Subtitles n" (`vod.audioN` / `vod.subN`). You asked for "Unknown language" instead; this is decision D2.
- **Xtream metadata [CODE + ASSUMPTION].**
  - `parseVodInfo` (`src/api/xtream/xtream-types.ts`) keeps name, plot, genre, director, cast, year, rating, duration, poster, backdrop and extension. It drops every other field.
  - Many Xtream panels also send `info.tmdb_id`, and some send `info.subtitles`, `info.audio`, `info.video` and `info.bitrate` (ffprobe data).
  - **Not verified for your provider:** the credentials are only on the TV, so the PC cannot query the panel. The §6 sample would record which key names the panel sends (names and presence only, never values with credentials).
- **Image subtitles:** listed and labelled "Image" (PGS / VobSub), but they are not drawn: AVPlay hands the app text cues only. Not tested; no provider file with them seen yet.

**Conclusion:** most movies have no subtitles because **the provider's files contain none** (8 of 10 sampled). The app is not losing embedded tracks. A library-wide figure needs the sample in §6. Library-wide subtitles are only possible with an **external source**.

### 2.2 External sources

**123movies SubDL implementation (audited, read only):**
- **Architecture:** TV → **LAN relay on the PC** (`scripts/relay.mjs`, `/subdl/search` and `/subdl/file/:id`) → `api.subdl.com/api/v2`.
- The relay holds the key (environment variable or git-ignored `subdl.key`), searches **by title only** (`film_name`, plus season/episode), and asks for 20 languages.
  - It unzips the download with Node `zlib`, and caches searches and files.
- The TV module `subdl.ts` only maps the relay's rows. It does not dedupe by URL and never rejects.
- Copying it as-is would bring a PC relay (a backend) into EliteStream, which goes against the approved "no backend" decision.

**Coverage measured in 123movies [PC]**
- Sample: 23 mainstream titles from 123movies' catalogue, **not this provider's library**.
- **[ASSUMPTION]** this provider's library has many foreign and regional titles, so coverage there is likely lower.

| Source | Titles with ≥ 1 subtitle | English | Dutch | French | Turkish | Arabic | Access |
|---|---|---|---|---|---|---|---|
| SubDL | **18 / 23** | 17 | 4 | 8 | 4 | 13 | free account + API key; search by title, IMDb or TMDB id |
| OpenSubtitles (REST) | 10 / 23 | 8 | 4 | 7 | 3 | 3 | API key + user login; free accounts have a small **daily download limit** (VIP is paid) [ASSUMPTION: exact limit to confirm] |
| SubSource | 9 / 23 | — | — | — | — | — | no official public API (scraping); fragile |

**Other options**
- Podnapisi, Addic7ed (series) and YIFY subtitles: no stable public API, or scraping only. Not recommended.
- Community subtitle sites host user uploads. Licensing is a grey area; personal use is the usual basis.
- **[ASSUMPTION]** SubDL's terms and rate limits are to be confirmed on subdl.com before you decide.

**Movie identification [CODE]**
- The app has title, year, extension and category.
- It does **not** keep a TMDB or IMDb id.
- Provider titles carry tags such as `NF - `, so matching by title alone is error-prone.
- **Safest matching:** use the provider's `tmdb_id` where present, and send it to SubDL as `tmdb_id`.
  - Fall back to the cleaned title + year only when the year is known.
  - Accept only results whose year matches.
  - Otherwise offer **no** external subtitles; never guess.

**Tizen compatibility [CODE]**
- `src/content/gzip.ts` already has a raw-inflate implementation (used for gzip XMLTV). A ZIP's deflated entry can be unpacked on the TV without a relay or a new dependency.
- SRT/VTT parsing is small.
- The app already draws subtitles itself (`ss-subs`), so external cues would be timed against `engine.timing()`.
- **[ASSUMPTION]** timing accuracy for app-drawn external cues: 123movies measured 23–84 ms against expected times (cited in the Stage 7E task text); not yet measured in EliteStream.

**Recommended architecture (needs your approval — D4)**
- An **opt-in** "Online subtitles (SubDL)" setting, with **your own free SubDL key** entered on the TV and stored in the TV key manager like the playlist credentials. No relay, and no key in the app package.
- When a movie has no embedded subtitles, or on request, search by `tmdb_id`, else title + year. Download the chosen file only, unzip it on the TV, and cache the results per session.
- External rows appear after the embedded ones, labelled e.g. `Dutch · SubDL · <release name>`.
- Time and cost: you said "no SubDL" earlier today; this is only a proposal. Free at the account level; a few hours to build; adds network requests to subdl.com only when used.

## 3. Control bar never hides

**Root cause [CODE], confirmed** (`src/screens/vod-player-screen.ts`):
- The player screen calls `ctl.tick()` every second. `tick()` writes the new `positionMs`, which emits a state change.
- `render()` then calls `armHide()` whenever the phase is `playing`. `armHide()` clears and restarts the **5 s** hide timer (`BAR_MS = 5000`).
- So the timer is restarted every 1 s and never reaches 5 s: **the bar stays up for the whole movie.**
- There is no competing second timer. The single timer is reset by position updates instead of by user input.
- Also, any non-playing phase (buffering, paused, loading) calls `showBar(false)`. The bar comes up on every short buffering event and then also never hides.

**Fix:**
- Arm the hide timer only on **user input** (any key that `showBar(true)` handles), on the transition **into** `playing` (start, resume, end of buffering), and after the panel or seek cursor closes. Never on position ticks.
- `BAR_MS` 5000 → **3000**.
- **Paused:** bar stays (no timer). Resume restarts the timer.
- **Panel open or seek cursor active:** no hiding; the timer restarts when they close.
- Buffering after the picture shows only the small status text, not the whole bar.
- One timer variable, cleared in `destroy` (already the case). Back is unchanged: it closes the panel or cursor first, then leaves.

**Tests to add (fake timers):**
- the bar hides 3 s after the last key while ticks keep arriving;
- every key resets the timer;
- held ◀▶ keeps the bar up;
- pause keeps it, resume hides after 3 s;
- panel open keeps it;
- leaving clears the timer.

## 4. Title and time at the top

**Current state [CODE]**
- **Top band** (`ss-vbar__top`, 260 px dark band): the **title** on the left and the **time of day** (`HH:MM`, `renderClock()`) on the right.
  - The clock is **not** the playback position; this is probably what looked wrong.
- **Bottom:** elapsed position on the left and **remaining** time (`−1:23:45`) on the right; the progress bar is above them.
- Total duration is not shown directly.
- **Title source:**
  - movies: the movie name;
  - episodes: `<series> · Episode <n>: <title>` (`vod-details-screen.ts` → `playEpisode()`). The season number is missing from the title (it is stored in progress as `S1 E3`).
  - Continue watching: `title · sub`.
- Both bands are inside the bar, so they will hide with it once §3 is fixed. Nothing stays on screen except subtitles and status messages.
- No overlap [CODE]: subtitles move up when the bar is visible (`ss-subs--raised`). Not visually checked.

**Recommendation (D1):**
- Title, time and controls appear and disappear **together** (as Netflix does): one timer, no separate one.
- **Top:** title. Episodes as `<series> · S1 E3 · <episode title>`.
- **Bottom:** `elapsed / total` on the left and `−remaining` on the right.
- Replace the time-of-day clock with nothing, or keep it small? → **your choice.**

## 5. Audio tracks

**Findings [TV-M]**
- **Provider sample (10 movies, run 1, E2):**
  - **9 have one audio track**;
  - 1 has Turkish + Portuguese;
  - all 11 provider audio tracks were AAC (2.0 or 5.1, 127–384 kb/s where stated).
  - "English + French" was **not** seen in this sample. It may be a series or another movie: please name one if you know it.
- **AVPlay lists every audio track** (lab: 4/4 and 3/3). Selection by API switched every track (`1->1 … 4->4`). **Nobody has listened** to a switch yet.
- **Language:** AVPlay cuts codes to 2 letters (`tu`, `po`). The file probe restores them (`tur`, `por`). Names are shown in the UI language.
- **Codec, channels, bitrate:** from the file probe. AVPlay gives no bitrate for most AAC tracks.
- **Duplicates:** "English (1)", "English (2)" plus channels, codec and bitrate.
- **Quality:** no transcoding exists anywhere. AVPlay plays the provider's stream directly, so quality is the file's own.
- **Selection memory [CODE]:** `services/track-prefs.ts` keeps the chosen audio and subtitle language, and applies it to later titles that have it. Within a title the choice stays until you leave.
- **Not filtered [CODE]:** `mapAvTracks` keeps every AVPlay audio track. No list is capped.

**Unknown: which codecs this TV decodes [ASSUMPTION].**
- Expected to play: AAC, AC-3, E-AC-3, MP3.
- Not known: DTS (2017 Samsung support unclear), TrueHD, Opus, FLAC and PCM in MKV.
- This needs a lab file with one track per codec (built with ffmpeg, as for the Stage 7E fixtures), with AVPlay's listing and selection result recorded. Unsupported codecs would then be marked "Not supported on this TV" instead of being offered.

**Improvements proposed:**
1. Codec support test and labelling (D3 sample run).
2. "Unknown language" fallback (D2).
3. A hint when audio is switched: the label of the new track for 2 s.
- **Audible verification needs you:** the TV cannot report what it outputs.

## 6. Decisions for you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Playback chrome | One 3 s timer for title + controls; episode title with season; bottom `elapsed / total` and `−remaining`; time-of-day clock: drop or keep? |
| D2 | Label for a track without language | "Unknown language" (numbered when several: "Unknown language (2)") instead of "Subtitles n" / "Audio n" |
| D3 | **TV sample run** (dev build installed temporarily, release reinstalled afterwards) | Probe 60 movies, metadata only: a few Range requests each, no full downloads. Record the Xtream `get_vod_info` key names (presence of `tmdb_id`, `subtitles`, `audio`); run a lab codec file (AAC / AC-3 / E-AC-3 / DTS / MP3 / Opus / TrueHD); then test the preview fix and bar timer with injected keys |
| D4 | External subtitles | SubDL directly from the TV with your own free key (opt-in, `tmdb_id` match first, no relay), or no external subtitles. OpenSubtitles is not recommended (download limit); SubSource is not recommended (no API) |

**Without further approval I would do only:** the §1 preview fix, the §3 bar fix and the §4 layout per D1, with tests. Each is small and local.

**Approval needed for:**
- D3: installing a dev build on the TV;
- D4: any external subtitle code.

## 7. Risks and compatibility

- All proposed code is ES5 (compat check). No new dependency (`gzip.ts` already exists). No second decoder.
- **Bar fix:** the hide timer must not hide the bar while the seek cursor is active. This is covered by the tests above.
- **SubDL:** coverage on this provider is unknown (only a 123movies sample was measured). It adds an outside service and depends on its availability and terms. It needs a key on the TV.
- **Visual and audio** checks can only be done by you. Scripted keys only show the DOM state.
