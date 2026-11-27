# AI-02 — API key with the phone (QR), end-to-end encrypted

Date: 2026-11-27.

**Status:** deployed and **physically verified by the user on 2026-11-27**. The relay is live at `https://pair.elitestreamplayer.com`. The user installed 0.3.5 on the Samsung UE50MU6100 as an upgrade, sent a real Gemini key from their phone, saved it and ran Test connection, which **passed**. The code is local and uncommitted.

Findings from the physical test, all fixed the same day:
- The first QR code (version 7, 7.9 px per module) scanned only once in several tries. It is now version 5 at a whole 12 px per module (see §1).
- New AI Studio keys use the **"AQ." auth-key format** (default since 2026-05-28; about 53 characters, with dots). The phone page and the TV accepted only "AIza…" keys. Both now accept both formats, and AQ. keys are also redacted in logs and blocked in prompts (`tests/unit/ai-key-format.test.mjs`). An AQ. key works through the `x-goog-api-key` header.
- The phone page now removes spaces, line breaks, invisible characters and quotes that copying adds. When it still refuses a value, it says why (length, the kind of character and its position) without ever showing the value.
- The TLS chain of `pair.elitestreamplayer.com` is **Let's Encrypt** (YE1, then Root YE, then ISRG Root X2, then ISRG Root X1). On the Free plan the certificate authority cannot be chosen. The 2017 Samsung **does accept** this chain.

This replaces typing a 39-character key with the remote. It is the "safe way" proposed in `AI-02-QR-PAIRING-REPORT.md` (option 2), using the owner's Cloudflare domain **elitestreamplayer.com**. The experimental fake-key QR test (`AI-02-QR-UI-TEST-REPORT.md`) stays dev-only and separate.

## 1. How it works

1. On the TV, go to Settings → AI Intelligence → **"Google Gemini API key with phone (QR)"**.
   - The TV creates a **fresh X25519 key pair** for every code.
   - It shows a QR code for `https://pair.elitestreamplayer.com/#2.<TV public key>.gemini`.
   - Both sides derive the 128-bit relay session id from the public key: base64url of the first 16 bytes of SHA-512("ES-PAIR-SID" || public key). The relay sees only this id and cannot recover the key from it.
   - The QR code is version 5 at level L (37×37 modules), drawn at a whole 12 px per module (540 px). Before 2026-11-27 it was version 7 at level M (45×45 modules) at a fractional 7.9 px per module, which the user found hard to scan on the TV. The phone page still accepts the older `#v1.<session id>.<public key>.<provider>` links.
   - Everything after `#` is the URL fragment, which the browser **never sends to a server**.
2. The phone opens the page, the user pastes the key and taps **Send to TV**.
   - The page encrypts `{v, provider, key}` to the TV public key with **nacl.box** (X25519 + XSalsa20-Poly1305), using a fresh phone key pair and nonce.
   - It then wipes the plaintext and the phone secret key.
   - It posts only the sealed envelope `{v, epk, n, c}`.
3. The relay (a Cloudflare Worker with one Durable Object per session) stores that **one** envelope.
   - It hands the envelope to the TV **once**, then deletes it.
   - Anything left over is deleted after 5 minutes (expiry) or 10 minutes (purge alarm).
4. The TV polls every 2 s, decrypts locally and **wipes its secret key** immediately. It then shows:
   - a **6-digit check code**, derived on both sides from the two public keys, which the phone shows too;
   - the masked key (`AIza…1234, 39 characters`);
   - **Discard** (focused) and **Save key**.
5. Only **Save key** stores the key, through the existing credential path (`setCredential` → secure key store). After that, run **Test connection** as usual.

Crypto library: **TweetNaCl 1.0.3** (public domain, audited by Cure53).
- It is plain ES5 and needs only `crypto.getRandomValues`, not WebCrypto.subtle, so it suits Tizen 3.0 and old WebViews.
- The phone page uses the identical npm file, vendored as `relay/public/vendor/nacl-fast.min.js`, SHA-256 `3ec535c0…a5131`. A test checks that it matches the npm copy byte for byte.

## 1b. Xtream login with the phone (added 2026-11-27, after the user asked for it)

**Physically verified by the user on 2026-11-27** on the Samsung. Fill in with phone (QR), then send from the phone, then Use these details, then Save: the playlist loads. After the upgrade install, the TV kept running the old app instance until it was restarted (`was_kill`, then `tv:run`).

