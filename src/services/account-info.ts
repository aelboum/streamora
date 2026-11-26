// S2: per-playlist Xtream account metadata (subscription expiry, account status), stored apart from
// the DI-1-protected playlist list: KV "account.<playlistId>". No credentials, no server address.
//
// Written only after a successful Xtream authentication, so a later update that fails before it
// (network, timeout, wrong login) keeps the last known values. Removed only together with a
// playlist the user explicitly removes (playlist-service remove / removeAll). Reads go through
// kv.get, which never deletes (an unreadable record is quarantined and kept, DI-1).
import type { KeyValueStore } from '../storage/kv-store.ts';
import { isPlaylistId } from '../models/content.ts';
import type { ClockBasis, Expiry } from '../content/expiry.ts';
import { isClockBasis, isExpiry } from '../content/expiry.ts';

export const ACCOUNT_KEY_PREFIX = 'account.';

export interface AccountInfo {
  expiry: Expiry;
  /** Account status as reported by the server (e.g. "Active", "Disabled"); separate from expiry. */
  status: string;
  trial: boolean;
  maxConnections: number | null;
  /** TV clock when the server was asked (epoch ms). */
  checkedAt: number;
  /** Time basis chosen for this answer (server clock only with evidence; see expiry.ts). */
  clock: ClockBasis;
}

export interface AccountInfoStore {
  get(playlistId: string): AccountInfo | null;
  /** False when not stored (invalid id or data, storage full). Never touches the playlist list. */
  save(playlistId: string, info: AccountInfo): boolean;
}

const STATUS_RE = /^[A-Za-z0-9 _-]{0,32}$/;

export function isAccountInfo(x: unknown): x is AccountInfo {
  const a = x as AccountInfo;
  return !!a && typeof a === 'object' && isExpiry(a.expiry) && typeof a.status === 'string' && STATUS_RE.test(a.status) &&
    typeof a.trial === 'boolean' && (a.maxConnections === null || (typeof a.maxConnections === 'number' && isFinite(a.maxConnections))) &&
    typeof a.checkedAt === 'number' && isFinite(a.checkedAt) && isClockBasis(a.clock);
}

export function createAccountInfoStore(kv: KeyValueStore): AccountInfoStore {
  return {
    get: function (playlistId) {
      if (!isPlaylistId(playlistId)) { return null; }
      return kv.get<AccountInfo | null>(ACCOUNT_KEY_PREFIX + playlistId, function (x): x is AccountInfo | null { return isAccountInfo(x); }, null);
    },
    save: function (playlistId, info) {
      if (!isPlaylistId(playlistId)) { return false; }
      // Only the whitelisted fields are stored (no credentials can slip in through extra properties).
      const clean: AccountInfo = {
        expiry: info.expiry.kind === 'date' ? { kind: 'date', at: info.expiry.at } : { kind: info.expiry.kind },
        status: STATUS_RE.test(info.status) ? info.status : '',
        trial: !!info.trial,
        maxConnections: typeof info.maxConnections === 'number' && isFinite(info.maxConnections) ? info.maxConnections : null,
        checkedAt: info.checkedAt,
        clock: { source: info.clock.source, offsetMs: info.clock.offsetMs, reason: info.clock.reason }
      };
      if (!isAccountInfo(clean)) { return false; }
      return kv.set(ACCOUNT_KEY_PREFIX + playlistId, clean);
    }
  };
}
