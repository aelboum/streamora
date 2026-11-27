// AI-02 (multi-provider): AI Intelligence Engine foundation against fakes of the Gemini API and the
// EliteStream AI service (tests/fakes/fake-gemini.mjs, fake-gateway.mjs). Covers the AI HTTP client,
// both adapters, the provider/model registry, settings (consent per party, routes, credentials),
// usage (global limits, per-provider budgets and quota pauses), the cache, and the manager (gating,
// capability validation, task routing, fallback rules, privacy guard, logging hygiene).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiHttpClient, aiUrlAllowed } from '../../src/api/ai-http-client.ts';
import { createGeminiAdapter, parseRetryDelay } from '../../src/ai/gemini-provider.ts';
import { createGatewayAdapter } from '../../src/ai/gateway-provider.ts';
import { createProviderRegistry, PLANNED_PROVIDERS } from '../../src/ai/provider-registry.ts';
import { createUsageManager, localDay } from '../../src/ai/usage-manager.ts';
import { createAiCache, aiCacheKey, AI_CACHE_FILE } from '../../src/ai/ai-cache.ts';
import { createAiSettings, credentialAlias, defaultAiSettings } from '../../src/ai/ai-settings.ts';
import { createAiManager, privacyViolation, FALLBACK_ON } from '../../src/ai/ai-manager.ts';
import { createAiEngine } from '../../src/ai/ai-engine.ts';
import { AI_TASKS, modelServes, taskSpec } from '../../src/ai/tasks.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createLogger } from '../../src/utils/log.ts';
import { redactString } from '../../src/utils/redact.ts';
import { createFakeGemini, defaultGemini, geminiError, header, FAKE_KEY, ORIGIN } from '../fakes/fake-gemini.mjs';
import { combinedHandler, defaultGateway, GW_URL, GW_TOKEN } from '../fakes/fake-gateway.mjs';

const timers = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIM = { timeoutMs: 2000, maxResponseChars: 100000 };
const kvStore = () => createKeyValueStore(createMemoryLocalStore(), createLogger(100));

function client(handler, origins = [ORIGIN, GW_URL]) {
  const g = createFakeGemini(handler);
  return { g, http: createAiHttpClient({ xhrFactory: g.factory, allowedOrigins: origins, ...timers }) };
}

// ---------------------------------------------------------------- AI HTTP client

test('AI HTTP client: only https allow-listed origins; never a key in the URL; no userinfo', async () => {
  assert.equal(aiUrlAllowed(ORIGIN + '/v1beta/models', [ORIGIN]), true);
  assert.equal(aiUrlAllowed('http://generativelanguage.googleapis.com/x', ['http://generativelanguage.googleapis.com']), false, 'http refused');
  assert.equal(aiUrlAllowed('https://evil.example/v1beta/models', [ORIGIN]), false);
  assert.equal(aiUrlAllowed(ORIGIN + '/v1beta/models?key=abc', [ORIGIN]), false, 'key in the URL refused');
  assert.equal(aiUrlAllowed('https://user:pw@generativelanguage.googleapis.com/x', [ORIGIN]), false);
  const { g, http } = client();
  const r = await http.request({ method: 'GET', url: 'https://iptv.example/player_api.php', timeoutMs: 1000, maxChars: 1000 }).promise;
  assert.deepEqual([r.ok, r.kind], [false, 'invalid-url']);
  assert.equal(g.requests.length, 0, 'nothing sent to a non-AI origin');
});

test('AI HTTP client: network/CORS failure, timeout, too large, cross-origin redirect, bad JSON, Retry-After', async () => {
  const get = (h, ms = 2000) => client(h).http.request({ method: 'GET', url: ORIGIN + '/v1beta/models?pageSize=1', timeoutMs: ms, maxChars: 1000 }).promise;
  assert.equal((await get(() => ({ fail: 'network' }))).kind, 'network');
  assert.equal((await get(() => ({ fail: 'hang' }), 1000)).kind, 'timeout');
  assert.equal((await get(() => ({ status: 200, body: 'x'.repeat(5000) }))).kind, 'too-large');
  assert.equal((await get(() => ({ status: 200, json: {}, finalUrl: 'https://evil.example/x' }))).kind, 'redirect-blocked');
  assert.equal((await get(() => ({ status: 200, body: '{nope' }))).kind, 'parse');
  const r429 = await get(() => ({ status: 429, json: { error: {} }, headers: { 'Retry-After': '7' } }));
  assert.deepEqual([r429.kind, r429.retryAfterMs], ['http', 7000]);
  const none = createAiHttpClient({ xhrFactory: null, allowedOrigins: [ORIGIN], ...timers });
  assert.equal((await none.request({ method: 'GET', url: ORIGIN + '/v1beta/models', timeoutMs: 1000, maxChars: 10 }).promise).kind, 'unavailable');
});

