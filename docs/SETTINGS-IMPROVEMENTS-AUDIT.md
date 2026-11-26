# Settings improvements: audit

Date: 2026-11-26. **Audit only.** Nothing was implemented, no TV was contacted, and nothing was committed. Scope:
- an About section;
- automatic start-up and last-channel restore;
- the Xtream subscription expiry date.

Platform statements are sourced (links in §9). Where no official source exists, the document says "unverified" and does not claim support.

---

## 1. Current implementation findings

### 1.1 Settings and About (Feature 1)

**Settings layout.** `src/screens/settings-screen.ts` builds one vertical list of rows in groups:

| Group | Rows |
|---|---|
| Accounts | One row; opens the playlists screen |
| Language | English, Nederlands |
| Playback | Audio and subtitle language |
| Parental controls | PIN rows |
| History | Clear Continue watching, clear searches |
| **About** | Four information rows from `SettingsDeps.about()` (`bootstrap.ts`); then **Diagnostics** (opens `diagnostics`) |

**The About rows are:**
- Version: `0.2.0`, plus the build mode when not `release`;
- Platform: for example `tizen 3.0`;
- Screen: `1920 × 1080`;
- Storage: file storage present or not.

**How focus treats them.** The information rows have `act: null`, so ▲▼ skips them by design. A test asserts this: `tests/unit/vod-ui.test.mjs:884` ("About rows are information only: ▼ skips them"). On the TV they are only seen when focus scrolls past them to Diagnostics, and Diagnostics is the last row.

**Translations.** `set.about`, `set.version`, `set.platform`, `set.screen`, `set.storage` and `set.diagnostics` exist in English and Dutch.

**Diagnostics** is a separate screen. Since DI-1.1 it shows playlist storage and storage events, and must stay read-only.

### 1.2 Start-up and last channel (Feature 2)

**Start-up.**
- `startApp()` (`bootstrap.ts`) always resets to `home`, or to `diagnostics` when there is no playlist service.
- There is no auto-play path, no start-up preference, and no code that runs at TV power-on on any platform.
- The Android wrapper's manifest has only `INTERNET` and `ACCESS_NETWORK_STATE`, with a single `LEANBACK_LAUNCHER` activity. There is no boot receiver and no overlay permission.

**The last channel is already stored persistently, per playlist.**
- `user-lists.ts`, `markWatched(pid, channelId)` puts the channel ID at the front of KV `recent.<playlistId>`.
- It is called from the player's `onPlaying` (`live-screens.ts`), meaning only when the **first picture appears**, not when a channel is merely tuned. So `recent(pid)[0]` is "the last channel that actually played" for that playlist.
- Remove and remove-all already delete `recent.<id>`.

**Previous channel** (Blue key, Stage 10) uses an in-memory `zapHistory`, which is lost on restart and not suitable for restoring.

**What opening the player needs** (`PlayerParams`):
- `{ playlistId, index: ChannelIndex, list: number[], pos }`, so the active playlist's live catalogue must be loaded first (`loadLive`).
- That is a large read (about 22k channels on the test TV) and is subject to the memory guards.

**Parental gating** (`withParental`, `isLocked`) is applied when a channel is opened from the list. Any automatic start must go through the same gate.

### 1.3 Xtream expiry (Feature 3)

**Already fetched and parsed.**
- `xtream-source.ts` calls `client.authenticate()` (`player_api.php` without an action), which returns `user_info` and `server_info`.
- `parseAccount()` (`api/xtream/xtream-types.ts`) reads the fields below. Through `toInt()` it accepts numbers and numeric strings, and rejects `""`, `null` and non-numeric values.

| Field | Parsed as | Notes |
|---|---|---|
| `exp_date` | `expiresAt = exp * 1000` if greater than 0, otherwise `null` | |
| `status` | String, at most 32 characters | |
| `is_trial` | `trial` | |
| `max_connections` | `maxConnections` | |
| `active_cons` | `activeConnections` | |
| `server_info.timestamp_now` | `serverTime` | |
| `server_info.timezone` | `timezone` | |

**How it is used:**
- The import fails as `expired` when `status` is "Expired" or `expiresAt` is earlier than the device clock (`xtream-source.ts`).
- The refresh result stores `expiresAt`, `maxConnections` and `trial` in `PlaylistDef.lastStatus` (`playlist-service.ts`).
- The playlist details screen shows "Subscription ends" with `formatDate(expiresAt)` when present.

