# DI-1 — Playlist data-integrity repair: report

Date: 2026-11-26. Scope: DI-1 only, as authorised. It is a separate repair stage, implemented on the CP1 working tree and also verified on the production baseline `c0adf0b`. CP2 and CP3 were not started. Nothing was committed, pushed, released, published or installed, and the TV was not contacted.

**Status: implementation and automated verification complete. Physical Samsung verification has not been done; it needs your authorisation. CP1 acceptance stays blocked until you approve DI-1 and that verification.**

---

## 1. Incident summary

- **What was lost:** the original Xtream playlist `pmwuiieey01`, which had about 108,627 movies and 25,502 series. Its entry, its downloaded catalogue and its login all disappeared from the Samsung UE50MU6100. You did not delete it.
- **When:** it last loaded at 25 Nov 22:57 UTC and was already missing at the first CP1 start on 26 Nov at 09:06 UTC.
- **What remains:** `pmwxc6brb01`, added separately during the CP1 test. It did not replace the original by an edit.
- **Most likely window:** a production start between 25 Nov 23:07 and 26 Nov 09:06 UTC, with medium-to-high confidence. At the first CP1 start no catalogue cleanup was logged, which means the original's files had already been deleted before then. The trigger on the TV is still unknown.
- **Evidence:** the investigation reports (in the session) and `docs/CP1-REPORT.md` §8.

## 2. Root-cause mechanism (now addressed)

1. At start-up the app read the saved playlist list through `kv.get()`.
2. A failed read, corrupt JSON, a broken wrapper, an unsupported version or failed validation all gave the same answer: an empty list. For every case except a failed read, the stored value was also **deleted**.
   - `createWebLocalStore.getItem()` turned a read that threw into "nothing stored".
   - `isPlaylistList()` rejected the whole list if a single entry was bad.
3. `recover()` treated that empty list as authoritative.
4. `catalogue.cleanup(knownIds)` then deleted every catalogue file of every playlist missing from the list.
5. A later `add()` saved a list containing only the new playlist, overwriting the original for good.

The desk reproduction showed this in both `c0adf0b` and CP1, in scenarios S5a–S5d and S6a–S6e.

## 3. Files and functions changed

| File | Change |
|---|---|
| `src/storage/kv-store.ts` | `read()` returns a status (new); `quarantine()` and `quarantined()` (new); `get()` no longer deletes anything; optional event sink for diagnostics |
| `src/app/platform/common.ts` | `createWebLocalStore.getItem()` lets read errors through, so they become `read-error` instead of "missing" |
| `src/app/platform/platform.ts` | Comment only: `getItem` may throw |
| `src/storage/diag-log.ts` | **New:** persistent, bounded, privacy-filtered diagnostics log |
| `src/storage/catalogue-store.ts` | `cleanup(removedIds, knownIds)` deletes only tombstoned playlists and temp files of known ones; `ownerIds()` (new) |
| `src/services/playlist-service.ts` | Fail-safe list storage: state machine, guarded writes, per-entry validation, backup, tombstones, `storageState`, `whenChecked`, `recheckStorage`, `restoreBackup`, `continueWithoutRestore`; `add`, `update`, `remove`, `removeAll`, `setActive`, `patch` and `recover` guarded |
| `src/app/bootstrap.ts` | Creates the diagnostics log; passes `files`, `diag` and `storagePersistent` to the playlist service; adds `ctx.diag` |
| `src/screens/home-screen.ts` | Recovery dialog; no Add tile and no "No account" text while the list is protected |
| `src/screens/settings-screen.ts` | The Accounts row shows "Protected: needs attention" |
| `src/screens/playlists-screen.ts` | An empty protected list is not shown as "No playlists yet" |
| `src/screens/playlist-details-screen.ts` | A refused removal is reported ("Nothing was deleted") |
| `src/i18n/strings.ts` | 30 new strings, English and Dutch |
| `tests/unit/di1-playlist-integrity.test.mjs` | **New:** 22 fault-injection and behaviour tests |
| `tests/unit/kv-store.test.mjs`, `catalogue-store.test.mjs`, `playlist-service.test.mjs` | Four expectations updated to the DI-1 contract (§12) |