// ---------------------------------------------------------------- adapters

test('Gemini adapter: models with declared capabilities; generation; key only in the header', async () => {
  const { g, http } = client();
  const a = createGeminiAdapter(http, LIM);
  assert.equal(a.descriptor.distributionSafe, false, 'own-key provider is not distribution-safe');
  const m = await a.listModels({ kind: 'api-key', secret: FAKE_KEY });
  assert.equal(m.ok, true);
  assert.deepEqual(m.models.map((x) => x.id), ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], 'embedding-only model left out');
  assert.deepEqual(m.models[0].capabilities, ['text.generate', 'text.json']);
  assert.equal(m.models[0].dataGroup, 'google');
  const r = await a.generateText({ kind: 'api-key', secret: FAKE_KEY }, 'gemini-3.5-flash-lite', { system: 'S', prompt: 'Hello', json: true }, 'epg.enrich');
  assert.deepEqual([r.ok, r.text, r.provider], [true, 'OK: 5', 'gemini']);
  assert.equal(g.requests[1].body.generationConfig.responseMimeType, 'application/json');
  assert.ok(g.requests.every((q) => !q.url.includes(FAKE_KEY) && header(q, 'x-goog-api-key') === FAKE_KEY));
  assert.equal(a.chooseModel(m.models, 'text.generate', false), 'gemini-3.5-flash-lite');
  assert.equal(a.chooseModel(m.models, 'audio.transcribe', false), '', 'no audio model is assumed');
});

test('Gemini adapter: error mapping (invalid key, permission, not found, quota+retryDelay, 5xx, safety)', async () => {
  const cases = [
    [geminiError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 'invalid-key'],
    [geminiError(403, 'PERMISSION_DENIED'), 'permission'],
    [geminiError(400, 'FAILED_PRECONDITION'), 'permission'],
    [geminiError(404, 'NOT_FOUND'), 'model-not-found'],
    [geminiError(429, 'RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED', '12s'), 'quota'],
    [geminiError(503, 'UNAVAILABLE'), 'unavailable'],
    [{ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } }, 'blocked'],
    [{ status: 200, json: { nothing: true } }, 'bad-response']
  ];
  for (const [resp, code] of cases) {
    const a = createGeminiAdapter(client(() => resp).http, LIM);
    const r = await a.generateText({ kind: 'api-key', secret: FAKE_KEY }, 'gemini-3.5-flash-lite', { prompt: 'x' }, 'epg.summary');
    assert.equal(r.code, code, JSON.stringify(resp).slice(0, 60));
    if (code === 'quota') { assert.equal(r.retryAfterMs, 12000); }
  }
  assert.equal(parseRetryDelay('1.5s'), 1500);
  assert.equal(parseRetryDelay('soon'), 0);
});

