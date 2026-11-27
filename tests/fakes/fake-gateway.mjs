// AI-02 multi-provider: fake EliteStream AI service (gateway) speaking the client protocol of
// src/ai/gateway-provider.ts. Use with createFakeGemini(handler) from fake-gemini.mjs, which
// provides the XHR plumbing; combinedHandler() routes Gemini and gateway URLs.
import { defaultGemini, header } from './fake-gemini.mjs';

export const GW_URL = 'https://ai.elitestream.test';
export const GW_TOKEN = 'gwSessionToken.0000000000000000000000';

export const GW_MODELS = [
  { provider: 'gemini', dataGroup: 'google', id: 'gemini-3.5-flash-lite', name: 'Gemini Flash-Lite (via service)', capabilities: ['text.generate', 'text.json'], input: ['text'], output: ['text', 'json'], contextTokens: 1048576, outputTokens: 65536, streaming: false, available: true },
  { provider: 'openai', dataGroup: 'openai', id: 'gpt-5-mini', name: 'GPT mini (via service)', capabilities: ['text.generate', 'text.json'], input: ['text'], output: ['text', 'json'], contextTokens: 400000, outputTokens: 128000, streaming: true, available: true },
  { provider: 'elevenlabs', dataGroup: 'elevenlabs', id: 'scribe-v2', name: 'Scribe (via service)', capabilities: ['audio.transcribe', 'audio.transcribe.stream'], input: ['audio'], output: ['text'], contextTokens: 0, outputTokens: 0, streaming: true, available: true },
  // Invalid entries the client must skip:
  { provider: 'bad provider', dataGroup: 'x', id: 'm', capabilities: ['text.generate'] },
  { provider: 'openai', dataGroup: 'openai', id: 'no-caps', capabilities: ['teleport'] },
  { provider: 'openai', dataGroup: 'BAD GROUP', id: 'm2', capabilities: ['text.generate'] }
];

/** Gateway behaviour; prompts containing trigger words produce service errors. */
export function defaultGateway(req) {
  if (header(req, 'Authorization') !== 'Bearer ' + GW_TOKEN) { return { status: 401, json: { error: { code: 'invalid-key' } } }; }
  if (req.method === 'GET' && req.url === GW_URL + '/v1/catalog') { return { status: 200, json: { models: GW_MODELS } }; }
  if (req.method === 'POST' && req.url === GW_URL + '/v1/tasks/text') {
    const p = String(req.body && req.body.prompt);
    if (/user-quota/.test(p)) { return { status: 429, json: { error: { code: 'user-quota', retryAfterMs: 3600000 } } }; }
    if (/global-budget/.test(p)) { return { status: 429, json: { error: { code: 'budget' } } }; }
    if (/gw-down/.test(p)) { return { status: 503, json: { error: { code: 'unavailable' } } }; }
    return { status: 200, json: { text: 'GW ' + req.body.provider + '/' + req.body.model + ': ' + p.length, provider: req.body.provider, model: req.body.model, usage: { input: 9, output: 2 } } };
  }
  return { status: 404, json: { error: { code: 'model-not-found' } } };
}

/** Routes gateway URLs to `gw` and everything else to `gem` (both (req, n) → response). */
export function combinedHandler(gem = defaultGemini, gw = defaultGateway) {
  return (req, n) => (req.url.indexOf(GW_URL) === 0 ? gw(req, n) : gem(req, n));
}
