# AI-02 — AI Intelligence Engine foundation

> **Note (2026-11-26):** the multi-provider revision supersedes §1, §2 and §8 of this report. See `AI-02-MULTI-PROVIDER-REPORT.md`. The connectivity findings (§3) and the key-risk analysis (§4) still apply.

Date: 2026-11-26.

**Status:** implemented and tested on the PC, **not committed and not installed on any TV**. The test on the Samsung itself (§3) needs a separate, approved TV installation and your own Gemini API key.

AI-01 (audit) and the AI-02 approval define the scope. AI-02 builds only the infrastructure. There is **no AI feature yet**: no EPG enrichment, no search, no subtitle translation, no audio and no dubbing.

## 1. Components

| Component (AI-01 name) | File | Role |
|---|---|---|
| AI HTTP client | `src/api/ai-http-client.ts` | POST/GET JSON to an allow-list of https origins only (Gemini: `https://generativelanguage.googleapis.com`); see §4 |
| Provider interface | `src/ai/types.ts` | `AiProvider`, result and error codes. Providers get the key per call and never keep it |
| GeminiProvider | `src/ai/gemini-provider.ts` | `GET v1beta/models`, `POST v1beta/models/<id>:generateContent`; maps errors to codes (invalid key, permission, quota with `retryDelay`, 5xx, safety block, …) |
| AIProviderManager | `src/ai/ai-manager.ts` | Single entry point: gating, privacy guard, cache, usage slot, retries, connection test, automatic model choice |
| AIUsageManager | `src/ai/usage-manager.ts` | Per-minute and per-day limits, concurrency 1 (`busy`, no queue), pause after a quota answer, daily counters in KV `ai.usage` (figures only) |
| AICacheManager | `src/ai/ai-cache.ts` | LRU + TTL cache in `ai-cache.json` (file store), hashed keys, delayed writes. Never touches the playlist `cat.*` files |
| AISettingsManager | `src/ai/ai-settings.ts` | KV `ai.settings` (all off by default); the API key in the platform key store, alias `ai_gemini_key` |
| Limits | `src/ai/ai-config.ts` | 8 requests/min, 200/day, 1 in flight, 30 s timeout, 2 retries (1.5–20 s backoff with jitter), 60 s pause after quota, 60,000-character prompt cap, cache 2,000 entries / 1.5 M characters / 7 days |
| Assembly | `src/ai/ai-engine.ts` | Builds the engine; created **idle** at start-up |
| Settings → AI Intelligence | `src/screens/ai-settings-screen.ts` | TV screen (see §2) |

**Not added on purpose:**
- `SpeechRecognitionEngine`, `SubtitleGeneration` / `TranslationEngine`, `AudioTranslationEngine`, `AIDubbingEngine`, `EPGIntelligenceEngine`, `AIProgramDescriptionEngine`, `AIRecommendationEngine`. They belong to later stages.
- There is no coupling to the playback engines.

## 2. Settings → AI Intelligence

The screen is reached from a new row in Settings, just above About. Remote use: ▲▼ moves, OK acts, Back leaves.

**General**
- **Enable AI**: off.
- **Allow external AI processing**: off. Turning it on shows a dialog with **Cancel focused** that explains what is sent, the EU paid-only rule and the age of 18.
- **AI provider**: Google Gemini.
- **Gemini API key**:
  - entered with the TV keyboard in the password field, which has Show/Hide;
  - shown only as "Stored on this TV", "Stored until the app closes" or "Not set";
  - **Remove API key** asks first, with Cancel focused.
- **Gemini model**: Automatic, or a choice from the models the key can use (loaded by the connection test).
- **Test API connection**:
  1. lists the models;
  2. sends one 1-word request;
  3. shows `OK · <model> · <ms> ms` or a plain error text.

  It needs consent and a key, not the master switch.

**Usage today**
- Requests, tokens in and out, errors and quota errors, cache entries and hit/miss counts, and any quota pause.

