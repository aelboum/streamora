// Xtream Codes API response shapes (provider side) and their validation.
//
// Raw* interfaces document what panels send; nothing outside src/api/xtream and
// src/content/xtream-source.ts sees them. Panels disagree on typing (numbers vs numeric strings,
// null vs "", 0/1 vs "0"/"1"), so every field is read through a tolerant converter, checked, and
// capped. An item that fails validation is dropped and counted, never passed on.
import { cleanText, decodeBase64Text, toFlag, toId, toInt } from '../../content/text.ts';
import { checkUrl } from '../url.ts';
import { parseExpiry } from '../../content/expiry.ts';
import type { Expiry } from '../../content/expiry.ts';

// ---------------------------------------------------------------- raw provider shapes
export interface RawUserInfo {
  auth?: number | string;
  status?: string;            // "Active" | "Expired" | "Banned" | "Disabled" | …
  exp_date?: string | number | null;   // unix seconds
  is_trial?: string | number;
  active_cons?: string | number;
  max_connections?: string | number;
  created_at?: string | number;
  allowed_output_formats?: string[];
  username?: string;          // echoed back by most panels; never stored or logged
  password?: string;
}
export interface RawServerInfo {
  url?: string;               // advertised host; NEVER used for requests (SECURITY-DECISIONS S5.4)
  port?: string | number;
  https_port?: string | number;
  server_protocol?: string;
  timezone?: string;
  timestamp_now?: number | string;
}
export interface RawAuthResponse { user_info?: RawUserInfo; server_info?: RawServerInfo }
export interface RawCategory { category_id?: string | number; category_name?: string; parent_id?: string | number }
export interface RawLiveStream {
  num?: number | string;
  name?: string;
  stream_type?: string;
  stream_id?: number | string;
  stream_icon?: string;
  epg_channel_id?: string | null;
  category_id?: string | number | null;
  category_ids?: (number | string)[];
  is_adult?: number | string;
  tv_archive?: number | string;
  tv_archive_duration?: number | string;
  direct_source?: string;
}
export interface RawEpgListing {
  id?: string; epg_id?: string; title?: string; description?: string; channel_id?: string;
  start?: string; end?: string; start_timestamp?: string | number; stop_timestamp?: string | number;
}

// ---------------------------------------------------------------- validated types
export interface XtreamUserInfo {
  auth: boolean;
  status: string;
  /** epoch ms, null when unlimited or unknown (back-compatible view of `expiry`). */
  expiresAt: number | null;
  /** S2: date / unlimited / unknown, with plausibility checks (content/expiry.ts). */
  expiry: Expiry;
  trial: boolean;
  activeConnections: number | null;
  maxConnections: number | null;
  allowedFormats: string[];
}
export interface XtreamServerInfo {
  timezone: string;
  /** Server clock (epoch ms) when reported. */
  serverTime: number | null;
  protocol: string;
}
export interface XtreamAccount {
  user: XtreamUserInfo;
  server: XtreamServerInfo;
}
export interface XtreamCategory { id: string; name: string; parentId: string | null }
export interface XtreamLiveStream {
  streamId: string;
  num: number | null;
  name: string;
  icon: string;
  epgChannelId: string;
  categoryId: string;
  adult: boolean;
  archiveDays: number | null;
}
export interface XtreamEpgListing {
  start: number;
  end: number;
  title: string;
  desc: string;
  channelId: string;
}

const MAX_NAME = 200;
const MAX_ID = 64;
const MAX_URL = 2048;
const MAX_DESC = 2000;

function obj(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && Object.prototype.toString.call(x) !== '[object Array]'
    ? x as Record<string, unknown> : null;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? cleanText(v, max) : (typeof v === 'number' && isFinite(v) ? String(v) : '');
}

