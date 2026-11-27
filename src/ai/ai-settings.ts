// AISettingsManager (AI-02 multi-provider): AI switches, consent, task routes and budgets in KV
// `ai.settings` (schema 2), and provider credentials in the platform key store.
//   - Everything is OFF by default: master switch off, no consent for any data-processing group,
//     no routes, automatic fallback off, no audio.
//   - Consent is per data-processing group (google, openai, elitestream, …): the party that
//     receives the text. A route or fallback is only used when its group has consent.
//   - Routes: per task a primary and an optional fallback {provider, model}; model '' = automatic.
//     Only implemented providers can be stored; planned ones are refused.
//   - Credentials: one key-store alias per provider (`ai_key_<id>` for API keys, `ai_session_<id>`
//     for the EliteStream AI service session token). Never in KV, never shown, never logged.
//     Playlist secrets (ss_pl_*) are not touched.
//   - Security limitation (docs/AI-02-MULTI-PROVIDER-REPORT.md §6): a provider API key stored on a
//     TV or phone is not production-safe; direct keys are for personal / development use only.
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { KeyStore } from '../app/platform/platform.ts';
import type { AiAuthKind, AiTask } from './types.ts';
import { isTask } from './tasks.ts';

export const KV_AI_SETTINGS = 'ai.settings';
const SCHEMA = 2;
const PROVIDER_RE = /^[a-z][a-z0-9\-]{1,30}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9.\-_:\/]{0,140}$/;
const GROUP_RE = /^[a-z][a-z0-9\-]{1,30}$/;

export interface AiRouteRef { provider: string; model: string }
export interface AiRoute { primary: AiRouteRef | null; fallback: AiRouteRef | null }

export interface AiBudget {
  /** Requests per local day, per provider (on top of the global request limit). */
  dailyRequestsPerProvider: number;
  /** Tokens (in + out) per local day, per provider. */
  dailyTokensPerProvider: number;
}

export interface AiSettings {
  enabled: boolean;
  consent: Record<string, boolean>;
  routes: Record<string, AiRoute>;
  fallbackEnabled: boolean;
  budget: AiBudget;
  /** Provider → time of the last successful connection test on this device (0 / absent = never). */
  verified: Record<string, number>;
  /** Consent for audio processing (reserved for later stages; no AI-02 feature uses audio). */
  allowAudio: boolean;
}

export const DEFAULT_BUDGET: AiBudget = { dailyRequestsPerProvider: 150, dailyTokensPerProvider: 300000 };

export function defaultAiSettings(): AiSettings {
  return { enabled: false, consent: {}, routes: {}, fallbackEnabled: false, budget: { dailyRequestsPerProvider: DEFAULT_BUDGET.dailyRequestsPerProvider, dailyTokensPerProvider: DEFAULT_BUDGET.dailyTokensPerProvider }, verified: {}, allowAudio: false };
}

function isRef(x: unknown): x is AiRouteRef {
  const r = x as AiRouteRef;
  return !!r && typeof r === 'object' && typeof r.provider === 'string' && PROVIDER_RE.test(r.provider) &&
    typeof r.model === 'string' && (r.model === '' || MODEL_RE.test(r.model));
}

function isSettings(x: unknown): x is AiSettings {
  const o = x as AiSettings;
  if (!o || typeof o !== 'object' || typeof o.enabled !== 'boolean' || typeof o.fallbackEnabled !== 'boolean' || typeof o.allowAudio !== 'boolean') { return false; }
  if (!o.consent || typeof o.consent !== 'object' || !o.routes || typeof o.routes !== 'object' || !o.verified || typeof o.verified !== 'object') { return false; }
  if (!o.budget || typeof o.budget.dailyRequestsPerProvider !== 'number' || typeof o.budget.dailyTokensPerProvider !== 'number') { return false; }
  for (const g in o.consent) { if (Object.prototype.hasOwnProperty.call(o.consent, g) && (!GROUP_RE.test(g) || typeof o.consent[g] !== 'boolean')) { return false; } }
  for (const t in o.routes) {
    if (!Object.prototype.hasOwnProperty.call(o.routes, t)) { continue; }
    const r = o.routes[t];
    if (!isTask(t) || !r || (r.primary !== null && !isRef(r.primary)) || (r.fallback !== null && !isRef(r.fallback))) { return false; }
  }
  return true;
}

function copy(s: AiSettings): AiSettings {
  return JSON.parse(JSON.stringify(s)) as AiSettings;
}

/** Key-store alias for a provider credential. */
export function credentialAlias(provider: string, kind: AiAuthKind): string {
  return (kind === 'user-session' ? 'ai_session_' : 'ai_key_') + provider.replace(/-/g, '_');
}

export interface AiSettingsStore {
  get(): AiSettings;
  setEnabled(on: boolean): void;
  hasConsent(group: string): boolean;
  setConsent(group: string, on: boolean): void;
  route(task: AiTask): AiRoute;
  /** Stores a route slot; `implemented(provider)` must be true (planned providers are refused). */
  setRoute(task: AiTask, slot: 'primary' | 'fallback', ref: AiRouteRef | null, implemented: (provider: string) => boolean): boolean;
  setFallbackEnabled(on: boolean): void;
  setBudget(b: Partial<AiBudget>): void;
  markVerified(provider: string, at: number): void;
  clearVerified(provider: string): void;
  /** Restores the defaults (credentials stay; removeCredential() deletes them). */
  reset(): void;