**Gaps:**
1. **Unlimited and unknown look the same.** `exp_date: null`, `"0"`, `""` or a missing key all become `expiresAt: null`. The UI can't tell "No expiration" from "Unknown".
2. **The value is lost easily.**
   - It lives only in `lastStatus`, which each refresh **replaces**. A later refresh that fails before authenticating (network or timeout) drops the known expiry.
   - It is written through the playlist list, which DI-1 protects. Extending this would touch DI-1-guarded storage.
3. **The value is only refreshed by a live import** (manual "Update" or the first import). VOD browsing authenticates through `xtreamClient()`, but the result isn't stored.
4. **No sanity checks.** There is no plausibility range: a millisecond value would be multiplied again, and a 1970 date is accepted. The device clock is used directly, even though the TV clock may be wrong and `timestamp_now` is available.
5. **Placement.** It is shown on the details screen only, not in Settings. There is no remaining-days count and no "Expired" or "No expiration" text.

The expiry information is per playlist (`lastStatus` lives on each `PlaylistDef`). M3U playlists have no `user_info`.

---

## 2. Recommended implementation

### Feature 1: About behind a button

- **Replace** the About group's four information rows with **one row, "About ScreenShelf"**. OK opens a small **About screen** (or a large confirm-style overlay; a screen is recommended because Back already works there).
- **The About screen shows:**
  - version and build mode;
  - platform and version;
  - screen;
  - storage;
  - a licences line (fonts: OFL / Material Symbols licence, already shipped in `fonts/`).
- **Diagnostics:** keep the Diagnostics row in Settings for now, below About. Optionally, add a "Diagnostics" button on the About screen later.
- **Navigation:**
  - every Settings row is now focusable, so no information rows are skipped;
  - Back from About returns to Settings with focus on "About ScreenShelf";
  - About is read-only and changes no settings.
- **Translations:** reuse `set.about`, `set.version`, `set.platform`, `set.screen` and `set.storage`; add `set.aboutRow` and `about.title` (English and Dutch).
- **Existing test:** the `vod-ui` About assertion changes from "rows are skipped" to "the About row opens the About screen, which shows Version 0.2.0". This is an intended behaviour change, to be documented.

### Feature 2A: automatic start at TV power-on

Implement **no app-side auto-start mechanism** on any platform now. Reasons (details in §3):
- **Samsung Tizen:** there is no documented API or `config.xml` key for foreground auto-start of a consumer app.
  - The only documented launch-time key, `prelaunch.support`, loads the app in the **background** for preview, and Samsung says it is no longer supported since the 2019 models.
  - The TV has a **user** setting, "Autorun Last App" (Settings → General → Smart Features). It reopens whatever app was last in use, on some models. The app can't set it or read it.
- **LG webOS:** LG developer forum answers state there is no API to launch an app at power-on. The only known methods need a rooted TV, which is unsupported.
- **Android TV:**
  - Since Android 10 an app may not start an activity from the background, so a `BOOT_COMPLETED` receiver can't open the UI.
  - The documented exception is a **user-granted** `SYSTEM_ALERT_WINDOW` ("display over other apps"). Whether that permission can be granted on a given Android TV or Google TV device varies by device and is unverified.
  - Requesting it raises store-policy questions, and Android 15 narrows exemptions further.
  - Possible later as a sideload-only, opt-in feature after verification on a real device. Not now.
- **Titan OS:** no auto-start documentation was found. The documented `apps.launch` API is "protected", needs whitelisting, and only launches *another* app on demand. Treat it as unsupported, and add it to the open questions for Titan.

**What to show:** in Settings, under a new group "Start-up", a row "Start ScreenShelf with the TV":
- On Tizen it's **informational only** and opens a help text explaining that it's a TV setting ("Autorun Last App" under General → Smart Features, availability depends on the model).
- On every other platform it's **hidden**.
- No fake toggle anywhere.

### Feature 2B: play the last Live TV channel at start (independent option)

**Setting.** "Play last channel at start-up": Off (default) or On. Stored in the existing config or KV namespace, e.g. `config.ui.resumeLastChannel`. It's per device, not per playlist.

