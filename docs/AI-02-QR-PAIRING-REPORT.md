# AI-02 — QR code smartphone pairing: feasibility and proposal

Date: 2026-11-26.

**Result: direct, secure smartphone-to-TV pairing is NOT feasible on Samsung Tizen 3.0. NO-GO for the direct design.** As the assignment requires in that case (§4, §9), nothing was implemented:
- no code was changed, and no insecure workaround was built;
- nothing was installed on a TV (Samsung or Philips), and no real key or external API call was used;
- no backend was deployed, and nothing was committed.

This report documents the limitation and proposes secure alternatives for your decision.

**Legend:** **[Verified]** measured or tested in this stage · **[Platform knowledge]** documented or well-known platform behaviour, not tested on the TV here · **[Assumption]** to be verified.

## 1. Architecture assessed

The requested flow has the phone browser deliver the key **directly to the TV** over an **authenticated, encrypted** connection. Two parts are needed for that:
- **(A)** a listener on the TV that the phone can reach;
- **(B)** a TLS certificate for that listener that a phone browser trusts.

| Requirement | Tizen 3.0 web app (EliteStream) | Finding |
|---|---|---|
| (A) Listening socket / HTTP(S) server in the app | The Tizen Web API offers outbound XHR/WebSocket only; there is no server socket for web apps | **Not available** [Platform knowledge] |
| (A) Samsung's own TV channels | The TV exposes 8001, 8002, 8080, 9197, 7678 [Verified: open ports]. 8001/8002 is the Samsung Smart View (multiscreen) channel; 9197/7678 are DIAL/UPnP | Usable only through Samsung's protocols, not as an EliteStream HTTPS endpoint |
| (B) Trusted TLS on the TV | Port 8002 presents `CN=SmartViewSDK`, issued by "SmartViewSDK Root Ceritificate Authority", **self-signed** (`Verify return code: 19`) [Verified] | **Phone browsers reject it.** Accepting it would require a certificate bypass, which is forbidden |
| (B) Own certificate for a LAN address | No public CA issues certificates for `192.168.x.x`. A self-signed certificate means browser warnings on the phone, and Tizen's root store cannot be changed by apps | **Not achievable** without a public domain [Platform knowledge] |
| Samsung Convergence / Smart View app-to-app | Needs Samsung's mobile SDK in a **native** phone app (Android/iOS), not a web page; the TV side uses the 8001/8002 channel | Possible only with a native companion app; out of scope [Platform knowledge] |
| Plain HTTP on the LAN | Technically possible from a local helper, but the key would cross the network in clear | **Forbidden** (no silent downgrade) |

**Conclusion:** no component available to a Tizen 3.0 web app can receive a connection from a phone browser with browser-trusted TLS. **No direct design meets the security requirements**, so none was implemented.

**What the TV *can* do securely [Platform knowledge, partly Verified]:**
- outbound HTTPS to a public, CA-trusted host;
- Google's endpoints were verified in AI-02 §3 (TLS 1.2/1.3, a GlobalSign-rooted chain, CORS for `Origin: null`).

Every secure design therefore needs a **rendezvous point both devices reach outbound over public HTTPS**, i.e. a relay.

## 2. Proposed protocol (for approval): end-to-end encrypted, zero-knowledge relay

The relay only carries an **encrypted** envelope that only the TV can open. The relay never sees the key, so it doesn't need to be trusted with it.

**Roles**
- **TV:** EliteStream on Tizen.
- **Phone:** any modern phone browser, opening a static HTTPS page.
- **Relay:** a tiny HTTPS mailbox service, part of a future EU-hosted EliteStream backend. **Not deployed.**

**Protocol (v1)**
1. **TV starts pairing.**
   - It generates a fresh **ephemeral key pair**: ECDH P-256 or RSA-OAEP-2048 with `crypto.subtle` [Assumption: algorithm availability on Tizen 3.0 must be tested; WebCrypto as such is present, since the PIN feature uses PBKDF2].
   - It generates a **pairing id** of 128 random bits from `crypto.getRandomValues`.
   - It registers `{pairingId, tvPublicKey, expiresAt = now + 5 min}` at the relay (`POST /v1/pair`). The relay returns a **mailbox token** that only the TV holds, used later to collect the envelope.
