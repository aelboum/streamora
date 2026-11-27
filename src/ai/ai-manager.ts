// AIProviderManager + task router (AI-02 multi-provider). The single entry point for AI requests:
// features (later stages) call runTask(task, request) and never name a provider or model.
// Every failure resolves with a code; nothing throws, so no feature can break because AI is off,
// misconfigured or unreachable. Playback never calls this.
//
// runTask(task, request):
//   1. master switch on; task known; the task's capability is one this client can execute
//      (text.generate in AI-02; audio/speech tasks → 'not-implemented');
//   2. privacy guard on the request text (URLs, credentials, e-mail, keys, long tokens → refused,
//      nothing sent) and the prompt size limit;
//   3. route: the task's primary {provider, model}; the fallback only when automatic fallback is on;
//   4. per candidate, in order: provider implemented and declares the capability · consent for the
//      provider's data group · credentials · model list (fetched when missing or older than an hour)
//      · model chosen (configured or automatic) and validated against the list, its capabilities
//      covering the task · consent for the model's own data group (gateway upstream) · cache ·
//      usage slot (global limits, provider budget, provider quota pause) · the call, with retries
//      for transient failures;
//   5. the fallback is tried only after an availability failure of the primary (unavailable,
//      network, timeout, quota, budget, service user quota, model gone). Configuration and privacy
//      failures never fall back, and the fallback must pass every check on its own: its consent,
//      capability, credentials and budget. A fallback answer is marked (fallback: true).
// Logging: codes, statuses, provider and model ids, figures. Never keys, prompts, answers or URLs.
import type { Logger } from '../utils/log.ts';
import type { AiCache } from './ai-cache.ts';
import { aiCacheKey } from './ai-cache.ts';
import type { AiRouteRef, AiSettingsStore } from './ai-settings.ts';
import type { ProviderRegistry } from './provider-registry.ts';
import type { UsageManager } from './usage-manager.ts';
import { AI_TASKS, modelServes, taskSpec } from './tasks.ts';
import type { AiTaskSpec } from './tasks.ts';
import type { AiAuth, AiCapability, AiConnectionResult, AiErrorCode, AiModelInfo, AiProviderAdapter, AiProviderDescriptor, AiTask, AiTextRequest, AiTextResult } from './types.ts';

export interface AiManagerLimits {
  retryAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxPromptChars: number;
  /** Model lists older than this are fetched again before use. */
  modelListMaxAgeMs: number;
}

export interface AiManagerDeps {
  settings: AiSettingsStore;
  registry: ProviderRegistry;
  usage: UsageManager;
  cache: AiCache;
  log: Logger;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  limits: AiManagerLimits;
  /** 0..1; injectable for tests. */
  random?: () => number;
}

export interface AiCallOptions {
  /** Cache namespace (e.g. 'epg-desc'); absent = do not cache. */
  cache?: string;
  ttlMs?: number;
}

export interface AiProviderStatus {
  descriptor: AiProviderDescriptor;
  consent: boolean;
  hasCredential: boolean;
  /** Last successful connection test on this device (0 = never). */
  verifiedAt: number;
  /** Models listed (null = not listed yet). */
  models: number | null;
}

export interface AiStatus {
  enabled: boolean;
  fallbackEnabled: boolean;
  keyStore: 'persistent' | 'session' | 'none';
  providers: AiProviderStatus[];
}

export interface AiManager {
  status(): Promise<AiStatus>;
  /** Fetches a provider's models (needs consent for its group and credentials). */
  refreshModels(provider: string): Promise<{ ok: true; models: AiModelInfo[] } | { ok: false; code: AiErrorCode }>;
  /** Credentials, model list and one tiny text request. Needs consent, not the master switch. */
  testConnection(provider: string): Promise<AiConnectionResult>;
  /** Route choices for a task: implemented providers declaring the capability, with '' (automatic)
   *  plus every listed model that covers the task. Planned providers never appear. */
  routeOptions(task: AiTask): AiRouteRef[];
  runTask(task: AiTask, req: AiTextRequest, opts?: AiCallOptions): Promise<AiTextResult>;
}