- **On the TV:** Playlists → Add Xtream account (or Edit) → the first row is **"Fill in with phone (QR)"**. It appears only when phone pairing is available.
- **The QR link:** `…/#2.<TV public key>.xtream`, with the same relay, encryption and check code as the key flow.
- **The phone page** shows Server address, Username, Password (with Show) and an optional Name.
  - A whole provider link such as `http://host:port/get.php?username=…&password=…&type=m3u_plus`, pasted into the server field, is split automatically. `player_api.php` and `xmltv.php` links are split too.
  - Payload: `{ v: 1, p: 'xtream', x: { s, u, w, n } }`, at most about 1,100 bytes.
- **On the TV:** `parseXtreamPayload` (`src/screens/playlist-pair.ts`) accepts only complete details:
  - the server is an http(s) address with no user info;
  - username and password are not empty;
  - no control characters; at most 256 characters (64 for the name).
- **The confirmation screen** shows the check code, the server, and only the *lengths* of the username and password. The confirm button is **"Use these details"**.
- **The details are not stored by the pairing screen.** They fill the form: the server, username, password and, if empty, the name. The form shows "Filled in from your phone…", with Save focused. Saving goes through the normal `PlaylistService` validation and the existing secure storage.
- **Code:**
  - the screen is shared: `ai-phone-pair-screen.ts` takes a `PairPurpose` (`keyPurpose`, `xtreamPurpose`);
  - `pair-crypto.ts` `openSealed` / `openRaw` return the decrypted payload; `openEnvelope` (keys) is built on it.
- **Tests:** payload rules, and the API-key screen and Xtream screen each refusing the other's payload. A full run goes: form, then QR, then the real phone page splitting a `get.php` link, then the relay (which saw only ciphertext), then the same check code with no credentials on the TV, then Use, then the form filled, then Save.

## 1c. M3U playlist link with the phone (added 2026-11-27)

- **On the TV:** Add M3U playlist (or Edit an M3U playlist) → first row **"Fill in with phone (QR)"**, described as "Paste the playlist link on your phone".
- **The QR link:** `…/#2.<TV public key>.m3u`. The phone page's kind pattern now allows digits (`[a-z0-9]{2,20}`).
- **The phone page** shows Playlist link (with Paste from clipboard), an optional Guide (EPG) address and an optional Name.
  - Payload: `{ v: 1, p: 'm3u', x: { l, e, n } }`. A sealed message is at most about 1,100 bytes, which leaves room for a link of roughly 1,000 characters.
- **On the TV:** `parseM3uPayload` (`src/screens/playlist-pair.ts`, renamed from `xtream-pair.ts`) accepts:
  - an http(s) link with no spaces or control characters, at most 2,048 characters;
  - an optional EPG address with the same rule;
  - a name of at most 64 characters.
- **The confirmation screen** shows the check code and the link **with its credentials masked** (`maskUrl`). The confirm button is **"Use this link"**. The form is then filled: the link, the EPG address if one was sent, and the name if empty. Save is focused.
- **Tests:** payload rules and wrong-kind refusal. A full run goes: M3U form, then QR (`.m3u`), then the real phone page, then the relay (ciphertext only), then the masked link and the same check code on the TV, then Use, then Save with the link and EPG address.

## 2. Security properties, and what they do not cover

**What the design guarantees** (tested where marked [T]):
- **The key never travels or rests in plaintext outside the phone and the TV.** The relay holds only ciphertext [T].
- **The relay cannot decrypt, and cannot forge an envelope the TV accepts,** because it never receives the TV public key, which lives only in the QR fragment [T].
- **The QR code contains no secret:** only the page address, the session id and a *public* key [T].
- **One-time use, expiry and cancellation:**
  - one envelope per session; a second one is refused [T];
  - the envelope is handed over once [T];
  - sessions expire after 5 minutes [T];
  - Back, Cancel and expiry on the TV cancel at the relay [T].
- **Tamper detection:** any modified envelope fails authentication [T].
- **Strict input:**
  - the envelope must be exactly `{v, epk, n, c}` with fixed sizes [T];
  - bodies are limited to 2 KB [T];
  - a session locks after 5 bad posts [T].
- **Nothing is stored without confirmation.** The check code must match, and Discard is the default [T].
- **Network allow-lists:**
  - the TV's pairing client can reach only `https://pair.elitestreamplayer.com`; any other origin is refused [T];
  - the Gemini client's allow-list is unchanged.
- **The phone page:**
  - no storage, cookies, analytics or third-party code; CSP `default-src 'none'` with only `'self'` scripts [T];
  - the fragment is removed from the address bar after reading [T].

