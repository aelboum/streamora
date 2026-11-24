# Security Decisions

Stage 3, 2026-11-22; updated for Stage 4 (playlist engine and Xtream client), 2026-11-23. Approved architecture: `docs/ARCHITECTURE.md` rev 3.

Stage 4 additions: S5 (TV redirect evidence), S6 (redaction), S8 (credentials and the stored catalogue), S9 (untrusted playlist content), S10 (Xtream client rules). Stage 4B: S2 rewritten (PIN hardening P1–P4) and S11 (playlist screens).

Status tags:
- **[W]** implemented and unit-tested on Windows;
- **[TV]** verified on the UE50MU6100 (evidence: `docs/evidence/stage3-tv-selftest.jsonl`, probe reports);
- **[A]** assumption, not yet verified.

## S1. Credentials stay on the TV, in the key manager

| Decision | Detail | Status |
|---|---|---|
| Playlist secrets are stored only through `KeyStore` | Xtream username/password, or an M3U URL that embeds credentials. Path: `src/storage/secret-store.ts` → `platform.keyStore` → `tizen.keymanager` (`src/app/platform/tizen-key-store.ts`), alias `ss_pl_<playlistId>`. | [W] adapter; [TV] save/overwrite/load/remove via the self-test |
| No plaintext fallback | Without a key store, `ctx.secrets` is `null` and the UI must refuse to save credentials. The browser development platform uses an in-memory store, forgotten on reload. | [W] |
| Values never leave through errors or logs | Key-store and secret-store errors are replaced by generic messages. Values are validated (length, no control characters). | [W] |
| No per-item password | Key-manager data is saved with a `null` password and relies on the key manager's per-application access control. Encryption at rest is a platform property and was not inspected. | [A] |
| Overwrite = remove + save | The key manager does not overwrite an alias. A crash between remove and save loses the secret (the user re-enters it); it never exposes it. | [W], [TV] |

## S2. Parental PIN (hardened in Stage 4B: P1–P4 of `docs/SECURITY-PIN-FOLLOWUP.md`)

| Item | Decision |
|---|---|
| Algorithm | **PBKDF2 (RFC 8018) with HMAC-SHA-256**, run by the platform WebCrypto: `crypto.subtle.importKey('raw', pin, {name:'PBKDF2'}, false, ['deriveBits'])`, then `deriveBits({name:'PBKDF2', hash:'SHA-256', salt, iterations}, key, 256)`. No home-made construction and no JavaScript fallback. |
| Work factor (P1) | **600,000 iterations** for every new record. Configuration can raise it but not lower it (floor 600,000). Older records of at least 100,000 still verify and are re-hashed at 600,000 on the next successful check. Measured on the TV: verify 0.80 s; set (PIN + recovery code) 1.7 s [TV]. |
| PIN length (P2) | New and changed PINs: **6–8 digits**. An older 4–5 digit PIN still verifies; the result carries `upgradeRequired`, and the Stage 8 PIN screen will ask for a new PIN. |
| Salt / output | 16 random bytes from `crypto.getRandomValues`, new for every write; 32-byte output. |
| Storage (P4) | **Tizen key manager**, not localStorage. Two aliases `ss_pin_a` / `ss_pin_b` hold `{v:2, gen, alg, it, salt, dk, rc}`. A Stage 3 record found in localStorage is moved into a slot on load and then deleted. |
| Crash-safe replacement (P4) | The key manager can't overwrite an alias. A new record is written to the **other** slot with `gen+1`; only after that save succeeds is the old slot removed. On load, the valid record with the highest `gen` wins and a leftover slot is removed. A crash at any step leaves the old or the new PIN, never none. [W] simulated crash before each step; [TV] interrupted removal then restart: new PIN wins, stale slot removed. |
| Fail closed | A slot that exists but holds no valid record (corrupt, tampered, lowered iteration count), or a key manager that can't be read, puts the service in state `unavailable`. Then `hasPin()` is true, every check fails, and setting a new PIN over it is refused. The only way out is the content-wiping reset. |
| Recovery code (P3) | 12 symbols of Crockford base32 (60 bits), drawn from `crypto.getRandomValues` (one byte per symbol, `& 31`, no modulo bias). It is shown once when the first PIN is set, or when it is regenerated (which needs the PIN). Only its PBKDF2 verifier is stored (own salt, 600,000 iterations), in the same key-manager record. Input tolerates case, dashes and look-alike letters (O→0, I/L→1). |
| Change | Needs the current PIN; keeps the recovery code. |
| Authenticated reset (P3) | `resetWithPin` or `resetWithRecoveryCode` removes the PIN record and every `parental.*` setting. Playlists are untouched. |
| Unauthenticated reset (P3) | Needs the exact phrase `RESET PARENTAL CONTROLS AND DELETE PLAYLISTS`. It **deletes every playlist, its credentials and its catalogue files first** (`PlaylistService.removeAll`, which also aborts a running import), and only then the PIN and parental settings. A journal (`parental.wipe`) resumes an interrupted wipe on the next start. If deleting the content fails, the PIN stays. |
| Failed attempts | Counted persistently (`parental.attempts`, localStorage) for PIN and recovery-code checks alike. After 5 failures, every check (verify, change, both authenticated resets, regenerate) is refused for 60 s. Concurrent operations return `busy`. |
| Comparison | Recompute, then `constantTimeEqual` (full-length XOR, no early exit). |
| No default PIN | `hasPin()` is false until a PIN is set (state `none`). |
| Never exposed | PINs and recovery codes are never logged, stored in clear, or returned in errors. Error logs carry no error object, because it could hold a value. The dev self-test result keys avoid the word "pin" so the redactor doesn't hide the measurements. |
| Remaining limit | A numeric PIN protects against casual use on the device. Someone who can extract the app's key-manager data can still brute-force 10⁶ PINs offline (6 × 10¹¹ PBKDF2 iterations). Whether the key manager encrypts data at rest wasn't inspected [A]. |