/**
 * Text that must never be sent to an AI provider: any URL (stream and playlist URLs carry the
 * login), e-mail addresses, "password=" / "username:" style credentials, API-key-like and other
 * long opaque tokens. Deliberately strict: a false positive only means one request is not sent.
 */
export function privacyViolation(text: string): boolean {
  if (typeof text !== 'string') { return true; }
  if (/\b[a-z][a-z0-9+.\-]{1,15}:\/\//i.test(text)) { return true; }
  if (/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.test(text)) { return true; }
  if (/AIza[0-9A-Za-z_\-]{20,}/.test(text)) { return true; }
  if (/AQ\.[0-9A-Za-z_\-.]{20,}/.test(text)) { return true; }
  if (/\b(?:password|passwd|pwd|username|user_?name|api[_-]?key|token)\s*[=:]/i.test(text)) { return true; }
  if (/[A-Za-z0-9_\-]{40,}/.test(text)) { return true; }
  return false;
}

/** Capabilities this client can execute in AI-02 (audio and speech come with later stages). */
const EXECUTABLE: AiCapability[] = ['text.generate'];
const RETRYABLE: AiErrorCode[] = ['network', 'timeout', 'unavailable'];
/** Failures of the primary after which a configured fallback may be tried. */
export const FALLBACK_ON: AiErrorCode[] = ['unavailable', 'network', 'timeout', 'quota', 'budget', 'user-quota', 'model-not-found', 'not-configured'];

type Check<T> = { ok: true; value: T } | { ok: false; code: AiErrorCode; status: number; retryAfterMs: number };

function no<T>(code: AiErrorCode, status?: number, retryAfterMs?: number): Check<T> {
  return { ok: false, code: code, status: status || 0, retryAfterMs: retryAfterMs || 0 };
}

export function createAiManager(d: AiManagerDeps): AiManager {
  const log = d.log;
  const random = d.random || Math.random;

  function wait(ms: number): Promise<void> {
    return new Promise<void>(function (resolve) { d.setTimer(resolve, ms); });
  }

  function backoff(attempt: number, hintMs: number): number {
    const exp = Math.min(d.limits.retryMaxMs, d.limits.retryBaseMs * Math.pow(2, attempt));
    const jitter = Math.round(exp * 0.25 * random());
    return Math.min(d.limits.retryMaxMs, Math.max(hintMs, exp + jitter));
  }

  function budget(): { dailyRequests: number; dailyTokens: number } {
    const b = d.settings.get().budget;
    return { dailyRequests: b.dailyRequestsPerProvider, dailyTokens: b.dailyTokensPerProvider };
  }

  /** Implemented adapter + consent for its group + credentials. */
  function access(provider: string): Promise<Check<{ a: AiProviderAdapter; auth: AiAuth }>> {
    const desc = d.registry.descriptor(provider);
    if (!desc) { return Promise.resolve(no<{ a: AiProviderAdapter; auth: AiAuth }>('invalid-request')); }
    const a = d.registry.adapter(provider);
    if (!a || desc.status !== 'implemented') { return Promise.resolve(no<{ a: AiProviderAdapter; auth: AiAuth }>('not-implemented')); }
    if (!d.settings.hasConsent(desc.dataGroup)) { return Promise.resolve(no<{ a: AiProviderAdapter; auth: AiAuth }>('no-consent')); }
    if (desc.auth === 'none') { return Promise.resolve({ ok: true as const, value: { a: a, auth: { kind: 'none' as const, secret: '' } } }); }
    if (!d.settings.keyStoreAvailable()) { return Promise.resolve(no<{ a: AiProviderAdapter; auth: AiAuth }>('no-key-store')); }
    return d.settings.loadCredential(provider, desc.auth).then(function (secret): Check<{ a: AiProviderAdapter; auth: AiAuth }> {
      if (!secret || (a.validKey && !a.validKey(secret))) { return no('no-credentials'); }
      return { ok: true, value: { a: a, auth: { kind: desc.auth, secret: secret } } };
    }, function () { return no<{ a: AiProviderAdapter; auth: AiAuth }>('no-credentials'); });
  }

  /** The provider's model list, fetched when missing or stale (counts as a request). */
  function ensureModels(provider: string, a: AiProviderAdapter, auth: AiAuth, force: boolean): Promise<Check<AiModelInfo[]>> {
    const have = d.registry.models(provider);
    if (have && !force && d.now() - d.registry.listedAt(provider) < d.limits.modelListMaxAgeMs) {
      return Promise.resolve({ ok: true as const, value: have });
    }
    const slot = d.usage.acquire(provider, budget());
    if (!slot.ok) { return Promise.resolve(no<AiModelInfo[]>(slot.code, 0, slot.retryAfterMs)); }
    return a.listModels(auth).then(function (r): Check<AiModelInfo[]> {
      slot.release(r.ok ? {} : { error: r.code, retryAfterMs: r.retryAfterMs });
      if (!r.ok) { return no(r.code, r.status, r.retryAfterMs); }
      d.registry.setModels(provider, r.models, d.now());
      return { ok: true, value: d.registry.models(provider) || [] };
    }, function () {
      slot.release({ error: 'network' });
      return no<AiModelInfo[]>('network');
    });
  }

  /** Picks and validates the model of a route slot for a task. */
  function pickModel(ref: AiRouteRef, a: AiProviderAdapter, spec: AiTaskSpec): Check<AiModelInfo> {
    const fits = d.registry.modelsFor(ref.provider, spec.requires, spec.json);
    const consented: AiModelInfo[] = [];
    for (let i = 0; i < fits.length; i++) { if (d.settings.hasConsent(fits[i].dataGroup)) { consented.push(fits[i]); } }
    const id = ref.model || a.chooseModel(consented, spec.requires, spec.json);
    if (!id) { return no(fits.length ? 'no-consent' : 'capability-unsupported'); }
    const m = d.registry.model(ref.provider, id);
    if (!m || !m.available) { return no('model-not-found'); }
    if (!modelServes(m.capabilities, spec)) { return no('capability-unsupported'); }
    if (!d.settings.hasConsent(m.dataGroup)) { return no('no-consent'); }
    return { ok: true, value: m };
  }

  function call(a: AiProviderAdapter, auth: AiAuth, provider: string, model: string, req: AiTextRequest, task: AiTask): Promise<AiTextResult> {
    let attempt = 0;
    const maybe = a.generateText;
    if (!maybe) { return Promise.resolve<AiTextResult>({ ok: false, code: 'capability-unsupported', status: 0, retryAfterMs: 0, provider: provider }); }
    const gen: NonNullable<AiProviderAdapter['generateText']> = maybe;
    function once(): Promise<AiTextResult> {
      const slot = d.usage.acquire(provider, budget());
      if (!slot.ok) { return Promise.resolve<AiTextResult>({ ok: false, code: slot.code, status: 0, retryAfterMs: slot.retryAfterMs, provider: provider }); }
      return gen(auth, model, req, task).then(function (r) { return r; }, function (): AiTextResult {
        return { ok: false, code: 'network', status: 0, retryAfterMs: 0, provider: provider };
      }).then(function (r) {
        if (r.ok) {
          slot.release({ usage: r.usage });
          return r;
        }
        slot.release({ error: r.code, retryAfterMs: r.retryAfterMs });
        const shortQuota = r.code === 'quota' && r.retryAfterMs > 0 && r.retryAfterMs <= d.limits.retryMaxMs;
        if (attempt < d.limits.retryAttempts && (RETRYABLE.indexOf(r.code) >= 0 || shortQuota)) {
          const delay = backoff(attempt, r.retryAfterMs);
          attempt++;
          log.info('ai: retry', { provider: provider, code: r.code, status: r.status, attempt: attempt, delayMs: delay });
          return wait(delay).then(once);
        }
        return r;
      });
    }
    return once();
  }

  function attempt(ref: AiRouteRef, spec: AiTaskSpec, req: AiTextRequest, opts: AiCallOptions | undefined, isFallback: boolean): Promise<AiTextResult> {
    const provider = ref.provider;
    function failed(code: AiErrorCode, status?: number, retryAfterMs?: number): AiTextResult {
      return { ok: false, code: code, status: status || 0, retryAfterMs: retryAfterMs || 0, provider: provider };
    }
    const desc = d.registry.descriptor(provider);
    if (desc && desc.capabilities.indexOf(spec.requires) < 0) { return Promise.resolve(failed('capability-unsupported')); }
    return access(provider).then(function (acc): AiTextResult | Promise<AiTextResult> {
      if (!acc.ok) { return failed(acc.code, acc.status, acc.retryAfterMs); }
      const a = acc.value.a;
      const auth = acc.value.auth;
      return ensureModels(provider, a, auth, false).then(function (ml): AiTextResult | Promise<AiTextResult> {
        if (!ml.ok) { return failed(ml.code, ml.status, ml.retryAfterMs); }
        const pm = pickModel(ref, a, spec);
        if (!pm.ok) { return failed(pm.code, pm.status, pm.retryAfterMs); }
        const model = pm.value.id;
        const ns = opts && opts.cache;
        const ck = ns ? aiCacheKey([provider, model, ns, spec.task, req.system || '', req.prompt, String(req.json || false), String(req.maxOutputTokens || 0)]) : '';
        const cached: Promise<string | null> = ns ? d.cache.get(ck).then(null, function () { return null; }) : Promise.resolve(null);
        return cached.then(function (hit): AiTextResult | Promise<AiTextResult> {
          if (ns) { d.usage.recordCache(hit !== null); }
          if (hit !== null) {
            return { ok: true, text: hit, provider: provider, model: model, usage: { inputTokens: 0, outputTokens: 0 }, cached: true, fallback: isFallback };
          }
          return call(a, auth, provider, model, req, spec.task).then(function (r): AiTextResult {
            if (r.ok) {
              if (ns) { d.cache.set(ck, r.text, opts && opts.ttlMs).then(null, function () { /* cache is best effort */ }); }
              return { ok: true, text: r.text, provider: r.provider, model: r.model, usage: r.usage, cached: false, fallback: isFallback };
            }
            return r;
          });
        });
      });
    });
  }

  return {
    status: function (): Promise<AiStatus> {
      const s = d.settings.get();
      const descs = d.registry.descriptors();
      const out: AiProviderStatus[] = [];
      let chain: Promise<void> = Promise.resolve();
      for (let i = 0; i < descs.length; i++) {
        const desc = descs[i];
        chain = chain.then(function () {
          const has = desc.status !== 'implemented' ? Promise.resolve(false)
            : desc.auth === 'none' ? Promise.resolve(true) : d.settings.hasCredential(desc.id, desc.auth);
          return has.then(function (h) {
            const m = d.registry.models(desc.id);
            out.push({ descriptor: desc, consent: d.settings.hasConsent(desc.dataGroup), hasCredential: h, verifiedAt: s.verified[desc.id] || 0, models: m ? m.length : null });
          });
        });
      }
      return chain.then(function () {
        return {
          enabled: s.enabled, fallbackEnabled: s.fallbackEnabled,
          keyStore: !d.settings.keyStoreAvailable() ? 'none' as const : d.settings.keyPersistent() ? 'persistent' as const : 'session' as const,
          providers: out
        };
      });
    },

    refreshModels: function (provider: string) {
      return access(provider).then(function (acc) {
        if (!acc.ok) { return { ok: false as const, code: acc.code }; }
        return ensureModels(provider, acc.value.a, acc.value.auth, true).then(function (m) {
          return m.ok ? { ok: true as const, models: m.value } : { ok: false as const, code: m.code };
        });
      });
    },

    testConnection: function (provider: string): Promise<AiConnectionResult> {
      const t0 = d.now();
      function result(ok: boolean, stage: AiConnectionResult['stage'], code: AiErrorCode | null, status: number, models: number, model: string): AiConnectionResult {
        const r = { ok: ok, provider: provider, stage: stage, code: code, status: status, models: models, model: model, latencyMs: Math.max(0, d.now() - t0) };
        log.info('ai: connection test', { provider: provider, ok: ok, stage: stage, code: code, status: status, models: models, model: model, latencyMs: r.latencyMs });
        if (ok) { d.settings.markVerified(provider, d.now()); }
        return r;
      }
      return access(provider).then(function (acc) {
        if (!acc.ok) { return result(false, 'checks', acc.code, 0, 0, ''); }
        const a = acc.value.a;
        const auth = acc.value.auth;
        return ensureModels(provider, a, auth, true).then(function (ml) {
          if (!ml.ok) { return result(false, 'models', ml.code, ml.status, 0, ''); }
          const text = d.registry.modelsFor(provider, 'text.generate', false);
          const consented: AiModelInfo[] = [];
          for (let i = 0; i < text.length; i++) { if (d.settings.hasConsent(text[i].dataGroup)) { consented.push(text[i]); } }
          const model = a.chooseModel(consented, 'text.generate', false);
          if (!model || !a.generateText) { return result(false, 'models', text.length ? 'no-consent' : 'capability-unsupported', 0, ml.value.length, ''); }
          return call(a, auth, provider, model, { prompt: 'Reply with the single word OK.', maxOutputTokens: 16, temperature: 0 }, 'epg.summary').then(function (r) {
            return r.ok ? result(true, 'done', null, 200, ml.value.length, model) : result(false, 'generate', r.code, r.status, ml.value.length, model);
          });
        });
      });
    },

    routeOptions: function (task: AiTask): AiRouteRef[] {
      const spec = taskSpec(task);
      const out: AiRouteRef[] = [];
      if (!spec) { return out; }
      const descs = d.registry.descriptors();
      for (let i = 0; i < descs.length; i++) {
        const desc = descs[i];
        if (desc.status !== 'implemented' || desc.capabilities.indexOf(spec.requires) < 0) { continue; }
        const ad = d.registry.adapter(desc.id);
        if (!ad || (ad.configured && !ad.configured())) { continue; } // e.g. no EliteStream AI service in this build
        out.push({ provider: desc.id, model: '' });
        const ms = d.registry.modelsFor(desc.id, spec.requires, spec.json);
        for (let j = 0; j < ms.length && j < 40; j++) { out.push({ provider: desc.id, model: ms[j].id }); }
      }
      return out;
    },

    runTask: function (task: AiTask, req: AiTextRequest, opts?: AiCallOptions): Promise<AiTextResult> {
      function failed(code: AiErrorCode, provider?: string): Promise<AiTextResult> {
        return Promise.resolve<AiTextResult>({ ok: false, code: code, status: 0, retryAfterMs: 0, provider: provider || '' });
      }
      const s = d.settings.get();
      if (!s.enabled) { return failed('disabled'); }
      const spec = taskSpec(task);
      if (!spec) { return failed('invalid-request'); }
      if (EXECUTABLE.indexOf(spec.requires) < 0) { return failed('not-implemented'); }
      if (!req || typeof req.prompt !== 'string' || !req.prompt || ((req.system || '').length + req.prompt.length) > d.limits.maxPromptChars) { return failed('invalid-request'); }
      if (privacyViolation(req.prompt) || (req.system ? privacyViolation(req.system) : false)) {
        log.warn('ai: request refused by the privacy guard', { task: task, chars: req.prompt.length });
        return failed('privacy-blocked');
      }
      const route = d.settings.route(task);
      if (!route.primary) { return failed('no-route'); }
      const primary = route.primary;
      const fallback = s.fallbackEnabled ? route.fallback : null;
      return attempt(primary, spec, req, opts, false).then(function (r): AiTextResult | Promise<AiTextResult> {
        if (r.ok) { return r; }
        if (!fallback || FALLBACK_ON.indexOf(r.code) < 0 || (fallback.provider === primary.provider && fallback.model === primary.model)) {
          log.warn('ai: task failed', { task: task, provider: primary.provider, code: r.code, status: r.status });
          return r;
        }
        log.info('ai: fallback', { task: task, from: primary.provider, to: fallback.provider, reason: r.code });
        d.usage.recordFallback();
        return attempt(fallback, spec, req, opts, true).then(function (f) {
          if (!f.ok) { log.warn('ai: fallback failed', { task: task, provider: fallback.provider, code: f.code, status: f.status }); }
          return f;
        });
      }, function () { return failed('network', primary.provider); });
    }
  };
}

/** Tasks for Settings, in display order (re-exported for the UI). */
export const TASKS = AI_TASKS;
