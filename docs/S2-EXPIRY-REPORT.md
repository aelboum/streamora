# S2 — Xtream subscription expiry: report

Date: 2026-11-26. Scope: stage S2 of `docs/SETTINGS-IMPROVEMENTS-AUDIT.md` only (Feature 3), with your decisions:
- the cleanup exception only for playlists you removed explicitly;
- server clock with evidence;
- status kept separate from expiry.

S3–S5 were not started. Nothing was installed, committed or pushed.

## 1. Behaviour

**Parsing** (`src/content/expiry.ts`). `exp_date` is in Unix seconds (UTC) and is read as one of three states:

| Raw value | State |
|---|---|
| Plausible instant (2000-01-01 ≤ t < 2100-01-01) | **date** |
| A 12–13 digit value whose ÷1000 is in that range | **date** (read as milliseconds) |
| Key present with `null`, `0`, `"0"`, `""` or `"null"` | **unlimited** ("No expiration") |
| Key missing, negative, non-numeric, non-integer or implausible (e.g. `"5"` = 1970) | **unknown**, never shown as a date |

`expiresAt` is kept for compatibility, as `date ? at : null`.

**Time basis:**
- The TV clock is used unless the server's own clock (`server_info.timestamp_now`, from the same authenticated answer) is **trustworthy** and differs from the TV clock by **more than 24 h**. Trustworthy means present and plausible: 2024-01-01 ≤ t < 2100-01-01. This app did not exist before 2024.
- The basis and its reason are stored with each answer: `in-sync`, `device-clock-off`, `no-server-time` or `server-time-implausible`.
- The details screen reports the fallback ("TV clock (no server time available)" and the other reasons).
- The **same basis** is used for the expired check during an import (`xtream-source.ts`), which previously used only the TV clock, and for the display.

**Storage** (`src/services/account-info.ts`): KV `account.<playlistId>`, holding:
- the expiry;
- the status (only `[A-Za-z0-9 _-]`, at most 32 characters; anything else is stored as empty);
- trial;
- maximum connections;
- `checkedAt`;
- the clock basis.

It holds **no credentials, no server address and no URL**; a test checks this. It is apart from the DI-1-protected playlist list, and reading it uses `kv.get`, which never deletes: a damaged record is quarantined and kept.

**When it is written:** right after a **successful login** (the `onAccount` hook in `xtream-source.ts`), before any later step can fail.
- A later update that fails **before** login (network, timeout, wrong login) keeps the record.
- A failure **after** login (for example the channel list fails, or the account has expired) still refreshes it.

**Removal: the approved exception.** `o.kv.remove(ACCOUNT_KEY_PREFIX + id)` was added to the per-playlist key clean-up in `remove()` and `removeAll()`. Both run only after DI-1's verified list read; a protected list refuses them. The record is **never** deleted for:
- missing, unreadable or protected lists;
- quarantined records;
- playlists not in the list;
- start-up cleanup.

**Display:**
- **Settings → Accounts,** for the active playlist: an information row **Subscription**, plus **Account status** only when the server reports a status other than Active or unknown.
- **Playlist details,** per playlist: the same rows, plus **Checked** (time) and **Time basis**.
- **Status versus expiry:** status never changes the expiry line. An "Expired" status with no usable date shows "Unknown" and "Account status: Expired".
- **Values:**

| State | Shown |
|---|---|
| Date ahead | `Until 2027-03-12 · 106 days left` / `… · 1 day left` |
| Last day | `Ends today (2027-03-12)` |
| Date passed | `Expired on 2027-03-12` |
| Unlimited | `No expiration` |
| Unknown | `Unknown` |
| No record yet | `Unknown · not checked yet` |
| M3U playlist | `Not available for M3U playlists` |