Verification:
- [W] `pin.test.mjs`, 19 tests: published PBKDF2 vectors; record = PBKDF2(pin, salt, 600,000); key-manager storage and nothing in localStorage; P2 formats and migration of a Stage 3 4-digit record; lockout across verify, change and reset; recovery-code generation (150 codes, all 32 symbols, roughly uniform), verifier only, regeneration; both reset kinds; wipe order; interrupted wipe resumed; crash before every replacement step; highest generation wins; corrupt, tampered or unreadable record fails closed.
- [TV] Stage 4B self-test on the real key manager and WebCrypto: set, verify, wrong PIN rejected, change with a simulated power loss before the old slot is removed, restart (new PIN wins, one slot left), old PIN rejected, recovery-code reset (no slots left). Timings in TEST-REPORT.md §9.
- Not yet: PIN screens (Stage 8).

## S3. Network: user-entered endpoints

| Decision | Detail | Status |
|---|---|---|
| Two URL policies | `strict` (https, allowlisted host, port 443) and `userSource` (http/https, any host and port). Both reject userinfo, whitespace, control characters, non-http(s) schemes and URLs over 2,048 characters. | [W] |
| No credentials in headers or cookies | The client never calls `setRequestHeader` and sets `withCredentials = false`. | [W] |
| Credential-bearing URLs must declare their origin | `carriesCredentials()` uses the redaction rules (query parameters, Xtream paths, opaque tokens). Such a URL is refused before any request unless `credentialOrigin` is given and equals the request origin. | [W] |
| Size and time limits | Default 2,000,000 characters per response. Streaming downloads need an explicit cap (config: 100,000,000). Total and idle timeouts plus a backstop timer. | [W] |
| Plain HTTP | Allowed for user sources, because most IPTV servers are HTTP-only. The UI will show a one-time cleartext notice (Stage 4). | decision |

## S4. config.xml