test('Gateway adapter: not configured without an address; catalogue parsing; Bearer token; service error codes', async () => {
  const unconfigured = createGatewayAdapter(client().http, '', LIM);
  assert.equal(unconfigured.configured(), false);
  assert.equal((await unconfigured.listModels({ kind: 'user-session', secret: GW_TOKEN })).code, 'not-configured');
  const { g, http } = client(combinedHandler());
  const a = createGatewayAdapter(http, GW_URL, LIM);
  assert.equal(a.descriptor.distributionSafe, true);
  assert.equal(a.descriptor.auth, 'user-session');
  const m = await a.listModels({ kind: 'user-session', secret: GW_TOKEN });
  assert.equal(m.ok, true);
  assert.deepEqual(m.models.map((x) => x.id), ['gemini/gemini-3.5-flash-lite', 'openai/gpt-5-mini', 'elevenlabs/scribe-v2'], 'invalid catalogue entries skipped');
  assert.deepEqual(m.models.map((x) => x.dataGroup), ['google', 'openai', 'elevenlabs'], 'upstream data group kept per model');
  assert.equal(header(g.requests[0], 'Authorization'), 'Bearer ' + GW_TOKEN);
  const ok = await a.generateText({ kind: 'user-session', secret: GW_TOKEN }, 'openai/gpt-5-mini', { prompt: 'Hello' }, 'epg.summary');
  assert.deepEqual([ok.ok, ok.text, ok.model], [true, 'GW openai/gpt-5-mini: 5', 'openai/gpt-5-mini']);
  assert.equal(g.requests[1].body.task, 'epg.summary');
  for (const [prompt, code] of [['user-quota', 'user-quota'], ['global-budget', 'budget'], ['gw-down', 'unavailable']]) {
    assert.equal((await a.generateText({ kind: 'user-session', secret: GW_TOKEN }, 'openai/gpt-5-mini', { prompt }, 'epg.summary')).code, code);
  }
  assert.equal((await a.generateText({ kind: 'user-session', secret: 'wrongToken.000000000000000000000' }, 'openai/gpt-5-mini', { prompt: 'x' }, 'epg.summary')).code, 'invalid-key');
  assert.equal((await a.generateText({ kind: 'user-session', secret: GW_TOKEN }, 'not a ref', { prompt: 'x' }, 'epg.summary')).code, 'model-not-found');
});

// ---------------------------------------------------------------- registry and tasks

test('Registry: implemented vs planned providers; duplicates refused; models validated per provider and capability', () => {
  const { http } = client();
  const gem = createGeminiAdapter(http, LIM);
  const reg = createProviderRegistry([gem, createGatewayAdapter(http, '', LIM)]);
  const ids = reg.descriptors().map((d) => d.id);
  assert.deepEqual(ids.slice(0, 2), ['gemini', 'gateway']);
  for (const p of ['openai', 'anthropic', 'azure', 'elevenlabs', 'openai-compatible', 'self-hosted']) {
    assert.ok(ids.includes(p), 'registered: ' + p);
    assert.equal(reg.descriptor(p).status, 'planned');
    assert.equal(reg.adapter(p), null, 'planned providers are never callable');
  }
  assert.throws(() => createProviderRegistry([gem, gem]), /duplicate/);
  assert.throws(() => createProviderRegistry([{ descriptor: PLANNED_PROVIDERS[0] }]), /not implemented/);
  assert.equal(reg.models('gemini'), null);
  reg.setModels('gemini', [
    { provider: 'gemini', id: 'a', displayName: 'a', capabilities: ['text.generate', 'text.json'], inputFormats: ['text'], outputFormats: ['text'], inputTokenLimit: 0, outputTokenLimit: 0, streaming: false, dataGroup: 'google', available: true },
    { provider: 'gemini', id: 'b', displayName: 'b', capabilities: ['text.generate'], inputFormats: ['text'], outputFormats: ['text'], inputTokenLimit: 0, outputTokenLimit: 0, streaming: false, dataGroup: 'google', available: true },
    { provider: 'other', id: 'c', displayName: 'c', capabilities: ['text.generate'], inputFormats: [], outputFormats: [], inputTokenLimit: 0, outputTokenLimit: 0, streaming: false, dataGroup: 'x', available: true }
  ], 1);
  assert.deepEqual(reg.models('gemini').map((m) => m.id), ['a', 'b'], 'foreign entries ignored');
  assert.deepEqual(reg.modelsFor('gemini', 'text.generate', true).map((m) => m.id), ['a'], 'json tasks need text.json');
  assert.equal(reg.model('gemini', 'zzz'), null);
  assert.equal(AI_TASKS.length, 9);
  assert.ok(AI_TASKS.every((t) => t.implemented === false), 'no AI feature implemented in AI-02');
  assert.equal(modelServes(['text.generate'], taskSpec('epg.enrich')), false);
  assert.equal(modelServes(['text.generate', 'text.json'], taskSpec('epg.enrich')), true);
});

