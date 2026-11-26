// Result types shared by the playlist sources (m3u-source.ts, xtream-source.ts).
import type { EpgSource, ImportCounts, ImportErrorCode } from '../models/content.ts';
import type { LivePayload } from './catalogue-codec.ts';
import type { ClockBasis, Expiry } from './expiry.ts';

/**
 * S2: account metadata reported right after a successful Xtream login (before any later step can
 * fail). No credentials, no server address. Same shape as services/account-info.ts AccountInfo.
 */
export interface AccountReport {
  expiry: Expiry;
  status: string;
  trial: boolean;
  maxConnections: number | null;
  checkedAt: number;
  clock: ClockBasis;
}

export interface SourceImport {
  payload: LivePayload;
  counts: ImportCounts;
  categories: number;
  epg: EpgSource[];
  warnings: string[];
  /** Xtream account details (Xtream imports only). */
  account?: { expiresAt: number | null; maxConnections: number | null; trial: boolean; status: string };
}

export type ImportResult =
  | { ok: true; data: SourceImport }
  | { ok: false; code: ImportErrorCode; message: string };

export interface ImportHandle {
  result: Promise<ImportResult>;
  abort(): void;
}

export interface ImportProgress {
  /** Characters parsed so far (0 for the Xtream list, which reports channels only). */
  chars: number;
  channels: number;
  /** 'store' once download and parsing are done and the catalogue is being saved. */
  phase?: 'fetch' | 'store';
}

export function mapHttpCode(kind: string, status: number): ImportErrorCode {
  switch (kind) {
    case 'timeout': return 'timeout';
    case 'aborted': return 'aborted';
    case 'too-large': return 'too-large';
    case 'redirect-blocked': return 'redirect-blocked';
    case 'invalid-url': return 'invalid-url';
    case 'parse': return 'invalid-response';
    case 'http': return status === 401 || status === 403 ? 'auth' : 'http';
    default: return 'network';
  }
}