- `<access origin="*" subdomains="true"/>`.
- CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: http: https:; media-src http: https:; connect-src http: https:`. No `unsafe-*`, no remote script.
- Privileges: internet, tv.inputdevice, filesystem.read, filesystem.write, keymanager. `unlimitedstorage` is not requested (no effect, probe 2).
- `scripts/lib/release-check.mjs` fails a release build whose config deviates. [W] build test; [TV] the dev build with this config installed and ran.

## S5. Redirects (requirement: never forward credentials to a redirected host)

**Limitation.** On Tizen 3.0 the only usable network API is XMLHttpRequest. XHR follows HTTP redirects inside the engine; there is no option to stop at a redirect or approve it before the next request is sent. `fetch(..., {redirect: 'manual'})` exists on the TV, but is untested for remote URLs and fails for packaged files (probe 1). **The app therefore cannot validate a redirect before the redirected request is sent.**

What actually reaches a redirect target, and the safe alternative implemented:

1. **Nothing the app adds.** No headers, no cookies (`withCredentials = false`), no userinfo. A browser never copies the original query string or path onto a redirect target. [W]
2. **Credential-bearing URLs.** Xtream credentials are part of the URL the user's own server receives. A redirect target can only see them if that server writes them into the `Location` header, meaning the server already holds them and chooses to disclose them. The app can't prevent that and doesn't try to.
3. **Detection and discard.** At `HEADERS_RECEIVED`, before the body is read, the client compares `responseURL` with the request. The request is aborted, the body discarded and the result reported as `redirect-blocked` if:
   - a credentialed request ended on any other origin (including an https→http downgrade on the same host), or
   - any request ended on a URL the policy rejects.

   [W] tests; [TV] `responseURL` is present and accurate on the TV's XHR (Stage 3 self-test).

   **Real redirects on the TV [TV, Stage 4 self-test, two runs].** Dev-sink fixture: a 302 from port 8097 to port 8098, a different origin.

   | Request | TV behaviour | Client result |
   |---|---|---|
   | Credentialed URL, redirected to another origin | The TV's XHR **did send** the follow-up request to the second origin (logged by that server) before the app saw any headers | `redirect-blocked`; body discarded |
   | Credentialed URL, redirected on the same origin | Followed | ok, `redirect: same-origin` |
   | URL without credentials, redirected to another origin | Followed | ok, `redirect: cross-origin` |

   This confirms the limitation: the redirected request leaves the TV before the app can stop it. The follow-up URL was the server's `Location` value, which in this test carried no credentials. The app never adds a header or cookie.
4. **No propagation.** Follow-up credentialed URLs are always built from the configured server origin, never from `responseURL` or response content. Stage 4: the Xtream client builds every URL from the normalised server origin and ignores the panel's `server_info.url`/`port` (test: `xtream-client.test.mjs` "authentication").
5. **Unknown state.** If an engine lacks `responseURL`, the result reports `redirect: 'unknown'`. The UE50MU6100 does provide it [TV].

Residual risk: a malicious or compromised IPTV server can redirect the device to another host carrying credentials the server already knows. Accepted: that server is the party the user gave the credentials to.

AVPlay (Stage 7) follows stream redirects inside the media engine; the same analysis applies, and the app can't inspect those redirects.

## S6. Logging

Entries are structured as `{t, level, component, msg, data, err}` and kept in a 200-entry in-memory ring buffer. There is no remote telemetry.

Every string and object is redacted on entry:
- sensitive keys (password, token, pin, username, mac, email, …);
- `Authorization`-style tokens;
- URL userinfo;
- sensitive query parameters;
- Xtream `/live|movie|series|timeshift/<user>/<pass>/` path segments;
- Xtream stream paths without the type prefix, as used in M3U links (`scheme://host/<user>/<pass>/<id>[.ts|.m3u8|…]`; Stage 4);
- opaque path tokens of 20+ characters;
- e-mail addresses.

The dev-only LAN sink receives already-redacted entries and is removed from release builds (release check, build test). [W]

## S7. Storage integrity

- Catalogue files carry a header with payload length and an FNV-1a checksum. This guards against torn writes; it is not tamper protection.
- Corrupt, truncated, outdated or mismatched files are deleted and reported, so the catalogue is re-downloaded. [W]
- Atomic replacement is write-temp-then-`File.moveTo`. **`moveTo` works on the TV [TV]** (self-test: `atomicReplace=true`). The direct-write fallback remains for robustness. [W]

## S8. Credentials and the stored catalogue (Stage 4)

| Decision | Detail | Status |
|---|---|---|
| Playlist URL is a secret | The full M3U URL usually contains the username and password, so it is stored only in the SecretStore. The playlist definition in localStorage keeps only the origin (`server`). | [W] |
| Credentials removed from catalogue files | Stream URLs repeat the account (`…/U/P/123`, `?username=U&password=P`). Before storing, the playlist's own credentials are replaced. Xtream-layout URLs at the playlist origin become an Xtream reference `{type, id, ext}`. Other URLs keep `{U}`/`{P}` placeholders and a `cred` flag. Header EPG URLs get the same treatment. Credentials are substituted only at play time (`resolvePlayback`, `resolveEpgSources`), and the result is never stored or logged. | [W]: tests scan the KV store, every catalogue file and the log for the password |
| Xtream stream URLs | Never stored: rebuilt at play time from the configured server, the secret and the playlist's live format. | [W] |
| Unrecognised tokens | A per-stream token the app can't recognise as the account credentials (for example `?token=abc`) is stored as part of the URL in app-private file storage. It can't be separated without knowing what it is. | limitation (O7) |
| Credentials go only to their origin | Credentialed requests (playlist download, Xtream API) declare `credentialOrigin` = the configured origin. Placeholders are filled in only for URLs the provider's own playlist wrote; the app never adds credentials to any other URL. | [W] |
| Without a key store | `ctx.playlists` is `null` when the key manager or file storage is missing; there is no plaintext fallback. | [W] |