// ---------------------------------------------------------------- settings, usage, cache

test('Settings: off by default; consent per party; routes refuse planned providers; credentials per provider alias', async () => {
  const kv = kvStore();
  const keys = createMemoryKeyStore();
  await keys.save('ss_pl_abc', '{"username":"u","password":"p"}');
  const s = createAiSettings(kv, keys);
  const d = defaultAiSettings();
  assert.deepEqual(s.get(), d);
  assert.deepEqual([d.enabled, d.fallbackEnabled, d.allowAudio, Object.keys(d.consent).length, Object.keys(d.routes).length], [false, false, false, 0, 0]);
  s.setConsent('google', true);
  assert.equal(s.hasConsent('google'), true);
  assert.equal(s.hasConsent('openai'), false, 'consent is per party');
  const impl = (p) => p === 'gemini' || p === 'gateway';
  assert.equal(s.setRoute('epg.summary', 'primary', { provider: 'openai', model: '' }, impl), false, 'planned provider refused');
  assert.equal(s.setRoute('not.a.task', 'primary', { provider: 'gemini', model: '' }, impl), false);
  assert.equal(s.setRoute('epg.summary', 'primary', { provider: 'gemini', model: 'gemini-3.5-flash-lite' }, impl), true);
  assert.deepEqual(createAiSettings(kv, keys).route('epg.summary').primary, { provider: 'gemini', model: 'gemini-3.5-flash-lite' }, 'persisted');
  assert.equal(credentialAlias('gemini', 'api-key'), 'ai_key_gemini');
  assert.equal(credentialAlias('openai-compatible', 'api-key'), 'ai_key_openai_compatible');
  assert.equal(credentialAlias('gateway', 'user-session'), 'ai_session_gateway');
  await assert.rejects(s.setCredential('gemini', 'api-key', 'bad key!', () => false), /invalid-key-format/);
  await s.setCredential('gemini', 'api-key', '  ' + FAKE_KEY + ' ', (k) => k === FAKE_KEY);
  assert.equal(await keys.load('ai_key_gemini'), FAKE_KEY);
  assert.equal(await keys.load('ss_pl_abc'), '{"username":"u","password":"p"}', 'playlist secrets untouched');
  const dump = kv.names().map((n) => JSON.stringify(kv.get(n, () => true, null))).join('');
  assert.equal(dump.includes(FAKE_KEY), false, 'no credential in KV');
  await s.removeCredential('gemini', 'api-key');
  assert.equal(await s.hasCredential('gemini', 'api-key'), false);
  await assert.rejects(createAiSettings(kv, null).setCredential('gemini', 'api-key', FAKE_KEY, () => true), /no-key-store/);
});

test('Usage: global limits, busy, per-provider budgets and quota pauses (other providers keep working)', () => {
  let now = Date.UTC(2026, 10, 26, 10);
  const kv = kvStore();
  const u = createUsageManager(kv, () => now, { requestsPerMinute: 3, requestsPerDay: 50, maxConcurrent: 1, quotaCooldownMs: 60000 });
  const big = { dailyRequests: 100, dailyTokens: 1000000 };
  const a = u.acquire('gemini', big);
  assert.equal(a.ok, true);
  assert.equal(u.acquire('gateway', big).code, 'busy', 'backpressure: nothing queues');
  a.release({ error: 'quota', retryAfterMs: 30000 });
  assert.equal(u.acquire('gemini', big).code, 'quota', 'gemini paused');
  const b = u.acquire('gateway', big);
  assert.equal(b.ok, true, 'another provider is not paused');
  b.release({ usage: { inputTokens: 40, outputTokens: 10 } });
  const small = { dailyRequests: 1, dailyTokens: 1000000 };
  assert.equal(u.acquire('gateway', small).code, 'budget', 'provider request budget');
  assert.equal(u.acquire('gateway', { dailyRequests: 100, dailyTokens: 50 }).code, 'budget', 'provider token budget');
  const c = u.acquire('gateway', big); c.release({});
  assert.equal(u.acquire('gateway', big).code, 'rate-limited', 'global per-minute limit');
  const s = u.stats();
  assert.equal(s.providers.gemini.quotaErrors, 1);
  assert.equal(s.providers.gateway.inputTokens + s.providers.gateway.outputTokens, 50);
  assert.ok(s.providers.gemini.pausedForMs > 0);
  now += 24 * 3600000;
  assert.equal(createUsageManager(kv, () => now, { requestsPerMinute: 3, requestsPerDay: 50, maxConcurrent: 1, quotaCooldownMs: 1 }).stats().requests, 0, 'new day');
  assert.equal(localDay(Date.UTC(2026, 0, 5, 12)).length, 10);
});