## 4. Storage contract changes (DI-1.1)

`kv.read(name, validate, schema?, migrate?)` returns one of:

| Status | Meaning |
|---|---|
| `ok` (with `value`) | Read and validated |
| `missing` | The key does not exist |
| `read-error` | The storage read threw (raw value unknown) |
| `corrupt` | Not valid JSON |
| `malformed` | Not a `{v, d}` envelope |
| `unsupported` | Wrong schema version, no migration |
| `invalid` | Failed validation |

All except `ok`, `missing` and `read-error` also return the raw stored text.

`read()` never changes storage. `get()` keeps its "value or fallback" contract for small settings, but an unreadable value is **left in place and copied to quarantine**; it is no longer deleted. Each problem is logged once per key and kind per session.

A genuinely empty list is stored as `[]` (an explicit value) and reads as `ok`. A first installation is a *verified* missing list: no list key, no verified backup, and no catalogue files from earlier playlists apart from tombstoned ones. Remove and remove-all now write `[]` instead of deleting the key, so a list the user emptied is never mistaken for a lost one.

## 5. Quarantine design (DI-1.2)

- **Keys:**
  - `ss:v1:quarantine.<name>` holds the first unreadable value seen and is never overwritten;
  - `ss:v1:quarantine.<name>.2` holds the latest different unreadable value.
  - Each holds `{v:1, d:{reason, raw}}`.
- **Repeated starts** with the same bad value change nothing: the comparison is exact.
- **The original is never removed.** If the quarantine write fails (storage full, or an unreadable quarantine slot), the result is `preserved: false`. No recovery decision may then overwrite the original; only "Try again" is offered.
- **Privacy:** logs carry the key name and a code only, never the raw value. The quarantine stays on the TV, in the same storage as the original.
- **Partially valid lists** are quarantined as the parsed envelope. The content is unchanged, but the whitespace may differ from the original text.

## 6. Protected playlist writes (DI-1.3)

The playlist service is always in one of three states:
- `ok`: the list was read and verified;
- `checking`: the list key is missing, and the backup and catalogue files are being checked;
- `protected`, with a problem: `read-error`, `corrupt`, `malformed`, `unsupported`, `invalid`, `partial`, `missing-with-backup`, `missing-with-data`, `unverified` or `no-local-storage`.

Every writer goes through `freshList()`: the state must be `ok` and a fresh read must be clean. `saveList()` repeats that guard just before writing.

| Operation | While protected |
|---|---|
| `add`, `update` | `{ ok: false, code: 'storage-protected' }`; nothing saved, and the new login is rolled back |
| `remove` | Rejects; nothing deleted (no list change, no login removal, no file deletion) |
| `removeAll` (PIN-reset wipe) | Rejects; the PIN service keeps the PIN and retries the wipe at the next start (`pin.ts`) |
| `setActive` | `false`; the stored setting is unchanged |
| `patch` (import status, cleartext notice) | Skipped; the refusal is logged |
| `recover` | Neither cleanup nor journal handling runs; returns `cleanupSkipped: true` |

If the list becomes unreadable while the app is running, the next read or write switches to the protected state. The last list read successfully stays on screen, never an invented empty one. A failed write is never reported as success: `add` and `update` return `storage`, and `remove` rejects.

## 7. Catalogue cleanup safeguards (DI-1.4)

- **Only after a verified read.** `cleanup()` runs only when the state is `ok` and a fresh read is clean.
- **Only positive evidence.** It deletes:
  - every file of a **tombstoned** playlist, one the user removed, recorded in `playlists.removed` (at most 50 IDs);
  - leftover `.tmp` files of known playlists.
