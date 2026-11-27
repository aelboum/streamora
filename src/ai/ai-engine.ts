// EliteStream AI Intelligence Engine (AI-02 multi-provider): assembles the AI infrastructure.
//   AI HTTP client (allow-list: Gemini + the EliteStream AI service when configured) ·
//   provider adapters (Gemini direct, EliteStream AI service) · provider/model registry (planned
//   providers listed, not callable) · AISettingsManager · AIUsageManager · AICacheManager ·
//   AIProviderManager with task routing and fallback · phone pairing relay client (when configured).
// Created at start-up but idle: nothing is sent until the user enables AI, consents for a provider,
// stores credentials and a feature (later stages) or a connection test asks. Playback never
// depends on it.
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { FileStore, KeyStore, XhrLike } from '../app/platform/platform.ts';
import type { Logger } from '../utils/log.ts';
import { createAiHttpClient } from '../api/ai-http-client.ts';
import type { AiHttpClient } from '../api/ai-http-client.ts';
import { originOf } from '../api/url.ts';
import { AI_GATEWAY_URL, AI_LIMITS, AI_PAIRING_URL } from './ai-config.ts';
import type { AiLimits } from './ai-config.ts';
import { createAiCache } from './ai-cache.ts';
import type { AiCache } from './ai-cache.ts';
import { createAiManager } from './ai-manager.ts';
import type { AiManager } from './ai-manager.ts';
import { createAiSettings } from './ai-settings.ts';
import type { AiSettingsStore } from './ai-settings.ts';
import { createGeminiAdapter, GEMINI_ORIGIN } from './gemini-provider.ts';
import { createGatewayAdapter } from './gateway-provider.ts';
import { createProviderRegistry } from './provider-registry.ts';
import type { ProviderRegistry } from './provider-registry.ts';
import { createUsageManager } from './usage-manager.ts';
import type { UsageManager } from './usage-manager.ts';

export interface AiEngine {
  settings: AiSettingsStore;
  registry: ProviderRegistry;
  usage: UsageManager;
  cache: AiCache;
  manager: AiManager;
  /** Phone pairing relay (null: not configured). Its own client: the allow-list holds only the relay. */
  pairing: { baseUrl: string; http: AiHttpClient } | null;
}

export interface AiEngineDeps {
  kv: KeyValueStore;
  /** Platform key store (null: no credential can be stored; AI then reports 'no-key-store'). */
  keyStore: KeyStore | null;
  files: FileStore | null;
  xhrFactory: (() => XhrLike) | null;
  log: Logger;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  random?: () => number;
  /** EliteStream AI service address (default AI_GATEWAY_URL; tests use a fake). Must be https. */
  gatewayUrl?: string;
  /** Phone pairing relay address (default AI_PAIRING_URL; tests use a fake). Must be https. */
  pairingUrl?: string;
  /** Tests: the Gemini origin of a fake server. */
  geminiOrigin?: string;
  /** Tests: overrides of AI_LIMITS (e.g. short retry delays). */
  limits?: Partial<AiLimits>;
}

export function createAiEngine(d: AiEngineDeps): AiEngine {
  const L = {} as AiLimits;
  const over = (d.limits || {}) as Record<string, unknown>;
  for (const k in AI_LIMITS) {
    if (Object.prototype.hasOwnProperty.call(AI_LIMITS, k)) {
      (L as unknown as Record<string, unknown>)[k] = typeof over[k] === 'number' ? over[k] : (AI_LIMITS as unknown as Record<string, unknown>)[k];
    }
  }
  const gemOrigin = d.geminiOrigin || GEMINI_ORIGIN;
  const gw = d.gatewayUrl !== undefined ? d.gatewayUrl : AI_GATEWAY_URL;
  const gwOk = !!gw && /^https:\/\//i.test(gw) && !!originOf(gw);
  const origins = [gemOrigin];
  if (gwOk) { origins.push(originOf(gw) as string); }
  const http = createAiHttpClient({ xhrFactory: d.xhrFactory, allowedOrigins: origins, setTimer: d.setTimer, clearTimer: d.clearTimer });
  const pu = d.pairingUrl !== undefined ? d.pairingUrl : AI_PAIRING_URL;
  const pairOrigin = pu && /^https:\/\//i.test(pu) ? originOf(pu) : null;
  const pairing = pairOrigin ? {
    baseUrl: pairOrigin,
    http: createAiHttpClient({ xhrFactory: d.xhrFactory, allowedOrigins: [pairOrigin], setTimer: d.setTimer, clearTimer: d.clearTimer })
  } : null;
  const limits = { timeoutMs: L.requestTimeoutMs, maxResponseChars: L.maxResponseChars };
  const registry = createProviderRegistry([
    createGeminiAdapter(http, limits),
    createGatewayAdapter(http, gwOk ? gw : '', limits)
  ]);
  const settings = createAiSettings(d.kv, d.keyStore);
  const usage = createUsageManager(d.kv, d.now, {
    requestsPerMinute: L.requestsPerMinute, requestsPerDay: L.requestsPerDay, maxConcurrent: L.maxConcurrent, quotaCooldownMs: L.quotaCooldownMs
  });
  const cache = createAiCache(d.files, d.now, {
    maxEntries: L.cacheMaxEntries, maxChars: L.cacheMaxChars, defaultTtlMs: L.cacheDefaultTtlMs, saveDelayMs: L.cacheSaveDelayMs
  }, { setTimer: d.setTimer, clearTimer: d.clearTimer });
  const manager = createAiManager({
    settings: settings, registry: registry, usage: usage, cache: cache, log: d.log, now: d.now, setTimer: d.setTimer,
    limits: { retryAttempts: L.retryAttempts, retryBaseMs: L.retryBaseMs, retryMaxMs: L.retryMaxMs, maxPromptChars: L.maxPromptChars, modelListMaxAgeMs: L.modelListMaxAgeMs },
    random: d.random
  });
  return { settings: settings, registry: registry, usage: usage, cache: cache, manager: manager, pairing: pairing };
}
