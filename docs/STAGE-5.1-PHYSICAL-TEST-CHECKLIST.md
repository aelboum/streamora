# Stage 5.1 — physical TV test checklist (Samsung UE50MU6100, Tizen 3.0)

These tests need **you**, the physical remote and your eyes. Every automated TV run so far used
injected key events; none of it replaces this checklist.

Fill in the **Actual** and **Result** columns. Use exactly one of:

- **PASS**: the expected result happened.
- **FAIL**: something else happened; write what you saw.
- **NOT TESTED**: you skipped it or could not do it. Never mark a skipped test PASS.

Tester: ____________  Date: ____________

## 0. Setup

1. Install the test build from the PC:
   ```
   cd C:\Users\imran\Documents\screenshelf
   npm run build:dev
   npm run tv:install
   ```
   This is the development build **without** the PC log sink. It behaves like the release build
   and keeps its log in memory, where **Diagnostics** shows it.
2. Have one playlist ready. Use a **real provider** if you can, because only that counts as
   real-provider validation. Otherwise use the PC test streams:
   - start `node scripts/dev-sink.mjs --port 8097` on the PC;
   - add the M3U playlist `http://192.168.1.180:8097/fixture/live.m3u`.

   These are synthetic PC streams with 4 channels: 1 and 2 work, 3 is a dead channel (HTTP 404),
   4 refuses the connection.
3. For section C, a username and password that you are willing to type on the TV. Made-up values
   are fine for the form tests.

| # | Setup step | Actual | Result |
|---|---|---|---|
| 0.1 | App starts from the TV's app list and shows **Playlists** | | |
| 0.2 | Playlist source used: real provider / PC test streams (circle one) | | — |

## A. Remote navigation (Live TV)

