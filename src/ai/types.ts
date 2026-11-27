// EliteStream AI Intelligence Engine: shared types (AI-02, multi-provider revision).
//
// Separation of concerns (docs/AI-02-MULTI-PROVIDER-REPORT.md §2):
//   provider     who runs the model (descriptor: id, data-processing group, auth type, status)
//   model        what a provider offers (discovered from the provider, validated before use)
//   capability   what a model can do (text.generate, audio.transcribe, speech.synthesize, …)
//   task         what an app feature needs (epg.enrich, subtitle.translate, …) → required capability
//   route        which provider/model serves a task (primary + optional fallback), user-chosen
// Features (later stages) call AiManager.runTask(task, request); they never name a provider.
// Nothing here depends on playback.

/** What a model can do. Declared by providers, never assumed for all of them. */
export type AiCapability =
  | 'text.generate'           // text in, text out (summaries, descriptions, translation, search)
  | 'text.json'               // structured JSON output
  | 'audio.transcribe'        // recorded audio → text with timestamps
  | 'audio.transcribe.stream' // live audio → text, streaming
  | 'audio.translate'         // audio → text in another language
  | 'speech.synthesize';      // text → speech (TTS)

export const AI_CAPABILITIES: AiCapability[] = ['text.generate', 'text.json', 'audio.transcribe', 'audio.transcribe.stream', 'audio.translate', 'speech.synthesize'];

/** App features that can use AI. None is implemented in AI-02; routing is prepared for all. */
export type AiTask =
  | 'epg.enrich' | 'epg.summary' | 'subtitle.translate' | 'subtitle.generate' | 'speech.live'
  | 'audio.translate' | 'speech.tts' | 'audio.dub' | 'search';

export type AiErrorCode =
  | 'disabled'               // AI master switch off (the default)
  | 'no-consent'             // no consent for this provider's data-processing group
  | 'no-credentials'         // no key (direct providers) or not signed in (EliteStream AI service)
  | 'no-key-store'           // the device cannot store credentials
  | 'not-configured'         // provider prepared but not available in this build (e.g. no service address)
  | 'not-implemented'        // provider is planned only
  | 'no-route'               // no provider/model configured or able to serve this task
  | 'capability-unsupported' // the chosen model cannot do what the task needs
  | 'invalid-key'            // the provider rejected the key / the service rejected the session
  | 'permission'             // authenticated but not allowed (API not enabled, region, billing, plan)
  | 'quota'                  // provider quota exhausted or local cooldown after one
  | 'user-quota'             // the EliteStream AI service's per-user limit is reached
  | 'budget'                 // local token budget or the service's global budget is reached
  | 'rate-limited'           // local per-minute / per-day request limit reached
  | 'busy'                   // too many requests in flight (backpressure; nothing queues)
  | 'unavailable'            // provider or service down / overloaded (5xx), or no network stack
  | 'network'                // DNS, TLS, CORS or connection failure
  | 'timeout'
  | 'bad-response'
  | 'too-large'
  | 'blocked'                // the provider's safety filter refused
  | 'model-not-found'
  | 'invalid-request'
  | 'privacy-blocked';       // the text looked like it carried URLs or credentials; not sent

/** How a provider authenticates. 'api-key' keys live on the device: personal / development use only. */
export type AiAuthKind = 'api-key' | 'user-session' | 'none';

/** 'implemented' = adapter exists (verified only against test doubles until a live test passes);
 *  'planned' = registered for later, never selectable. */
export type AiProviderStatus = 'implemented' | 'planned';

export interface AiProviderDescriptor {
  id: string;
  name: string;
  /** Who processes the data (consent is given per group; fallback never crosses groups silently). */
  dataGroup: string;
  auth: AiAuthKind;
  status: AiProviderStatus;
  /** Capabilities the provider type can offer (each model then declares its own). */
  capabilities: AiCapability[];
  /** True when the provider is suitable for distribution to other users (keys stay server-side). */
  distributionSafe: boolean;
  /** Short note for Settings (i18n key). */
  noteKey: string;
}

export interface AiModelInfo {
  provider: string;
  /** Provider's model id, validated before every request. */
  id: string;
  displayName: string;
  capabilities: AiCapability[];
  /** e.g. ['text'], ['text','audio']. */
  inputFormats: string[];
  outputFormats: string[];
  /** Context / output limits in tokens (0 = unknown). */
  inputTokenLimit: number;
  outputTokenLimit: number;
  streaming: boolean;
  /** For gateway models: the upstream provider's data group (consent applies to it too). */
  dataGroup: string;
  available: boolean;
}

export interface AiTextRequest {
  /** Instructions for the model (sent as system instruction where supported). */
  system?: string;
  /** The user-content text. Must not contain URLs, credentials or personal data (enforced). */
  prompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask for a JSON answer (needs text.json). */
  json?: boolean;
}

export interface AiUsage { inputTokens: number; outputTokens: number }

export type AiTextResult =
  | { ok: true; text: string; provider: string; model: string; usage: AiUsage; cached: boolean; fallback: boolean }
  | { ok: false; code: AiErrorCode; status: number; retryAfterMs: number; provider: string };

export type AiModelsResult =
  | { ok: true; models: AiModelInfo[] }
  | { ok: false; code: AiErrorCode; status: number; retryAfterMs: number };

/** Credentials handed to an adapter for one call. Never stored by adapters, never logged. */
export interface AiAuth { kind: AiAuthKind; secret: string }

/** An implemented provider adapter. Capability-specific calls are optional. */
export interface AiProviderAdapter {
  readonly descriptor: AiProviderDescriptor;
  /** Models usable now, with their capabilities (from the provider, not assumed). */
  listModels(auth: AiAuth): Promise<AiModelsResult>;
  /** text.generate (and text.json). */
  generateText?(auth: AiAuth, model: string, req: AiTextRequest, task: AiTask): Promise<AiTextResult>;
  /** Automatic model choice among listed models for a capability ('' when none fits). */
  chooseModel(models: AiModelInfo[], capability: AiCapability, json: boolean): string;
  /** Format check for a user-entered key (api-key providers). */
  validKey?(key: string): boolean;
  /** False when the provider cannot work in this build (e.g. no service address). Absent = true. */
  configured?(): boolean;
}

/** Result of a provider connection test. Codes and figures only. */
export interface AiConnectionResult {
  ok: boolean;
  provider: string;
  stage: 'checks' | 'models' | 'generate' | 'done';
  code: AiErrorCode | null;
  status: number;
  models: number;
  model: string;
  latencyMs: number;
}