2. **QR code** = `https://pair.<domain>/#<pairingId>.<base64url(SHA-256(tvPublicKey))[0..16]>`.
   - The part after `#` is **never sent to any server** by browsers.
   - The QR code holds **no key**, and the pairing id does not grant access to the TV: it only allows **one** encrypted envelope to be deposited.
   - **Manual alternative:** a short code such as `K7Q-4MZ-9TA` (about 45 bits, valid only with the relay's attempt limits) plus the short address, shown next to the QR code.
3. **Phone page.** A static page with a strict CSP and Subresource Integrity, no analytics, no storage, and no third-party scripts.
   1. It fetches `tvPublicKey` for the pairing id from the relay.
   2. It **checks the fingerprint** against the one in the QR fragment, which defeats a substituted public key.
   3. The user picks the provider (Gemini; extensible), pastes the key (with Show/Hide), and confirms explicitly: "Send this key to your TV".
   4. It **encrypts** with ECDH + HKDF + AES-GCM (or RSA-OAEP), binding `pairingId` and `provider` as associated data.
   5. It posts the ciphertext once (`POST /v1/pair/<id>/envelope`), then clears the field and shows "Sent — check your TV".
4. **TV** polls `GET /v1/pair/<id>/envelope` with the mailbox token (every 2–3 s, with backoff).
   - It decrypts, checks the provider and associated data, and runs the existing format check (`validKey`).
   - It stores the key **only on full success** through the existing `settings.setCredential(provider, 'api-key', …)`, so the key store alias is `ai_key_gemini`.
   - It then **deletes the private key and the decrypted string references**, and tells the relay to close the pairing.
5. **Expiry and abuse limits** (relay **and** TV):
   - 5-minute lifetime; **one envelope only** (a second is refused: replay protection); the pairing is closed after delivery;
   - at most 5 failed lookups per pairing id and a per-IP rate limit (brute-force protection);
   - cancel on the TV deletes the pairing at the relay and discards the private key.

**Security properties (by design; to be proven by tests once implemented)**

| Requirement | How it is met |
|---|---|
| Key never in the QR code, a URL or a query string | The key travels only inside the encrypted POST body; the QR code holds an id and a fingerprint in the fragment |
| Authenticated and encrypted end to end | TLS phone↔relay and TV↔relay (public CA). The **TV public-key fingerprint from the QR code** authenticates the TV to the phone, and AES-GCM protects integrity |
| The relay cannot read or alter the key | It sees ciphertext only; a tampered envelope fails AES-GCM |
| Short-lived, one-time, attempt-limited, cancellable | Steps 1 and 5 |
| Pairing token gives no access to the TV | It permits one deposit; the TV pulls and validates |
| No logging or storage of key or secret | Neither the page nor the relay logs bodies; the TV logs codes only; no localStorage, cookies or session storage on the page |
| No partial save | Decrypt, validate, then store, all or nothing |

**Residual risk:** someone who photographs the QR code within 5 minutes could deposit **their own** key into your TV, not read yours. Mitigation:
- the TV shows "Key received from phone — keep it? [Cancel] [Keep]" with **Cancel focused**;
- the provider and the last 4 characters of the key are shown, so you can recognise your own key without exposing it.

## 3. Alternatives considered

| # | Alternative | Secure? | Effort / cost | Assessment |
|---|---|---|---|---|
| A | **E2E-encrypted zero-knowledge relay** (§2) as a small part of the future **EU-hosted EliteStream backend** | Yes, with the relay untrusted for content | Small service plus a static page plus a domain; fits the AI-02 multi-provider backend design (device sign-in uses the same pattern, RFC 8628) | **Recommended** |
| B | **Local pairing helper on your own PC**, with a publicly trusted certificate for a domain whose DNS points to the LAN IP (ACME DNS-01) | Yes, if configured correctly | Needs a domain and DNS automation per user; not suitable for distribution | Developer-only option |
| C | **Native companion app** (Android/iOS) with Samsung's Smart View / Convergence SDK | Depends on Samsung's channel (self-signed CA); needs certificate pinning in the app | High (two native apps, store publishing) | Not recommended |
| D | **No pairing:** keep the TV keyboard entry with Show/Hide (AI-02, already on the TV) | Yes (no network transfer) | None | Current fallback; inconvenient for long keys |
| E | **The gateway removes the need for keys altogether:** with the EliteStream AI service, users sign in by device code and never enter provider keys | Yes | Part of the backend | **Long-term answer** for distribution; QR pairing then only matters for own-key users |

## 4. Tizen 3.0 compatibility (for the proposed design)

| Item | Status |
|---|---|
| Outbound HTTPS XHR to a public host | Works (AI-02 / playlists) [Verified for Google from a PC; TV untested] |
| `crypto.getRandomValues` | Present on Tizen 3.0 Chromium [Platform knowledge]; a JS fallback is **not** acceptable |
| `crypto.subtle` ECDH P-256 / RSA-OAEP / AES-GCM / HKDF | **[Assumption]**: PBKDF2 works (PIN feature); the other algorithms must be **tested on the TV** first |
| QR rendering | Feasible in ES5: a small QR encoder writing to `<canvas>` or a table of divs, no external library needed [Assumption until built and scanned on the TV] |
| Focus and remote | The existing focus manager; a pairing overlay with **Cancel focused** by default |
| ES5 / bundle | A new encoder is about 10–15 KB minified [estimate] |

## 5. Smartphone browser compatibility (proposed page)

- Modern iOS Safari and Android Chrome support ECDH/AES-GCM through `crypto.subtle` on HTTPS pages [Platform knowledge].
- The page is plain HTML/JS with no framework and no third-party CDN, and works with no storage APIs.
- Camera QR scanning uses the phone's own camera app, so the page needs no camera permission.

## 6. Key-storage behaviour (unchanged; for the proposal)

- **Only** `settings.setCredential('gemini', 'api-key', key, adapter.validKey)`, i.e. the existing key store alias `ai_key_gemini`.
- Never KV, settings, cache, diagnostics or logs.
- On any failure (decrypt, AAD, format, key store) nothing is saved.
- The existing TV keyboard entry and Show/Hide stay as they are. Show/Hide only affects the input field while typing on the TV; a key received by pairing is never shown.

## 7. Tests

**Run in this stage [Verified]:**
- TV network surface: ports 8001, 8002, 8080, 9197 and 7678 open.
- 8002 TLS: `CN=SmartViewSDK`, self-signed chain (verify code 19).

**No code was written, so there are no new automated tests.** The current tree is unchanged since the AI-02 Samsung install:
- 461/461 unit tests, 6/6 build tests;
- version 0.3.5 local and uncommitted.

**Planned once the proposal is approved** (fake relay, fake phone client, fake keys only):
- random pairing-id entropy and format;
- 5-minute expiry; one-time envelope; replay refused;
- attempt limits (brute force); cancellation;
- substituted public key detected by the fingerprint; tampered envelope refused by AES-GCM;
- wrong provider refused;
- failed transfer leaves no partial save; successful storage only in `ai_key_gemini`;
- key absent from the QR payload, URLs, logs, KV and cache;
- https-only relay URL; pairing timeout;
- TV-side focus and Cancel default.

## 8. Remaining security risks

1. A relay is unavoidable on Tizen 3.0. Its availability (not its confidentiality) becomes a dependency of pairing.
2. Photographing the QR code allows depositing a **foreign** key. Mitigated by the "Keep this key?" confirmation with Cancel focused.
3. The phone page must be served with a strict CSP and SRI, and from a domain you control. If an attacker compromises the hosting, they could serve a malicious page; this is the usual web trust boundary.
4. WebCrypto ECDH/RSA-OAEP on Tizen 3.0 is unverified. If missing, the design needs an approved, audited JS crypto implementation, a separate decision (not a silent fallback).
5. Own-key mode stays personal use only (AI-02 report §4): a key on the TV can still be extracted by someone with developer access.

## 9. Physical Samsung testing

**Yes, required, after the proposal is approved and implemented.** To verify:
- WebCrypto algorithm support;
- outbound HTTPS to the relay domain (certificate chain and CORS);
- QR legibility from a phone at sofa distance;
- remote focus and Cancel default;
- end-to-end transfer with a **test** key.

A desktop test does not prove Tizen 3.0 behaviour.

## 10. Recommendation

- **NO-GO** for direct phone-to-TV pairing on Tizen 3.0: no listener and no browser-trusted TLS on the TV. Nothing insecure was built.
- **GO (conditional)** for proposal **A**, the E2E-encrypted zero-knowledge relay, **only after your approval** of:
  1. **A domain and EU hosting** for a tiny relay plus a static pairing page. This is the first piece of the EliteStream backend. Nothing is deployed until approved, and it is free or near-free in scale.
  2. **A local prototype first:** TV side, phone page and relay, implemented and tested against fakes; no deployment.
  3. **A Tizen WebCrypto test** on the Samsung as the first physical step.
- **Meanwhile:** the TV keyboard entry with Show/Hide (already installed in 0.3.5) remains the way to enter a key. Your pending Gemini connection test on the Samsung is unaffected.