/** null when the response has no user_info object (not an Xtream API response). */
export function parseAccount(x: unknown): XtreamAccount | null {
  const root = obj(x);
  const u = root ? obj(root.user_info) : null;
  if (!root || !u) {
    return null;
  }
  const s = obj(root.server_info) || {};
  const expiry = parseExpiry(u);
  const formats: string[] = [];
  const af = u.allowed_output_formats;
  if (Object.prototype.toString.call(af) === '[object Array]') {
    const arr = af as unknown[];
    for (let i = 0; i < arr.length && i < 10; i++) {
      const f = str(arr[i], 16).toLowerCase();
      if (/^[a-z0-9]+$/.test(f)) { formats.push(f); }
    }
  }
  const ts = toInt(s.timestamp_now);
  return {
    user: {
      auth: toFlag(u.auth),
      status: str(u.status, 32) || 'unknown',
      expiresAt: expiry.kind === 'date' ? expiry.at : null,
      expiry: expiry,
      trial: toFlag(u.is_trial),
      activeConnections: toInt(u.active_cons),
      maxConnections: toInt(u.max_connections),
      allowedFormats: formats
    },
    server: {
      timezone: str(s.timezone, 64),
      serverTime: ts !== null && ts > 0 ? ts * 1000 : null,
      protocol: str(s.server_protocol, 8).toLowerCase()
    }
  };
}

export function parseCategory(x: unknown): XtreamCategory | null {
  const c = obj(x);
  if (!c) {
    return null;
  }
  const id = toId(c.category_id, MAX_ID);
  const name = str(c.category_name, MAX_NAME);
  if (id === null || !name) {
    return null;
  }
  const parent = toId(c.parent_id, MAX_ID);
  return { id: id, name: name, parentId: parent !== null && parent !== '0' ? parent : null };
}

export function parseLiveStream(x: unknown): XtreamLiveStream | null {
  const r = obj(x);
  if (!r) {
    return null;
  }
  const id = toId(r.stream_id, MAX_ID);
  const name = str(r.name, MAX_NAME);
  if (id === null || !/^[A-Za-z0-9_-]+$/.test(id) || !name) {
    return null;
  }
  let cat = toId(r.category_id, MAX_ID);
  if (cat === null && Object.prototype.toString.call(r.category_ids) === '[object Array]') {
    cat = toId((r.category_ids as unknown[])[0], MAX_ID);
  }
  const days = toInt(r.tv_archive_duration);
  return {
    streamId: id,
    num: toInt(r.num),
    name: name,
    icon: typeof r.stream_icon === 'string' ? cleanText(r.stream_icon, MAX_URL) : '',
    epgChannelId: typeof r.epg_channel_id === 'string' ? cleanText(r.epg_channel_id, 128) : '',
    categoryId: cat === null ? '' : cat,
    adult: toFlag(r.is_adult),
    archiveDays: toFlag(r.tv_archive) && days !== null && days > 0 && days <= 365 ? days : null
  };
}

export interface EpgParse { items: XtreamEpgListing[]; invalid: number }

/** get_short_epg / get_simple_data_table: {"epg_listings":[…]}. null when the shape is wrong. */
export function parseEpgListings(x: unknown, maxItems: number): EpgParse | null {
  const root = obj(x);
  if (!root || Object.prototype.toString.call(root.epg_listings) !== '[object Array]') {
    return null;
  }
  const list = root.epg_listings as unknown[];
  const items: XtreamEpgListing[] = [];
  let invalid = 0;
  for (let i = 0; i < list.length && items.length < maxItems; i++) {
    const e = obj(list[i]);
    const start = e ? toInt(e.start_timestamp) : null;
    const end = e ? toInt(e.stop_timestamp) : null;
    if (!e || start === null || end === null || end <= start || start <= 0) {
      invalid++;
      continue;
    }
    items.push({
      start: start * 1000,
      end: end * 1000,
      title: decodeBase64Text(e.title, MAX_NAME),
      desc: decodeBase64Text(e.description, MAX_DESC),
      channelId: str(e.channel_id, 128)
    });
  }
  return { items: items, invalid: invalid };
}

