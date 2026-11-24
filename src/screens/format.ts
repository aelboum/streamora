// Display formatting for the playlist screens (no business logic).
import { redactString, REDACTED } from '../utils/redact.ts';

/** A URL as shown on screen: credential parts (query values, Xtream paths, userinfo, tokens) replaced with dots. */
export function maskUrl(url: string): string {
  return redactString(url).split(REDACTED).join('•••');
}

function two(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/** Local date and time, "2026-11-23 14:05". */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
}

/** "50,000" style grouping without Intl (not verified on the TV). */
export function formatCount(n: number): string {
  const s = String(Math.floor(n));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) {
      out += ',';
    }
    out += s.charAt(i);
  }
  return out;
}
