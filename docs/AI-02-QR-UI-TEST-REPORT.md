# AI-02 — Experimental QR pairing UI test

Date: 2026-11-26.

**Status:** implemented and tested on the PC; **not installed on any TV**; local and uncommitted.

This is a **usability and compatibility experiment only**. It tests whether a QR code renders on the Samsung, scans from a phone and leads to a simulated confirmation. It is **not** a key transfer, and it cannot handle real (or fake) API keys. The secure design remains the proposal in `AI-02-QR-PAIRING-REPORT.md`.

**Legend:** **[Tested]** automated or run on this PC · **[Assumption]** to be confirmed on the TV.

## 1. QR implementation

- **Encoder:** `qrcode-generator` **1.4.4** (Kazuhiko Arase, MIT), an established, plain-ES5 library. It is a dev-only dependency with an exact version, and `npm audit` reports 0 vulnerabilities. `jsqr` **1.4.0** (Apache-2.0) is used **only in tests**, as an independent decoder.
- **Rendering** (`src/dev/qr-pairing/qr-svg.ts`):
  - error correction M, smallest version that fits;
  - drawn as **one SVG path**, black on white, with the standard 4-module quiet zone and crisp edges;
  - shown through `<img src="data:image/svg+xml,…">` at 440 × 440 px (the brand mark used SVG data URIs on Tizen before).
- **Payload** (`protocol.ts`): `http://<PC on the LAN>:8095/p/#<pairing id>`.
  - The pairing id sits in the **URL fragment**, which browsers never send to a server.
  - The id is **10 characters** from an alphabet without look-alikes (≈ 49.5 bits), drawn from `crypto.getRandomValues` with rejection sampling. There is no `Math.random` fallback: without a crypto source the test screen is not offered.
  - **No key, credential or token** is in the payload. Verified: the payload decodes back exactly with jsQR, and the sensitive-pattern check is negative.
- **TV screen** (`src/dev/qr-pairing/screen.ts`, "Phone pairing test (experimental)"):
  - the warning "EXPERIMENTAL TEST ONLY – NEVER ENTER A REAL API KEY";
  - the QR code, the **pairing ID as text** ("ABCDE-FGHJK") for manual testing, and a **5-minute countdown**;
  - a status line, polled every 2 s from the test server: waiting / confirmed / expired / test server not reachable;
  - buttons **Cancel (initial focus)** and **New code**, using the existing focus manager. ◀▶ moves, OK acts, Back = Cancel;
  - on confirmation it shows "Test pairing confirmed from the phone (Gemini). No key was transferred or stored." and polling stops.
- **Where it appears:** Settings → AI Intelligence → "Phone pairing test (experimental, fake keys only)". The row appears **only when the screen is registered**, which only the dev hook does.

## 2. Smartphone page and test server