// ---------------------------------------------------------------- movies and series (Stage 6)
// Shapes as documented for the Xtream Codes player API and observed variations:
//   get_vod_streams   [{num, name, stream_type:"movie", stream_id, stream_icon, rating, rating_5based,
//                      added, category_id, container_extension, ...}]
//   get_series        [{num, name, series_id, cover, plot, cast, director, genre, releaseDate,
//                      last_modified, rating, rating_5based, category_id, ...}]
//   get_vod_info      {info:{plot|description, genre, director, cast|actors, releasedate, duration_secs,
//                      duration, rating, movie_image, cover_big, backdrop_path[]}, movie_data:{...}}
//   get_series_info   {seasons:[{season_number, name, cover}], info:{...},
//                      episodes:{"1":[{id, episode_num, title, container_extension, season,
//                                 info:{duration_secs, duration, plot, movie_image}}]}}
//                      (some panels send `episodes` as an array of arrays or a flat array)
// Every field is optional on the wire; missing values become ''/null, never an error.

export interface XtreamVodStream {
  streamId: string;
  name: string;
  icon: string;
  categoryId: string;
  /** 0–10, null when unknown. */
  rating: number | null;
  /** epoch seconds when the panel added it, null when unknown. */
  added: number | null;
  year: number | null;
  /** Container extension (mp4, mkv, …), '' when unknown. */
  ext: string;
  adult: boolean;
}
export interface XtreamSeries {
  seriesId: string;
  name: string;
  cover: string;
  categoryId: string;
  rating: number | null;
  year: number | null;
  genre: string;
  /** epoch seconds (last_modified), null when unknown. */
  updated: number | null;
}
export interface XtreamMediaInfo {
  name: string;
  plot: string;
  genre: string;
  director: string;
  cast: string;
  year: number | null;
  rating: number | null;
  /** seconds, null when unknown. */
  durationSec: number | null;
  poster: string;
  backdrop: string;
}
export interface XtreamVodInfo extends XtreamMediaInfo { ext: string }
export interface XtreamEpisode {
  id: string;
  season: number;
  episode: number;
  title: string;
  ext: string;
  plot: string;
  durationSec: number | null;
  image: string;
  /**
   * Stage 11: true only when the provider stated the episode number and the season (in the
   * episode itself or as the numeric key it is listed under). Numbers filled in from the list
   * position or a default season are not used to choose a next episode.
   */
  exact: boolean;
}
export interface XtreamSeason { number: number; name: string; cover: string; episodes: XtreamEpisode[] }
export interface XtreamSeriesInfo { info: XtreamMediaInfo; seasons: XtreamSeason[]; invalid: number }

const MAX_TEXT = 300;
const MAX_EPISODES = 5000;
const MAX_SEASONS = 200;
const STREAM_ID_RE = /^[A-Za-z0-9_-]+$/;

function imageUrl(v: unknown): string {
  if (typeof v !== 'string' || !v) {
    return '';
  }
  const c = checkUrl(cleanText(v, MAX_URL), { kind: 'userSource' });
  return c.ok ? c.href : '';
}

/** First usable image of a field that may be a string or an array of strings. */
function firstImage(v: unknown): string {
  if (Object.prototype.toString.call(v) === '[object Array]') {
    const a = v as unknown[];
    for (let i = 0; i < a.length && i < 5; i++) {
      const u = imageUrl(a[i]);
      if (u) { return u; }
    }
    return '';
  }
  return imageUrl(v);
}

function ratingValue(x: unknown): number | null {
  const n = typeof x === 'number' ? x : (typeof x === 'string' && /^\s*\d{1,2}(\.\d{1,3})?\s*$/.test(x) ? parseFloat(x) : NaN);
  return isFinite(n) && n > 0 ? n : null;
}

/** Rating 0–10 from "7.4" / 7.4, else from rating_5based. */
function toRating(v: unknown, five: unknown): number | null {
  const r = ratingValue(v);
  if (r !== null && r <= 10) {
    return Math.round(r * 10) / 10;
  }
  const f = ratingValue(five);
  return f !== null && f <= 5 ? Math.round(f * 20) / 10 : null;
}

