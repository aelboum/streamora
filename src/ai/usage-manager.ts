// AIUsageManager (AI-02 multi-provider): local throttling, backpressure, budgets and statistics.
//   Global (all providers together):
//     - requests per minute and per local day; over the limit → 'rate-limited' with the wait;
//     - at most maxConcurrent requests in flight; more → 'busy' (the caller skips; nothing queues).
//   Per provider:
//     - budget: requests and tokens per local day (Settings → AI → Usage and costs); over → 'budget';
//     - quota pause: after a provider quota answer only that provider pauses (its retry delay or the
//       cooldown), so a fallback to another provider stays possible → 'quota'.
//   Counters (figures only, never content) are kept per day in KV `ai.usage`; the minute window and
//   pauses live in memory. A per-user and global budget for distribution is enforced server-side
//   by the EliteStream AI service (design: docs/AI-02-MULTI-PROVIDER-REPORT.md §6).
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { AiErrorCode, AiUsage } from './types.ts';

export interface UsageLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  maxConcurrent: number;
  quotaCooldownMs: number;
}

export interface ProviderBudget { dailyRequests: number; dailyTokens: number }

export interface ProviderUsage { requests: number; inputTokens: number; outputTokens: number; errors: number; quotaErrors: number; pausedForMs: number }

export interface UsageStats {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  quotaErrors: number;
  cacheHits: number;
  cacheMisses: number;
  fallbacks: number;
  totalRequests: number;
  providers: Record<string, ProviderUsage>;
}

export type UsageSlot =
  | { ok: true; release(outcome: { usage?: AiUsage; error?: AiErrorCode; retryAfterMs?: number }): void }
  | { ok: false; code: AiErrorCode; retryAfterMs: number };

export interface UsageManager {
  /** Takes a request slot for a provider or says why not. Every successful acquire is released once. */
  acquire(provider: string, budget: ProviderBudget): UsageSlot;
  recordCache(hit: boolean): void;
  recordFallback(): void;
  stats(): UsageStats;
  clear(): void;
}

const KV_USAGE = 'ai.usage';
const SCHEMA = 2;

interface Counters { requests: number; inputTokens: number; outputTokens: number; errors: number; quotaErrors: number }
interface StoredUsage {
  day: string; totals: Counters; cacheHits: number; cacheMisses: number; fallbacks: number; totalRequests: number;
  providers: Record<string, Counters>;
}

function zero(): Counters { return { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0, quotaErrors: 0 }; }

function isCounters(x: unknown): x is Counters {
  const c = x as Counters;
  return !!c && typeof c.requests === 'number' && typeof c.inputTokens === 'number' && typeof c.outputTokens === 'number' && typeof c.errors === 'number' && typeof c.quotaErrors === 'number';
}

function isStored(x: unknown): x is StoredUsage {
  const o = x as StoredUsage;
  if (!o || typeof o !== 'object' || typeof o.day !== 'string' || !isCounters(o.totals) || typeof o.cacheHits !== 'number' ||
    typeof o.cacheMisses !== 'number' || typeof o.fallbacks !== 'number' || typeof o.totalRequests !== 'number' || !o.providers || typeof o.providers !== 'object') { return false; }
  for (const k in o.providers) { if (Object.prototype.hasOwnProperty.call(o.providers, k) && !isCounters(o.providers[k])) { return false; } }
  return true;
}

function pad(n: number): string { return n < 10 ? '0' + n : String(n); }