**Source of truth.** `lists.recent(activeId)[0]`: the last channel that actually showed a picture. It's already persisted, per playlist, and cleaned up when a playlist is removed. No new channel storage is needed.

**Safe start sequence** (new, small `resume-live.ts` service, called once from `startApp` after Home is shown):
1. Run only if the option is On **and** all of these hold:
   - this is a fresh app start, not a resume from background or a language switch (which `resetTo`s Home);
   - DI-1 storage state is `ok`, never while protected;
   - there is an active Xtream or M3U playlist with credentials;
   - a playback engine exists;
   - free memory is above the work floor (memory policy).
2. Wait for Home to be shown and the start-up checks to settle, including DI-1 `whenChecked()`. Show a small "Resuming <channel>… Press Back to cancel" toast for about 3 s. **Any key cancels.**
3. Load the live catalogue with the normal `loadLive` (which uses the cache). If the channel ID is no longer in the catalogue, do nothing and stay on Home. No fallback to another channel.
4. **Parental:** if the channel is adult and locked, do **not** auto-play and do not prompt for the PIN at start. Stay on Home.
5. Open the player through the same route as a manual open: push `live-tv` for the playlist, then `player` with `{ list: [the channel's category or all channels], pos }`, so Back and CH± behave exactly as after a manual start.
6. **Failure:**
   - a stream error behaves like any manual tune (the existing retry rules, then an error message);
   - the app never retries in a loop;
   - it never auto-plays again in the same session.
7. **Never:** auto-play while a modal is open (DI-1 recovery dialog, sign-in prompt, exit dialog), while an import is running, or after a crash-restart loop. Keep a "last auto-resume at" timestamp; if the previous auto-resume was under 60 s ago and the app did not reach a stable `playing`, skip it.

**Playback-state integrity.**
- The resume uses the normal controller, so `markWatched` keeps working as before. Auto-play does not write anything new until a picture appears.
- No playback-state file is introduced. The setting itself is one config value.

**Platforms.** The resume option works on every platform that can play Live TV, because it is the app's own behaviour at launch. It is independent of 2A, so it also works when the user starts the app manually or through the TV's own "Autorun Last App".

### Feature 3: subscription expiry in Settings

**Parsing.** Change it to a three-way result, with the raw-value rules in §4:

```ts
type Expiry = { kind: 'date'; at: number /* epoch ms */ } | { kind: 'unlimited' } | { kind: 'unknown' };
```

**Storage.** Keep it away from the DI-1-protected playlist list: use a **separate KV key `account.<playlistId>`**:
- content: `{ v: 1, d: { expiry, status, trial, maxConnections, checkedAt, serverTime? } }`, with no username, password or URL;
- written only after a **successful** `authenticate()` (import or VOD client), and never cleared by a failed refresh;
- deleted by remove and remove-all, which means adding `account.` to the existing list of keys removed per playlist. That is the only touch on `playlist-service.ts` and needs approval, because it is next to DI-1 code. Alternatively, a small `AccountInfoStore` with its own cleanup hook.
- `lastStatus.expiresAt` stays as it is, for backward compatibility. New UI reads `account.<id>`, with `lastStatus.expiresAt` as a fallback marked "from last update".

**Display in Settings** (Accounts group, for the **active** playlist). A row "Subscription" with:

| State | Shown |
|---|---|
| Date in the future | "Until 12 Mar 2027 · 106 days left" ("1 day left"; "Ends today" on the last day) |
| Date in the past, or status Expired | "Expired on 2 Jan 2026" |
| Unlimited | "No expiration" |
| Unknown, or M3U | "Unknown" ("Not available for M3U playlists" for M3U) |
| Never checked | "Unknown · not checked yet" |

**Status versus expiry.** Status (Active, Banned, Disabled) is shown separately and only when it isn't Active, e.g. "Account: Disabled". It is never derived from the date, and the date from the status only for the "Expired" wording.

The playlist details screen uses the same formatter, per playlist, so every playlist's date can be seen there.

---

## 3. Platform support matrix

