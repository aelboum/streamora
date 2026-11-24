// Playlist credentials, stored only in the platform KeyStore (tizen.keymanager on the TV).
// Never written to files or localStorage, never logged, never included in errors.
// Without a KeyStore the app has no secret store at all (bootstrap leaves it null), so the UI
// must refuse to save credentials rather than fall back to plaintext.
import type { KeyStore } from '../app/platform/platform.ts';

export type PlaylistSecret =
  | { kind: 'xtream'; username: string; password: string }
  | { kind: 'm3u'; url: string };

export interface SecretStore {
  /** True when secrets survive a restart (key manager). False in the browser/test double. */
  readonly persistent: boolean;
  put(playlistId: string, secret: PlaylistSecret): Promise<void>;
  /** Resolves null when absent or unreadable. */
  get(playlistId: string): Promise<PlaylistSecret | null>;
  remove(playlistId: string): Promise<void>;
}

const PLAYLIST_ID_RE = /^[a-z0-9]{1,32}$/;
const MAX_FIELD = 256;
const MAX_URL = 2048;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function secretAlias(playlistId: string): string {
  if (!PLAYLIST_ID_RE.test(playlistId)) {
    throw new Error('invalid playlist id');
  }
  return 'ss_pl_' + playlistId;
}

function validField(s: unknown, max: number): boolean {
  return typeof s === 'string' && s.length > 0 && s.length <= max && !CONTROL.test(s);
}

export function isPlaylistSecret(x: unknown): x is PlaylistSecret {
  const s = x as { kind?: unknown; username?: unknown; password?: unknown; url?: unknown };
  if (!s || typeof s !== 'object') {
    return false;
  }
  if (s.kind === 'xtream') {
    return validField(s.username, MAX_FIELD) && validField(s.password, MAX_FIELD);
  }
  if (s.kind === 'm3u') {
    return validField(s.url, MAX_URL);
  }
  return false;
}

export function createSecretStore(keys: KeyStore): SecretStore {
  return {
    persistent: keys.persistent,
    put: function (playlistId, secret) {
      let alias: string;
      try { alias = secretAlias(playlistId); } catch (e) { return Promise.reject(e); }
      if (!isPlaylistSecret(secret)) {
        return Promise.reject(new Error('invalid credentials'));
      }
      const value = secret.kind === 'xtream'
        ? JSON.stringify({ kind: 'xtream', username: secret.username, password: secret.password })
        : JSON.stringify({ kind: 'm3u', url: secret.url });
      return keys.save(alias, value).then(null, function () {
        // Never propagate the underlying error object: it could carry the value in some engines.
        throw new Error('credentials could not be stored');
      });
    },
    get: function (playlistId) {
      let alias: string;
      try { alias = secretAlias(playlistId); } catch (e) { return Promise.reject(e); }
      return keys.load(alias).then(function (raw) {
        if (raw === null) {
          return null;
        }
        try {
          const parsed: unknown = JSON.parse(raw);
          return isPlaylistSecret(parsed) ? parsed : null;
        } catch (e) {
          return null;
        }
      }, function () {
        throw new Error('credentials could not be read');
      });
    },
    remove: function (playlistId) {
      let alias: string;
      try { alias = secretAlias(playlistId); } catch (e) { return Promise.reject(e); }
      return keys.remove(alias);
    }
  };
}