- **Unknown owners are kept.** Files of any other playlist ID, and unrecognised `cat.*` names, are kept and counted as `kept`.
- **The explicit wipe** (`removeAll` after an unauthenticated PIN reset) deletes every catalogue file, as intended, but only from the verified state.
- **Other cleanup paths reviewed:**
  - The VOD page clean-up (`vod-service` → `removePages`) acts only on the playlist being refreshed and keeps the current generation. Unchanged.
  - The catalogue store still deletes a single file that it read successfully but that fails its header, length or checksum check. That is unusable, re-downloadable data of a known playlist, with no uncertainty about the owner. Kept as it is; see §14.

## 8. Per-entry validation (DI-1.5)

- **Partly valid list:** each entry is checked on its own with `isPlaylistDef` and duplicate-ID detection. If some entries are invalid:
  - the valid ones stay visible and playable (read-only);
  - the state becomes `protected / partial` with counts;
  - the raw list goes to quarantine;
  - the stored list is left untouched;
  - nothing is discarded.
- **Cleanup** doesn't run, and the catalogue files of the invalid entry are never treated as deletable, because their owner is uncertain.
- **"Continue without"** (§11) saves only the valid entries. Afterwards the quarantine still holds the full original list, and the invalid entry's files stay on disk.
- **"Restore backup"** saves the backup plus any valid entries the backup lacks.

## 9. Backup and recovery (DI-1.6)

- **Files:**
  - `ss-playlists.bak.json` in the FileStore. On Tizen that is the app's file system, a different medium from localStorage.
  - Content: `{v:1, count, hash, list}`. The hash is a 32-bit checksum over the list text plus its length; it detects truncation and damage but is not a security measure.
- **When it is written:**
  - only after a successful, validated save;
  - or at start-up after a verified read, when it is missing or different.
- **When it is never written:** from a protected state, with an invalid list, or when the content is identical. It is one file, replaced atomically, so copies never pile up.
- **Verification before use:** `v`, `count`, `hash` and full list validation. A damaged backup is ignored, logged (`backup-invalid`) and left as it is.
- **`ss-playlists.bak.keep.json`:** before a recovery decision replaces the backup, the backup is preserved here once, and this file is never overwritten. If preserving it fails, "Continue without" is refused, so a good backup can't be lost.
- **No automatic overwrite of the main list.** Recovery is always the user's decision, and only when the unreadable value is safely preserved:
  - **Restore backup:** writes the backup (plus any valid entries not in it) as the list, and repairs the active selection if needed.
  - **Continue without:** writes the valid entries, or an empty list. Quarantine, backup copy and every catalogue file are kept.
  - **Try again:** reads again. This is the only option for `read-error` and `no-local-storage`.

The recovery steps for support are in §11.

## 10. Persistent diagnostics (DI-1.7)

- **Storage:**
  - `ss-diag.json` in the FileStore, holding at most 60 entries `{t, e, d?}`, oldest dropped first;
  - written in the background with best effort, never blocking or breaking the app;
  - kept in release builds and across restarts.
- **Events:**
  - `kv-unreadable`, `quarantined`, `quarantine-failed`, `kv-write-failed`;
  - `pl-protected`, `pl-write-refused`, `pl-write-failed`, `pl-orphan-data`, `pl-recheck`;
  - `pl-restored`, `pl-continued`, `pl-removed`, `pl-removed-all`;
  - `cleanup`, `cleanup-skipped`;
  - `backup-written`, `backup-failed`, `backup-invalid`, `backup-unreadable`, `backup-skipped`.
- **Privacy filter:** only 18 known field names pass. Values must be numbers, booleans or codes matching `[A-Za-z0-9._-]{1,48}`, so no `:`, `/`, `@`, `?`, `=` or spaces. URLs, server addresses, user names and passwords cannot pass. The test checks this against stored data.
- **Viewing:** it is readable through `ctx.diag.entries()` or the file. There is no on-screen viewer yet (§14).

## 11. User-facing behaviour (DI-1.8)