/** Year from the first value that holds one: a year field, a date ("2019-05-01") or "(2019)" in a name. */
function toYear(vals: unknown[]): number | null {
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    const s = typeof v === 'number' ? String(v) : (typeof v === 'string' ? v : '');
    const m = /(^|\D)((19|20)\d{2})(\D|$)/.exec(s);
    if (m) {
      return parseInt(m[2], 10);
    }
  }
  return null;
}

/** Seconds from duration_secs or "hh:mm:ss" / "mm:ss". */
function toDuration(secs: unknown, text: unknown): number | null {
  const s = toInt(secs);
  if (s !== null && s > 0 && s < 86400) {
    return s;
  }
  if (typeof text === 'string') {
    const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(text);
    if (m) {
      const total = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      return total > 0 ? total : null;
    }
  }
  return null;
}

function toExt(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9]{1,5}$/.test(v) ? v.toLowerCase() : '';
}

function catOf(r: Record<string, unknown>): string {
  let cat = toId(r.category_id, MAX_ID);
  if (cat === null && Object.prototype.toString.call(r.category_ids) === '[object Array]') {
    cat = toId((r.category_ids as unknown[])[0], MAX_ID);
  }
  return cat === null ? '' : cat;
}

export function parseVodStream(x: unknown): XtreamVodStream | null {
  const r = obj(x);
  if (!r) {
    return null;
  }
  const id = toId(r.stream_id, MAX_ID);
  const name = str(r.name, MAX_NAME);
  if (id === null || !STREAM_ID_RE.test(id) || !name) {
    return null;
  }
  const added = toInt(r.added);
  return {
    streamId: id, name: name, icon: imageUrl(r.stream_icon), categoryId: catOf(r),
    rating: toRating(r.rating, r.rating_5based), added: added !== null && added > 0 ? added : null,
    year: toYear([r.year, r.release_date, r.releasedate, name]), ext: toExt(r.container_extension), adult: toFlag(r.is_adult)
  };
}

export function parseSeries(x: unknown): XtreamSeries | null {
  const r = obj(x);
  if (!r) {
    return null;
  }
  const id = toId(r.series_id, MAX_ID);
  const name = str(r.name, MAX_NAME);
  if (id === null || !STREAM_ID_RE.test(id) || !name) {
    return null;
  }
  const upd = toInt(r.last_modified);
  return {
    seriesId: id, name: name, cover: imageUrl(r.cover), categoryId: catOf(r),
    rating: toRating(r.rating, r.rating_5based), year: toYear([r.year, r.releaseDate, r.release_date, name]),
    genre: str(r.genre, 120), updated: upd !== null && upd > 0 ? upd : null
  };
}

function mediaInfo(i: Record<string, unknown>, fallbackName: string): XtreamMediaInfo {
  return {
    name: str(i.name, MAX_NAME) || str(i.o_name, MAX_NAME) || fallbackName,
    plot: str(i.plot, MAX_DESC) || str(i.description, MAX_DESC),
    genre: str(i.genre, 120),
    director: str(i.director, MAX_TEXT),
    cast: str(i.cast, MAX_TEXT) || str(i.actors, MAX_TEXT),
    year: toYear([i.year, i.releasedate, i.releaseDate, i.release_date]),
    rating: toRating(i.rating, i.rating_5based),
    durationSec: toDuration(i.duration_secs, i.duration),
    poster: imageUrl(i.movie_image) || imageUrl(i.cover_big) || imageUrl(i.cover),
    backdrop: firstImage(i.backdrop_path)
  };
}

/** get_vod_info. null when the response is not an object. */
export function parseVodInfo(x: unknown): XtreamVodInfo | null {
  const root = obj(x);
  if (!root) {
    return null;
  }
  const info = obj(root.info) || {};
  const data = obj(root.movie_data) || {};
  const m = mediaInfo(info, str(data.name, MAX_NAME));
  return {
    name: m.name, plot: m.plot, genre: m.genre, director: m.director, cast: m.cast, year: m.year, rating: m.rating,
    durationSec: m.durationSec, poster: m.poster, backdrop: m.backdrop, ext: toExt(data.container_extension)
  };
}