test('Cache: TTL, LRU, persistence in ai-cache.json only, corrupt file ignored, clear', async () => {
  let now = 1000000;
  const files = createMemoryFileStore();
  await files.write('cat.pabc.live.json', '{"keep":true}');
  const lim = { maxEntries: 2, maxChars: 100000, defaultTtlMs: 60000, saveDelayMs: 10 };
  const c = createAiCache(files, () => now, lim, timers);
  await c.set('a', 'A'); await c.set('b', 'B'); await c.get('a'); await c.set('c', 'C');
  assert.equal(await c.get('b'), null, 'LRU eviction');
  await c.flush();
  assert.equal(await createAiCache(files, () => now, lim, timers).get('c'), 'C');
  now += 120000;
  assert.equal(await createAiCache(files, () => now, lim, timers).get('c'), null, 'expired');
  await c.clear();
  const names = await files.list();
  assert.deepEqual([names.includes(AI_CACHE_FILE), names.includes('cat.pabc.live.json')], [false, true]);
  await files.write(AI_CACHE_FILE, '{broken');
  assert.equal(await createAiCache(files, () => now, lim, timers).get('x'), null);
  assert.equal(aiCacheKey(['x']).length, 16);
  assert.notEqual(aiCacheKey(['x', 'y']), aiCacheKey(['xy', '']));
});

// ---------------------------------------------------------------- manager: routing, fallback, privacy

function engine(handler = combinedHandler(), gatewayUrl = GW_URL) {
  const g = createFakeGemini(handler);
  const log = createLogger(800);
  const keys = createMemoryKeyStore();
  const e = createAiEngine({
    kv: kvStore(), keyStore: keys, files: createMemoryFileStore(), xhrFactory: g.factory, log, now: Date.now, ...timers, gatewayUrl, random: () => 0,
    limits: { requestsPerMinute: 100, retryBaseMs: 5, retryMaxMs: 50 }
  });
  return { g, log, keys, e, s: e.settings, m: e.manager };
}
const IMPL = (p) => p === 'gemini' || p === 'gateway';
async function ready(x, { gemini = true, gateway = false } = {}) {
  x.s.setEnabled(true);
  if (gemini) { x.s.setConsent('google', true); await x.s.setCredential('gemini', 'api-key', FAKE_KEY, () => true); }
  if (gateway) { x.s.setConsent('elitestream', true); await x.s.setCredential('gateway', 'user-session', GW_TOKEN, () => true); }
}

test('Manager: gating order — disabled, invalid task, audio task not implemented, no route, no consent, no credentials', async () => {
  const x = engine();
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'x' })).code, 'disabled');
  x.s.setEnabled(true);
  assert.equal((await x.m.runTask('nope', { prompt: 'x' })).code, 'invalid-request');
  assert.equal((await x.m.runTask('speech.live', { prompt: 'x' })).code, 'not-implemented', 'audio tasks are not executable in AI-02');
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'x' })).code, 'no-route');
  x.s.setRoute('epg.summary', 'primary', { provider: 'gemini', model: '' }, IMPL);
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'x' })).code, 'no-consent');
  x.s.setConsent('google', true);
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'x' })).code, 'no-credentials');
  assert.equal(x.g.requests.length, 0, 'nothing sent before every gate passes');
  await x.s.setCredential('gemini', 'api-key', FAKE_KEY, () => true);
  const r = await x.m.runTask('epg.summary', { prompt: 'A quiz show.' });
  assert.deepEqual([r.ok, r.provider, r.model, r.fallback], [true, 'gemini', 'gemini-3.5-flash-lite', false]);
});