**While the list is protected:**
- **Home:**
  - shows a warning dialog once per app run: "Your playlists are protected", with "Nothing has been deleted…" and the reason;
  - the dialog says how many entries the backup has, if there is one;
  - buttons: **Later**, **Restore backup** (only with a verified backup), **Try again**, and **Continue without**, which asks for confirmation first;
  - the account chip says "Playlists protected", not "No account";
  - the Add tile is disabled ("Paused while playlists are protected").
- **Settings:** the Accounts row reads "Protected: needs attention".
- **Playlists list:** never says "No playlists yet" while protected.
- **Add or edit form:** shows "Playlists can't be added or changed right now… Your existing data was kept."
- **Remove:** shows "Playlists can't be removed while their storage is protected. Nothing was deleted."

There is no reset or delete button anywhere. It reuses the existing confirm dialog and its warning variant, and is fully translated into Dutch.

**Recovery procedure (for support):**
1. Press **Try again** first. A temporary read error then recovers by itself.
2. If a verified backup is offered, use **Restore backup**.
3. Use **Continue without** only when the old list can't be recovered. Everything stays on the TV for later investigation:
   - the quarantine (`ss:v1:quarantine.playlists`);
   - the backup copy;
   - the persistent diagnostics log;
   - every catalogue file.

## 12. Regression scenarios and results

These tests use the real start-up code (`createAppContext`), with one set of persistent fake stores shared by all starts. Every scenario checks the playlist list **and** the catalogue files (6 per playlist). All 22 tests pass, as do the 4 updated expectations.

| Scenario | Result |
|---|---|
| **S5b:** reads fail at the production start and the CP1 start; add attempted | Add refused (`storage-protected`); stored list byte-identical; cleanup skipped twice; catalogue 6/6; after reads recover the original is visible and active, login kept, no replacement entry |
| **S5c:** read fails at one start; add attempted | Refused; cleanup skipped; list and catalogue intact |
| **S6a:** truncated JSON | `corrupt`; value kept and quarantined; add refused; catalogue 6/6; Restore backup brings the original back; quarantine and backup copy kept |
| **S6b:** broken wrapper | `malformed`; nothing deleted; list not replaced |
| **S6c:** one entry with an invalid server (two entries) | `partial`: the valid entry is usable; the invalid one is preserved; add and remove refused (remove deleted nothing); Continue keeps the valid entry; quarantine holds the full list; the invalid entry's files are never deleted |
| **S6d:** `epgUrl: null` on the only entry | `partial` with 0 valid; shown as protected, not empty; restore works |
| **S6e:** localStorage wiped, backup present | `missing-with-backup`; no new list created; catalogue 6/6; Restore brings back entry and active selection |
| **S6e:** wiped, no backup (upgrade from `c0adf0b`) | `missing-with-data` (from the catalogue files); add refused; after Continue the old files are never deleted automatically |
| **S6e:** localStorage unavailable | `no-local-storage`; no add to a temporary list; data intact at the next start |
| Quota exceeded or primary write fails | Add reports `storage` (not success); the new login is rolled back; original intact |
| Quarantine write fails | `preserved: false`; Restore and Continue refused (`not-preserved`); original untouched; logged |
| Backup write fails | Main list unaffected; logged; no restore offer later |
| Damaged backup | Not used, not replaced; logged |
| Interrupted write at 3 repeated starts | Evidence kept; a single quarantine copy; nothing deleted |
| Read error, then readable again | `recheckStorage()` returns to ok with no loss |
| List becomes unreadable while running | Writes refused; last list stays visible; `setActive` refused |
| Low-memory start (120 MB), invalid active ID, missing login, interrupted import | List and catalogue kept; a bad active ID does not lock the list and is not deleted; an interrupted import marks the status and removes only the temp file |
| First installation | Verified empty; add works; backup written |
| Genuine deletion | Files deleted and tombstoned; leftovers deleted at the next start; unknown-owner file kept; the last removal writes an explicit `[]`, and the next start is ok |
| PIN-reset wipe | Refused while protected; works once verified |
| Diagnostics | Survive a restart; bounded at 60; no addresses, user names, passwords or raw values; the filter blocks a URL in a code field |
| Home UI with a torn list | Recovery dialog, reason text, "Playlists protected" chip, Add disabled, Try again and Continue offered, no Restore without a backup, nothing written |