/** Local calendar day "YYYY-MM-DD" (the device's time zone). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function fresh(day: string, total: number): StoredUsage {
  return { day: day, totals: zero(), cacheHits: 0, cacheMisses: 0, fallbacks: 0, totalRequests: total, providers: {} };
}

export function createUsageManager(kv: KeyValueStore, now: () => number, limits: UsageLimits): UsageManager {
  let u: StoredUsage = kv.get<StoredUsage | null>(KV_USAGE, function (x): x is StoredUsage | null { return x === null || isStored(x); }, null, SCHEMA) || fresh(localDay(now()), 0);
  const minute: number[] = [];
  let inFlight = 0;
  const pausedUntil: Record<string, number> = {};

  function roll(): void {
    const today = localDay(now());
    if (u.day !== today) { u = fresh(today, u.totalRequests); }
  }
  function save(): void { kv.set(KV_USAGE, u, SCHEMA); }
  function prov(p: string): Counters {
    if (!Object.prototype.hasOwnProperty.call(u.providers, p)) { u.providers[p] = zero(); }
    return u.providers[p];
  }
  function untilMidnight(t: number): number {
    const d = new Date(t);
    return Math.max(1000, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - t);
  }

  return {
    acquire: function (provider: string, budget: ProviderBudget): UsageSlot {
      const t = now();
      roll();
      const paused = pausedUntil[provider] || 0;
      if (paused > t) { return { ok: false, code: 'quota', retryAfterMs: paused - t }; }
      if (inFlight >= limits.maxConcurrent) { return { ok: false, code: 'busy', retryAfterMs: 0 }; }
      if (u.totals.requests >= limits.requestsPerDay) { return { ok: false, code: 'rate-limited', retryAfterMs: untilMidnight(t) }; }
      const pc = prov(provider);
      if (pc.requests >= budget.dailyRequests || pc.inputTokens + pc.outputTokens >= budget.dailyTokens) {
        return { ok: false, code: 'budget', retryAfterMs: untilMidnight(t) };
      }
      while (minute.length && minute[0] <= t - 60000) { minute.shift(); }
      if (minute.length >= limits.requestsPerMinute) { return { ok: false, code: 'rate-limited', retryAfterMs: Math.max(1000, minute[0] + 60000 - t) }; }
      minute.push(t);
      inFlight++;
      u.totals.requests++;
      pc.requests++;
      u.totalRequests++;
      save();
      let released = false;
      return {
        ok: true,
        release: function (outcome) {
          if (released) { return; }
          released = true;
          inFlight = Math.max(0, inFlight - 1);
          roll();
          const c = prov(provider);
          if (outcome.usage) {
            u.totals.inputTokens += outcome.usage.inputTokens; u.totals.outputTokens += outcome.usage.outputTokens;
            c.inputTokens += outcome.usage.inputTokens; c.outputTokens += outcome.usage.outputTokens;
          }
          if (outcome.error) {
            u.totals.errors++; c.errors++;
            if (outcome.error === 'quota') {
              u.totals.quotaErrors++; c.quotaErrors++;
              const wait = outcome.retryAfterMs && outcome.retryAfterMs > 0 ? outcome.retryAfterMs : limits.quotaCooldownMs;
              pausedUntil[provider] = Math.max(pausedUntil[provider] || 0, now() + wait);
            }
          }
          save();
        }
      };
    },
    recordCache: function (hit: boolean) { roll(); if (hit) { u.cacheHits++; } else { u.cacheMisses++; } save(); },
    recordFallback: function () { roll(); u.fallbacks++; save(); },
    stats: function (): UsageStats {
      roll();
      const t = now();
      const providers: Record<string, ProviderUsage> = {};
      const names: string[] = [];
      for (const p in u.providers) { if (Object.prototype.hasOwnProperty.call(u.providers, p)) { names.push(p); } }
      for (const p in pausedUntil) { if (Object.prototype.hasOwnProperty.call(pausedUntil, p) && names.indexOf(p) < 0) { names.push(p); } }
      for (let i = 0; i < names.length; i++) {
        const c = u.providers[names[i]] || zero();
        const pu = pausedUntil[names[i]] || 0;
        providers[names[i]] = { requests: c.requests, inputTokens: c.inputTokens, outputTokens: c.outputTokens, errors: c.errors, quotaErrors: c.quotaErrors, pausedForMs: pu > t ? pu - t : 0 };
      }
      return {
        day: u.day, requests: u.totals.requests, inputTokens: u.totals.inputTokens, outputTokens: u.totals.outputTokens, errors: u.totals.errors,
        quotaErrors: u.totals.quotaErrors, cacheHits: u.cacheHits, cacheMisses: u.cacheMisses, fallbacks: u.fallbacks, totalRequests: u.totalRequests,
        providers: providers
      };
    },
    clear: function () { u = fresh(localDay(now()), 0); kv.remove(KV_USAGE); }
  };
}