**Limits (stated plainly):**
- **Trust in the page origin.** The phone runs JavaScript served from `pair.elitestreamplayer.com`. Whoever controls that Cloudflare account, or Cloudflare itself, could serve a modified page that leaks the key. End-to-end encryption protects against the relay *storage and transport*, not against a malicious page. Protect the Cloudflare account with 2FA.
- **Someone who sees the QR code** (photo or shoulder-surfing) within the 5 minutes could send *their own* key first. They cannot read yours. The check-code comparison and the Discard default stop this.
- **Phishing:** the page must only ever be opened from the TV's QR code. The TV never shows any other address.
- **Session ids are visible to the relay.** They identify only a 5-minute mailbox and carry no secret.

## 3. Files

| Part | Files |
|---|---|
| TV crypto/protocol | `src/ai/pairing/pair-crypto.ts` |
| TV screen | `src/screens/ai-phone-pair-screen.ts` (route `ai-phone-pair`) |
| Wiring | `src/ai/ai-config.ts` (`AI_PAIRING_URL = 'https://pair.elitestreamplayer.com'`), `src/ai/ai-engine.ts` (`pairing`), `src/app/bootstrap.ts`, `src/screens/ai-settings-screen.ts` (row), `src/i18n/strings.ts` (19 EN/NL strings) |
| QR renderer | `src/components/qr-code.ts` (moved from the dev experiment, which re-exports it) |
| Relay Worker | `relay/src/worker.js`, `relay/wrangler.toml` |
| Phone page | `relay/public/index.html`, `app.js`, `app.css`, `_headers`, `vendor/nacl-fast.min.js` |
| Local emulator | `relay/local-relay.mjs` (tests; `node relay/local-relay.mjs` serves http://localhost:8787) |
| Tests | `tests/unit/ai-phone-pair.test.mjs` (9 tests); `tests/build/qr-pairing-build.test.mjs` updated |
| Dependencies | `tweetnacl` 1.0.3 and `qrcode-generator` 1.4.4 are now runtime dependencies (exact); `npm audit`: 0 |

The row appears only when `AI_PAIRING_URL` is set, a key store exists and the platform has a cryptographic random source. Release bundle: 623 KB (`app.js`), ES5 check OK.

## 4. Test results

- Unit tests **480/480**, including the 9 new tests. Build tests **7/7**.
- Typecheck OK; compat check: 0 findings; `npm run build:all` OK (release check OK; Android 0.3.5-beta.1 debug APK).
- **Full runs [T].** The real phone page script (in a sandbox) and the real Worker code (in-memory Durable Object) run against the TV screen:
  - the QR shown on the TV screen is **decoded back from its SVG with jsQR**;
  - the phone encrypts and posts; the TV shows the **same check code** as the phone and the masked key; Save stores it;
  - also tested: Discard, Back/cancel, expiry with New code, a failing key store, an invalid link and an invalid key.

## 5. Deployment (done 2026-11-27, with the owner's approval)

Done: Worker `elitestream-pair` on the custom domain `pair.elitestreamplayer.com`, deployed with wrangler 4.168.0. The login is an OAuth token with 8 scopes: account, user and zone read; workers, scripts and routes write; ssl_certs write; offline access. Telemetry was off for each deploy. The live mailbox was checked with a dummy envelope. Step 1 below was not possible on the Free plan, and it was not needed.

The original plan:

Prerequisites: the zone `elitestreamplayer.com` is active on Cloudflare, on the Free plan. No paid feature is used.
1. **Certificate chain for the Samsung (important).** Tizen 3.0 has a 2017 root store. In Cloudflare → SSL/TLS → Edge Certificates, set the Universal SSL **certificate authority to Google Trust Services**. Its chain reaches GlobalSign Root CA, the same root the Gemini connection already uses on this TV. A Let's Encrypt chain may fail on the 2017 TV (ISRG Root X1 is too new). **Unverified until tested on the TV.**
2. In a terminal: `cd relay`, then `npx wrangler@4 login` (opens the browser), then `npx wrangler@4 deploy`. Wrangler creates the Worker, the Durable Object class and the DNS record/certificate for `pair.elitestreamplayer.com`.
3. Check from the PC that `https://pair.elitestreamplayer.com/` returns the page, and that `/v1/s/AAAAAAAAAAAAAAAAAAAAAA/status` returns `{"state":"unknown"}`.
4. Physical test, which needs its own approval: install 0.3.5 with this change on the Samsung as an upgrade, then run the flow with a real key on the user's own phone.

Free-plan budget: one pairing is about 150 TV polls plus a few phone requests. That is far below 100,000 requests per day.

## Phone page design (2026-11-27)

The phone page now uses the EliteStream website design system: the same header, navigation, footer, fonts, cards and buttons, through `site.css`, which `website/build.mjs` copies from `website/src/styles.css`. See `docs/WEBSITE.md`. The pairing logic, element IDs and relay API are unchanged. `_headers` adds `font-src 'self'` for the self-hosted fonts.
