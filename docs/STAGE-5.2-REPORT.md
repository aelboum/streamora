# Stage 5.2 report — Xtream Live TV channel list could not be read

Date: 2026-11-24. TV: Samsung UE50MU6100, Tizen 3.0. Status: **root cause confirmed, fixed, and verified on the TV with your real Xtream playlist.** You have confirmed it is working. Nothing was committed, pushed, tagged or released.

## 1. Symptom

1. You added a real Xtream playlist (server, username and password) on the TV.
2. The playlist was added and its channels downloaded successfully.
3. Opening Live TV showed "The channel list couldn't be read. Update the playlist to download it again."
4. Later, Live TV showed no channels at all.

## 2. Root cause (confirmed)

Two defects together:

**Defect 1, the TV file storage corrupts non-ASCII text (primary cause).**
- Tizen 3.0's `FileStream` (opened as UTF-8) mixes up bytes and characters when text contains multi-byte characters.
- On write and read the text is shifted and gets longer, and emoji become U+FFFD.
- Your provider's list has 21,986 channels and about 4,800 non-ASCII characters in channel and category names (Arabic, superscripts such as ᴴᴰ, ™, Greek and others).
- The saved channel list therefore failed its integrity checksum the first time Live TV read it.
- `CatalogueStore.load` then treated the file as corrupt and **deleted it**, as designed for damaged files.

**Defect 2, "Update" could not repair it.**
- `PlaylistService.store` skips rewriting the channel list when the downloaded content has the same checksum as the last import (incremental update).
- It did not check that the file still existed. After the file had been deleted, every update reported success ("unchanged"), but the list stayed missing.
- From then on Live TV found metadata without a channel list and showed no channels.

Not the cause, checked and ruled out:
- the Xtream response;
- normalisation of the data;
- the channel count;
- playlist selection;
- the Xtream versus M3U handling;
- the storage key or namespace;
- any race in loading.

## 3. Failure location

| Step | File / function | What happened |
|---|---|---|
| Save | `src/app/platform/tizen-file-store.ts` → `write` (TV `FileStream.write`) | non-ASCII text written incorrectly by the TV |
| Load | `src/storage/catalogue-store.ts` → `load` | header checksum mismatch → `discard()` deletes the file → `corrupt` |
| Live TV | `src/services/playlist-service.ts` → `loadLive` → `src/screens/live-tv-screen.ts` → `loadAll` | status not `ok` → "The channel list couldn't be read" |
| Update | `src/services/playlist-service.ts` → `store` → `CatalogueStore.save(…, { unlessChecksum })` | unchanged content skipped although the file was missing → status `inconsistent` ("channel list missing") forever |

## 4. Evidence (TV, diagnostic build, credentials never logged)

Your playlist on the TV before the fix:
- one Xtream playlist;
- the metadata file present (370 categories);
- the channel list file `cat.<id>.live.json` **missing**;
- `loadLive` returned `inconsistent: channel list missing`.

Update with the original code:

| Measurement | Value |
|---|---|
| Channels received / normalised / saved | **21,986 / 21,986 / 21,986** (0 invalid, 0 duplicates), 370 categories |
| Channel list file written | 2,321,875 characters, 4,805 non-ASCII |
| Reading it back | `catalogue: discarding file … reason: checksum mismatch`, then the file is deleted |
| Written versus read text | same length; from character 102,063 on the text is shifted (1,490,816 characters differ) |
| A second update | `unchanged: true`, so not rewritten; the file stays missing |

Storage probes on the TV with synthetic text:

| Text | Result |
|---|---|
| 300,000 ASCII characters | identical |
| 90,000 characters with 1,800 "é" (one write) | **91,800** characters come back |
| 300,000 characters, an "é" every 5,000th | 300,019 back, shifted at each 102,400-character write chunk |
| Arabic or U+1D34 (ᴴ) every 50th character | longer and shifted |
| Emoji (inside a chunk or across a chunk) | come back as U+FFFD |

(A probe with only 9 non-ASCII characters seemed fine, because the shift fell inside padding. Every earlier Stage 4/5 TV test used ASCII-only synthetic channel names, so the problem never appeared.)

## 5. Data flow

1. **Import:** `XtreamClient` streams `get_live_streams`, `parseLiveStream` normalises the entries, and `createLiveBuilder` builds 21,986 rows.
2. **Save:** `CatalogueStore.save` wrote the header plus the JSON payload with raw non-ASCII characters, and the TV `FileStream` stored it damaged. The metadata was saved with the checksum of the correct text.
3. **First Live TV open:** `loadLive` read the channel list, the checksum didn't match, so the file was deleted and Live TV showed "couldn't be read".
4. **Later opens:** metadata OK, channel list missing → `inconsistent` → no channels.
5. **Update:** same content, same checksum → skipped → still missing.