| | Samsung Tizen 3.0 (UE50MU6100) | Android TV | LG webOS | Philips Titan OS |
|---|---|---|---|---|
| **App-controlled auto-launch at power-on** | **No.** No documented API or key. `prelaunch.support` is background-only and dropped since 2019 models | **Not in the normal model.** Background activity starts are blocked since Android 10. Only with a user-granted `SYSTEM_ALERT_WINDOW` (device-dependent; unverified on TV; store-policy risk) | **No.** No API, per LG forum. Root-only workarounds are excluded | **No documentation found.** `apps.launch` is protected, needs whitelisting, and launches on demand only |
| **User/TV-level alternative** | TV setting "Autorun Last App" (General → Smart Features). Model-dependent, **unverified on this TV**, and the app can't detect it | Launcher or vendor settings on some devices (unverified) | None official found | Unknown; ask Titan |
| **Setting offered in ScreenShelf** | Information row with a help text | Hidden (maybe later: sideload-only opt-in after verification) | Hidden | Hidden |
| **Last-channel resume (2B)** | Yes (AVPlay) | Yes (ExoPlayer bridge) | Yes, once webOS playback exists (CP3) | Yes, once Titan is unblocked |
| **Last-channel data today** | `recent.<pid>` (persistent) | Same | Same | Same |

---

## 4. API response examples and expiry parsing rules

**`player_api.php?username=…&password=…` (no action).** This is the repository fixture `tests/fixtures/xtream/auth-ok.json`, shortened; credentials are fake:

```json
{
  "user_info": { "auth": 1, "status": "Active", "exp_date": "1893456000", "is_trial": "0",
                 "active_cons": "0", "created_at": "1700000000", "max_connections": "2",
                 "allowed_output_formats": ["m3u8", "ts", "rtmp"] },
  "server_info": { "timezone": "Europe/Amsterdam", "timestamp_now": 1763856000,
                   "time_now": "2025-11-23 00:00:00", "server_protocol": "http" }
}
```

`auth-expired.json` has `"status": "Expired", "exp_date": "1600000000"`.

Variants seen across panels, to cover with fixtures: `"exp_date": null`, `"exp_date": ""`, `"exp_date": "0"`, `"exp_date": "null"`, the key missing, `"exp_date": 1893456000` (a number), and a 13-digit millisecond value. That panels send these variants is **inferred**, not documented. The Xtream API has no official public specification.

**Parsing rules** (`exp_date` is **Unix seconds, UTC**):

| Raw value | Result |
|---|---|
| Key missing; non-numeric text (other than below); negative | `unknown` |
| `null`, `""`, `"0"`, `0`, `"null"` (key present) | `unlimited` (panels use this for unlimited lines) |
| 9 to 11 digits, between 2000-01-01 and 2100-01-01 | `date`, value × 1000 |
| 12 to 13 digits | Treated as milliseconds **only if** ÷1000 falls in the same range; otherwise `unknown` |
| Anything outside 2000–2100 | `unknown`, never shown as a real date |

Supporting rules:
- **Timezone:** the epoch value has no timezone. Show it in the **device's local time** (`formatDate`). `server_info.timezone` and `time_now` are only needed for the server's own clock and are not used for the date.
- **"Expired" and days left** are based on the device clock. If the TV clock differs from `timestamp_now` by more than 24 h, use `timestamp_now` plus the time elapsed since then, and note the difference in diagnostics. This matters because import already fails as `expired` using the device clock alone; that rule should get the same clock check.
- **Days left** = `ceil((at − now) / 86,400,000)`. 0 means "Ends today"; below 0 means "Expired".
- **Unlimited:** "No expiration" is shown only when the server explicitly sent an unlimited value. A missing key is `unknown`.
- **Status:** `status` is shown as its own fact, never mixed into the expiry state, except that `Expired` with no date gives "Expired".

---

## 5. UI and navigation proposal

```
Settings
  ACCOUNTS
    Accounts and playlists      Mine · 1 in total      ›
    Subscription                Until 12 Mar 2027 · 106 days left      (active playlist; info row)
  LANGUAGE …
  PLAYBACK
    Preferred audio language …
    Preferred subtitles …
    Play last channel at start-up      Off / On          (OK toggles)
  START-UP                                          (Tizen only)
    Start ScreenShelf with the TV      How to…  ›     (help text, no toggle)
  PARENTAL CONTROLS …
  HISTORY …
  ABOUT
    About ScreenShelf          0.2.0   ›            (opens the About screen)
    Diagnostics                                ›
```

