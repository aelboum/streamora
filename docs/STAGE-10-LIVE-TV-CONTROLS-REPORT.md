# Stage 10 — Live TV controls: report

Date: 2026-11-25. Scope: the Search memory-safety audit (with minimal corrections) and three Live TV controls: channel-number entry, previous channel, and the channel list over the playing video.

**Evidence tags**
- **[SIM]** unit tests;
- **[TV-S]** scripted on the TV with injected keys;
- **[TV-P]** physical remote, operated by you, as you reported it.

Evidence: `docs/evidence/stage10/tv-stage10.jsonl` (485 lines: key discovery, the scripted check, your physical session). It contains key codes, timings and memory only: no URLs or credentials (checked by search).

## 1. Initial repository and backup verification

- Branch `main`, HEAD `5739de1` (unchanged), 99 `git status` entries, nothing staged. This matches `docs/STAGE-9-PERFORMANCE-REPORT.md` §13.
- Stage 0 backup `C:\Users\imran\Documents\screenshelf-backups\screenshelf-20261125-183600.*`: `sha256sum -c` **OK** for the archive and the git bundle.
- Read before starting:
  - `docs/STAGE-0-BACKUP-REPORT.md` and `docs/STAGE-9-PERFORMANCE-REPORT.md`;
  - the Stage 9 search and cache code and its tests;
  - the key map (`src/navigation/keys.ts`) and the player (`src/screens/player-screen.ts`);
  - the remote findings in `docs/PROBE-REPORT.md` and the probe result `probe/results/latest-keys.json`. The TV's `getSupportedKeys` lists `PreviousChannel=10190` and `ChannelList=10073`.

## 2. Stage 9 Search memory-safety audit

| Question | Finding |
|---|---|
| How results are loaded | Channels: `PlaylistService.loadLive` (through the live cache), then an in-memory search. Movies/series: `VodService.load` (views cached by the service), then a name-page scan, one page at a time per list |
| Can all three load at once? | **Yes**, and they did before Stage 9 too. The Stage 9 TV run measured the lowest free memory (**135 MB**) exactly then, below the 150 MB floor. **Risk: medium** |
| Intermediate results / references released? | Yes. Per query: rows and closures only. Per screen: the channel index and its name table (released with the screen). The movie/series views belong to `VodService` (shared, bounded: 8 pages + 400 items) |
| Obsolete callbacks, timers, data after repeated searches? | No timers in Search. Old scans are cancelled and stop after their current page; old progress and results are ignored (generation check). **One leftover:** a replaced query's final result still read its title pages (`ensure`). Wasted reads, no wrong output. **Risk: low** |
| Overlapping work on rapid queries? | Limited to the one name page already being read per list, plus the leftover above |
| Leaving Search | `destroy` cancels the scans; loads still in flight finish into a dead screen and are then garbage |
| 150 MB threshold respected? | The live cache honours it (not kept / released below 150 MB). **Search itself did not**: it started all three loads regardless of free memory |
| Live cache × Search | Safe. Search uses the same checksum-validated cache and shares an in-flight load with Live TV. It never modifies the cached objects |

## 3. Minimal corrections made to Search

1. **Below 150 MB free, the stored lists load one after another** (channels, then movies, then series), each starting when the previous one has ended. Above the floor they load in parallel, as before. The floor is the existing `LIVE_CACHE_MIN_FREE_MB`, unchanged.
2. **A replaced query reads no title pages for its final result.**

No redesign and no index. Results, ordering and messages are unchanged. Files: `src/screens/search-screen.ts` (optional `memoryMB` / `minFreeMB` dependencies) and `src/app/bootstrap.ts` (wiring).

## 4. Number entry and remote key mapping

**Key discovery on the TV [TV-P]**, using a temporary key logger while you pressed keys:

| Key | Code delivered to the app |
|---|---|
| Digits via the remote's **123** on-screen pad | **48–57** (0, 1, 2 pressed: 48, 49, 50) |
| Blue | **406** |
| Arrows / OK / Back / CH+ / CH− | 37–40 / 13 / 10009 / 427 / 428 |
| **PRE-CH, CH LIST** | **not delivered.** You confirmed your remote has neither; the TV lists the codes as supported, but nothing arrives |
| (also seen) | 229 and 65376, unmapped, ignored (probably the 123 pad / input method) |