- Days left are counted in **local calendar days** (the TV's time zone), and dates are shown in local time.
- **Playlists imported before S2** (no record yet) show the expiry from their last update, `lastStatus.expiresAt`, on the TV clock. The current TV playlist will show its date without a new update.

## 2. Files changed

| File | Change |
|---|---|
| `src/content/expiry.ts` | **New:** `parseExpiry`, `clockBasis`, `expiryView` and validators (pure) |
| `src/services/account-info.ts` | **New:** `account.<id>` store (whitelisted fields, validation) |
| `src/screens/subscription-text.ts` | **New:** Settings and details rows (English and Dutch through `t`) |
| `src/api/xtream/xtream-types.ts` | `XtreamUserInfo.expiry`; `expiresAt` derived from it |
| `src/content/import-types.ts` | `AccountReport` type |
| `src/content/xtream-source.ts` | `onAccount` after login; the expired check uses the same time basis |
| `src/services/playlist-service.ts` | `accounts` option passed to the Xtream import; **one cleanup line each** in `remove()` and `removeAll()` (approved). Nothing else changed |
| `src/app/bootstrap.ts` | Account store and `ctx.accounts`; `subscriptionFor()` (with the pre-S2 fallback) for Settings and details |
| `src/screens/settings-screen.ts`, `playlist-screens.ts`, `playlist-details-screen.ts` | Optional `subscription` rows (the old expiry line stays as the fallback when absent) |
| `src/i18n/strings.ts` | 16 keys each in English and Dutch |
| `tests/unit/xtream-client.test.mjs` | Additive: the expected account object gains `expiry` |
| `tests/unit/s2-expiry.test.mjs` | **New:** 13 tests |

**Not changed:**
- DI-1 storage, backup, quarantine and recovery logic: `kv-store.ts`, `catalogue-store.ts`, the `playlist-service` list, state, backup and cleanup code, and `diag-log.ts`;
- `config.xml`, signing, the design source, and other platforms' adapters.

## 3. Tests (13 new, all pass)

1. Parsing table: 26 raw values, including the invalid timestamps (1970, before 2000, 2100 and later, non-integer, `NaN`, `Infinity`, text, negative, too long), the unlimited markers, milliseconds and a missing key.
2. `clockBasis`: no server time; implausible server times; exactly 24 h (TV clock); a few hours off (TV clock); 3 days ahead (server); a TV clock in 1970 (server).
3. `expiryView`: 106 days, 1 day, today, at the instant, expired, with a server offset (TV says 5 days left, server says expired), unlimited and unknown.
4. **Time zones** (child processes with `TZ=UTC`, `Pacific/Kiritimati` (UTC+14) and `America/Los_Angeles`): the date and days left follow the local calendar (the 12th versus the 13th; "today" versus "1 day").
5. The import stores the record apart from the list; no user name, password, server or `http` in it; the list keeps one valid entry.
6. **Failed updates:** a network failure before login leaves the record unchanged; a failure after login refreshes it.
7. **Clock discrepancy:**
   - TV clock in 2031, server 2025, expiry 2030: not expired on the server clock; the time basis says so.
   - No server time: TV-clock fallback, the import fails as expired, the record is still stored, and the fallback is reported.
8. `null`, `"0"`, `"abc"`, `"5"` and a missing key: stored as unlimited or unknown; implausible values don't fail the import as expired.
9. **Removed playlists:** explicit removal deletes only that record; another playlist's and an unrecognised playlist's records are kept; start-up cleanup never touches records; remove-all deletes only listed playlists.
10. **Missing, unrecognised, protected and quarantined:**
    - with a damaged list (protected), remove and remove-all are refused and the record is kept;
    - with a wiped list key (missing, protected), the record is kept;
    - a damaged record reads as "not checked", stays in place, and is quarantined.
11. An expiry update never writes or invalidates the playlist list; an unsafe status string is not stored.
12. Display states (English and Dutch), with status separate from expiry.
13. Real start-up: Settings shows the row for the active Xtream playlist, "Not available" for M3U, and the pre-S2 `lastStatus` date.

## 4. Automated checks

| Check | Result |
|---|---|
| Typecheck | OK |
| Compat (ES5 and platform isolation) | 132 files, 0 findings |
| Unit tests | **422 / 422** (409 + 13) |
| Build tests | 6 / 6 |
| Samsung release build | OK |
| `release-check` | OK |
| Android build | OK (local only) |

**Build** (CP1 + DI-1 + DI-1.1 + S1 + S2), SHA-256:
- `app.js` (383,285 B): `811efbbcb63cab4dfde1bb8c91a635632cbf32782a5f9e25ee5b1a9c1570702f`
- `app.css`: `382e0155…` (unchanged since S1)
- `config.xml`: `08b9151c…` (identical to production)
- `icon.png`: `35fb3813…`
- `index.html`: `629cf34f…`

**Not installed;** the physical check is in S5.

## 5. Limitations

- **Refreshes:** the expiry is refreshed by Xtream imports (adding a playlist, or "Update"). VOD browsing logs in separately and does not refresh the record. That was left out to keep S2's scope.
- **"Checked"** is shown in TV time. If the TV clock is wrong, that time is wrong too, while the expiry decisions use the recorded basis.
- **The server offset is measured at each login.** If the TV clock is corrected later, the stored offset stays until the next successful login. The display could then be off by that correction; at worst a day count is stale until the next update.
- **The unlimited markers** (`null`, `0`, `""`, `"null"`) reflect common panel behaviour; there is no official Xtream specification.

## 6. Next

Waiting for your review of S2 before S3 (last-channel start-up option).