- **"Subscription"** is an information row (not focusable), matching the current style. Its full details are on the playlist's details screen.
- **Placement of "Play last channel…":** under Playback, next to the other playback preferences. OK toggles it, with no confirmation.
- **About screen:** the existing frame plus a read-only key/value list and Back. No buttons other than Back. It reuses the diagnostics or details styles and stays inside the 1080 px frame. This is the lesson from DI-1.1: test the layout for overflow.
- **Remote:** all new interactive rows are reached with ▲▼, activated with OK, and left with Back. There is no focus trap and no new key codes.

---

## 6. Security and data integrity

- **No credentials anywhere new.** `account.<id>` stores no username, password, server or URL. The parser already drops `username`, `password` and `server_info.url`. Logs and diagnostics stay code-only.
- **DI-1 untouched:**
  - Feature 3 stores account information outside the playlist list;
  - Feature 2B reads `recent.<pid>` and never writes the playlist list;
  - nothing new runs while DI-1 storage is protected;
  - no backup, quarantine or cleanup logic changes.

  The only change near DI-1 is adding `account.` to the per-playlist key clean-up in remove and remove-all. It needs a test showing it changes nothing else.
- **Playback safety (2B):** opt-in, cancellable, one attempt per session, parental-aware, memory-aware, and it reuses the normal controller.
- **No background processes,** no boot receivers and no changes to TV start-up behaviour. Feature 2A stays information-only.
- **Existing user data:** the new settings default to Off or absent; existing `recent`, config and playlists are unchanged; there is no migration.

## 7. Files likely to change

| Feature | Files |
|---|---|
| 1 | `src/screens/settings-screen.ts` (one row instead of the group); new `src/screens/about-screen.ts`; `src/app/bootstrap.ts` (register `about`, move the `about()` data); `src/i18n/strings.ts`; `tests/unit/vod-ui.test.mjs` (About expectation); new About test |
| 2B | New `src/services/resume-live.ts`; `src/app/bootstrap.ts` (one call after start-up); `src/screens/settings-screen.ts` (toggle); `src/app/config.ts` (new `ui.resumeLastChannel`, default false); `src/i18n/strings.ts`; possibly a small toast component; new tests |
| 2A | `src/screens/settings-screen.ts` (Tizen-only help row); `src/app/platform/*` (a `startup.autoLaunch: 'tv-setting' \| 'unsupported'` capability flag, so no platform checks are scattered); strings |
| 3 | `src/api/xtream/xtream-types.ts` (`parseExpiry`, three-way); `src/content/xtream-source.ts` and the VOD client path (hand the account over after a successful auth); new `src/services/account-info.ts` (KV `account.<id>`); `src/services/playlist-service.ts` (**only** the remove and remove-all key list; approval needed); `settings-screen.ts`, `playlist-details-screen.ts`; strings; new fixtures and tests |
| Not changed | DI-1 storage, backup and quarantine code; `config.xml`; signing; the design source and export; production configuration |

## 8. Test plan

**Automated (node --test, fakes, no network):**
- **Feature 1:**
  - every Settings row is focusable;
  - the About row opens the About screen with the right values;
  - Back returns focus to the row;
  - English and Dutch strings exist (the `missingTranslations` test);
  - the About screen stays inside 1080 px (structure check, plus a layout check in a real browser as was done for DI-1.1).
- **Feature 2B:**
  - Off: no playback at start.
  - On: resumes the last channel that actually played.
  - Missing channel: stays on Home.
  - Adult and locked: no auto-play and no PIN prompt.
  - Protected DI-1 state, a running import, no engine, low memory or an open modal: no auto-play.
  - Any key during the toast cancels.
  - Only one attempt per session; the crash-loop guard works.
  - A language switch or a resume from background does not trigger it.
  - `recent` is only written on the first picture.
- **Feature 2A:** the help row appears only where the capability is `tv-setting`; no toggle anywhere.
- **Feature 3:**
  - `parseExpiry` table tests for all the variants in §4;
  - timezone independence (a fixed epoch shows as the same day in UTC and in Amsterdam);
  - days left at the boundaries (0, 1, −1);
  - clock-skew fallback to `timestamp_now`;
  - a failed refresh keeps the stored expiry;
  - `account.<id>` is removed with the playlist;
  - DI-1 suites stay green and unchanged;
  - no credentials in KV, logs or diagnostics;
  - M3U shows "Not available".

