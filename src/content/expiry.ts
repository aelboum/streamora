// S2: Xtream subscription expiry — parsing, time basis and display state. Pure: no I/O, no DOM.
//
// exp_date (user_info) is Unix time in seconds (UTC). Three distinct states:
//   date       a plausible instant (2000-01-01 ≤ t < 2100-01-01); 12–13 digit values are accepted as
//              milliseconds only when they fall in the same range;
//   unlimited  the key is present with null, 0, "0", "" or "null" (how panels mark unlimited lines);
//   unknown    the key is missing, negative, non-numeric or implausible. Never shown as a date.
//
// Time basis: the TV clock is used unless the server's own clock (server_info.timestamp_now, from
// the same authenticated response) is trustworthy AND differs by more than 24 h. Trustworthy =
// present and plausible (2024-01-01 ≤ t < 2100-01-01; this app did not exist earlier). The chosen
// basis and the reason are recorded so the fallback can be reported.

export type Expiry = { kind: 'date'; at: number } | { kind: 'unlimited' } | { kind: 'unknown' };

const DAY_MS = 86400000;
const MIN_S = 946684800;          // 2000-01-01T00:00:00Z
const MAX_S = 4102444800;         // 2100-01-01T00:00:00Z
const SERVER_MIN_MS = 1704067200000; // 2024-01-01T00:00:00Z
export const CLOCK_SKEW_MS = 24 * 3600 * 1000;

const UNKNOWN: Expiry = { kind: 'unknown' };
const UNLIMITED: Expiry = { kind: 'unlimited' };

/** user_info.exp_date → Expiry. `info` is the raw user_info object (or null). */
export function parseExpiry(info: Record<string, unknown> | null): Expiry {
  if (!info || !Object.prototype.hasOwnProperty.call(info, 'exp_date')) {
    return UNKNOWN;
  }
  const v = info.exp_date;
  let n: number;
  if (v === null || v === 0) {
    return UNLIMITED;
  }
  if (typeof v === 'string') {
    const s = v.replace(/^\s+|\s+$/g, '');
    if (s === '' || s === '0' || s.toLowerCase() === 'null') {
      return UNLIMITED;
    }
    if (!/^\d{1,15}$/.test(s)) {
      return UNKNOWN;
    }
    n = parseInt(s, 10);
  } else if (typeof v === 'number' && isFinite(v) && v > 0 && Math.floor(v) === v) {
    n = v;
  } else {
    return UNKNOWN;
  }
  if (n >= MIN_S && n < MAX_S) {
    return { kind: 'date', at: n * 1000 };
  }
  if (n >= MIN_S * 1000 && n < MAX_S * 1000) {
    return { kind: 'date', at: n }; // milliseconds
  }
  return UNKNOWN;
}

export type ClockReason = 'in-sync' | 'device-clock-off' | 'no-server-time' | 'server-time-implausible';

export interface ClockBasis {
  source: 'device' | 'server';
  /** Added to the TV clock to get the time used for expiry decisions (0 for 'device'). */
  offsetMs: number;
  reason: ClockReason;
}

export function isClockBasis(x: unknown): x is ClockBasis {
  const c = x as ClockBasis;
  return !!c && typeof c === 'object' && (c.source === 'device' || c.source === 'server') &&
    typeof c.offsetMs === 'number' && isFinite(c.offsetMs) &&
    (c.reason === 'in-sync' || c.reason === 'device-clock-off' || c.reason === 'no-server-time' || c.reason === 'server-time-implausible') &&
    (c.source === 'server' || c.offsetMs === 0);
}

/** Chooses the time basis from the server clock reported in the same response (ms, or null). */
export function clockBasis(serverTimeMs: number | null, deviceNow: number): ClockBasis {
  if (serverTimeMs === null) {
    return { source: 'device', offsetMs: 0, reason: 'no-server-time' };
  }
  if (!(serverTimeMs >= SERVER_MIN_MS && serverTimeMs < MAX_S * 1000)) {
    return { source: 'device', offsetMs: 0, reason: 'server-time-implausible' };
  }
  const diff = serverTimeMs - deviceNow;
  if (Math.abs(diff) <= CLOCK_SKEW_MS) {
    return { source: 'device', offsetMs: 0, reason: 'in-sync' };
  }
  return { source: 'server', offsetMs: diff, reason: 'device-clock-off' };
}

export function isExpiry(x: unknown): x is Expiry {
  const e = x as Expiry;
  if (!e || typeof e !== 'object') { return false; }
  if (e.kind === 'unlimited' || e.kind === 'unknown') { return true; }
  return e.kind === 'date' && typeof e.at === 'number' && e.at >= MIN_S * 1000 && e.at < MAX_S * 1000;
}

export type ExpiryView =
  | { state: 'unknown' }
  | { state: 'unlimited' }
  | { state: 'expired'; at: number }
  | { state: 'today'; at: number }
  | { state: 'days'; at: number; days: number };

/** Local calendar day number (the TV's time zone), for "days left". */
function localDay(ms: number): number {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Display state at `deviceNow` (+ the recorded clock offset). Dates are shown in local time. */
export function expiryView(expiry: Expiry, basis: ClockBasis | null, deviceNow: number): ExpiryView {
  if (expiry.kind === 'unknown') { return { state: 'unknown' }; }
  if (expiry.kind === 'unlimited') { return { state: 'unlimited' }; }
  const now = deviceNow + (basis ? basis.offsetMs : 0);
  if (expiry.at <= now) { return { state: 'expired', at: expiry.at }; }
  const days = localDay(expiry.at) - localDay(now);
  if (days <= 0) { return { state: 'today', at: expiry.at }; }
  return { state: 'days', at: expiry.at, days: days };
}