## S9. Untrusted playlist and provider content (Stage 4)

| Threat | Handling | Status |
|---|---|---|
| Script/HTML in names, groups, EPG text | Kept as inert text; control, zero-width and bidi-override characters removed; lengths capped (title 200, group 100, ids 128). Rendering is `textContent` only; the compat gate bans `innerHTML`. | [W] |
| Dangerous URLs (`javascript:`, `data:`, `file:`, `rtmp:`, userinfo, whitespace, over 2,048 characters) | Every stream, logo, EPG and referrer URL goes through the `userSource` URL policy; failures are dropped and counted. | [W] |
| Oversized input | Caps: download 100,000,000 characters (`maxPlaylistChars`); line 8,192 characters (longer lines are skipped without buffering); 500,000 entries; JSON element 100,000 characters; small JSON responses 2,000,000. | [W] |
| Wrong content type | An HTML or JSON body is recognised by its first visible character and the download is stopped. An HLS manifest is recognised and imported as a single stream. | [W] |
| Malformed provider JSON | Every field is read through tolerant converters and validated; invalid items are dropped and counted; path-like ids are rejected. | [W] |
| Corrupt stored catalogue | Header length and checksum (Stage 3), plus per-row validation on decode. A live file that doesn't match the meta checksum is reported as `inconsistent`. | [W] |

## S10. Xtream client (Stage 4)