| # | Step | Expected | Actual | Result |
|---|---|---|---|---|
| A1 | On **Playlists**, select **Live TV** and press OK | Live TV opens with categories, channels and channel details. One item is clearly highlighted. | | |
| A2 | In the channel list press **Down** 10 times, then **Up** 10 times | The highlight moves one row per press with no skipped or stuck rows. The details follow the highlighted channel (name, current programme or "No guide information"). | | |
| A3 | Hold **Down** for 3 seconds, then release | The list scrolls, the highlight stays visible and nothing freezes. Scrolling stops on release. | | |
| A4 | Press **Left** | The highlight moves to the categories column. | | |
| A5 | In categories press **Down** / **Up** | The channel list changes to the highlighted category and starts at its first channel. | | |
| A6 | Press **Right** (or OK on a category) | The highlight returns to the channel list. | | |
| A7 | Check the screen after each step above | Exactly **one** highlighted item is visible at all times, never none and never two. | | |
| A8 | On a channel press **OK** | The player opens and the channel starts (see section B). | | |
| A9 | In the player press **CH+**, then **CH−** | Next channel, then back. The banner shows the channel name and number. | | |
| A10 | In the player press **Back** | Back to Live TV, with the highlight on the channel just watched. No video remains behind the list. | | |
| A11 | In Live TV press **Back**, then **Back** again | First Back moves to the categories column; the second returns to **Playlists**. | | |
| A12 | In the Live TV channel list press **CH+** / **CH−** | The list pages up / down by about one screen. | | |
| A13 | In the player press **CH+** 5 times as fast as possible | Only the channel you land on opens, shortly after the last press. The banner follows each press, there is no flicker between several streams and no error. | | |
| A14 | In Live TV press **Down**/**Up**/**Left**/**Right** rapidly for 5 seconds, then stop | The app keeps responding, the highlight stays visible and nothing opens by itself. | | |
| A15 | In the player press **Back** 5 times quickly | You end on Playlists or the exit dialog, never a blank screen. | | |

## B. Playback

| # | Step | Expected | Actual | Result |
|---|---|---|---|---|
| B1 | Start a working channel (OK in the list) | "Loading…", then the picture with sound within about 5 s. Write down the seconds. | | |
| B2 | Watch for 2 minutes | No stalls and no "Connection lost. Reconnecting…" message. Sound in sync. | | |
| B3 | **CH+** to the next channel | The old picture stops and the new one starts within about 5 s. Write down the seconds. | | |
| B4 | **CH−** back | The previous channel starts again. | | |
| B5 | (PC test streams) **CH+** to channel 3, the dead one | After about 11 s: "The channel can't be reached." and "Press OK to try again or Back for the channel list." | | |
| B6 | **CH+** to channel 4, the refused one | Same message after about 11 s. | | |
| B7 | **CH+** to channel 1, a working one | The picture starts within about 5 s. Repeat B5 to B7 three times and write how often it started. | __ of 3 | |
| B8 | While a channel still shows "Loading…", press **CH+** then **CH−** | The channel you end on starts, with no error from the channel you left. | | |
| B9 | Press **Back** to Live TV | Video and sound stop completely and the list is fully visible. | | |
| B10 | Open the player again on any channel | It starts normally, so the previous stream was released. | | |
| B11 | While a channel plays press **Play/Pause** (if your remote has it) | The picture freezes with "Paused"; pressing it again continues. | | |
| B12 | While a channel plays press **Home**, wait 10 s, then return to ScreenShelf | No sound while away. On return, the same channel restarts at the live point within about 5 s. | | |
| B13 | Press **Home**, play a video in another app (for example YouTube), then return to ScreenShelf | ScreenShelf's channel restarts and the other app's video is gone. | | |
| B14 | Exit the app (Back on Playlists, then confirm) and start it again | It starts normally, with no video left from before. | | |

## C. Native Samsung keyboard (playlist forms)

| # | Step | Expected | Actual | Result |
|---|---|---|---|---|
| C1 | **Playlists**, then **Add M3U playlist**, then OK on **Playlist address (URL)** | A dialog with a text field opens and the **Samsung on-screen keyboard** appears by itself. | | |
| C2 | Type a URL with the Samsung keyboard (for example `http://example.com/list.m3u`) | The characters appear in the field as you type, with nothing typed twice. | | |
| C3 | Press the keyboard's **Done** key | The keyboard and dialog close; the form shows exactly the typed URL. | | |
| C4 | Open the URL field again | The field starts with the URL you typed, not empty and not doubled. | | |
| C5 | Press **Back** while the Samsung keyboard is open | The keyboard closes; the dialog stays, showing Done, On-screen keyboard and Cancel. | | |
| C6 | Press **Back** again | The dialog closes and the field keeps its **previous** value; the new typing is discarded. | | |
| C7 | **Add Xtream account**, **Username**: type a name, Done | The username shows in the form. | | |
| C8 | **Password**: type a password | The field shows **dots**, not the characters. Note whether the Samsung keyboard shows each character briefly. | | |
| C9 | Done | The form does not show the password in plain text. | | |
| C10 | Open the password field again | It does **not** show the old password in plain text. | | |
| C11 | In a field choose **On-screen keyboard** (press Back first if the Samsung keyboard is open) | The app's own keyboard opens with the text typed so far; its Done sets the field. | | |
| C12 | Open and close a field 5 times with Back, then 5 times with Done | No leftover text, and no field shows text from another field. | | |
| C13 | Save a test playlist with a made-up password, then open **Diagnostics** (on Playlists) and read the log | The password never appears. Credentials in addresses show as `[redacted]` or are absent. | | |
| C14 | Cancel the Add form without saving | Nothing is added to Playlists. | | |

## D. Gzip guide (optional: needs a provider with a `.gz` XMLTV guide)

| # | Step | Expected | Actual | Result |
|---|---|---|---|---|
| D1 | Edit a playlist, set **EPG address (optional)** to a `.gz` XMLTV guide, then open Live TV | "Updating the guide…", then current programmes on matching channels. The list stays responsive meanwhile. | | |
| D2 | Set the EPG address to a damaged or incomplete `.gz` file | "Guide update failed: compressed guide is damaged or incomplete". The previous guide stays. | | |

## Summary

| Area | PASS | FAIL | NOT TESTED |
|---|---|---|---|
| A. Remote navigation (15) | | | |
| B. Playback (14) | | | |
| C. Samsung keyboard (14) | | | |
| D. Gzip guide (2) | | | |

Please send back this file, or the summary plus the number and notes of every FAIL.
