// Xtream Codes API client (player_api.php). Typed, validated responses; no provider details.
//
// Security rules (SECURITY-DECISIONS.md S3, S5, S8):
//   - every URL is built from the user-configured server origin, never from server_info.url,
//     a response URL or response content;
//   - every credentialed request declares credentialOrigin = that origin, so the HTTP client
//     refuses to send it anywhere else and discards a response that was redirected elsewhere;
//   - URLs containing credentials are never returned in errors and never logged: errors carry
//     a code and a fixed message only;
//   - responses are size-capped; the live stream list is read incrementally.
import type { HttpClient, HttpError, HttpHandle } from '../http-client.ts';
import { withRetry } from '../retry.ts';
import type { RetryPolicy, RetryTimers } from '../retry.ts';
import { checkUrl } from '../url.ts';
import { createJsonArrayStream } from '../../content/json-array-stream.ts';
import { createSlicer } from '../../content/slicer.ts';
import type { SliceTimers } from '../../content/slicer.ts';
import { parseAccount, parseCategory, parseEpgListings, parseLiveStream, parseSeries, parseSeriesInfo, parseVodInfo, parseVodStream } from './xtream-types.ts';
import type { XtreamAccount, XtreamCategory, XtreamEpgListing, XtreamLiveStream, XtreamSeries, XtreamSeriesInfo, XtreamVodInfo, XtreamVodStream } from './xtream-types.ts';

export interface XtreamCredentials {
  username: string;
  password: string;
}

export type XtreamErrorCode =
  | 'invalid-url' | 'network' | 'timeout' | 'http' | 'auth' | 'invalid-response'
  | 'too-large' | 'redirect-blocked' | 'aborted';

export type XtreamResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: XtreamErrorCode; status: number; message: string };

export interface XtreamHandle<T> {
  result: Promise<XtreamResult<T>>;
  abort(): void;
}