  keyStoreAvailable(): boolean;
  keyPersistent(): boolean;
  hasCredential(provider: string, kind: AiAuthKind): Promise<boolean>;
  /** Rejects 'invalid-key-format' / 'no-key-store'. */
  setCredential(provider: string, kind: AiAuthKind, secret: string, valid: (s: string) => boolean): Promise<void>;
  removeCredential(provider: string, kind: AiAuthKind): Promise<void>;
  /** For the AI manager only: the credential or null. Never log or display the result. */
  loadCredential(provider: string, kind: AiAuthKind): Promise<string | null>;
}

export function createAiSettings(kv: KeyValueStore, keys: KeyStore | null): AiSettingsStore {
  let s: AiSettings = kv.get<AiSettings>(KV_AI_SETTINGS, isSettings, defaultAiSettings(), SCHEMA);
  const known: Record<string, boolean> = {};

  function save(): void { kv.set(KV_AI_SETTINGS, s, SCHEMA); }

  return {
    get: function () { return copy(s); },
    setEnabled: function (on: boolean) { s.enabled = !!on; save(); },
    hasConsent: function (group: string) { return Object.prototype.hasOwnProperty.call(s.consent, group) && s.consent[group] === true; },
    setConsent: function (group: string, on: boolean) {
      if (!GROUP_RE.test(group)) { return; }
      if (on) { s.consent[group] = true; } else { delete s.consent[group]; }
      save();
    },
    route: function (task: AiTask): AiRoute {
      const r = Object.prototype.hasOwnProperty.call(s.routes, task) ? s.routes[task] : null;
      return r ? { primary: r.primary ? { provider: r.primary.provider, model: r.primary.model } : null, fallback: r.fallback ? { provider: r.fallback.provider, model: r.fallback.model } : null } : { primary: null, fallback: null };
    },
    setRoute: function (task, slot, ref, implemented) {
      if (!isTask(task) || (ref !== null && (!isRef(ref) || !implemented(ref.provider)))) { return false; }
      const r = Object.prototype.hasOwnProperty.call(s.routes, task) ? s.routes[task] : { primary: null, fallback: null };
      r[slot] = ref ? { provider: ref.provider, model: ref.model } : null;
      if (!r.primary && !r.fallback) { delete s.routes[task]; } else { s.routes[task] = r; }
      save();
      return true;
    },
    setFallbackEnabled: function (on: boolean) { s.fallbackEnabled = !!on; save(); },
    setBudget: function (b: Partial<AiBudget>) {
      if (typeof b.dailyRequestsPerProvider === 'number' && b.dailyRequestsPerProvider >= 0 && b.dailyRequestsPerProvider <= 100000) { s.budget.dailyRequestsPerProvider = Math.floor(b.dailyRequestsPerProvider); }
      if (typeof b.dailyTokensPerProvider === 'number' && b.dailyTokensPerProvider >= 0 && b.dailyTokensPerProvider <= 100000000) { s.budget.dailyTokensPerProvider = Math.floor(b.dailyTokensPerProvider); }
      save();
    },
    markVerified: function (provider: string, at: number) { if (PROVIDER_RE.test(provider)) { s.verified[provider] = at; save(); } },
    clearVerified: function (provider: string) { delete s.verified[provider]; save(); },
    reset: function () { s = defaultAiSettings(); save(); },

    keyStoreAvailable: function () { return !!keys; },
    keyPersistent: function () { return !!keys && keys.persistent; },
    hasCredential: function (provider, kind) {
      const alias = credentialAlias(provider, kind);
      if (!keys) { return Promise.resolve(false); }
      if (Object.prototype.hasOwnProperty.call(known, alias)) { return Promise.resolve(known[alias]); }
      return keys.load(alias).then(function (v) { known[alias] = !!v; return known[alias]; }, function () { return false; });
    },
    setCredential: function (provider, kind, secret, valid) {
      const v = typeof secret === 'string' ? secret.replace(/^\s+|\s+$/g, '') : '';
      if (!v || !valid(v)) { return Promise.reject(new Error('invalid-key-format')); }
      if (!keys) { return Promise.reject(new Error('no-key-store')); }
      const alias = credentialAlias(provider, kind);
      return keys.save(alias, v).then(function () { known[alias] = true; });
    },
    removeCredential: function (provider, kind) {
      if (!keys) { return Promise.resolve(); }
      const alias = credentialAlias(provider, kind);
      return keys.remove(alias).then(function () { known[alias] = false; });
    },
    loadCredential: function (provider, kind) {
      if (!keys) { return Promise.resolve(null); }
      const alias = credentialAlias(provider, kind);
      return keys.load(alias).then(function (v) { known[alias] = !!v; return v || null; }, function () { return null; });
    }
  };
}
