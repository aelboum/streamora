// Removes sensitive data from values before they are logged or sent anywhere.
// Covers: secret-looking object keys, Authorization-style tokens, URL userinfo, sensitive
// query parameters, Xtream credential path segments (with and without the live/movie/series
// prefix), long opaque path tokens, e-mail addresses.

const SENSITIVE_KEY = /pass(word)?|pwd|secret|token|auth|cookie|session|credential|api[-_]?key|private|signature|username|^user$|pin(?!g)|salt|hash|mac(?!h)|email/i;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+\/=-]+/gi;
const URL_USERINFO = /(\w+:\/\/)[^\/\s@]+@/g;
/** Query parameters whose values are always removed. */
const SENSITIVE_PARAM = /([?&;](?:username|user|password|pass|pwd|token|access_token|key|apikey|api_key|auth|sig|signature|session|sid|secret|mac|email)=)[^&#\s"'<>]*/gi;
/** Xtream style: /live/<user>/<pass>/<id>.ts, also movie, series, timeshift. */
const XTREAM_PATH = /(\/(?:live|movie|series|timeshift)\/)[^\/\s?#"']+\/[^\/\s?#"']+(?=\/)/gi;
/** Xtream style without a type prefix (M3U links): scheme://host/<user>/<pass>/<id>[.ts|.m3u8|…]. */
const XTREAM_BARE = /(\w+:\/\/[^\/\s"'<>]+\/)[^\/\s?#"'<>]+\/[^\/\s?#"'<>]+(?=\/[A-Za-z0-9_-]{1,64}(?:\.(?:ts|m3u8|mp4|mkv|avi|mov|flv|mpd))?(?:[?#\s"'<>]|$))/gi;
/** Opaque path tokens (20+ chars of letters/digits/-/_ in one segment) inside URLs. */
const OPAQUE_SEGMENT = /(\w+:\/\/[^\s"'<>]*?\/)[A-Za-z0-9_-]{20,}(?=[\/?#\s"'<>]|$)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** AI-02: Google API keys ("AIza" + 35 characters) anywhere in a string. */
const GOOGLE_API_KEY = /AIza[0-9A-Za-z_\-]{20,}/g;
/** AI-02: Google auth keys from AI Studio ("AQ." + letters, digits, -, _ and dots). */
const GOOGLE_AUTH_KEY = /AQ\.[0-9A-Za-z_\-.]{20,}/g;
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_KEYS = 30;

export const REDACTED = '[redacted]';

export function redactString(s: string): string {
  let out = String(s)
    .replace(BEARER, '$1 ' + REDACTED)
    .replace(URL_USERINFO, '$1' + REDACTED + '@')
    .replace(SENSITIVE_PARAM, '$1' + REDACTED)
    .replace(XTREAM_PATH, '$1' + REDACTED + '/' + REDACTED)
    .replace(XTREAM_BARE, '$1' + REDACTED + '/' + REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(GOOGLE_API_KEY, REDACTED)
    .replace(GOOGLE_AUTH_KEY, REDACTED);
  // Opaque tokens: repeat until stable (a URL can hold several).
  for (let i = 0; i < 5; i++) {
    const next = out.replace(OPAQUE_SEGMENT, '$1' + REDACTED);
    if (next === out) {
      break;
    }
    out = next;
  }
  if (out.length > MAX_STRING) {
    out = out.substring(0, MAX_STRING) + '…';
  }
  return out;
}

export function redact(value: unknown, depth?: number): unknown {
  const d = depth || 0;
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (d >= MAX_DEPTH) {
    return '[depth]';
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(String(value.message)) };
  }
  if (Object.prototype.toString.call(value) === '[object Array]') {
    const arr = value as unknown[];
    const outArr: unknown[] = [];
    for (let i = 0; i < arr.length && i < MAX_KEYS; i++) {
      outArr.push(redact(arr[i], d + 1));
    }
    return outArr;
  }
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const key in src) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) {
        continue;
      }
      if (n++ >= MAX_KEYS) {
        break;
      }
      // Header maps are never logged, whatever their contents.
      out[key] = SENSITIVE_KEY.test(key) || /^headers?$/i.test(key) ? REDACTED : redact(src[key], d + 1);
    }
    return out;
  }
  return '[' + typeof value + ']';
}
