// EliteStream AI service adapter (backend-mediated; the production path for distribution).
// The app never holds provider keys: it sends a per-user session token to the EliteStream AI
// gateway, which holds the provider keys server-side, applies per-user quotas, provider limits
// and global budgets, and forwards the task to the upstream provider (Gemini, OpenAI, Anthropic,
// Azure, ElevenLabs, self-hosted …). Design: docs/AI-02-MULTI-PROVIDER-REPORT.md §6.
//
// Client protocol (v1; implemented here, tested against tests/fakes/fake-gateway.mjs; no server
// is deployed, so the adapter reports 'not-configured' until a gateway address is built in):
//   GET  <base>/v1/catalog       → { models: [{ provider, dataGroup, id, name, capabilities, input,
//                                   output, contextTokens, outputTokens, streaming, available }] }
//   POST <base>/v1/tasks/text    { task, provider, model, system?, prompt, json?, maxOutputTokens?,
//                                  temperature? } → { text, provider, model, usage: { input, output } }
//   Errors: { error: { code, retryAfterMs? } } with codes user-quota | budget | rate-limited |
//           quota | unavailable | permission | invalid-request | blocked | model-not-found.
//   Auth:   Authorization: Bearer <session token> (short-lived; obtained by device sign-in).
// Gateway model references are "<upstream provider>/<model id>"; the upstream provider's data
// group is part of each model, so consent covers who finally processes the text.
import type { AiHttpClient, AiHttpResult } from '../api/ai-http-client.ts';
import { transportError, num } from './gemini-provider.ts';
import type { AiAuth, AiCapability, AiErrorCode, AiModelInfo, AiModelsResult, AiProviderAdapter, AiProviderDescriptor, AiTask, AiTextRequest, AiTextResult } from './types.ts';
import { AI_CAPABILITIES } from './types.ts';

export const GATEWAY_DESCRIPTOR: AiProviderDescriptor = {
  id: 'gateway', name: 'EliteStream AI service', dataGroup: 'elitestream', auth: 'user-session', status: 'implemented',
  capabilities: AI_CAPABILITIES.slice(), distributionSafe: true, noteKey: 'ai.prov.note.gateway'
};

/** "<provider>/<model>": provider like gemini/openai, model id as the provider names it. */
export const GATEWAY_MODEL_ID = /^[a-z][a-z0-9\-]{1,30}\/[A-Za-z0-9][A-Za-z0-9.\-_:]{0,100}$/;
const TOKEN_RE = /^[A-Za-z0-9._\-~+\/=]{20,4096}$/;
const GROUP_RE = /^[a-z][a-z0-9\-]{1,30}$/;
const SERVICE_CODES: AiErrorCode[] = ['user-quota', 'budget', 'rate-limited', 'quota', 'unavailable', 'permission', 'invalid-request', 'blocked', 'model-not-found', 'invalid-key', 'too-large'];

export interface GatewayLimits { timeoutMs: number; maxResponseChars: number }

function fail(code: AiErrorCode, status: number, retryAfterMs: number): AiTextResult {
  return { ok: false, code: code, status: status, retryAfterMs: retryAfterMs, provider: 'gateway' };
}

function caps(x: unknown): AiCapability[] {
  const out: AiCapability[] = [];
  if (!Array.isArray(x)) { return out; }
  for (let i = 0; i < x.length; i++) {
    if (AI_CAPABILITIES.indexOf(x[i] as AiCapability) >= 0 && out.indexOf(x[i] as AiCapability) < 0) { out.push(x[i] as AiCapability); }
  }
  return out;
}

function strs(x: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(x)) { for (let i = 0; i < x.length && i < 10; i++) { if (typeof x[i] === 'string' && /^[a-z0-9.\-]{1,20}$/.test(x[i])) { out.push(x[i]); } } }
  return out;
}

