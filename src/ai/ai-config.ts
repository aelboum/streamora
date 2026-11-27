// AI-02: limits of the AI engine. Kept separate from app/config.ts so the existing configuration
// (and its stored overrides) is untouched. Values are deliberately conservative: providers no
// longer publish all free-tier limits (AI-01 report), so local limits sit below any plausible
// quota, and the providers' own 429 answers still win. Per-user and global budgets for a
// distributed app are enforced server-side by the EliteStream AI service (design only).
export const AI_LIMITS = {
  /** Requests per minute / per local day (all providers together). */
  requestsPerMinute: 8,
  requestsPerDay: 200,
  /** Requests in flight at the same time (backpressure: more are refused with 'busy'). */
  maxConcurrent: 1,
  /** Network timeout per request. */
  requestTimeoutMs: 30000,
  /** Response size cap (characters). */
  maxResponseChars: 400000,
  /** Retries after transient failures (network, timeout, 5xx, short 429): exponential backoff. */
  retryAttempts: 2,
  retryBaseMs: 1500,
  retryMaxMs: 20000,
  /** After a quota answer without a usable retry delay, pause that provider this long. */
  quotaCooldownMs: 60000,
  /** Longest request text (characters); longer requests are refused, not truncated silently. */
  maxPromptChars: 60000,
  /** Model lists are fetched again when older than this. */
  modelListMaxAgeMs: 3600000,
  /** Cache (file store, ai-cache.json). */
  cacheMaxEntries: 2000,
  cacheMaxChars: 1500000,
  cacheDefaultTtlMs: 7 * 24 * 3600000,
  cacheSaveDelayMs: 3000
};

export type AiLimits = typeof AI_LIMITS;

/**
 * Address of the EliteStream AI service (backend gateway). Empty: no service is deployed, so the
 * "EliteStream AI service" provider reports 'not-configured'. When a service exists, its https
 * origin goes here (build-time), and it is added to the AI HTTP client's allow-list.
 */
export const AI_GATEWAY_URL = '';

/**
 * Phone pairing relay (docs/AI-02-PHONE-PAIRING.md): https origin of the Cloudflare Worker in
 * relay/, e.g. 'https://pair.example.com'. Empty: "API key with phone (QR)" is not offered.
 * The relay only passes on end-to-end encrypted envelopes; it never sees a key.
 */
export const AI_PAIRING_URL = 'https://pair.elitestreamplayer.com';