export interface XtreamLimits {
  requestTimeoutMs: number;
  /** Cap for small JSON responses (auth, categories, EPG). */
  maxResponseChars: number;
  /** Cap for the live stream list. */
  maxListChars: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface XtreamClientOptions {
  http: HttpClient;
  /** Normalised origin from normalizeXtreamServer(). */
  server: string;
  credentials: XtreamCredentials;
  limits: XtreamLimits;
  retry: RetryPolicy;
  timers: RetryTimers;
  /** When given, the stream list is parsed in time slices (UI stays responsive). */
  slice?: SliceTimers;
}

export interface LiveStreamsSummary {
  count: number;
  invalid: number;
}

export interface XtreamClient {
  /** player_api.php without action: account and server information. auth=false resolves as code 'auth'. */
  authenticate(): XtreamHandle<XtreamAccount>;
  liveCategories(): XtreamHandle<XtreamCategory[]>;
  /** Streams get_live_streams element by element to `onStream`. */
  liveStreams(onStream: (s: XtreamLiveStream) => void, categoryId?: string): XtreamHandle<LiveStreamsSummary>;
  /** get_short_epg: now/next style listing for one stream. */
  shortEpg(streamId: string, limit: number): XtreamHandle<XtreamEpgListing[]>;
  /** get_simple_data_table: full listing the panel holds for one stream. */
  epgTable(streamId: string): XtreamHandle<XtreamEpgListing[]>;
  /** get_vod_categories (Stage 6). */
  vodCategories(): XtreamHandle<XtreamCategory[]>;
  /** Streams get_vod_streams element by element to `onItem`. */
  vodStreams(onItem: (s: XtreamVodStream) => void): XtreamHandle<LiveStreamsSummary>;
  /** get_vod_info for one movie. */
  vodInfo(streamId: string): XtreamHandle<XtreamVodInfo>;
  /** get_series_categories. */
  seriesCategories(): XtreamHandle<XtreamCategory[]>;
  /** Streams get_series element by element to `onItem`. */
  seriesList(onItem: (s: XtreamSeries) => void): XtreamHandle<LiveStreamsSummary>;
  /** get_series_info for one series: info, seasons and episodes. */
  seriesInfo(seriesId: string, fallbackName: string): XtreamHandle<XtreamSeriesInfo>;
}

const MAX_CRED = 256;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EPG_ITEMS = 2000;

export type ServerCheck = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Normalises a user-entered Xtream server address to an origin. Accepts "host:port" without a
 * scheme (http assumed), a trailing slash, and a pasted ".../player_api.php" path. Rejects
 * queries, fragments, other paths and anything the userSource URL policy rejects.
 */
export function normalizeXtreamServer(raw: string): ServerCheck {
  let s = typeof raw === 'string' ? raw.replace(/^\s+|\s+$/g, '') : '';
  if (!s) {
    return { ok: false, reason: 'empty' };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = 'http://' + s;
  }
  const c = checkUrl(s, { kind: 'userSource' });
  if (!c.ok) {
    return { ok: false, reason: c.reason };
  }
  const rest = c.href.substring(c.href.indexOf('/', c.href.indexOf('//') + 2));
  if (rest !== '/' && !/^\/(player_api\.php|panel_api\.php|get\.php)?$/i.test(rest)) {
    return { ok: false, reason: 'server address must not contain a path or query' };
  }
  return { ok: true, origin: c.origin };
}

/** Splits an Xtream-style M3U link (…/get.php?username=…&password=…) into server and credentials. */
export function splitXtreamUrl(raw: string): { server: string; credentials: XtreamCredentials } | null {
  const c = checkUrl(typeof raw === 'string' ? raw.replace(/^\s+|\s+$/g, '') : '', { kind: 'userSource' });
  if (!c.ok) {
    return null;
  }
  const q = c.href.indexOf('?');
  if (q < 0 || !/\/(get|player_api)\.php$/i.test(c.href.substring(0, q))) {
    return null;
  }
  const params = c.href.substring(q + 1).split('#')[0].split('&');
  let user = '';
  let pass = '';
  for (let i = 0; i < params.length; i++) {
    const eq = params[i].indexOf('=');
    if (eq <= 0) { continue; }
    const k = params[i].substring(0, eq).toLowerCase();
    let v: string;
    try {
      v = decodeURIComponent(params[i].substring(eq + 1).replace(/\+/g, ' '));
    } catch (e) {
      return null;
    }
    if (k === 'username') { user = v; }
    if (k === 'password') { pass = v; }
  }
  if (!validCredential(user) || !validCredential(pass)) {
    return null;
  }
  return { server: c.origin, credentials: { username: user, password: pass } };
}

function validCredential(s: string): boolean {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_CRED && !/[\u0000-\u001f\u007f]/.test(s);
}

export function validCredentials(c: XtreamCredentials): boolean {
  return !!c && validCredential(c.username) && validCredential(c.password);
}

/**
 * Stream URL for playback. Built at play time only; the result contains the credentials and must
 * never be stored or logged (the logger redacts it if it is, see utils/redact.ts).
 */
export function buildXtreamStreamUrl(server: string, cred: XtreamCredentials, type: 'live' | 'movie' | 'series', id: string, ext: string): string {
  if (!ID_RE.test(id) || !/^[a-z0-9]{1,5}$/.test(ext)) {
    throw new Error('invalid stream reference');
  }
  return server + '/' + type + '/' + encodeURIComponent(cred.username) + '/' + encodeURIComponent(cred.password) + '/' + id + '.' + ext;
}

/** XMLTV endpoint of the panel (consumed by the Stage 5 EPG engine). Contains credentials. */
export function buildXtreamXmltvUrl(server: string, cred: XtreamCredentials): string {
  return server + '/xmltv.php?username=' + encodeURIComponent(cred.username) + '&password=' + encodeURIComponent(cred.password);
}

function fromHttp(e: HttpError): { ok: false; code: XtreamErrorCode; status: number; message: string } {
  let code: XtreamErrorCode;
  switch (e.kind) {
    case 'invalid-url': code = 'invalid-url'; break;
    case 'timeout': code = 'timeout'; break;
    case 'aborted': code = 'aborted'; break;
    case 'too-large': code = 'too-large'; break;
    case 'redirect-blocked': code = 'redirect-blocked'; break;
    case 'parse': code = 'invalid-response'; break;
    case 'http': code = e.status === 401 || e.status === 403 ? 'auth' : 'http'; break;
    default: code = 'network';
  }
  // Messages from the HTTP client never contain the URL; keep only the classification.
  const message = code === 'http' ? 'HTTP ' + e.status : code;
  return { ok: false, code: code, status: e.status, message: message };
}

function bad<T>(code: XtreamErrorCode, message: string): XtreamResult<T> {
  return { ok: false, code: code, status: 0, message: message };
}

function mapHandle<A, B>(h: HttpHandle<A>, map: (a: A) => XtreamResult<B>): XtreamHandle<B> {
  return {
    result: h.result.then(function (r): XtreamResult<B> {
      return r.ok ? map(r.data) : fromHttp(r.error);
    }),
    abort: function () { h.abort(); }
  };
}

export function createXtreamClient(o: XtreamClientOptions): XtreamClient {
  const server = normalizeXtreamServer(o.server);
  const credsOk = validCredentials(o.credentials);
  const origin = server.ok ? server.origin : '';

  function apiUrl(action: string, extra: string): string {
    return origin + '/player_api.php?username=' + encodeURIComponent(o.credentials.username) +
      '&password=' + encodeURIComponent(o.credentials.password) + (action ? '&action=' + action : '') + extra;
  }

  function precheck<T>(): XtreamHandle<T> | null {
    if (!server.ok) {
      return { result: Promise.resolve(bad<T>('invalid-url', 'invalid server address')), abort: function () { /* nothing */ } };
    }
    if (!credsOk) {
      return { result: Promise.resolve(bad<T>('auth', 'invalid credentials')), abort: function () { /* nothing */ } };
    }
    return null;
  }

  function json(url: string): HttpHandle<unknown> {
    return withRetry(function () {
      return o.http.request<unknown>({
        url: url, policy: { kind: 'userSource' }, responseType: 'json', credentialOrigin: origin,
        timeoutMs: o.limits.requestTimeoutMs, maxChars: o.limits.maxResponseChars
      });
    }, o.retry, o.timers);
  }

  function epg(action: string, streamId: string, extra: string): XtreamHandle<XtreamEpgListing[]> {
    const pre = precheck<XtreamEpgListing[]>();
    if (pre) {
      return pre;
    }
    if (!ID_RE.test(streamId)) {
      return { result: Promise.resolve(bad<XtreamEpgListing[]>('invalid-url', 'invalid stream id')), abort: function () { /* nothing */ } };
    }
    return mapHandle(json(apiUrl(action, '&stream_id=' + streamId + extra)), function (d): XtreamResult<XtreamEpgListing[]> {
      const p = parseEpgListings(d, MAX_EPG_ITEMS);
      return p ? { ok: true, data: p.items } : bad<XtreamEpgListing[]>('invalid-response', 'unexpected EPG response');
    });
  }

  function categories(action: string): XtreamHandle<XtreamCategory[]> {
    const pre = precheck<XtreamCategory[]>();
    if (pre) {
      return pre;
    }
    return mapHandle(json(apiUrl(action, '')), function (d): XtreamResult<XtreamCategory[]> {
      if (Object.prototype.toString.call(d) !== '[object Array]') {
        return bad<XtreamCategory[]>('invalid-response', 'categories response is not a list');
      }
      const arr = d as unknown[];
      const out: XtreamCategory[] = [];
      const seen: Record<string, boolean> = {};
      for (let i = 0; i < arr.length && out.length < 10000; i++) {
        const c = parseCategory(arr[i]);
        if (c && !seen['k' + c.id]) {
          seen['k' + c.id] = true;
          out.push(c);
        }
      }
      return { ok: true, data: out };
    });
  }

  /** Streams a JSON array response element by element (live streams, movies, series). */
  function streamList<T>(action: string, extra: string, parse: (v: unknown) => T | null, onItem: (s: T) => void): XtreamHandle<LiveStreamsSummary> {
    let invalid = 0;
    let count = 0;
    let consumerFailed = false;
    const reader = createJsonArrayStream(function (v) {
      const s = parse(v);
      if (!s) {
        invalid++;
        return;
      }
      count++;
      onItem(s);
    }, { maxElementChars: 100000 });
    let aborted = false;
    const slicer = createSlicer(function (piece) {
      try {
        return reader.push(piece) || true;
      } catch (e) {
        consumerFailed = true;
        h.abort();
        return false;
      }
    }, o.slice);
    const h = o.http.stream({
      url: apiUrl(action, extra),
      policy: { kind: 'userSource' }, credentialOrigin: origin, maxChars: o.limits.maxListChars,
      idleTimeoutMs: o.limits.idleTimeoutMs, totalTimeoutMs: o.limits.totalTimeoutMs,
      onChunk: function (text) { slicer.push(text); }
    });
    function summarize(): XtreamResult<LiveStreamsSummary> {
      const sum = reader.end();
      if (consumerFailed) {
        return bad<LiveStreamsSummary>('invalid-response', 'stream consumer failed');
      }
      if (sum.verdict === 'not-array') {
        // Some panels answer an invalid login on this endpoint with {"user_info":{"auth":0}}.
        let parsed: unknown = null;
        try { parsed = JSON.parse(sum.prefix); } catch (e) { parsed = null; }
        const acc = parseAccount(parsed);
        if (acc && !acc.user.auth) {
          return bad<LiveStreamsSummary>('auth', 'login refused');
        }
        return bad<LiveStreamsSummary>('invalid-response', 'stream list is not a JSON array');
      }
      if (sum.verdict === 'too-large') {
        return bad<LiveStreamsSummary>('too-large', 'stream entry too large');
      }
      if (sum.verdict === 'truncated' && !sum.capped) {
        return bad<LiveStreamsSummary>('invalid-response', 'stream list ended early');
      }
      return { ok: true, data: { count: count, invalid: invalid + sum.invalid } };
    }
    return {
      result: h.result.then(function (r): XtreamResult<LiveStreamsSummary> | Promise<XtreamResult<LiveStreamsSummary>> {
        if (consumerFailed) {
          return bad<LiveStreamsSummary>('invalid-response', 'stream consumer failed');
        }
        if (!r.ok) {
          slicer.cancel();
          return fromHttp(r.error);
        }
        return slicer.drained().then(function () {
          return aborted ? bad<LiveStreamsSummary>('aborted', 'aborted') : summarize();
        });
      }),
      abort: function () {
        aborted = true;
        slicer.cancel();
        h.abort();
      }
    };
  }

  /** One small JSON object response for an item id (vod info, series info). */
  function itemCall<T>(action: string, param: string, id: string, parse: (d: unknown) => T | null, what: string): XtreamHandle<T> {
    const pre = precheck<T>();
    if (pre) {
      return pre;
    }
    if (!ID_RE.test(id)) {
      return { result: Promise.resolve(bad<T>('invalid-url', 'invalid ' + what + ' id')), abort: function () { /* nothing */ } };
    }
    return mapHandle(json(apiUrl(action, '&' + param + '=' + id)), function (d): XtreamResult<T> {
      const p = parse(d);
      return p ? { ok: true, data: p } : bad<T>('invalid-response', 'unexpected ' + what + ' response');
    });
  }

  return {
    authenticate: function () {
      const pre = precheck<XtreamAccount>();
      if (pre) {
        return pre;
      }
      return mapHandle(json(apiUrl('', '')), function (d): XtreamResult<XtreamAccount> {
        const acc = parseAccount(d);
        if (!acc) {
          return bad<XtreamAccount>('invalid-response', 'not an Xtream API response');
        }
        if (!acc.user.auth) {
          return bad<XtreamAccount>('auth', 'login refused');
        }
        return { ok: true, data: acc };
      });
    },

    liveCategories: function () {
      return categories('get_live_categories');
    },

    liveStreams: function (onStream, categoryId) {
      const pre = precheck<LiveStreamsSummary>();
      if (pre) {
        return pre;
      }
      if (categoryId !== undefined && !ID_RE.test(categoryId)) {
        return { result: Promise.resolve(bad<LiveStreamsSummary>('invalid-url', 'invalid category id')), abort: function () { /* nothing */ } };
      }
      return streamList<XtreamLiveStream>('get_live_streams', categoryId !== undefined ? '&category_id=' + categoryId : '', parseLiveStream, onStream);
    },

    shortEpg: function (streamId, limit) {
      const n = Math.max(1, Math.min(50, Math.floor(limit) || 4));
      return epg('get_short_epg', streamId, '&limit=' + n);
    },

    epgTable: function (streamId) {
      return epg('get_simple_data_table', streamId, '');
    },

    vodCategories: function () {
      return categories('get_vod_categories');
    },

    vodStreams: function (onItem) {
      const pre = precheck<LiveStreamsSummary>();
      return pre || streamList<XtreamVodStream>('get_vod_streams', '', parseVodStream, onItem);
    },

    vodInfo: function (streamId) {
      return itemCall<XtreamVodInfo>('get_vod_info', 'vod_id', streamId, parseVodInfo, 'movie');
    },

    seriesCategories: function () {
      return categories('get_series_categories');
    },

    seriesList: function (onItem) {
      const pre = precheck<LiveStreamsSummary>();
      return pre || streamList<XtreamSeries>('get_series', '', parseSeries, onItem);
    },

    seriesInfo: function (seriesId, fallbackName) {
      return itemCall<XtreamSeriesInfo>('get_series_info', 'series_id', seriesId, function (d) { return parseSeriesInfo(d, fallbackName); }, 'series');
    }
  };
}