**Expectations changed on purpose** (the contract changed; no test was weakened):
- `kv-store`: "values fall back and are removed" now asserts that they fall back, **stay in place and are quarantined**.
- `kv-store`: "a missing migration resets" now asserts that it falls back, keeps the value, and reports `unsupported`.
- `catalogue-store`: the unknown orphan and the unrecognised name are now **kept**; a new assertion checks that a tombstoned playlist's files are deleted.
- `playlist-service`, interrupted import: the orphan of an unknown playlist (no tombstone) is **kept**; the temp file is still deleted (`removedFiles` 1, was 2).

## 13. Production baseline and CP1 compatibility

- **Same core in both:** the storage code (`kv-store.ts`, `catalogue-store.ts`, `common.ts`, the list validators) is identical in `c0adf0b` and CP1, so the core repair is the same for both.
- **How the baseline was checked:**
  - the anchored DI-1 patch scripts were applied to an extracted `c0adf0b` copy in the scratchpad (not the repo);
  - only three anchors differ, all caused by CP1-only lines, with no logic difference:
    - `bootstrap.ts`: CP1's `memory` field next to which `diag` is added;
    - `home-screen.ts`: CP1's `askSignIn()` call, and CP1's `signIn` dependency, which the baseline replaces with a per-screen flag.
- **Baseline results with DI-1:**
  - typecheck OK;
  - compat 126 files, 0 findings;
  - unit tests **383/383**: 361 baseline tests, including the 4 updated expectations, plus the 22 DI-1 tests;
  - release build OK (`app.js` 367,611 B, ES5 gate passed);
  - `release-check` OK.
- **The DI-1-only patch against `c0adf0b`** is in the scratchpad, not in the repo, and is not durable:
  - `…\scratchpad\DI-1-on-c0adf0b-src.patch` (11 files);
  - `…\scratchpad\DI-1-on-c0adf0b-tests.patch` (4 files).
- **CP1 behaviour unchanged:** keys, memory policy, engines and the sign-in prompt work as before. Two notes:
  - The DI-1 recovery dialog shares CP1's once-per-run object (`signIn.asked.storage`).
  - The CP1 sign-in prompt only shows for a persistent-store-less platform; Tizen has a persistent store.
- **Platforms:**
  - Android uses the same `createWebLocalStore` and FileStore, so it gets the same protection.
  - The IndexedDB FileStore (CP1, for future platforms) can hold the backup and the diagnostics.
- **The TV today:** `ss:v1:playlists` holds `[pmwxc6brb01]`, which is valid, so DI-1's first start will be `ok` and will write the first backup.

## 14. Known limitations and remaining risks

1. **The TV trigger is still unknown.** DI-1 contains the damage; it does not explain why the list was lost. The persistent log will record the next occurrence.
2. **Nothing left to detect.** If localStorage is wiped **and** no backup exists **and** no catalogue files remain, the device can't be told apart from a first installation. This is the state the incident TV is in now, so the original playlist can't be recovered by DI-1.
3. **Other small settings keys** (My List, category preferences, VOD state, progress, favourites) are no longer deleted on read and are quarantined. However, their features still write fresh values over an unreadable one later; the first copy survives in quarantine. Only the playlist list is fully write-protected.
4. **Corrupt-file discard** in the catalogue store is unchanged (§7). It applies to a known playlist's file that was read but fails verification. That file is re-downloadable, but it is still a deletion.
5. **Files of unknown owners** are never deleted automatically, so storage can grow after a loss. There is no manual "clean up" action yet; that would need a separate decision.
6. **Tombstones live in localStorage.** After a wipe they are lost, and leftovers of removed playlists are then kept. The cost is storage space, not data.
7. **Backup and quarantine share the app's sandbox.** Uninstalling the app removes everything; there is no cloud copy, by decision.
8. **`read-error` and `no-local-storage`** offer only "Try again". If the storage never recovers, playlists stay unusable, but preserved.
9. **No on-screen viewer** for the diagnostics log yet.
10. **The backup checksum is not cryptographic.** It detects damage, not tampering.
11. **Brief "checking" phase at start-up** (missing list only): until the file listing resolves, the list is empty and Add is disabled. The Home screen repaints when it finishes.
12. **`createWebLocalStore.getItem` now throws on a read error.** Only `kv-store` calls it, which was checked, but how Tizen's localStorage actually fails has not been observed on the TV.