test('Manager: capability and model validation before any generation request', async () => {
  const x = engine();
  await ready(x, { gateway: true });
  x.s.setConsent('elevenlabs', true);
  x.s.setRoute('epg.enrich', 'primary', { provider: 'gateway', model: 'elevenlabs/scribe-v2' }, IMPL);
  assert.equal((await x.m.runTask('epg.enrich', { prompt: 'x', json: true })).code, 'capability-unsupported', 'a transcription model cannot do EPG enrichment');
  x.s.setRoute('epg.enrich', 'primary', { provider: 'gemini', model: 'gemini-9-imaginary' }, IMPL);
  const before = x.g.requests.filter((q) => q.method === 'POST').length;
  assert.equal((await x.m.runTask('epg.enrich', { prompt: 'x' })).code, 'model-not-found');
  assert.equal(x.g.requests.filter((q) => q.method === 'POST').length, before, 'unknown model: no generation request');
  const opts = x.m.routeOptions('epg.enrich');
  assert.ok(opts.every((o) => IMPL(o.provider)), 'planned providers never offered');
  assert.ok(opts.some((o) => o.provider === 'gemini' && o.model === ''), 'automatic is offered');
  const sub = x.m.routeOptions('subtitle.generate');
  assert.ok(sub.every((o) => o.provider === 'gateway'), 'only providers declaring audio.transcribe are offered');
});

test('Manager: gateway upstream consent — service consent alone does not cover OpenAI', async () => {
  const x = engine();
  await ready(x, { gemini: false, gateway: true });
  x.s.setRoute('epg.summary', 'primary', { provider: 'gateway', model: 'openai/gpt-5-mini' }, IMPL);
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'x' })).code, 'no-consent');
  x.s.setConsent('openai', true);
  const r = await x.m.runTask('epg.summary', { prompt: 'Hi' });
  assert.deepEqual([r.ok, r.provider, r.model], [true, 'gateway', 'openai/gpt-5-mini']);
});

test('Manager: fallback only after availability failures, only when enabled, and only with its own consent', async () => {
  let geminiDown = true;
  const x = engine(combinedHandler((req) => (geminiDown && /generateContent/.test(req.url) ? geminiError(503, 'UNAVAILABLE') : defaultGemini(req)), defaultGateway));
  await ready(x, { gateway: true });
  x.s.setConsent('google', true);
  x.s.setRoute('epg.summary', 'primary', { provider: 'gemini', model: '' }, IMPL);
  x.s.setRoute('epg.summary', 'fallback', { provider: 'gateway', model: 'gemini/gemini-3.5-flash-lite' }, IMPL);
  // Fallback switched off: the failure is returned.
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'news' })).code, 'unavailable');
  x.s.setFallbackEnabled(true);
  const f = await x.m.runTask('epg.summary', { prompt: 'news' });
  assert.deepEqual([f.ok, f.provider, f.fallback], [true, 'gateway', true], 'fallback used and marked');
  assert.equal(x.e.usage.stats().fallbacks, 1);
  // Fallback needs its own consent: without consent for the service it is not used.
  x.s.setConsent('elitestream', false);
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'news' })).code, 'no-consent');
  // Configuration failures never fall back.
  x.s.setConsent('elitestream', true);
  geminiDown = false;
  await x.s.setCredential('gemini', 'api-key', 'AIzaWRONGkey000000000000000000000000000', () => true);
  x.e.registry.clearModels();
  const bad = await x.m.runTask('epg.summary', { prompt: 'news' });
  assert.deepEqual([bad.code, bad.provider], ['invalid-key', 'gemini'], 'invalid key does not trigger the fallback');
  assert.ok(FALLBACK_ON.indexOf('invalid-key') < 0 && FALLBACK_ON.indexOf('privacy-blocked') < 0 && FALLBACK_ON.indexOf('no-consent') < 0);
});

