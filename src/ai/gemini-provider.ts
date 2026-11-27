// Gemini adapter (direct, own API key): Google Gemini API (REST, v1beta) over the AI HTTP client.
//   listModels:  GET  https://generativelanguage.googleapis.com/v1beta/models?pageSize=200
//   generate:    POST https://generativelanguage.googleapis.com/v1beta/models/<id>:generateContent
// The key goes only in the x-goog-api-key header (never in the URL). Errors are mapped to
// AiErrorCode from the HTTP status and the error body (error.status / ErrorInfo reason /
// RetryInfo retryDelay); response bodies are never logged.
// Capabilities come from the model list (supportedGenerationMethods): generateContent →
// text.generate + text.json. Audio and speech capabilities are NOT inferred from the listing; they
// will be declared only when a later stage verifies them.
// Direct keys live on the device: personal / development use only (distributionSafe = false).
// For distribution the same models are reached through the EliteStream AI service (gateway).
import type { AiHttpClient, AiHttpResult } from '../api/ai-http-client.ts';
import type { AiAuth, AiCapability, AiErrorCode, AiModelInfo, AiModelsResult, AiProviderAdapter, AiProviderDescriptor, AiTextRequest, AiTextResult } from './types.ts';

export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
const BASE = GEMINI_ORIGIN + '/v1beta/';
export const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,80}$/;
/**
 * Gemini keys: standard keys ("AIza…", ~39 letters, digits, - and _) and, since 2026-05-28, auth
 * keys from AI Studio ("AQ." + letters, digits, -, _ and dots; ~53 characters). Both go in the
 * x-goog-api-key header. A wider length band is accepted; spaces and URLs are rejected.
 */
const KEY_RE = /^(?:AQ\.[A-Za-z0-9_\-.]{17,197}|[A-Za-z0-9_\-]{20,200})$/;

export const GEMINI_DESCRIPTOR: AiProviderDescriptor = {
  id: 'gemini', name: 'Google Gemini', dataGroup: 'google', auth: 'api-key', status: 'implemented',
  capabilities: ['text.generate', 'text.json'], distributionSafe: false, noteKey: 'ai.prov.note.gemini'
};

/** Automatic choice: cheap/fast text models first (the 2.5 models are deprecated from 2026-12-01). */
const PREFERRED = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite',
  'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];

export interface GeminiLimits {
  timeoutMs: number;
  maxResponseChars: number;
}

interface GeminiErrorBody {
  error?: {
    code?: number;
    status?: string;
    details?: Array<{ '@type'?: string; reason?: string; retryDelay?: string }>;
  };
}

/** "12s" / "1.5s" → ms (0 when absent). */
export function parseRetryDelay(v: unknown): number {
  if (typeof v !== 'string') { return 0; }
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
  return m ? Math.min(3600000, Math.round(parseFloat(m[1]) * 1000)) : 0;
}

/** Transport-level failures shared by every adapter. Returns null for HTTP errors (provider-specific). */
export function transportError(r: AiHttpResult): { code: AiErrorCode; status: number; retryAfterMs: number } | null {
  if (r.ok) { return { code: 'bad-response', status: r.status, retryAfterMs: 0 }; }
  switch (r.kind) {
    case 'http': return null;
    case 'timeout': return { code: 'timeout', status: 0, retryAfterMs: 0 };
    case 'too-large': return { code: 'too-large', status: r.status, retryAfterMs: 0 };
    case 'parse': return { code: 'bad-response', status: r.status, retryAfterMs: 0 };
    case 'invalid-url': return { code: 'invalid-request', status: 0, retryAfterMs: 0 };
    case 'unavailable': return { code: 'unavailable', status: 0, retryAfterMs: 0 };
    default: return { code: 'network', status: 0, retryAfterMs: 0 }; // network, aborted, redirect-blocked
  }
}

/** Maps a failed AI HTTP result to an AiErrorCode and a retry delay (Gemini error bodies). */
export function geminiError(r: AiHttpResult): { code: AiErrorCode; status: number; retryAfterMs: number } {
  const t = transportError(r);
  if (t || r.ok) { return t || { code: 'bad-response', status: 0, retryAfterMs: 0 }; }
  const body = (r.json && typeof r.json === 'object' ? r.json : {}) as GeminiErrorBody;
  const err = body.error || {};
  const details = Array.isArray(err.details) ? err.details : [];
  let reason = '';
  let retryMs = r.retryAfterMs;
  for (let i = 0; i < details.length; i++) {
    const dt = details[i] || {};
    if (dt.reason && !reason) { reason = String(dt.reason); }
    const delay = parseRetryDelay(dt.retryDelay);
    if (delay) { retryMs = delay; }
  }
  const s = r.status;
  let code: AiErrorCode;
  if (reason === 'API_KEY_INVALID' || reason === 'API_KEY_EXPIRED' || s === 401) {
    code = 'invalid-key';
  } else if (s === 429 || err.status === 'RESOURCE_EXHAUSTED') {
    code = 'quota';
  } else if (s === 403) {
    code = 'permission';
  } else if (s === 404) {
    code = 'model-not-found';
  } else if (s === 400) {
    code = err.status === 'FAILED_PRECONDITION' ? 'permission' : 'invalid-request';
  } else if (s === 413) {
    code = 'too-large';
  } else if (s >= 500) {
    code = 'unavailable';
  } else {
    code = 'bad-response';
  }
  return { code: code, status: s, retryAfterMs: retryMs };
}