## 15. Build and static checks (CP1 working tree with DI-1)

| Check | Result |
|---|---|
| `npm run typecheck` | OK |
| `npm run compat` (ES5 source rules and platform isolation) | 128 files, **0 findings** |
| `npm test` | **396 / 396** (374 + 22 DI-1) |
| `npm run test:build` | **6 / 6** |
| `npm run build:all` | Release OK (`app.js` 370,877 B, SHA-256 `01f80a87…`); `release-check: OK`; APK built (`EliteStream-0.2.0-debug.apk`, 5,221,150 B, local only, not published) |
| Release `config.xml` | Identical to the production baseline (privileges, CSP) |

**Diff review:**
- **Changed files:** only the files in §3. The CP1 changes are kept.
- **Secrets:** no new log line carries a server address, URL, user name or password. The quarantine holds raw values only in local storage, never in logs or diagnostics.
- **No destructive empty-list fallback remains:** `kv.get` no longer deletes, and every write to `KV_LIST` goes through `saveList()`/`freshList()` or a guarded recovery action.
- **Cleanup:** none runs after an uncertain read.
- **Overwrites:** no write can overwrite an unreadable list, except a recovery action the user chose after the value was preserved.

**Note:** `dist/release` now contains the DI-1 release build. The pre-CP1 production build is still preserved in the session scratchpad (`cp1-baseline/release`, with checksums).

## 16. Physical Samsung verification: still required

None of this has been tested on the TV. Proposed, after your authorisation:
1. Install the DI-1 release build over the current app.
2. Check that the existing playlist `pmwxc6brb01` is intact and that the first backup is written.
3. Run the CP1 regression checklist.
4. Restore production afterwards, as in CP1.

Optionally, with separate authorisation: a test on a disposable test playlist that deliberately damages the stored list. That would need a dev-only hook and is not part of this build.

## 17. Next action requiring your approval

Review and approve DI-1, then decide on:
- **(a)** the Samsung physical verification above (TV install);
- **(b)** whether DI-1 should also be carried to a production build from `c0adf0b` (the patch is ready in the scratchpad), or ship only together with CP1;
- **(c)** any commit.

None of these has been done.

## 18. DI-1.1: read-only storage diagnostics (added 2026-11-26)

**Why:** physical verification needs evidence that the first backup exists and passes its integrity check. Release builds send no logs, the TV blocks shell access to app files, and its remote inspector does not work. This addresses limitation 9 in §14.

**Where:** Settings → Diagnostics. The existing diagnostics screen gets two new sections.

**Playlist storage section:**

| Field | Values |
|---|---|
| Storage state | Healthy / Protected (*reason*) / Unavailable (*reason*) / UNKNOWN |
| Playlists in the validated list | A number, or UNKNOWN when the list can't be read |
| Backup | Missing / Valid / Invalid / Unreadable / UNKNOWN |
| Playlists in the validated backup | A number, or UNKNOWN unless the backup is valid |
| Backup integrity check | Passed (count and checksum match) / FAILED / UNKNOWN |
| Last successful backup | Time of the latest `backup-written` event, or UNKNOWN |