function parseEpisode(x: unknown, seasonHint: number, index: number, hintStated: boolean): XtreamEpisode | null {
  const e = obj(x);
  if (!e) {
    return null;
  }
  const id = toId(e.id, MAX_ID);
  if (id === null || !STREAM_ID_RE.test(id)) {
    return null;
  }
  const i = obj(e.info) || {};
  const season = toInt(e.season);
  const num = toInt(e.episode_num);
  return {
    id: id,
    season: season !== null && season >= 0 && season < 10000 ? season : seasonHint,
    episode: num !== null && num >= 0 && num < 100000 ? num : index + 1,
    title: str(e.title, MAX_NAME) || str(i.name, MAX_NAME),
    ext: toExt(e.container_extension),
    plot: str(i.plot, MAX_DESC),
    durationSec: toDuration(i.duration_secs, i.duration),
    image: imageUrl(i.movie_image) || imageUrl(i.cover_big),
    exact: num !== null && num >= 0 && num < 100000 && ((season !== null && season >= 0 && season < 10000) || hintStated)
  };
}

/** get_series_info. null when the response is not an object. Episodes without a valid id are counted in `invalid`. */
export function parseSeriesInfo(x: unknown, fallbackName: string): XtreamSeriesInfo | null {
  const root = obj(x);
  if (!root) {
    return null;
  }
  const info = mediaInfo(obj(root.info) || {}, fallbackName);
  const bySeason: Record<string, XtreamSeason> = {};
  const order: number[] = [];
  let invalid = 0;
  let total = 0;
  function seasonOf(n: number): XtreamSeason {
    const k = 's' + n;
    if (!bySeason[k]) {
      bySeason[k] = { number: n, name: '', cover: '', episodes: [] };
      order.push(n);
    }
    return bySeason[k];
  }
  function addList(list: unknown, hint: number, hintStated: boolean): void {
    if (Object.prototype.toString.call(list) !== '[object Array]') {
      return;
    }
    const a = list as unknown[];
    for (let i = 0; i < a.length; i++) {
      if (Object.prototype.toString.call(a[i]) === '[object Array]') {
        addList(a[i], hint, hintStated); // array of arrays
        continue;
      }
      if (total >= MAX_EPISODES) {
        return;
      }
      const ep = parseEpisode(a[i], hint, i, hintStated);
      if (!ep) {
        invalid++;
        continue;
      }
      if (order.length >= MAX_SEASONS && !bySeason['s' + ep.season]) {
        invalid++;
        continue;
      }
      seasonOf(ep.season).episodes.push(ep);
      total++;
    }
  }
  const eps = root.episodes;
  if (Object.prototype.toString.call(eps) === '[object Array]') {
    addList(eps, 1, false); // no season key: the default season 1 is not a stated number
  } else if (obj(eps)) {
    const o = eps as Record<string, unknown>;
    for (const k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        const n = toInt(k);
        addList(o[k], n !== null && n >= 0 ? n : 1, n !== null && n >= 0);
      }
    }
  }
  // Season names and covers from the seasons list (only for seasons that have episodes).
  if (Object.prototype.toString.call(root.seasons) === '[object Array]') {
    const sl = root.seasons as unknown[];
    for (let j = 0; j < sl.length; j++) {
      const s = obj(sl[j]);
      const n = s ? toInt(s.season_number) : null;
      if (s && n !== null && bySeason['s' + n]) {
        bySeason['s' + n].name = str(s.name, MAX_NAME);
        bySeason['s' + n].cover = imageUrl(s.cover) || imageUrl(s.cover_big);
      }
    }
  }
  order.sort(function (a, b) { return a - b; });
  const seasons: XtreamSeason[] = [];
  for (let k = 0; k < order.length; k++) {
    const s = bySeason['s' + order[k]];
    s.episodes.sort(function (a, b) { return a.episode - b.episode; });
    seasons.push(s);
  }
  return { info: info, seasons: seasons, invalid: invalid };
}