export function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0;
}

function fail(code: AiErrorCode, status: number, retryAfterMs: number): AiTextResult {
  return { ok: false, code: code, status: status, retryAfterMs: retryAfterMs, provider: 'gemini' };
}

export function createGeminiAdapter(http: AiHttpClient, limits: GeminiLimits): AiProviderAdapter {
  function headers(auth: AiAuth): Record<string, string> {
    return { 'x-goog-api-key': auth.secret };
  }

  return {
    descriptor: GEMINI_DESCRIPTOR,

    validKey: function (key: string): boolean { return typeof key === 'string' && KEY_RE.test(key); },

    listModels: function (auth: AiAuth): Promise<AiModelsResult> {
      return http.request({ method: 'GET', url: BASE + 'models?pageSize=200', headers: headers(auth), timeoutMs: limits.timeoutMs, maxChars: limits.maxResponseChars })
        .promise.then(function (r): AiModelsResult {
          if (!r.ok) {
            const e = geminiError(r);
            return { ok: false, code: e.code, status: e.status, retryAfterMs: e.retryAfterMs };
          }
          const o = r.json as { models?: unknown };
          if (!o || !Array.isArray(o.models)) {
            return { ok: false, code: 'bad-response', status: r.status, retryAfterMs: 0 };
          }
          const out: AiModelInfo[] = [];
          for (let i = 0; i < o.models.length && out.length < 300; i++) {
            const m = o.models[i] as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown; supportedGenerationMethods?: unknown };
            if (!m || typeof m.name !== 'string') { continue; }
            const id = m.name.indexOf('models/') === 0 ? m.name.substring(7) : m.name;
            if (!MODEL_ID.test(id)) { continue; }
            const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
            const caps: AiCapability[] = methods.indexOf('generateContent') >= 0 ? ['text.generate', 'text.json'] : [];
            if (!caps.length) { continue; }
            out.push({
              provider: 'gemini', id: id, displayName: typeof m.displayName === 'string' ? m.displayName.substring(0, 80) : id,
              capabilities: caps, inputFormats: ['text'], outputFormats: ['text', 'json'],
              inputTokenLimit: num(m.inputTokenLimit), outputTokenLimit: num(m.outputTokenLimit),
              streaming: false, dataGroup: 'google', available: true
            });
          }
          return { ok: true, models: out };
        });
    },

    chooseModel: function (models: AiModelInfo[], capability: AiCapability): string {
      for (let i = 0; i < PREFERRED.length; i++) {
        for (let j = 0; j < models.length; j++) {
          if (models[j].id === PREFERRED[i] && models[j].capabilities.indexOf(capability) >= 0) { return models[j].id; }
        }
      }
      for (let j = 0; j < models.length; j++) {
        if (/flash/.test(models[j].id) && models[j].capabilities.indexOf(capability) >= 0) { return models[j].id; }
      }
      for (let j = 0; j < models.length; j++) { if (models[j].capabilities.indexOf(capability) >= 0) { return models[j].id; } }
      return '';
    },

    generateText: function (auth: AiAuth, model: string, req: AiTextRequest): Promise<AiTextResult> {
      if (!MODEL_ID.test(model)) { return Promise.resolve(fail('model-not-found', 0, 0)); }
      const config: Record<string, unknown> = {};
      if (req.maxOutputTokens) { config.maxOutputTokens = req.maxOutputTokens; }
      if (typeof req.temperature === 'number') { config.temperature = req.temperature; }
      if (req.json) { config.responseMimeType = 'application/json'; }
      const body: Record<string, unknown> = { contents: [{ role: 'user', parts: [{ text: req.prompt }] }], generationConfig: config };
      if (req.system) { body.systemInstruction = { parts: [{ text: req.system }] }; }
      return http.request({
        method: 'POST', url: BASE + 'models/' + model + ':generateContent', headers: headers(auth), body: body,
        timeoutMs: limits.timeoutMs, maxChars: limits.maxResponseChars
      }).promise.then(function (r): AiTextResult {
        if (!r.ok) {
          const e = geminiError(r);
          return fail(e.code, e.status, e.retryAfterMs);
        }
        const o = (r.json || {}) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: unknown }>;
          promptFeedback?: { blockReason?: unknown };
          usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
        };
        if (o.promptFeedback && o.promptFeedback.blockReason) { return fail('blocked', r.status, 0); }
        const c = Array.isArray(o.candidates) ? o.candidates[0] : undefined;
        if (!c) { return fail('bad-response', r.status, 0); }
        const parts = c.content && Array.isArray(c.content.parts) ? c.content.parts : [];
        let text = '';
        for (let i = 0; i < parts.length; i++) {
          if (typeof parts[i].text === 'string') { text += parts[i].text as string; }
        }
        if (!text) {
          const fr = String(c.finishReason || '');
          return fail(fr === 'SAFETY' || fr === 'BLOCKLIST' || fr === 'PROHIBITED_CONTENT' ? 'blocked' : 'bad-response', r.status, 0);
        }
        const u = o.usageMetadata || {};
        return { ok: true, text: text, provider: 'gemini', model: model, usage: { inputTokens: num(u.promptTokenCount), outputTokens: num(u.candidatesTokenCount) }, cached: false, fallback: false };
      });
    }
  };
}