**Privacy**
- **Clear AI cache** and **Clear AI usage statistics**, each with a confirmation.
- Two information notes: the key storage risk, and Google's terms.

## 3. Samsung connectivity test

**Not performed on the TV.** AI-02 forbids TV installation, and the test needs your own key, entered on the TV. What could be checked from the PC (2026-11-26, without a key):

| Item | Result | Relevance for Tizen 3.0 |
|---|---|---|
| CORS preflight, GET with `x-goog-api-key`, `Origin: null` | `200`; `Access-Control-Allow-Origin: null`; `Allow-Headers: x-goog-api-key` | A packaged Tizen app sends `Origin: null` or `file://`; both are allowed |
| CORS preflight, POST with `content-type, x-goog-api-key`, `Origin: file://` | `200`; `Allow-Origin: file://`; `Allow-Headers: content-type,x-goog-api-key` | POST with a JSON body and the key header is allowed |
| Error response without a key | `403 PERMISSION_DENIED` **with** `Access-Control-Allow-Origin` | The app can read error bodies, so it can tell invalid key from quota |
| TLS | TLS 1.3 and 1.2; TLS 1.2 accepts `ECDHE-RSA-AES128-GCM-SHA256` | A 2017 Chromium supports TLS 1.2 with these ciphers |
| Certificate chain | leaf ← `WE2` ← `GTS Root R4` ← **cross-signed by `GlobalSign Root CA`** | GlobalSign Root CA (1998) is in virtually every old trust store, so the chain should validate |

**Conclusion:** no blocker is visible. It is still **unverified on the TV**. The DNS, certificate store, XHR POST and `responseURL` behaviour on Tizen 3.0 must be confirmed by the in-app test.

**Proposed TV test** (needs approval: it is an upgrade install like 0.3.x):
1. Install a build containing AI-02.
2. Go to Settings → AI Intelligence → Allow external AI processing.
3. Enter the API key (with Show/Hide to check it).
4. Run Test API connection.
5. Record the result line exactly as shown.

The result codes separate the failure points:

| Result | Meaning |
|---|---|
| `network` | DNS, TLS, certificate or CORS failure (a WebView reports these all the same way) |
| `invalid-key` / `permission` | The connection works; the key or project is the problem |
| `quota` | The connection works; quota is used up |
| `OK` | Everything works |

## 4. Security assessment

**API key**
- Entered by the user and stored only in the platform key store: the Tizen key manager, or the Android Keystore (AES-GCM).
- Separate alias `ai_gemini_key`; playlist secrets (`ss_pl_*`) are untouched.
- Never in source code, the bundle, the APK, KV, the cache, logs, the URL or on screen. The input field is cleared after use.
- The key format is checked before storing.

**Client-side key risk (documented, not solvable on the TV)**
- Anyone with developer access to the TV (developer mode, `sdb`/ADB with root, a modified APK) or able to intercept TLS with a planted CA could extract the key.
- Google advises against keys in client apps for production and recommends a backend proxy.
- **Mitigation:**
  - use a dedicated key with **API restrictions** (Generative Language API only) and **quota/budget limits** in Google Cloud;
  - rotate it when in doubt;
  - for distribution to others, use a backend proxy (a separate decision).

**Transport**
- https only, to allow-listed origins.
- The key goes only in the `x-goog-api-key` header. A URL containing `key=` is refused.
- `withCredentials` is false.
- A redirect to another origin aborts the request and discards the body.
- Timeouts and a size cap apply.

**Data minimisation and privacy guard**
- Every prompt is checked before sending. It is refused (`privacy-blocked`, nothing sent) if it contains:
  - any URL;
  - an e-mail address;
  - `password=` / `username:` style text;
  - an `AIza…` key;
  - a 40-character-or-longer opaque token.
- Playlist credentials and stream URLs therefore cannot be sent, even by a later feature's mistake.
- Ordinary text, including "Basic training", Arabic and French, passes.

**Logging**
- The AI code logs codes, HTTP statuses, model ids and figures only. Never prompts, answers, keys or URLs.
- `redactString` additionally removes `AIza…` keys from any log line.