Every value is measured when the screen opens or Refresh is pressed:
- the list count comes only from validated entries;
- no checksum is computed or claimed for a missing or unreadable backup.

**Recent storage events section:** shows date, time, event code and the already privacy-filtered fields, newest first, at most 60 entries.

**Read-only by construction:**
- `PlaylistService.storageReport()` uses only `inspect()` (`kv.read`, which never writes) and `files.read(BACKUP_FILE)`.
- It calls none of these: `degrade`, `protect`, `quarantine`, `saveList`, `writeBackup`, `keepBackup`, `ensureChecked`, `cleanup`, `diag.record`.
- The screen only renders the report and `ctx.diag.entries()`. DI-1 recovery behaviour is unchanged.

**Files changed:**
- `src/services/playlist-service.ts`: `StorageReport` type and `storageReport()`;
- `src/screens/diagnostics-screen.ts`: optional `sections()` and `refresh()`;
- `src/app/bootstrap.ts`: `storageDiagnostics()` and the screen wiring;
- `src/i18n/strings.ts`: 19 strings each in English and Dutch;
- **new** `tests/unit/di1-1-storage-diagnostics.test.mjs` (8 tests).

**Tests (all pass):**
1. A valid backup is shown as valid.
2. A missing backup is shown as missing.
3. A corrupt backup (count changed, or truncated) is never shown as valid.
4. An unreadable backup is shown as unreadable, with integrity UNKNOWN.
5. The list count comes from validated data only (partial list: 1 of 2; corrupt list: UNKNOWN).
6. Events are listed without the server, user name, password, `http` or the raw value.
7. and 8. Opening the screen and pressing Refresh twice causes 0 localStorage writes, 0 file writes or removals and 0 new events. A temp file that cleanup would remove survives, and a protected state stays protected with its damaged value untouched.

A further test shows that a read error is reported as unavailable, never as healthy.

**Verification:**

| Check | Result |
|---|---|
| Typecheck | OK |
| Compat (ES5 and platform isolation) | 128 files, 0 findings |
| Unit tests | 404 / 404 |
| Build tests | 6 / 6 |
| Release build and `release-check` | OK |
| Android build | OK (local only) |

**New release build (CP1 + DI-1 + DI-1.1), SHA-256:**
- `app.js` (375,373 B): `973f5b63387eda39fed12661c0c867f583dbd098a1a4919919341f8b63e58435`
- `app.css`: `86566bb6c9f33379c3f899216791b0e67c1001f42c9d05e0033264d79841f09b`
- `config.xml`: `08b9151c8ed374be5e7a1a816bb4ea6ffac0c9c57129c9cd9b57dbac77b9239c`
- `icon.png`: `35fb3813bd5bf24a52dbdd1310a79e80cb9e4009750a4735b69ff3bd97fc6db0`
- `index.html`: `629cf34f6dd26b2d8cd1123f73b78aeb25381a362daf41b48cb41ba717772fc0`

The app ID is `SShelfDev1.ScreenShelf` and the signing profile is `probe-tizen`, both unchanged. `config.xml` is byte-identical to the production build's.

This build supersedes the DI-1 build `01f80a87…` for the physical verification. It has not been installed on the TV.

## 19. DI-1.1 physical gate: backup evidence (2026-11-26) — CLOSED (PASS)

**Installs:**
- The DI-1 build first went onto the UE50MU6100 at 12:17:42 local, as an upgrade without uninstalling or clearing storage.
- The Diagnostics section was not visible: the 1080 px page doesn't scroll. The layout was fixed under your option 1: actions at the top, storage section first, ▲▼ scrolling. That build (`app.js` `11d9589c…`, `app.css` `4d600e01…`) was checked in a real browser at 1920 × 1080 and reinstalled at 13:10:35.
- **Home:** no protected dialog; the playlist chip was shown.

**Read by you from Settings → Diagnostics → Refresh:**

