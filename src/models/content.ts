// Normalised content model (ARCHITECTURE.md rev 3 §4). Provider-specific response shapes live
// in src/api/xtream/xtream-types.ts and src/content/m3u-parser.ts; only these types cross
// into services and screens.
//
// Additions to §4, recorded in ARCHITECTURE.md §12a:
//   - Channel.userAgent / Channel.referrer (M3U #EXTVLCOPT and user-agent attributes);
//   - StreamRef 'url' may carry `cred: true`: the URL contains the {U}/{P} placeholders for the
//     playlist's own credentials, which are substituted only at play time;
//   - EpgSource is the playlist-level EPG reference; Channel.epgKey is the per-channel key.
//     An xmltv URL may also carry `cred: true` (same placeholder rule as StreamRef).

export type SourceKind = 'm3u' | 'xtream';
export type Section = 'live' | 'movie' | 'series';
export type LiveFormat = 'ts' | 'm3u8';

export type ImportErrorCode =
  | 'network' | 'timeout' | 'http' | 'auth' | 'expired' | 'not-playlist' | 'empty'
  | 'too-large' | 'invalid-response' | 'redirect-blocked' | 'storage' | 'no-credentials'
  | 'aborted' | 'interrupted' | 'busy' | 'invalid-url';

export interface SourceStatus {
  ok: boolean;
  /** Time of the attempt (epoch ms). */
  at: number;
  code?: ImportErrorCode;
  message?: string;
  /** Xtream account expiry (epoch ms), when the provider reports one. */
  expiresAt?: number;
  maxConnections?: number;
  trial?: boolean;
}

/** Stored in the KeyValueStore. Contains no secrets: credentials live in the SecretStore under secretAlias(id). */
export interface PlaylistDef {
  id: string;
  name: string;
  kind: SourceKind;
  /** Origin (scheme://host[:port]) of the playlist URL or Xtream server; the only origin that receives the credentials. */
  server: string;
  /** User-entered XMLTV URL (overrides the playlist's own EPG reference). */
  epgUrl?: string;
  liveFormat: LiveFormat;
  addedAt: number;
  lastLoadedAt?: number;
  lastStatus?: SourceStatus;
  /** The user has seen the notice that this http:// playlist sends credentials unencrypted. */
  cleartextNoticeSeen?: boolean;
}

/** Playlist-level EPG reference. */
export type EpgSource =
  | { kind: 'xmltv'; url: string; cred?: boolean }
  | { kind: 'xtream' };

export interface Category {
  id: string;
  name: string;
  section: Section;
  count: number;
  adult: boolean;
}

export type StreamRef =
  | { kind: 'xtream'; type: Section; id: string; ext?: string }
  | { kind: 'url'; url: string; cred?: boolean };

export interface Channel {
  /** Stable across refreshes (Xtream stream_id, or a hash of the M3U stream reference). */
  id: string;
  num: number;
  name: string;
  logo?: string;
  categoryId: string;
  /** EPG channel key (tvg-id / epg_channel_id). */
  epgKey?: string;
  adult: boolean;
  catchupDays?: number;
  streamRef: StreamRef;
  userAgent?: string;
  referrer?: string;
}

/** What the player receives (Stage 7). Built at play time; never stored or logged. */
export interface PlaybackSource {
  url: string;
  type: 'ts' | 'hls' | 'mp4' | 'mkv' | 'other';
  live: boolean;
  userAgent?: string;
  referrer?: string;
}

/** EPG programme (epoch ms, UTC). */
export interface Programme {
  start: number;
  end: number;
  title: string;
  desc?: string;
}

export interface ImportCounts {
  live: number;
  movie: number;
  series: number;
  /** Entries without a usable stream reference (bad URL, unsupported scheme, …). */
  invalid: number;
  /** Duplicates of an earlier entry (same stream reference). */
  duplicate: number;
}

