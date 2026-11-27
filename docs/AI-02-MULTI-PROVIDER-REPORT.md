# AI-02 — Multi-provider architecture upgrade

Date: 2026-11-26.

**Status:** implemented and tested on the PC. It is **local and uncommitted**: no TV install, no backend deployed, no paid service, no real API keys, no real user data. It revises the AI-02 foundation (`AI-02-REPORT.md`; that report's sections 1, 2 and 8 are superseded here, while its §3 connectivity findings and its key-risk analysis still apply).

**How to read this report:**
- **[Implemented]** — code that exists and is tested against fakes.
- **[Prepared]** — interfaces, registry entries or designs for future work. They are not operational and are not presented as operational in the app.

## 1. Assessment of the original (Gemini-only) AI-02

| # | Gemini-specific assumption | Where | Resolution |
|---|---|---|---|
| 1 | One global provider (`provider: 'gemini'`) and one global model | `ai-settings.ts` | Replaced by **per-task routes** (a primary and a fallback, each `{provider, model}`) |
| 2 | One consent flag (`allowExternal`) for "external processing", not tied to who processes the data | `ai-settings.ts`, `ai-manager.ts` | **Consent per data-processing party** (`google`, `elitestream`, `openai`, …), including the upstream party of gateway models |
| 3 | One credential alias `ai_gemini_key` with a Gemini-shaped format check | `ai-settings.ts` | **One alias per provider** (`ai_key_<id>`, `ai_session_<id>`); each adapter checks its own format |
| 4 | AI client allow-list hard-wired to the Gemini origin | `ai-engine.ts` | The allow-list is built from the registered providers (Gemini plus the EliteStream AI service when configured) |
| 5 | Preferred Gemini model names and a `/flash/` fallback in the manager | `gemini-provider.ts`, `ai-manager.ts` | Model choice moved into each adapter (`chooseModel` per capability) |
| 6 | Provider interface without capabilities, auth type, status or data party | `types.ts` | `AiProviderDescriptor` + `AiProviderAdapter` (see §2) |
| 7 | No task concept: one generic `generateText` | `ai-manager.ts` | `runTask(task, request)`. Features never name a provider |
| 8 | Global limits only, no budget | `usage-manager.ts` | Global limits **plus per-provider budgets and per-provider quota pauses** |
| 9 | UI texts "Gemini API key" and "Gemini model" | screen, strings | Provider-neutral texts and sections |
| 10 | The device key is the only way to connect, which is unsuitable for distribution | whole design | **Backend-mediated provider** (EliteStream AI service) as the distribution path; the device key is marked personal use only |

**Kept unchanged:**
- the AI HTTP client rules: https, allow-list, key only in a header, a URL with a `key=` parameter refused, redirect check, timeouts and size cap;
- the privacy guard;
- log redaction (including `AIza…`);
- AI off by default;
- the cache isolation from the playlist files;
- the platform key store for device credentials.

## 2. Provider-independent architecture [Implemented]

**Concepts and the modules that own them:**

| Concept | Module | Notes |
|---|---|---|
| Provider | `src/ai/types.ts` (`AiProviderDescriptor`), `provider-registry.ts` | Each descriptor has: id, name, **data group**, **auth kind** (`api-key` / `user-session` / `none`), **status** (`implemented` / `planned`), **declared capabilities**, `distributionSafe` |
| Model | `AiModelInfo` | Fields: provider, id, capabilities, input/output formats, token limits, streaming, data group, availability. **Always from the provider** (never assumed) |
| Capability | `AiCapability` | `text.generate`, `text.json`, `audio.transcribe`, `audio.transcribe.stream`, `audio.translate`, `speech.synthesize` |
| Task | `src/ai/tasks.ts` | 9 tasks, each with its required capability (and JSON need), implementation flag and stage |
| Model selection | `AiProviderAdapter.chooseModel` + `ai-manager.ts` `pickModel` | A configured model is validated; "Automatic" picks per capability among consented models |
| Provider authentication | `ai-settings.ts` (key store), `AiAuth` passed per call | Adapters never keep credentials |
| Usage tracking | `usage-manager.ts` | Global and per-provider counters, KV `ai.usage` (figures only) |
| Caching | `ai-cache.ts` | Key = hash(provider, model, namespace, task, request); `ai-cache.json` |
| Privacy validation | `ai-manager.ts` `privacyViolation` | Before any provider is chosen; nothing sent on failure |
| Request routing | `ai-manager.ts` `runTask` | Primary → fallback rules (§5) |
| Error handling | `AiErrorCode` (24 codes), adapters map provider and service errors | Every call resolves with a code; nothing throws to features |

**Adapter interface** (`AiProviderAdapter`):
- `descriptor`;
- `listModels(auth)`;
- `generateText?(auth, model, request, task)`;
- `chooseModel(models, capability, json)`;
- `validKey?(key)`;
- `configured?()`.

Audio and speech methods are added in their own stages; until then, tasks needing them return `not-implemented`. **Replacing or adding a provider means writing one adapter and registering it in `ai-engine.ts`.** Features and settings stay unchanged.

**Files**
- **New:** `src/ai/tasks.ts`, `src/ai/provider-registry.ts`, `src/ai/gateway-provider.ts`, `tests/fakes/fake-gateway.mjs`.
- **Rewritten:** `src/ai/types.ts`, `gemini-provider.ts` (now `createGeminiAdapter`), `ai-settings.ts` (schema 2), `usage-manager.ts` (schema 2), `ai-manager.ts`, `ai-engine.ts`, `ai-config.ts`, `src/screens/ai-settings-screen.ts`, `tests/unit/ai-foundation.test.mjs`, `tests/unit/ai-settings-ui.test.mjs`.
- **Unchanged since AI-02:** `src/api/ai-http-client.ts`, `src/ai/ai-cache.ts`, `tests/fakes/fake-gemini.mjs`.
- **App wiring:** `bootstrap.ts` (one comment changed), `settings-screen.ts` (the AI row), `redact.ts` (`AIza…` pattern), `strings.ts` (113 AI strings, EN and NL).

## 3. Supported and planned providers

| Provider | Status | Auth | Data group | Declared capabilities | Distribution-safe | Notes |
|---|---|---|---|---|---|---|
| Google Gemini (direct) | **[Implemented]**; tested against a fake API only | own API key on the device | google | text.generate, text.json (from the model list) | **No** (personal / development use) | CORS and TLS checked from a PC (AI-02 §3); the live test on the TV is still outstanding |
| EliteStream AI service (gateway) | **[Implemented] client**, **[Prepared] server** | user session token | elitestream + the upstream group per model | all capabilities, as declared per model by the service's catalogue | **Yes** | No service is deployed. `AI_GATEWAY_URL` is empty, so it shows "Not available in this version", is not offered for routing and cannot be tested |
| OpenAI | [Prepared] (registered, planned) | — | openai | expected: text, transcription, speech | via the gateway | Not selectable |
| Anthropic Claude | [Prepared] | — | anthropic | expected: text | via the gateway | Not selectable |
| Azure AI | [Prepared] | — | microsoft | expected: text, transcription (incl. ar-MA), speech | via the gateway | Not selectable |
| ElevenLabs | [Prepared] | — | elevenlabs | expected: transcription, speech | via the gateway | Not selectable |
| OpenAI-compatible APIs | [Prepared] | — | custom | expected: text | via the gateway | Not selectable |
| Self-hosted models | [Prepared] | — | self-hosted | expected: text, transcription | via the gateway | Not selectable |

**Second text adapter (security review).** No direct device-key adapter was added for OpenAI or Anthropic:
- the requirement says device-stored keys are not production-safe;
- Anthropic even requires a "dangerous direct browser access" opt-in for browser calls.

The second implemented text adapter is therefore the **gateway adapter**. It is provider-independent and reaches OpenAI, Anthropic and others **server-side** once the service exists. Its client protocol is tested end to end against a fake service, including upstream OpenAI and ElevenLabs models.

**Planned-provider capabilities** are expectations to be verified, not claims; the app never presents them as available.

## 4. Model and capability registry [Implemented]

- `createProviderRegistry(adapters)`:
  - registers implemented providers (duplicates and non-implemented adapters are refused);
  - lists the planned ones.
- **Models are never hard-coded.** They come from:
  - Gemini: `GET v1beta/models` (`supportedGenerationMethods`). Only `generateContent` gives text capabilities; audio is **not** inferred;
  - the EliteStream AI service: `GET /v1/catalog`, with per-model capabilities, formats, limits, streaming, data group and availability. Invalid entries (bad ids, unknown capabilities, invalid groups) are skipped.
- Lists are kept per provider for the session and fetched again after an hour or on "load models".
- **Validation before sending.** A configured model must be in the provider's current list, be available, and declare the task's capability (plus `text.json` for JSON tasks), and its data group must have consent. An unknown model gives `model-not-found` **without a generation request** (tested).

## 5. Task routing and fallback [Implemented]

**Tasks** (`tasks.ts`):

| Task | Required capability | Stage | Executable in AI-02? |
|---|---|---|---|
| Programme descriptions (`epg.enrich`) | text.generate + text.json | AI-08 | the routing is; the feature is not built |
| Programme summaries (`epg.summary`) | text.generate | AI-08 | the routing is |
| AI search | text.generate + text.json | AI-09 | the routing is |
| Subtitle translation | text.generate + text.json | AI-05 | the routing is |
| Subtitles from audio | audio.transcribe | AI-03 | no (`not-implemented`) |
| Live speech recognition | audio.transcribe.stream | AI-04 | no |
| Audio translation | audio.translate | AI-06 | no |
| Text to speech | speech.synthesize | AI-07 | no |
| AI dubbing | speech.synthesize | AI-07 | no |

**Routes**
- Per task: a **primary** and an optional **fallback** `{provider, model}`; model `''` means automatic.
- Only implemented providers can be stored; planned ones are refused (tested).
- Route choices in Settings come from `routeOptions(task)`: implemented, configured providers that declare the capability, plus their listed models that cover the task. A provider is never offered for a task it cannot do (tested: nothing is offered for "Subtitles from audio").

**Order of checks for every candidate:**
1. the master switch;
2. the task is known and executable;
3. the privacy guard and size limit;
4. the provider is implemented and declares the capability;
5. consent for the provider's data group;
6. credentials;
7. the model list;
8. the model chosen and validated;
9. consent for the model's data group;
10. the cache;
11. a usage slot (global limits, provider budget, provider quota pause);
12. the call, with retries.

**Fallback rules:**
- used only when **Automatic fallback is on** and a fallback is set for the task;
- tried only after **availability failures** of the primary: `unavailable`, `network`, `timeout`, `quota`, `budget`, `user-quota`, `model-not-found`, `not-configured`;
- **never** after configuration, consent, privacy or safety failures: `invalid-key`, `no-consent`, `no-credentials`, `privacy-blocked`, `blocked`, `capability-unsupported`, …;
- the fallback passes **every check on its own**: its consent (data group **and** model group), capability, credentials, budget and quota. **There is no silent switch to a party without consent** (tested);
- fallback answers are marked `fallback: true`, and fallbacks are counted in the usage statistics.

**Future automatic routing** (on latency, cost limits and availability) can be added in `runTask` using the registry data and usage statistics; it is not implemented.

## 6. Backend security architecture [Prepared: design and client protocol]

**Why a backend is needed:** the app is meant for distribution. A provider key on a TV or phone can be extracted, so **shared provider keys must stay server-side**. Device keys (the Gemini own-key mode) remain available only as personal / development use, and are labelled so.

**Components (none deployed)**

| Component | Role | Notes |
|---|---|---|
| **AI gateway API** (the EliteStream AI service) | Implements the client protocol: `GET /v1/catalog`, `POST /v1/tasks/text`, later audio endpoints | Stateless HTTPS service, for example on Cloud Run / App Engine / Workers / a small VPS behind TLS |
| **Identity / device sign-in** | Users authenticate on a phone or the web; the TV shows a short pairing code (OAuth 2.0 Device Authorization Grant, RFC 8628) | The TV never handles a password. It receives a short-lived access token (around 1 h) and a revocable, device-bound refresh token, stored in the platform key store (`ai_session_gateway`) |
| **Secret store** | Provider API keys per provider (Gemini, OpenAI, Anthropic, Azure, ElevenLabs, …) | For example Google Secret Manager / AWS Secrets Manager / Vault. Never shipped to clients; one key per provider and environment; rotation |
| **Policy and quota service** | Per-user daily and monthly request/token/audio-minute quotas; per-provider rate limits; **global budget caps** with a hard stop; per-plan entitlements | Prevents one user from exhausting the shared budget (`user-quota`, `budget` codes, already handled by the client) |
| **Usage ledger** | Per user, provider and model: requests, tokens, audio seconds, cost estimate | Figures only; no prompt or answer content stored by default |
| **Provider adapters (server-side)** | The same capability model as the client registry; maps tasks to upstream APIs | Each adapter declares capabilities; the catalogue tells clients what is available |
| **Privacy filter (server-side)** | Repeats the client's privacy guard (URLs, credentials, e-mail, keys, tokens) and refuses violating requests | Defence in depth: the server never relies on the client |
| **Observability** | Redacted structured logs (codes, latency, sizes); alerting on budget thresholds and error rates | No content logging |

**Security requirements and how they are met**

| Requirement | Design |
|---|---|
| Provider keys server-side; no shared secrets in the app | Keys only in the backend secret store; the app holds a per-user session token |
| Isolated provider credentials | One secret per provider and environment; least-privilege IAM; separate projects or billing accounts per provider |
| Users authenticated and authorised | Device grant plus short-lived tokens; entitlements per plan; token revocation per device |
| Per-user quotas and rate limits; per-provider limits; global budget | Policy service checks before forwarding; the client still applies local limits and budgets |
| One user cannot exhaust the shared budget | Hard per-user caps below the global cap; global cap with a hard stop; alerts |
| No IPTV credentials, playlist URLs or stream URLs to providers | The client privacy guard plus the server privacy filter; requests carry only task text |
| Privacy validation and redacted logging | Both sides; the server logs only codes and figures |
| HTTPS only; restricted endpoints and redirects | The client allow-list contains only the configured gateway origin (and Gemini for own-key mode); the redirect check aborts other origins; the server has HSTS and pins upstream endpoints |
| No internal backend credentials in the client | The client only knows the public gateway URL and its own session token |
| EU / GDPR | EU-region hosting; a data-processing agreement with each upstream provider; paid tiers only (Gemini EEA rule); consent per data party shown in the app; age 18+ |

**Infrastructure needed later** (not activated): a domain and TLS, the gateway runtime, an identity provider (device grant), a secret manager, a small database (users, devices, quotas, ledger), billed provider accounts with budget alerts, and monitoring. That is the decision for the next stage.

## 7. Settings changes [Implemented]

**Settings → AI Intelligence** now has these sections. Remote use is unchanged: ▲▼ moves, OK acts, Back leaves. Focus is kept by row when rows appear (tested).

- **AI:** master switch (off).
- **Privacy and consent:** one switch per data party (Google (Gemini), the EliteStream AI service, plus the upstream parties of listed gateway models). Turning a switch on asks first, **with Cancel focused**.
- **Providers:**
  - Gemini: its status, "API key (own key)" with masked entry, remove (Cancel focused), and the connection test;
  - EliteStream AI service: "Not available in this version";
  - the six planned providers: "Planned", not focusable.
- **Models:** load or refresh the model list per configured provider.
- **Task routing:** one row per task, marked "(from AI-xx)". OK steps through **only capable options**. With fallback on, there is a fallback row per task.
- **Automatic fallback:** switch (off).
- **Usage and costs today:** requests, tokens, errors / quota / fallbacks, per-provider usage and pause, the per-provider daily request and token limits (adjustable), and a costs note.
- **Cache:** statistics, clear cache, clear statistics, and notes on own keys and terms.

## 8. Test results

**New and rewritten AI tests**
- `ai-foundation.test.mjs` (16 tests):
  - the HTTP client;
  - the Gemini adapter, including error mapping;
  - the gateway adapter (not configured, catalogue parsing, Bearer token, service codes `user-quota` / `budget` / `unavailable`, invalid session, invalid model ref);
  - the registry (implemented and planned, duplicates, validation, capability filter);
  - tasks;
  - settings (consent per party, routes refuse planned providers, per-provider aliases, no credential in KV);
  - usage (busy, per-provider budget and quota pause, other providers keep working, per-minute limit, day roll-over);
  - the cache;
  - the manager:
    - gating order;
    - capability and model validation without a request;
    - gateway upstream consent;
    - fallback (off, on, consent required, never after configuration errors);
    - per-provider quota leading to fallback;
    - budget;
    - service user quota;
    - the privacy guard;
    - cache hits;
    - connection tests (including planned providers);
    - clean logs (no key, token, prompt or answer);
  - the engine (idle; gateway not configured by default).
- `ai-settings-ui.test.mjs` (2 tests): the real start-up and router:
  - sections, honest provider states and no requests;
  - consent with Cancel first, masked key entry and format check;
  - test result, routing offering only capable providers, fallback rows, budget, key removal and clean logs.

**Defects found by the tests and fixed:**
1. `routeOptions` offered the unconfigured service.
2. `status()` reported a credential for the planned self-hosted provider.
3. Focus jumped when fallback rows appeared.

**Results**
- Unit tests **461/461** (443 existing + 18 AI); build tests **6/6**; typecheck OK; release check OK.
- **No existing project test was changed.** Only the AI-02 test files, which are new and uncommitted, were rewritten for the new API.

## 9. Compatibility

- **ES5:** the compatibility check has no findings in `src/`, and the bundle contains no object spread or other ES2015+ syntax.
- **Tizen 3.0:** XHR only (no fetch), no AbortController, no new browser APIs. The Samsung `config.xml` and the app ID are unchanged.
- **Android:** the same code. Credentials go in the Android Keystore through the existing bridge; the debug APK builds (0.3.4-beta.1).
- **Unchanged:** playback, the playlist storage format and migration, the EPG, VOD and Live code paths, and the existing `http-client.ts`.
- **AI off by default;** nothing is sent at start-up (tested).
- **Bundle:** `app.js` is 553 KB (530 KB after the first AI-02).

## 10. Remaining risks

1. **No backend exists.** For distribution, every real AI feature depends on building and operating the EliteStream AI service: cost, operations, GDPR and the DPAs with providers.
2. **The Samsung connectivity test on the TV is still outstanding** (Gemini own-key mode). The gateway would also need TLS and CORS on its own domain.
3. **Device keys** (own-key mode) remain extractable. They are acceptable only for personal or development use.
4. **The gateway protocol is a proposal.** The server must match it, or the client adapter must be adjusted when the server is built.
5. **Provider free-tier limits are unpublished** and change; the local limits are conservative.
6. **Planned-provider capabilities are expectations,** to be verified per provider.
7. **Settings schema 2** replaces the uncommitted schema 1. No migration is needed because schema 1 was never released.
8. **Model lists live in memory per session.** The first request after a restart fetches the list (one extra request).

## 11. Recommended next stage

1. **Decide on the backend:** build the EliteStream AI service (the scope in §6), or limit AI to personal own-key use for now.
2. **TV verification** of the own-key path (approved install): Gemini connection test on the Samsung (and the Philips), with your key.
3. **Then AI-08 (EPG enrichment)** on top of `runTask('epg.enrich' | 'epg.summary')`, with no change to the provider architecture.