- The server address is normalised to an origin (scheme://host[:port]). Paths, queries and fragments are rejected, except a pasted `/player_api.php` or `/get.php`.
- Credentials are URL-encoded into the `player_api.php` query only, never into headers.
- `auth: 0`, HTTP 401/403 and an error object on the stream-list endpoint all map to `auth`. An expired or non-active account fails the import and the previous catalogue is kept.
- Errors carry a code and a fixed message, never the URL. Test: `xtream-client.test.mjs` "errors and results never contain the credentials".
- Plain HTTP is allowed because most panels are HTTP-only. `needsCleartextNotice()` flags an HTTP playlist until the user has seen the notice. The notice screen itself comes with the playlist screens (O5).

## S11. Playlist screens (Stage 4B)

| Rule | Implementation | Status |
|---|---|---|
| Credentials are never read back into the UI | The edit form shows "Unchanged" for the username, password and M3U address and never asks the SecretStore for them. A credential is only sent to the service when the user types a full replacement. | [W] UI tests |
| Typed secrets are masked | The password field shows dots on the form and in the keyboard (optional "Show"). URLs on the form are shown through the redactor, so `password=` values, Xtream paths and tokens appear as `•••`. | [W] |
| Typed values are short-lived | The form clears typed credentials after saving and when it is destroyed; the keyboard clears its value on close. | [W] |
| No HTML | Every screen renders through `h()`/`textContent`; the compat gate bans `innerHTML`. Playlist names are shown as typed or as imported (inert text). | [W] |
| HTTP warning before the first import | Shown for `http://` playlists until accepted (`markCleartextNoticeSeen`). "Cancel" is focused first; nothing is sent before Continue. A new server address shows it again. | [W]; [TV] shown once in the injected-key run |
| Errors in plain language | Import errors are shown by code (`err.*` strings, English and Dutch); no URL or server text is displayed. | [W] |

## S12. Live TV, player and EPG (Stage 5)

| Rule | Implementation | Status |
|---|---|---|
| Stream URLs are built at play time and never stored or logged | `PlaylistService.resolvePlayback` → `LiveController` → engine. The controller logs channel ids and error codes only; AVPlay receives the URL. | [W] test: log has no credentials |
| AVPlay follows redirects itself | Unchanged limitation (S5, O8): the app can't inspect or block stream redirects. | accepted |
| EPG URLs with credentials | Requested with `credentialOrigin` = the origin of the URL that the provider wrote (header `url-tvg`, Xtream `xmltv.php`). The stored guide contains no URL. | [W] |
| Untrusted guide text | XMLTV titles and descriptions are entity-decoded, cleaned, capped (title 200, description 500), and rendered with `textContent` only. Markup inside elements is never kept as markup. | [W] |
| Guide size | Download capped (`maxPlaylistChars`), tags over 16 K characters skipped, at most 300 programmes per channel and 400,000 in total. | [W] |
| Prototype keys | XMLTV channel ids are used as object keys; `__proto__` is refused and lookups use own properties only. | [W] |
| Xtream short EPG | Through `PlaylistService.shortEpg`, so the credentials stay inside the service; cached 15 min per channel. | [W] |

## S13. System keyboard (IME) (Stage 5)

| Rule | Implementation | Status |
|---|---|---|
| Password fields | `<input type="password">` with autocomplete, autocorrect, autocapitalize and spellcheck off. The value is read only on Done. The field is cleared on close, cancel and fallback. Nothing is logged. | [W] |
| Keys while typing | While the IME owns the field, the key router passes only Back; the first Back closes the IME, and the second cancels the dialog. | [W]; physical remote not yet |
| Fallback | "On-screen keyboard" hands the typed text to the app keyboard and closes the IME dialog. `config.ui.keyboard = app` forces the app keyboard. | [W] |
| Samsung IME key codes | Done 65376, Cancel 65385 (Samsung documentation [A]); Enter 13 also accepted. | [A]; only the Done path was exercised on the TV, via a dispatched event |

## S14. Compressed guides and playback recovery (Stage 5.1)

| Rule | Implementation | Status |
|---|---|---|
| Untrusted compressed input | `src/content/gzip.ts` is a bounds-checked decoder written for this project, with no dependency. Every Huffman table is validated (over-subscribed codes, missing end-of-block code, repeat codes beyond the table and lengths over 286/30 are rejected). Distances that reach before the start of the data are rejected. Stored-block lengths are checked against their complement. Header fields are size-capped (name 64 KiB, comment 128 KiB). | [W]: corruption fuzz in `gzip-epg.test.mjs` (every flipped byte detected) |
| Decompression bombs | Decoded bytes are capped (`network.maxPlaylistChars`, 100 M); decoding stops at the cap with `too-large`. The compressed download has its own cap (`epg.maxGzipMB`, 30 MB). The output of one push is at most the 2 KiB input piece times the ratio, and the cap is checked between 32 KiB output buffers. | [W]: 50 MB of zeros stopped at 1 MB; [TV] not tried with a bomb |
| Integrity | CRC-32 and ISIZE of every gzip member are verified. Damaged, truncated or empty files fail with `bad-gzip`; the previous guide stays in use (nothing is saved unless the whole guide verified). | [W]; [TV]: corrupt and truncated fixtures failed, guide kept |
| Credentials | gzip guide URLs follow S12 unchanged: `credentialOrigin`, no logging, no credentials in the stored guide. The binary download uses the same XHR client and redirect checks; only the MIME type is overridden. | [W] test: log and cache contain no credentials |
| Playback stall reopen | Reopens the same stream once with the same resolved source; no new URL is built and nothing is logged beyond the channel id and elapsed time. | [W] |
| AVPlay traces | Debug-level only (off by default); session numbers, AVPlay states, error type names and elapsed times. Never URLs. | [W] by construction; [TV] dev traces reviewed |

## Open security items

| # | Item | Status / when |
|---|---|---|
| O1 | `responseURL` on the TV's XHR | **Closed**: present and accurate [TV] |
| O2 | `File.moveTo` and `listFiles` on the TV | **Closed**: both work [TV] |
| O3 | PBKDF2 at 100,000 iterations on the TV | **Closed**: 157 ms [TV] |
| O4 | Observe a real cross-origin redirect on the TV | **Closed (Stage 4)**: the TV follows it and sends the redirected request; the client blocks the response [TV] (S5) |
| O5 | Cleartext notice for HTTP playlists (UI) | Service part done (`needsCleartextNotice`, `markCleartextNoticeSeen`) [W]; the screen comes with the playlist UI, which is not in the Stage 4 scope |
| O6 | PIN hardening (600,000 iterations, 6 digits, authenticated reset, key-manager verifier) | **Closed (Stage 4B)**: implemented (S2); [W] and [TV] |
| O9 | Attempt counter in localStorage: someone with storage access can reset it (that person can also brute-force offline) | Accepted |
| O10 | PIN screens: upgrade prompt for short PINs, recovery-code display, reset flows | Stage 8 |
| O11 | Attempt counter in localStorage (storage-reset bypass), offline PIN guessing, recovery-code handling | Recorded in `docs/SECURITY-PIN-FOLLOWUP.md` F5–F7 (Stage 5); not implemented |
| O12 | Compressed (.gz) XMLTV: an own inflate parses untrusted binary input | **Closed (Stage 5.1)**: S14; hardened decoder with size limits, CRC checks and corruption tests [W], verified on the TV with valid, corrupt and truncated guides |
| O7 | Unrecognised per-stream tokens are stored in catalogue files | Accepted limitation (S8) |
| O8 | AVPlay follows stream redirects inside the media engine | Unchanged from S5; Stage 7 |