export function createGatewayAdapter(http: AiHttpClient, baseUrl: string, limits: GatewayLimits): AiProviderAdapter {
  const base = baseUrl.replace(/\/+$/, '');

  function headers(auth: AiAuth): Record<string, string> {
    return { Authorization: 'Bearer ' + auth.secret };
  }

  function serviceError(r: AiHttpResult): { code: AiErrorCode; status: number; retryAfterMs: number } {
    const t = transportError(r);
    if (t || r.ok) { return t || { code: 'bad-response', status: 0, retryAfterMs: 0 }; }
    const body = (r.json && typeof r.json === 'object' ? r.json : {}) as { error?: { code?: unknown; retryAfterMs?: unknown } };
    const e = body.error || {};
    const retry = Math.max(num(e.retryAfterMs), r.retryAfterMs);
    if (typeof e.code === 'string' && SERVICE_CODES.indexOf(e.code as AiErrorCode) >= 0) {
      return { code: e.code as AiErrorCode, status: r.status, retryAfterMs: Math.min(retry, 86400000) };
    }
    const s = r.status;
    const code: AiErrorCode = s === 401 ? 'invalid-key' : s === 403 ? 'permission' : s === 404 ? 'model-not-found' : s === 429 ? 'rate-limited' : s >= 500 ? 'unavailable' : 'invalid-request';
    return { code: code, status: s, retryAfterMs: retry };
  }

  return {
    descriptor: GATEWAY_DESCRIPTOR,

    validKey: function (token: string): boolean { return typeof token === 'string' && TOKEN_RE.test(token); },

    configured: function (): boolean { return !!base; },

    listModels: function (auth: AiAuth): Promise<AiModelsResult> {
      if (!base) { return Promise.resolve<AiModelsResult>({ ok: false, code: 'not-configured', status: 0, retryAfterMs: 0 }); }
      return http.request({ method: 'GET', url: base + '/v1/catalog', headers: headers(auth), timeoutMs: limits.timeoutMs, maxChars: limits.maxResponseChars })
        .promise.then(function (r): AiModelsResult {
          if (!r.ok) {
            const e = serviceError(r);
            return { ok: false, code: e.code, status: e.status, retryAfterMs: e.retryAfterMs };
          }
          const o = r.json as { models?: unknown };
          if (!o || !Array.isArray(o.models)) { return { ok: false, code: 'bad-response', status: r.status, retryAfterMs: 0 }; }
          const out: AiModelInfo[] = [];
          for (let i = 0; i < o.models.length && out.length < 300; i++) {
            const m = o.models[i] as Record<string, unknown>;
            if (!m || typeof m.provider !== 'string' || typeof m.id !== 'string') { continue; }
            const ref = m.provider + '/' + m.id;
            const group = typeof m.dataGroup === 'string' && GROUP_RE.test(m.dataGroup) ? m.dataGroup : '';
            const c = caps(m.capabilities);
            if (!GATEWAY_MODEL_ID.test(ref) || !group || !c.length) { continue; }
            out.push({
              provider: 'gateway', id: ref, displayName: typeof m.name === 'string' ? m.name.substring(0, 80) : ref,
              capabilities: c, inputFormats: strs(m.input), outputFormats: strs(m.output),
              inputTokenLimit: num(m.contextTokens), outputTokenLimit: num(m.outputTokens),
              streaming: m.streaming === true, dataGroup: group, available: m.available !== false
            });
          }
          return { ok: true, models: out };
        });
    },

    chooseModel: function (models: AiModelInfo[], capability: AiCapability, json: boolean): string {
      // The service lists models in its recommended order; take the first available fit.
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        if (m.available && m.capabilities.indexOf(capability) >= 0 && (!json || m.capabilities.indexOf('text.json') >= 0)) { return m.id; }
      }
      return '';
    },

    generateText: function (auth: AiAuth, model: string, req: AiTextRequest, task: AiTask): Promise<AiTextResult> {
      if (!base) { return Promise.resolve(fail('not-configured', 0, 0)); }
      if (!GATEWAY_MODEL_ID.test(model)) { return Promise.resolve(fail('model-not-found', 0, 0)); }
      const slash = model.indexOf('/');
      const body: Record<string, unknown> = { task: task, provider: model.substring(0, slash), model: model.substring(slash + 1), prompt: req.prompt };
      if (req.system) { body.system = req.system; }
      if (req.json) { body.json = true; }
      if (req.maxOutputTokens) { body.maxOutputTokens = req.maxOutputTokens; }
      if (typeof req.temperature === 'number') { body.temperature = req.temperature; }
      return http.request({ method: 'POST', url: base + '/v1/tasks/text', headers: headers(auth), body: body, timeoutMs: limits.timeoutMs, maxChars: limits.maxResponseChars })
        .promise.then(function (r): AiTextResult {
          if (!r.ok) {
            const e = serviceError(r);
            return fail(e.code, e.status, e.retryAfterMs);
          }
          const o = (r.json || {}) as { text?: unknown; usage?: { input?: unknown; output?: unknown } };
          if (typeof o.text !== 'string' || !o.text) { return fail('bad-response', r.status, 0); }
          const u = o.usage || {};
          return { ok: true, text: o.text, provider: 'gateway', model: model, usage: { inputTokens: num(u.input), outputTokens: num(u.output) }, cached: false, fallback: false };
        });
    }
  };
}