/** Stored per playlist (catalogue section 'meta'). */
export interface CatalogueMeta {
  v: 1;
  importId: string;
  importedAt: number;
  kind: SourceKind;
  counts: ImportCounts;
  categories: number;
  epg: EpgSource[];
  /** Checksum of the live section file written with this meta (CatalogueStore header checksum).
   *  A live file with another checksum belongs to a different (interrupted) import. */
  liveHash: string;
  warnings: string[];
}

export interface LiveCatalogue {
  categories: Category[];
  channels: Channel[];
}

// ---------------------------------------------------------------- movies and series (Stage 6)
// ARCHITECTURE.md rev 3 §4 VodItem / SeriesItem / Episode. List entries hold only what the
// browse screens need; plot, genre, cast and duration are fetched per title (MediaDetails).

/** A movie (section 'movie') or a series (section 'series') in a catalogue list. */
export interface VodItem {
  /** Xtream stream_id (movie) or series_id (series). */
  id: string;
  name: string;
  poster?: string;
  categoryId: string;
  year?: number;
  /** 0–10. */
  rating?: number;
  /** epoch seconds: added (movie) or last modified (series). */
  added?: number;
  adult: boolean;
  /** Movies: container extension for the stream URL. */
  ext?: string;
  /** Series: genre from the list (movies get it from the details). */
  genre?: string;
}

export interface VodCatalogue {
  section: 'movie' | 'series';
  categories: Category[];
  items: VodItem[];
}

/** Details fetched per title (get_vod_info / get_series_info). Every field may be empty. */
export interface MediaDetails {
  name: string;
  plot: string;
  genre: string;
  director: string;
  cast: string;
  year: number | null;
  rating: number | null;
  durationSec: number | null;
  poster: string;
  backdrop: string;
}

export interface Episode {
  id: string;
  season: number;
  episode: number;
  title: string;
  plot: string;
  durationSec: number | null;
  image: string;
  streamRef: StreamRef;
}

export interface Season {
  number: number;
  name: string;
  cover: string;
  episodes: Episode[];
}

const PLAYLIST_ID_RE = /^[a-z0-9]{1,32}$/;

export function isPlaylistId(x: unknown): x is string {
  return typeof x === 'string' && PLAYLIST_ID_RE.test(x);
}

function isStatus(x: unknown): x is SourceStatus {
  const s = x as SourceStatus;
  return !!s && typeof s === 'object' && typeof s.ok === 'boolean' && typeof s.at === 'number';
}

export function isPlaylistDef(x: unknown): x is PlaylistDef {
  const d = x as PlaylistDef;
  return !!d && typeof d === 'object' && isPlaylistId(d.id) &&
    typeof d.name === 'string' && d.name.length > 0 && d.name.length <= 64 &&
    (d.kind === 'm3u' || d.kind === 'xtream') &&
    typeof d.server === 'string' && /^https?:\/\/[^\/?#\s]+$/.test(d.server) &&
    (d.epgUrl === undefined || typeof d.epgUrl === 'string') &&
    (d.liveFormat === 'ts' || d.liveFormat === 'm3u8') &&
    typeof d.addedAt === 'number' &&
    (d.lastLoadedAt === undefined || typeof d.lastLoadedAt === 'number') &&
    (d.lastStatus === undefined || isStatus(d.lastStatus)) &&
    (d.cleartextNoticeSeen === undefined || typeof d.cleartextNoticeSeen === 'boolean');
}

export function isPlaylistList(x: unknown): x is PlaylistDef[] {
  if (Object.prototype.toString.call(x) !== '[object Array]') {
    return false;
  }
  const a = x as unknown[];
  const seen: Record<string, boolean> = {};
  for (let i = 0; i < a.length; i++) {
    if (!isPlaylistDef(a[i])) {
      return false;
    }
    const id = (a[i] as PlaylistDef).id;
    if (seen['k' + id]) {
      return false;
    }
    seen['k' + id] = true;
  }
  return true;
}