## 6. Reproduction

On the TV, with the original code:
1. Add a playlist whose channel names contain non-ASCII characters.
2. Import it.
3. Open Live TV: "couldn't be read".
4. Update, then reopen: still no channels.

On Windows (regression tests): `tests/unit/unicode-storage.test.mjs` uses a file store that damages non-ASCII text the way the TV does. Without the fix, 3 of its 5 tests fail.

## 7. Impact

- **Affected:** every playlist on this TV, M3U or Xtream, whose channel or category names contain any non-ASCII character. That is almost every real provider list. It also affected the cached programme guide, because programme titles are often non-ASCII.
- **Not affected:** lists with pure ASCII names, which includes all the synthetic test lists used until now.
- **Deterministic:** the same list always fails.

## 8. Correction (implemented)

Both changes are in `src/storage/catalogue-store.ts`; there is no new dependency.

1. **ASCII-only files.** `save` passes the JSON text through `escapeNonAscii`, which replaces every character above U+007F, including emoji and lone surrogates, with its `\uXXXX` escape. `JSON.parse` restores exactly the same text, so names display unchanged.
   - Files written before the fix stay readable, and there is no format version change.
   - Your list grew from 2.32 M to 2.35 M characters (+1 %).
   - The size limit is checked after escaping.
2. **Repairing updates.** An unchanged section is skipped only if its file still exists. If it is missing, it is written again and a warning is logged.

Unchanged:
- AVPlay and playback;
- the PIN and security code;
- credentials and their handling;
- the Xtream client;
- the catalogue file structure (header + JSON).

## 9. Verification

**On the TV, with your real playlist and the fix:**

| Check | Result |
|---|---|
| Update | 21,986 channels, 370 categories, `unchanged: false` (rewritten) |
| Written versus read back | 2,345,762 characters, **0 differences**, 0 non-ASCII characters in the file |
| Live TV load | **ok: 21,986 channels, 370 categories**; the file stays on disk |
| Confirmed by you | Live TV working |

**Automated [W]:**
- `npm run check` passed: **216 unit tests** (+5) and 5 build tests;
- compatibility check: 83 files, 0 findings;
- release check: OK.

**New regression tests** (`tests/unit/unicode-storage.test.mjs`):
1. `escapeNonAscii` round trip (accents, Arabic, superscripts, emoji, lone surrogates).
2. A catalogue section with non-ASCII text survives a TV-like file store, and the file is pure ASCII.
3. An unchanged section whose file is missing is rewritten.
4. Xtream import with non-ASCII names, then Live TV loads every channel.
5. Update repairs a missing channel list even when the provider data is unchanged.

## 10. Data safety

**Never touched:** your playlist definition, server address, username and password.

**What happened to the channel list:**
- The original channel list had already been deleted by the app itself, the first time Live TV opened (the catalogue store discarded it as corrupt).
- During the diagnosis, the app's normal "Update now" ran several times and re-downloaded it.
- The current list was written by the fixed code and verified.

**Credentials:**
- never logged;
- not copied into fixtures or documents;
- the tests use synthetic values.

## 11. How the diagnosis was done

- **Diagnostic builds:** built from a **scratch copy** of the source (the repository was not changed for the diagnostics), installed temporarily on the TV, with the log sent to the PC.
- **What they logged:** file sizes and headers, channel counts, load results, and character-code differences between the written and the read-back text. Never names, URLs or credentials.
- **Afterwards:** the normal release build was reinstalled; the PC log sink is stopped.

## 12. Files changed

- `src/storage/catalogue-store.ts`: `escapeNonAscii`; the size check after escaping; rewrite when the file is missing.
- `tests/unit/unicode-storage.test.mjs`: new, 5 tests.
- `docs/TIZEN-COMPATIBILITY.md` §8, `docs/IMPLEMENTATION-STATUS.md` (L27), this report.

## 13. Remaining risks and follow-ups

- **Other file writes:** any other future use of the TV file store must also avoid non-ASCII text. Only the catalogue store uses it today. This is now documented (TIZEN-COMPATIBILITY §8).
- **Playback not checked:** playback from this provider was not verified in this investigation.
- **Diagnostics screen:** it shows only the last 8 log messages without their details. Showing the reason for a failed list load there would make a future problem like this quicker to diagnose (suggestion, not implemented).
- **Visible "Update" action:** Live TV's message says to update the playlist; with defect 2 fixed, that advice now actually works.