**Physical (Samsung UE50MU6100, after separate authorisation):**
- About and Back behave correctly.
- Subscription shows the real date and days left for `pmwxc6brb01`.
- Resume On or Off across real power cycles, including adult and locked cases, a missing channel and the cancel key.
- Check whether this TV has "Autorun Last App" and whether ScreenShelf reopens with it. This only documents it; nothing is changed on the TV unless you allow it.

**Android device:** confirm that resume works and that 2A stays hidden.

## 9. Dependencies and unresolved questions

**No new dependencies.**

**Open questions:**
1. **Tizen:** does the UE50MU6100 (2017) offer "Autorun Last App", and does it reopen a sideloaded app? This needs a manual check on the TV.
2. **Android TV:** do we want a sideload-only, opt-in auto-start using `SYSTEM_ALERT_WINDOW` later? It needs device testing and is a policy decision.
3. **Titan OS:** add "auto-start at power-on" to the pending Titan questions (`docs/CP-TITAN-INQUIRY-DRAFT.md`).
4. **Feature 3:** do you approve the one-line addition of `account.` to the remove and remove-all clean-up in `playlist-service.ts`, next to the DI-1 code?
5. **Feature 2B:** which list should CH± use after a resume: the channel's category, or All channels? The recommendation is the category, falling back to All.
6. **Feature 3:** should the expiry check use the server clock (`timestamp_now`) for "Expired"? This also affects the existing import rule.

**Sources:**
- [Samsung: Prelaunching Applications](https://developer.samsung.com/smarttv/develop/guides/fundamentals/prelaunching-applications.html)
- [Samsung: Configuring Web Applications](https://developer.samsung.com/smarttv/develop/guides/fundamentals/configuring-tv-applications.html)
- [Tizen forum: auto launch on start-up](https://developer.tizen.org/forums/web-application-development/how-auto-launch-tizen-tv-web-application-on-start-up) (community; not authoritative)
- [Samsung Members: launch app when TV turns on](https://r1.community.samsung.com/t5/tv-audio/launch-the-tv-application-when-the-tizen-tv-is-turned-on/td-p/19557908)
- [tab-tv: Samsung autorun setting](https://www.tab-tv.com/how-to-activate-app-autorun-when-starting-up-samsung-tv/)
- [Android: restrictions on starting activities from the background](https://developer.android.com/guide/components/activities/background-starts)
- [Android: restrictions on starting foreground services from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15)
- [webOS forum: make the app launch automatically after power on](https://forum.webostv.developer.lge.com/t/how-to-make-the-app-launch-automatically-after-power-on/28121)
- [webOS forum: autorun after reboot](https://forum.webostv.developer.lge.com/t/autorun-application-after-reboot-system/3899)
- [Titan OS: App Control](https://docs.titanos.tv/app-control)
- [Titan SDK: App Control](https://docs.titanos.tv/titan-sdk-app-control)

## 10. Estimated implementation stages

| Stage | Content | Size | Risk |
|---|---|---|---|
| **S1** | Feature 1: About screen and row; tests; real-browser layout check | Small | Low |
| **S2** | Feature 3: `parseExpiry`, `account.<id>` store, Settings and details display; fixtures and tests | Medium | Low–medium (touches the remove clean-up list; needs approval) |
| **S3** | Feature 2B: last-channel resume service, toggle and toast; tests | Medium | Medium (start-up and playback path) |
| **S4** | Feature 2A: capability flag and Tizen help row | Small | Low |
| **S5** | Physical Samsung verification of S1–S4 (after the pending DI-1.1 verification), with production restored afterwards | — | — |

## Recommendation

1. **First, finish the pending DI-1.1 physical verification.** The DI-1.1 test build is still installed on the TV, and CP1 acceptance still depends on it.
2. **Then implement S1, S2, S3 and S4 in that order,** each as its own stage with a report and your approval:
   - About first: smallest, no data;
   - expiry next: the most user value; it needs your yes on the clean-up line;
   - last-channel resume: opt-in and off by default;
   - the auto-start information row last.
3. **Do not build any app-controlled auto-start.**
   - Samsung, LG and Titan offer no supported mechanism.
   - Android only allows it through a user-granted overlay permission. That should be a separate, device-verified decision.
   - On Samsung, point users to the TV's own "Autorun Last App" setting instead.

Waiting for your approval before implementing anything.
