# S3 — Last channel at app start-up: report

Date: 2026-11-26. Scope: stage S3 of `docs/SETTINGS-IMPROVEMENTS-AUDIT.md` only (Feature 2B), with your decision that CH± navigates within the restored channel's category.

- S4 and S5 were not started.
- There is no automatic start of the app when the TV turns on.
- Nothing was installed, committed or pushed.

## 1. Behaviour

**Setting.** Settings → Playback → **"Play last channel on app startup"** ("Laatste zender afspelen bij het starten").
- **Off by default**; OK toggles it.
- Stored in KV `startup.resume-last-channel`, so it persists across restarts and is independent of every other option.
- Offered only where Live TV can play (an engine and the Live TV screens exist).

**Which channel.** The last channel that **actually showed a picture**: `recent.<playlistId>[0]`.
- This is the existing per-playlist "Recently watched" list, written by the player's `onPlaying` at the first picture.
- No new channel storage was needed.

**At start-up** (`src/services/resume-live.ts`; one attempt per app session):
1. If the option is off, nothing happens and the default start-up is unchanged (Home).
2. **Wait for start-up storage validation** (DI-1 `whenChecked()`). **Never while the playlists are protected**; this is checked again just before opening.
3. These conditions must all hold, or the attempt stops quietly on Home:
   - an active playlist with its login;
   - a player;
   - free memory **above the floor** (`memory.low()`, checked again after the channel list loads);
   - no import running;
   - a remembered channel;
   - the user still on Home with no dialog open (DI-1 recovery, sign-in, exit).
4. The channel list is loaded through the normal `loadLive`.
   - If the channel no longer exists, the attempt stops.
   - **An adult channel is never auto-played while parental control is locked,** and no PIN is asked at start-up.
5. **Restart-loop guard:** KV `startup.resume-guard` `{at}` records each attempt. There is no new attempt within **90 s** of the previous one; a crash during playback restarts the app quickly.
   - If the clock went back a little, the guard still applies.
   - If it went back a lot, the old mark is ignored.
6. **"Resuming <channel>…" / "Press any key to cancel."** appears for **3 s** (the existing toast look).
   - **Any remote key, Back included, cancels.** Nothing opens, and there is no second attempt in that session.
7. Then Live TV opens **through the normal path** with `resume: { channelId }`:
   - it shows the channel's **own category** and opens the channel with the same `play()` as an OK press, so **CH+ and CH− stay within that category**;
   - if the category is hidden or locked, it falls back to "All channels".

**Failure handling.**
- **Missing channel:** Live TV stays on its normal list with the note "The last channel could not be opened."
- **Playback failure:** the normal player error, "The channel can't be reached. Press OK to try again". There is no automatic re-attempt; Back returns to Live TV.
- A failed channel is not recorded as the last channel, because no picture appeared.

**One small shared fix** in `live-tv-screen.ts`: a note shown with `flashNote` now stays for its 4 s. Before, the guide status replaced it at once, which would have hidden the resume note, and other notes too. All existing Live TV tests still pass.

## 2. Files changed

| File | Change |
|---|---|
| `src/services/resume-live.ts` | **New:** the start-up decision (conditions, loop guard, cancellable delay); writes only its two keys |
| `src/screens/resume-toast.ts` | **New:** "Resuming …" overlay; every key cancels |
| `src/screens/live-tv-screen.ts` | `LiveTvParams.resume`; `resumeTo()` (own category, `play()`); the note-persistence fix |
| `src/screens/settings-screen.ts` | `resumeLast` toggle row (Playback group) |
| `src/app/bootstrap.ts` | Creates the service (only with an engine and Live TV); registers `resume-toast`; Settings toggle; one `resume.run()` after the root screen opens |
| `src/i18n/strings.ts` | 4 keys each in English and Dutch |
| `tests/unit/s3-last-channel.test.mjs` | **New:** 16 tests |

**Not changed:**
- playlist data, DI-1 storage, backup, quarantine and recovery;
- the default start-up;
- the platform adapters (Android, LG and Titan are unchanged);
- `config.xml`;
- no new dependencies.

## 3. Tests (16 new, all pass)

**Unit tests of the start-up decision** (stubbed playlists, manual timers):
1. Off by default: no message, no Live TV, no catalogue load. The setting persists into a new session.
2. Success: waits for storage validation, shows "Resuming News Two…" (the last pictured channel), opens nothing during the 3 s, then opens Live TV for that channel. The attempt is recorded, and a second `run()` in the session does nothing.
3. **Cancellation:** a key during the message cancels, the timer is cleared, a late timer does nothing, and there is no second attempt.
4. **Protected storage:** no catalogue load, no message, no playback.
5. **Parental:** a locked adult channel is not auto-played and no message appears. Unlocked (or no PIN), it is allowed.
6. **Memory:** below the floor there is no attempt; memory dropping while the list loads also stops it.
7. **Missing or invalid conditions:**
   - no remembered channel;
   - channel gone;
   - list not loadable;
   - no active playlist;
   - no login;
   - an import running;
   - no player.

   Each stops with nothing opened.
8. **Busy user:** another screen or an open dialog blocks the attempt, and so does moving away during the message.
9. **Restart-loop guard:**
   - a restart 20 s, or just under 90 s, after an attempt: no attempt;
   - the clock went back a little: still guarded;
   - just over 90 s: works;
   - the clock went back a lot: works.
10. **Writes** only its two keys, never the playlist list.
11. **The overlay:** OK, CH+ and Back all cancel.

**Through the real Live TV and player screens** (M3U fixture, fake engine):

12. Resuming "Sport Max 1" opens the player in "UK | Sports". **CH+ twice wraps back within that category**, and Back shows the restored category.
13. **Missing channel:** stays on Live TV with the note; no playback.
14. **Adult and locked:** not opened, and **no PIN dialog**.
15. **Playback failure:** the normal player error, no automatic re-attempt, the channel not recorded, and Back returns to Live TV.

**Real start-up:**

16. The default start-up is Home with no message. Settings offers the toggle, off by default; OK switches it on; a new app session shows it still on.

## 4. Automated checks

| Check | Result |
|---|---|
| Typecheck | OK |
| Compat (ES5 and platform isolation) | 134 files, 0 findings |
| Unit tests | **438 / 438** (422 + 16) |
| Build tests | 6 / 6 |
| Samsung release build | OK |
| `release-check` | OK |
| Android build | OK (local only) |

**Build** (CP1 + DI-1 + DI-1.1 + S1 + S2 + S3), SHA-256:
- `app.js` (387,389 B): `91802e8cf03b101d44a86e4a47c85735e1b5e22fb7eb9d70701194afcd1401e8`
- `app.css`: `382e0155…` (unchanged; the toast reuses existing styles)
- `config.xml`: `08b9151c…` (identical to production)
- `icon.png`: `35fb3813…`
- `index.html`: `629cf34f…`

**Not installed;** the physical check is in S5.

## 5. Limitations and notes

- **The loop guard is time-based (90 s).** A restart more than 90 s after a crash will try once more, and then the guard applies again for that attempt. Repeated crashes would cause at most one attempt per 90 s, and only if the option is on.
- **Memory on unmeasured platforms:** where the platform cannot measure free memory, `memory.low()` is always false, so only the normal loading limits apply.
- **Channel list loaded twice:** the service loads the channel list to validate the channel, and Live TV then loads it again, served from the Stage 9 live cache when it fits.
- **The toast's look on the TV** (bottom-right, existing style) is checked in S5.

## 6. Next

Waiting for your review of S3 before S4 (Samsung "Autorun Last App" help text).