| Field | Value |
|---|---|
| Storage state | Healthy |
| Playlists in the validated list | 1 |
| Backup | Valid |
| Playlists in the validated backup | 1 |
| Backup integrity check | Passed (count and checksum match) |
| Last successful backup | 2026-11-26 12:17 |

**Assessment:**
- The first backup was written at the first DI-1 start (12:17) and verifies.
- The 13:10 reinstall found it unchanged and correctly didn't rewrite it.
- The existing playlist (`pmwxc6brb01`) survived both upgrade installs.

**Not covered:** the "Recent storage events" lines were not recorded. The A–E regression checklist was not run on this build; it is planned for S5.

**Production restored:**
- the pre-CP1 build from `c0adf0b`, installed 2026-11-26 13:48:13 local;
- files verified 5/5 against their checksums;
- backups 6/6 OK.

The DI-1.1 build is preserved in the session scratchpad (`di11c-release/`, checksums in `di11c-release.sha256`).

**Note:** production `c0adf0b` still contains the original data-loss mechanism until DI-1 ships.

## 20. Formal acceptance status (2026-11-26)

**Recommendation: DI-1 — PASS** (subject to your formal approval).

| Requirement | Evidence | Status |
|---|---|---|
| Unreadable list never treated as empty; no delete on read; quarantine | §4–§6; 22 DI-1 tests (S5b/S5c/S6a–e and fault cases) | PASS |
| Writes blocked while protected; cleanup only after a verified read; tombstones | §6–§7; tests | PASS |
| Per-entry validation; backup with verification; recovery only as a user decision | §8–§9; tests | PASS |
| Persistent privacy-safe diagnostics; read-only diagnostics view (DI-1.1) | §10, §18; 9 DI-1.1 tests; real-browser layout check | PASS |
| Physical gate: backup created and verified on the TV | §19: Healthy · 1 · Valid · 1 · Passed · 12:17 | PASS |
| Physical regression with DI-1 (S5) | `S5-PHYSICAL-VERIFICATION-REPORT.md`: 22 PASS, 2 INCONCLUSIVE, 0 FAIL | PASS (with 2 INCONCLUSIVE items) |
| Production baseline compatibility | DI-1-only patch on `c0adf0b`: 383 / 383, build OK. Today: `kv-store`, `diag-log`, `catalogue-store` and `common.ts` are byte-identical to the candidate; `playlist-service` differs only by 1 changed and 84 added lines (CP1, DI-1.1, S2) | PASS |
| Full automated suite (final run today) | typecheck OK; compat 134 files, 0 findings; unit **438 / 438**; build **6 / 6**; `release-check` OK; Android build OK | PASS |

**INCONCLUSIVE (no evidence was turned into a PASS):**
- **A3:** the recent storage events were not recorded on the TV.
- **E5:** parental-control protection was not recorded as physically tested. It is covered by S3 tests 5 and 14.

**Critical or high data-integrity issues open: none in the candidate.** The one high-severity issue is **in production**: `c0adf0b` on the TV still contains the original data-loss mechanism until this release is installed. This is the reason to release before CP2.

**Residual risks** (accepted; from §14, the S2 and S3 limitations, and S5):
1. The TV-side trigger of the incident is still unknown. DI-1 contains it and the persistent log will record a next occurrence.
2. Wiped storage with no backup and no catalogue files can't be told apart from a first installation.
3. Other small settings keys are quarantined, but their features may overwrite them afterwards.
4. Per-file catalogue corrupt-discard is unchanged (re-downloadable data).
5. Files of unknown owners are never auto-deleted (storage growth).
6. Tombstones are lost on a localStorage wipe.
7. Backup and quarantine share the app sandbox.
8. `read-error` offers only "Try again".
9. The backup checksum is not cryptographic.
10. A brief "checking" phase at start-up.
11. Tizen localStorage read failures have not been observed.

**Release.** Candidate, version recommendation (0.3.0), installation, stop conditions and rollback: see `DI-1-RELEASE-PLAN.md`.