test('Manager: budget and quota per provider; fallback to another provider when the first is over budget', async () => {
  const x = engine(combinedHandler((req) => (/generateContent/.test(req.url) && /quota/.test(JSON.stringify(req.body)) ? geminiError(429, 'RESOURCE_EXHAUSTED', '', '120s') : defaultGemini(req)), defaultGateway));
  await ready(x, { gateway: true });
  x.s.setRoute('epg.summary', 'primary', { provider: 'gemini', model: '' }, IMPL);
  x.s.setRoute('epg.summary', 'fallback', { provider: 'gateway', model: 'gemini/gemini-3.5-flash-lite' }, IMPL);
  x.s.setFallbackEnabled(true);
  const q = await x.m.runTask('epg.summary', { prompt: 'quota please' });
  assert.deepEqual([q.ok, q.provider, q.fallback], [true, 'gateway', true], 'quota on Gemini → fallback');
  assert.ok(x.e.usage.stats().providers.gemini.pausedForMs > 100000, 'Gemini paused, not the service');
  x.s.setBudget({ dailyRequestsPerProvider: 0 });
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'anything' })).code, 'budget', 'both providers over the local budget');
  // Service-side per-user quota is reported as such.
  x.s.setBudget({ dailyRequestsPerProvider: 150 });
  x.s.setRoute('epg.summary', 'primary', { provider: 'gateway', model: 'gemini/gemini-3.5-flash-lite' }, IMPL);
  x.s.setRoute('epg.summary', 'fallback', null, IMPL);
  assert.equal((await x.m.runTask('epg.summary', { prompt: 'user-quota' })).code, 'user-quota');
});

test('Manager: privacy guard (nothing sent), cache, connection tests, clean logs', async () => {
  const x = engine();
  await ready(x, { gateway: true });
  x.s.setRoute('epg.summary', 'primary', { provider: 'gemini', model: '' }, IMPL);
  const bad = ['Watch http://line.example.ru/live/u/p/1.ts', 'rtmp://cdn/app', 'mail someone@example.com', 'password=hunter2', 'username: demo', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'token ' + 'A'.repeat(48)];
  for (const p of bad) {
    assert.equal(privacyViolation(p), true, p);
    assert.equal((await x.m.runTask('epg.summary', { prompt: p })).code, 'privacy-blocked', p);
  }
  assert.equal(x.g.requests.length, 0, 'none sent');
  for (const ok of ['Basic training for beginners', 'Ajax – PSV, 21:00', 'Le journal de 20h', 'نشرة الأخبار']) { assert.equal(privacyViolation(ok), false, ok); }
  const a = await x.m.runTask('epg.summary', { prompt: 'same' }, { cache: 'epg' });
  const b = await x.m.runTask('epg.summary', { prompt: 'same' }, { cache: 'epg' });
  assert.deepEqual([a.cached, b.cached], [false, true]);
  const t1 = await x.m.testConnection('gemini');
  assert.deepEqual([t1.ok, t1.stage, t1.model], [true, 'done', 'gemini-3.5-flash-lite']);
  assert.ok(x.s.get().verified.gemini > 0, 'verified on this device');
  const t2 = await x.m.testConnection('gateway');
  assert.equal(t2.ok, true);
  assert.equal((await x.m.testConnection('openai')).code, 'not-implemented', 'planned provider cannot be tested');
  const logged = JSON.stringify(x.log.entries());
  for (const secret of [FAKE_KEY, GW_TOKEN, 'same', 'OK: ', 'GW ']) { assert.equal(logged.includes(secret), false, 'not logged: ' + secret); }
  assert.equal(redactString('key ' + FAKE_KEY).includes(FAKE_KEY), false);
});

test('Engine: idle at creation; gateway not configured by default (no service deployed)', async () => {
  const g = createFakeGemini();
  const e = createAiEngine({ kv: kvStore(), keyStore: createMemoryKeyStore(), files: createMemoryFileStore(), xhrFactory: g.factory, log: createLogger(50), now: Date.now, ...timers });
  await sleep(20);
  assert.equal(g.requests.length, 0);
  const st = await e.manager.status();
  assert.equal(st.enabled, false);
  assert.ok(st.providers.every((p) => p.consent === false && p.hasCredential === false));
  assert.equal(e.registry.adapter('gateway').configured(), false);
  e.settings.setEnabled(true);
  e.settings.setConsent('elitestream', true);
  assert.equal((await e.manager.testConnection('gateway')).code, 'no-credentials');
});
