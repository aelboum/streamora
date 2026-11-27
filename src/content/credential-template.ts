// Keeps playlist credentials out of the stored catalogue (SECURITY-DECISIONS.md S8).
//
// Provider M3U links usually carry the account in the query (…/get.php?username=U&password=P),
// and every stream URL inside repeats it (…/U/P/123.ts, …/live/U/P/123.m3u8, ?username=U&…).
// Before a URL is stored, occurrences of the playlist's own credentials are replaced:
//   - stream URLs at the playlist origin with the Xtream layout become an Xtream StreamRef
//     ({type, id, ext}); the URL is rebuilt at play time from the server and the secret;
//   - any other URL containing them keeps the {U}/{P} placeholders and is flagged `cred: true`;
//     substitution happens only at play time (resolveTemplate), into the URL the provider wrote.
// Credentials in other forms (opaque tokens the app cannot recognise) cannot be separated and
// are stored as part of the URL in app-private file storage; documented limitation.
import { checkUrl } from '../api/url.ts';
import type { Section, StreamRef } from '../models/content.ts';

export const USER_TOKEN = '{U}';
export const PASS_TOKEN = '{P}';

export interface PlaylistCredentials {
  username: string;
  password: string;
}

/** Credentials from a playlist URL's query (username/password), or null. */
export function credentialsFromUrl(url: string): PlaylistCredentials | null {
  const q = url.indexOf('?');
  if (q < 0) {
    return null;
  }
  const params = url.substring(q + 1).split('#')[0].split('&');
  let u = '';
  let p = '';
  for (let i = 0; i < params.length; i++) {
    const eq = params[i].indexOf('=');
    if (eq <= 0) { continue; }
    const k = params[i].substring(0, eq).toLowerCase();
    let v: string;
    try {
      v = decodeURIComponent(params[i].substring(eq + 1).replace(/\+/g, ' '));
    } catch (e) {
      continue;
    }
    if (k === 'username') { u = v; }
    if (k === 'password') { p = v; }
  }
  // Very short values would match ordinary path segments; such credentials are not templated.
  return u.length >= 2 && p.length >= 2 ? { username: u, password: p } : null;
}

/**
 * An Xtream account hidden in an M3U link: http(s)://host[:port][/prefix]/get.php (or
 * player_api.php) with username and password in the query. Returns the Xtream server address
 * (scheme, host, port, prefix) and the login, or null for any other link. Many providers no longer
 * serve get.php (e.g. HTTP 884) while their Xtream API keeps working.
 */
export function xtreamFromLink(url: string): { server: string; username: string; password: string } | null {
  const link = String(url || '').replace(/^\s+|\s+$/g, '');
  const m = /^(https?:\/\/[^\s\/?#@]+)((?:\/[^\s\/?#]+)*?)\/(?:get|player_api)\.php\?[^#\s]*$/i.exec(link);
  if (!m) { return null; }
  const cred = credentialsFromUrl(link);
  if (!cred) { return null; }
  return { server: m[1] + (m[2] || ''), username: cred.username, password: cred.password };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

export interface Templater {
  /** Converts a validated stream URL into the StreamRef that gets stored. */
  streamRef(url: string, section: Section): StreamRef;
  /** Any other URL (EPG): placeholders when it carries the credentials. */
  template(url: string): { url: string; cred: boolean };
}

export function createTemplater(playlistOrigin: string, cred: PlaylistCredentials | null): Templater {
  if (!cred) {
    return {
      streamRef: function (url) { return { kind: 'url', url: url }; },
      template: function (url) { return { url: url, cred: false }; }
    };
  }
  const rawUser = cred.username;
  const eu = encodeURIComponent(cred.username);
  const ep = encodeURIComponent(cred.password);
  // Path form: /U/P/ (raw or percent-encoded).
  const pathRe = new RegExp('/(?:' + escapeRe(eu) + '|' + escapeRe(cred.username) + ')/(?:' + escapeRe(ep) + '|' + escapeRe(cred.password) + ')(?=/)', 'g');
  const userParam = new RegExp('([?&](?:username|user)=)(?:' + escapeRe(eu) + '|' + escapeRe(cred.username) + ')(?=&|#|$)', 'gi');
  const passParam = new RegExp('([?&](?:password|pass)=)(?:' + escapeRe(ep) + '|' + escapeRe(cred.password) + ')(?=&|#|$)', 'gi');
  const xtreamRe = new RegExp('^' + escapeRe(playlistOrigin) + '/(?:(live|movie|series)/)?' + escapeRe(USER_TOKEN) + '/' + escapeRe(PASS_TOKEN) +
    '/([A-Za-z0-9_-]{1,64})(?:\\.([A-Za-z0-9]{1,5}))?$');

  function template(url: string): { url: string; cred: boolean } {
    if (url.indexOf(rawUser) < 0 && url.indexOf(eu) < 0) {
      return { url: url, cred: false }; // fast path: the username is not in the URL at all
    }
    const t = url.replace(pathRe, '/' + USER_TOKEN + '/' + PASS_TOKEN).replace(userParam, '$1' + USER_TOKEN).replace(passParam, '$1' + PASS_TOKEN);
    return { url: t, cred: t !== url };
  }

  return {
    streamRef: function (url, section) {
      const t = template(url);
      if (!t.cred) {
        return { kind: 'url', url: url };
      }
      const m = xtreamRe.exec(t.url);
      if (m) {
        const type: Section = m[1] === 'movie' ? 'movie' : m[1] === 'series' ? 'series' : (m[1] === 'live' ? 'live' : section);
        const ext = m[3] ? m[3].toLowerCase() : '';
        return ext ? { kind: 'xtream', type: type, id: m[2], ext: ext } : { kind: 'xtream', type: type, id: m[2] };
      }
      return { kind: 'url', url: t.url, cred: true };
    },
    template: template
  };
}

/**
 * Play-time substitution. Returns null when the result is not an acceptable URL. The result
 * contains credentials: it is handed to the player and never stored or logged.
 */
export function resolveTemplate(url: string, cred: PlaylistCredentials): string | null {
  const out = url.split(USER_TOKEN).join(encodeURIComponent(cred.username)).split(PASS_TOKEN).join(encodeURIComponent(cred.password));
  const c = checkUrl(out, { kind: 'userSource' });
  return c.ok ? c.href : null;
}