**Implementation** (`src/screens/live-controls.ts`, `player-screen.ts`):
- Digits in the live player build a channel number of at most 6 digits, shown top right as "12_".
- It is tuned **2 s after the last digit** (config `player.numberEntryMs`, 500–10,000 ms), **at once on OK**, or at the 6th digit.
- **Back** cancels without changing the channel.
- **Leading zeros are ignored** ("007" = 7). "0" alone, or an unknown number, shows "No channel N" for 2 s and changes nothing.
- The number is looked up in the list being watched first. If it is not there, it is looked up in all channels, and the player then continues in All channels.
- **Duplicate numbers:** the first one in list order wins.
- **Accidental changes:** any non-digit key except OK drops a half-typed number before acting.

## 5. Previous channel and key mapping

- **Key (your decision): Blue**, verified on your remote. `PreviousChannel` (10190) is mapped as well, in case a remote sends it.
- History records only channels whose **picture started** (the controller's `onPlaying`). A failed tune is never remembered, and a retry or reconnect of the same channel never becomes its own previous.
- Repeated presses alternate between the last two channels.
- Number entry, the channel list, CH±/▲▼ zapping and Live TV selection all go through the same playing event, so all are handled the same way.
- History is in memory only, shared by player screens so that it survives going back to the list. It is **per account**: another account starts empty and never sees the first one's channels.
- No previous channel yet: "No previous channel yet" for 2 s.

## 6. Channel-list overlay

- **Key (your decision): OK** opens the list over the playing video.
  - On an error, OK still retries.
  - ←/→/Info still show the banner. The banner is no longer toggled by OK.
  - `ChannelList` (10073) also opens it, should a remote send it.
- The video keeps playing: opening calls nothing on the controller or the engine. The page stays transparent over the video, and the list is a left-hand HTML panel.
- It shows the list being watched, in its own order (category, favourites, recent, search results or all), with number and name. The playing channel is marked ▶.
- ▲▼ move, CH± page by 9, OK tunes the focused channel and closes. Back closes and keeps the channel. Digits and Blue work while it is open (tune, then close).
- While the list is open, no key zaps behind it.
- **Performance:**
  - 9 pooled rows from the existing virtual list, created once per player screen, so 21,986 channels cost 9 rows.
  - Opening rebinds the visible rows only. There is no copy of the playlist and no catalogue reload: it uses the index the player already has.
  - The number lookup builds one number table for the list on the first lookup, released with the screen.

## 7. Performance and memory measurements

| Measurement | Result |
|---|---|
| Open the list over the video [TV-S] | key handled in **2 ms**; player state `playing` before and after; **0 new stream opens** |
| 300 moves at 100 ms (21,986 channels) [TV-S] | longest main-thread stall **73 ms**; 0 opens; 0 errors |
| 30 open/close cycles [TV-S] | free memory **218 → 214 MB** (samples 216, 215, 214, 214, 215, 214): no growth; still 9 rows; 0 opens |
| Typed number [TV-S] | the number appeared, the right channel was tuned, and the banner matched |
| Previous channel (Blue) [TV-S] | back to the first channel |
| Lowest free memory, scripted part | **178 MB** (the run would have stopped below 155 MB; it did not) |
| Your physical session [TV-P] | 130 key presses in the player over 6 min 19 s; free memory **185–244 MB**, ending at 219 MB; 0 errors |
| List with 22,000 channels [SIM] | opens < 200 ms, 300 pages < 1.5 s, a number lookup over 22,000 channels < 1 s (Node, fake DOM) |

## 8. Automated test results

`npm run check`:
- typecheck OK;
- **331/331 unit tests** pass, 14 of them new, in `tests/unit/stage10-live-controls.test.mjs`;
- **5/5 build tests** pass.

ES5: `compat-check: 118 files, 0 finding(s)`.

`npm run build:all`:
- `release-check: OK (no development logging code or origins)`;
- no Stage 10 test code or LAN address in the release bundle;
- APK rebuilt (not run on a device).

New tests:
- **Keys:** 123-pad digits, Blue, PreviousChannel, ChannelList.
- **Number parsing:** leading zeros, 0, too long, non-digits.
- **Entry:** the timeout and its restart on each digit; OK; Back; 6 digits; invalid digits; destroy clears the timer.
- **History:** only started channels; alternation; the same channel is never its own previous; per account.
- **Lookup:** duplicates, absent numbers, a list change.
- **Player:**
  - a typed number tunes after the timeout or on OK, an unknown number shows "No channel 999", and Back cancels without leaving;
  - a number for the channel already playing does not restart it;
  - Blue alternates, a failed channel is not remembered, and PreviousChannel works;
  - the list opens without a load or stop, moves and pages without zapping, selects, and Back closes;
  - 25 open/close cycles add no DOM nodes;
  - digits and Blue work inside the list.
- **Key conflicts:** OK retries on an error; → shows the banner.
- **22,000-channel performance**, as above.
- **Cleanup:** a half-typed number never tunes after the player is left.
- **Account switch:** no previous channel from the other account.
- **Search audit:** the sequential loads below 150 MB (parallel above); no page reads for a replaced query; destroy cancels the scans.

## 9. Physical remote tests (separate from the scripted tests)

**Done by you with the physical remote [TV-P]; your report: "all worked, video kept playing behind the list".** The key log confirms 130 presses in the player: OK 12, ▲ 24, ▼ 3, CH+ 12, CH− 44, ← 3, → 4, Back 4, Blue 2, digits 1/2/3/4/6, and Play/Pause 6.

| # | Check | Result |
|---|---|---|
| 1 | Number entry with the physical remote (123 pad) | **Worked** (your report; digits 49–54 logged) |
| 2 | Previous channel with Blue | **Worked** (Blue ×2 logged) |
| 3 | List appears over live video | **Worked** |
| 4 | Video keeps playing behind it | **Worked**, as you saw |
| 5 | Selecting a channel | **Worked** |
| 6 | Back closes the list | **Worked** |
| 7 | Fast navigation responsive | **Worked** (CH− 44, ▲ 24 logged) |
| 8 | Repeated open/close without memory growth | **Worked** (scripted 30 cycles: flat; physical session 185–244 MB) |
| 9 | Favourites and categories unchanged | **Worked** (your report) |
| 10 | No crashes, freezes or playback interruptions | None reported. 0 errors logged. See §10 for 4 channels the provider could not deliver |

Your remote sent **Play/Pause (10252)** six times. Earlier notes said it had no media keys. The key works in the player as before (pause/resume).

## 10. Limitations and unresolved issues

- **PRE-CH and CH LIST are not available on your remote.** Previous channel is therefore on Blue and the list on OK (your decisions). Both dedicated codes remain mapped for other remotes, but are not verified on this TV.
- **Four channel starts failed during your session** (`live: channel failed`, 3× "connection", 1× "unknown", 3 different channels). The provider could not deliver those streams. The app showed its error and stayed responsive. Not caused by Stage 10: the list does not start streams. Not investigated further (outside scope).
- **The guide download was stopped once by the existing memory guard** (149 MB free < 200 MB): the known Stage 7E behaviour, unchanged (EPG paused).
- **OK no longer hides the banner.** The banner hides itself after 5 s as before, and ←/→/Info show it.
- The list shows the list the player was opened from. A channel tuned by number outside that list switches the player to All channels, and the list then shows all channels.
- History is kept for the session only (not stored).

## 11. Normal release build restored

- `src/dev/device-selftest.ts` restored byte-identical (SHA-1 `07584df…`); `npm run check` and `npm run build:all` were rerun afterwards.
- The release build was **installed** ("Tizen application is successfully installed") and **launched** ("successfully launched").
- It has the same application id as the test build (`SShelfDev1.ScreenShelf`), so it **replaced** the test build.
- The dev log sink received no lines from a running test build afterwards: the last three lines are the test build's final heartbeat and key batch, sent before it was replaced, and the count stayed the same afterwards.
- Dev-only Stage 10 code (`src/dev/device-selftest-stage10.ts`: key logger and scripted check) stays in the tree, unreferenced, like earlier stages.

## 12. Git status

**Nothing was committed, pushed, published or released.** HEAD is still `5739de1`, and nothing is staged.

`git status`: **106 entries**. New against the Stage 0 backup:
- modified: `src/app/config.ts`, `src/screens/player-screen.ts`, `src/services/playlist-service.ts` (Stage 9);
- untracked:
  - `docs/STAGE-0-BACKUP-REPORT.md`, `docs/STAGE-9-PERFORMANCE-REPORT.md`, this report;
  - `docs/evidence/stage9-performance/`, `docs/evidence/stage10/`;
  - `src/app/input-quiet.ts`;
  - `src/dev/device-selftest-stage9.ts`, `src/dev/device-selftest-stage10.ts`;
  - `src/screens/live-controls.ts`;
  - `tests/unit/stage9-performance.test.mjs`, `tests/unit/stage10-live-controls.test.mjs`.

Files changed in Stage 10 that were already listed as changed: `src/navigation/keys.ts`, `src/screens/search-screen.ts`, `src/screens/live-screens.ts`, `src/app/bootstrap.ts`, `src/i18n/strings.ts`, `src/styles/live.css`.

All earlier uncommitted work is preserved.