- **Test server:** `scripts/qr-test-server.mjs` (`node scripts/qr-test-server.mjs`, port **8095**).
  - Port 8098 was first planned, but it is in use by the existing dev log receiver (`dev-sink.mjs` uses 8097 and 8097 + 1).
  - Serves only private-LAN and loopback clients; public clients get 403.
  - Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`, and a strict **CSP** (`default-src 'none'`; scripts, styles and `connect` only from itself; no frames, forms or base).
  - The pairing API is in memory: TV poll and cancel, and the phone's confirmation.
  - **The confirmation body must be exactly `{id, provider}`** (at most 200 bytes). Any other field, such as a `key` or `token`, is refused, so the server is **technically unable to receive a key**.
  - The log shows only method and route, with the id masked.
- **Phone page** (`scripts/qr-test-page/`: `index.html`, `app.js`, `app.css`; no external resources):
  - EliteStream branding, the **permanent warning** "EXPERIMENTAL TEST ONLY – NEVER ENTER A REAL API KEY.", and the pairing ID from the fragment;
  - provider choice (Google Gemini), a fake-key field with **Show/Hide**, a "Test pairing" button, and an explicit confirm dialog;
  - **the key is checked locally only and never sent.** Only `TEST-XXXX-123456` passes. A real-looking key (`AIza…`, `sk-…`, 30 characters or more) is **cleared and not sent**;
  - the one request sends `{id, provider}`; afterwards the field is cleared and the result is shown;
  - no `localStorage`, `sessionStorage`, cookies, IndexedDB, analytics or third-party resources.
- **Local run [Tested]:**
  - the server on this PC and the page in Chrome at phone size (390 × 844);
  - the warning and ID are shown;
  - a made-up real-looking key gave "This looks like a REAL key. It was cleared and NOT sent.";
  - `TEST-GEMINI-123456` + confirm gave "Test pairing confirmed", and the server state became `confirmed`;
  - the server log showed only routes, with the id masked.

## 3. Security isolation

- **Dev builds only.** The screen is registered by `src/dev/dev-hooks.ts`. Release builds replace that module with the no-op `dev-hooks.release.ts`, so **none of the screen, the test-server calls or the QR encoder is in a release bundle** [Tested: build test].
- The release bundle keeps only the **inert guard** in the AI screen: the screen name and label, used only if the screen is registered [Tested].
- **No access to production secrets.** `src/dev/qr-pairing/*` has no reference to AI settings, the key store, KV, playlists or `localStorage` [Tested: source scan].
- A full simulated flow with a key store whose `save` and `remove` **throw** leaves the stored `ai_key_gemini` value unchanged [Tested].
- **No key transfer at all:** the phone never sends the key, and the server refuses any key field [Tested].
- **No external calls:** the TV only contacts the test server on the LAN (from the dev-sink host); there are no production endpoints.
- **Existing protections unchanged:**
  - the AI HTTP client, its allow-list and redirect rules;
  - TLS behaviour, the privacy guard and log redaction;
  - the production key store, playlist storage and playback.
- **Plain HTTP on the LAN** is used **only** because nothing secret is exchanged (fake flow, expiring ids). This is stated in the server source and must never be reused for real keys.

## 4. Test results

**New tests**
- `tests/unit/qr-pairing-test.test.mjs` (10 tests):
  - pairing-id randomness, format and bias rejection; the server URL derived only from a private-LAN dev sink;
  - the **QR payload** (address + id in the fragment), **decoded back with jsQR**, and **no sensitive data**;
  - the fake-key check (real-looking keys refused);
  - the registry: fake flow, invalid, unknown, **expired**, **one-time use (replay refused)**, **cancellation**, wrong provider, extra fields refused, **brute-force lock** after 10 failures (other clients unaffected);
  - the test server: LAN-only, headers, key field refused, 413 on large bodies, full flow, id masked in logs;
  - the phone page: no storage APIs, only `{id, provider}` sent, fake-format rule, permanent warning, no third-party resources;
  - the TV screen: QR and ID shown, **Cancel focused**, poll leading to confirmed, polling stops, **expiry after 5 minutes**, New code, Cancel and Back close it and send the cancel;
  - **isolation**: the production key is untouched and the release stub contains nothing.
- `tests/build/qr-pairing-build.test.mjs` (1 test): the dev bundle contains the experiment **and stays ES5** (`checkEs5Bundle`, including the QR library); the release bundle has none of the implementation.

**Results**
- Unit tests **471/471**; build tests **7/7**.
- Typecheck OK; source compatibility check: no findings; release check OK.
- `npm run build:all` OK: Samsung 0.3.5 release and the Android 0.3.5-beta.1 debug APK.
- **No existing test was changed.**

## 5. Samsung Tizen 3.0 compatibility

| Item | Status |
|---|---|
| ES5 | [Tested] on the dev bundle, including qrcode-generator |
| QR rendering through an SVG data URI in `<img>` | [Assumption]: SVG data URIs render on this TV (brand mark); a large QR path must be checked on the TV |
| Scanning from a phone at viewing distance | [Assumption]: 440 px of a 1920-wide page, about 23 % of the screen width; needs a physical test |
| `crypto.getRandomValues` | [Assumption] (Chromium on Tizen 3.0); without it the screen is not offered |
| XHR to the LAN test server | [Assumption]: dev builds already reach the dev sink on the LAN |
| Remote and focus | [Tested in fakes]: Cancel focused, ◀▶, OK, Back |

## 6. Physical TV testing

**Required.** A desktop test does not prove Tizen 3.0 behaviour. It needs your approval and these **conditions**:
1. **A dev build is needed** (the experiment exists only in dev builds), built with `SS_DEV_SINK_URL=http://<PC-IP>:8097/ingest`. It is installed **as an upgrade** over the production 0.3.5; afterwards the **release 0.3.5 is reinstalled** as an upgrade. A rollback copy of 0.3.4 is already in `screenshelf-backups`.
2. **Disable the automatic device self-test** for this test build. Dev builds currently also start the Stage 7B.2 device self-test at launch (synthetic data; its source says it never touches real playlists, but it starts playback tests against the media fixture server). That is unwanted on your production TV. Proposal: a build option, e.g. `SS_DEV_SELFTEST=off`, that registers only the QR test. It is a small dev-only change, **not made yet**: it needs your OK.
3. On the PC, run `node scripts/qr-test-server.mjs` (port 8095) and the dev log receiver.
4. Test with **only** `TEST-GEMINI-123456`. Record:
   - QR legibility from the sofa;
   - scan success and time on your phone;
   - status changes on the TV;
   - Cancel and Back behaviour.

## 7. Remaining limitations

- **Not a secure transfer and not a product feature.** Real key entry stays the TV keyboard (with Show/Hide) until the E2E relay of `AI-02-QR-PAIRING-REPORT.md` is approved and built.
- Plain HTTP on the LAN for the test page; acceptable only for this fake flow.
- The test server must run on the dev-sink PC (port 8095) and the phone must be on the same network.
- The TV polls every 2 s while the screen is open (about 150 requests per 5 minutes, LAN only).
- New dev dependencies: `qrcode-generator` 1.4.4 and `jsqr` 1.4.0 (`package.json` / `package-lock.json`).
- **Dev builds always contain the experiment;** it is only offered when a dev sink is configured.
