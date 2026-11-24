// URL guard used by the network layer for every request (ARCHITECTURE.md rev 3 §6.1).
//   strict     : https only, exact allowlisted host, port 443, no userinfo (fixed hosts)
//   userSource : http or https, any host and port, no userinfo (user-entered IPTV endpoints)
// Both: absolute URL, at most 2,048 characters, no control or whitespace characters.

export type UrlPolicy =
  | { kind: 'strict'; allowedHosts: string[] }
  | { kind: 'userSource' };

export type UrlCheck =
  | { ok: true; href: string; origin: string; protocol: 'http:' | 'https:' }
  | { ok: false; reason: string };

export const MAX_URL_LENGTH = 2048;

export function checkUrl(raw: string, policy: UrlPolicy): UrlCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'empty or too long' };
  }
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) {
    return { ok: false, reason: 'control or whitespace characters' };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch (e) {
    return { ok: false, reason: 'not an absolute URL' };
  }
  const protocol = u.protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    return { ok: false, reason: 'scheme not allowed' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'credentials in URL' };
  }
  const host = u.hostname.toLowerCase();
  if (!host) {
    return { ok: false, reason: 'missing host' };
  }
  if (u.port) {
    const p = Number(u.port);
    if (!(p >= 1 && p <= 65535)) {
      return { ok: false, reason: 'invalid port' };
    }
  }
  if (policy.kind === 'strict') {
    if (protocol !== 'https:') {
      return { ok: false, reason: 'only https is allowed' };
    }
    if (u.port && u.port !== '443') {
      return { ok: false, reason: 'non-standard port' };
    }
    if (policy.allowedHosts.indexOf(host) < 0) {
      return { ok: false, reason: 'host not allowlisted' };
    }
  }
  return { ok: true, href: u.href, origin: protocol + '//' + host + (u.port ? ':' + u.port : ''), protocol: protocol };
}

/** Origin (scheme://host[:port]) of an absolute URL, or '' when it cannot be parsed. */
export function originOf(raw: string): string {
  const c = checkUrl(raw, { kind: 'userSource' });
  return c.ok ? c.origin : '';
}