**Consent and defaults**
- AI off, external processing off and audio off by default.
- Nothing is sent at start-up; this is tested.
- The connection test needs explicit consent.

**Google terms (AI-01)**
- In the EEA, UK and Switzerland, only paid services may be used for apps offered to others.
- The paid data terms also apply to free quota there.
- Users must be 18 or older.
- The consent text and an information note say this. Free-tier eligibility for distribution is not assumed.

**Unchanged:**
- playlist storage and authentication;
- the GET-only `http-client.ts`;
- the playback engines;
- the EPG, VOD and Live code paths.

## 5. Android compatibility

- The same code runs in the Android WebView.
- The key goes in the Android Keystore through the existing bridge. Android 5 uses session memory; the screen then says "Stored until the app closes".
- The AI client uses the WebView's XHR, and the Android build allows https.
- The WebView origin is `file://`, the same CORS situation as Samsung.
- `npm run build:all` builds the Android 0.3.4-beta.1 APK with AI-02.
- **Not tested on an Android device** (Android testing is deferred).

## 6. Tests

**New**
- `tests/fakes/fake-gemini.mjs`: a fake Gemini API (models, generateContent, error bodies with `ErrorInfo` / `RetryInfo`).
- `tests/unit/ai-foundation.test.mjs` (13 tests):
  - the AI HTTP client (origin and key protection, POST/JSON, network/CORS, timeout, size, redirect, JSON errors, Retry-After);
  - the Gemini provider (models, generation, error mapping);
  - the usage manager (per-minute and per-day limits, `busy`, quota pause, persistence, day roll-over);
  - the cache (LRU, TTL, persistence, a corrupt file, isolation from `cat.*`);
  - settings and key (defaults off, alias isolation, key never in KV, format check, no key store);
  - the manager (gating order, privacy guard, cache hit, 503 retries, quota pause, connection-test stages, clean logs);
  - the engine (idle at creation).
- `tests/unit/ai-settings-ui.test.mjs` (2 tests): the real start-up and router:
  - Settings row → screen, off by default, no request at start-up, all strings present in EN and NL;
  - consent with Cancel focused, masked key entry, invalid-format message, key stored and never displayed;
  - connection test result and request count, model choice, key removal with Cancel focused, clean logs.

**Results**
- Unit tests 458/458 (443 existing + 15 new); build tests 6/6.
- Typecheck OK; compatibility (ES5) check with no findings; release check OK; `npm run build:all` OK.
- **No existing test was changed.**

## 7. Remaining limitations

- The Samsung connectivity test on the TV is outstanding (§3).
- Free-tier rate limits are not published. Local limits are conservative, and Google's 429 answers win.
- Model names come from the live model list. "Automatic" prefers Flash-Lite models; the 2.5 models are deprecated from 2026-12-01.
- No backend. The key-extraction risk is documented and accepted for personal use only.
- The cache key is a 64-bit non-cryptographic hash. That is fine for answer caching; it is not a security boundary.
- The app bundle grows from 497 KB to 530 KB.

## 8. Files

**New**
- `src/api/ai-http-client.ts`
- `src/ai/types.ts`, `ai-config.ts`, `gemini-provider.ts`, `usage-manager.ts`, `ai-cache.ts`, `ai-settings.ts`, `ai-manager.ts`, `ai-engine.ts`
- `src/screens/ai-settings-screen.ts`
- `tests/fakes/fake-gemini.mjs`, `tests/unit/ai-foundation.test.mjs`, `tests/unit/ai-settings-ui.test.mjs`
- this report

**Changed**

| File | Change |
|---|---|
| `src/app/bootstrap.ts` | The `ai` engine in the app context (idle); the `ai-settings` screen registration |
| `src/screens/settings-screen.ts` | One row "AI Intelligence", shown only when the screen is registered |
| `src/i18n/strings.ts` | 65 strings, EN and NL |
| `src/utils/redact.ts` | One extra pattern for `AIza…` keys |
