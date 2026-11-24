// M3U/M3U8 playlist import: streaming download -> streaming parse -> compact live catalogue.
// ContentProvider layer (ARCHITECTURE.md rev 3 §2): no storage, no DOM.
//
// Every URL found in the playlist is validated with the userSource policy (http/https only, no
// userinfo, no control characters, ≤ 2,048 characters); entries without a valid stream URL are
// dropped and counted. Logos and EPG URLs that fail validation are dropped. Names are cleaned
// text. Nothing from the playlist is ever executed or rendered as HTML.
import type { HttpClient, HttpHandle, StreamSummary } from '../api/http-client.ts';
import { checkUrl } from '../api/url.ts';
import type { EpgSource, ImportCounts, ImportErrorCode, Section } from '../models/content.ts';
import { mapHttpCode } from './import-types.ts';
import type { ImportHandle, ImportProgress, ImportResult } from './import-types.ts';
import { createM3uParser } from './m3u-parser.ts';
import type { M3uEntry, M3uSummary } from './m3u-parser.ts';
import { createLiveBuilder, looksAdult } from './catalogue-codec.ts';
import { createTemplater, credentialsFromUrl } from './credential-template.ts';
import { fnv1a32 } from '../utils/bytes.ts';
import { createSlicer } from './slicer.ts';
import type { SliceTimers } from './slicer.ts';

export interface M3uImportOptions {
  http: HttpClient;
  /** Full playlist URL (from the SecretStore). Never logged. */
  url: string;
  /** Display name used when the URL turns out to be a single HLS stream. */
  name: string;
  maxChars: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  onProgress?: (p: ImportProgress) => void;
  /** When given, parsing runs in time slices between XHR events (UI stays responsive). */
  timers?: SliceTimers;
}

const VOD_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|m4v|mpg|mpeg|webm)(?:[?#]|$)/i;
const EPISODE = /\bS\d{1,2}\s?E\d{1,3}\b/i;

/** Section of an M3U entry: Xtream paths first, then file extension, then episode naming. */
export function classifyEntry(url: string, title: string): Section {
  const path = url.replace(/^[a-z]+:\/\/[^\/]*/i, '').toLowerCase();
  if (path.indexOf('/movie/') === 0 || path.indexOf('/movie/') > 0) {
    return 'movie';
  }
  if (path.indexOf('/series/') >= 0) {
    return 'series';
  }
  if (VOD_EXT.test(path)) {
    return EPISODE.test(title) ? 'series' : 'movie';
  }
  return 'live';
}

function nameFromUrl(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const seg = path.substring(path.lastIndexOf('/') + 1).replace(/\.[A-Za-z0-9]{1,5}$/, '');
  let s: string;
  try {
    s = decodeURIComponent(seg);
  } catch (e) {
    s = seg;
  }
  return s.replace(/[\u0000-\u001f\u007f]/g, '').substring(0, 100);
}

function fail(code: ImportErrorCode, message: string): ImportResult {
  return { ok: false, code: code, message: message };
}

export function importM3u(o: M3uImportOptions): ImportHandle {
  const src = checkUrl(o.url, { kind: 'userSource' });
  if (!src.ok) {
    return { result: Promise.resolve(fail('invalid-url', 'invalid playlist address')), abort: function () { /* nothing */ } };
  }
  const origin = src.origin;
  const templater = createTemplater(origin, credentialsFromUrl(src.href));
  const builder = createLiveBuilder();
  const counts: ImportCounts = { live: 0, movie: 0, series: 0, invalid: 0, duplicate: 0 };
  const groupIds: Record<string, string> = {};
  let chars = 0;
  let aborted = false;
  let lastProgress = 0;

  function categoryFor(group: string): string {
    if (!group) {
      return '';
    }
    const k = 'k' + group;
    if (!Object.prototype.hasOwnProperty.call(groupIds, k)) {
      const id = 'g' + fnv1a32(group);
      groupIds[k] = id;
      builder.addCategory(id, group, looksAdult(group));
    }
    return groupIds[k];
  }

  function onEntry(e: M3uEntry): void {
    const u = checkUrl(e.url, { kind: 'userSource' });
    if (!u.ok) {
      counts.invalid++;
      return;
    }
    const title = e.title || e.tvgName || nameFromUrl(u.href) || 'Channel';
    const section = classifyEntry(u.href, title);
    if (section !== 'live') {
      // Movies and series are catalogued in Stage 6; counted here only.
      if (section === 'movie') { counts.movie++; } else { counts.series++; }
      return;
    }
    let logo = '';
    if (e.logo) {
      const l = checkUrl(e.logo, { kind: 'userSource' });
      logo = l.ok ? l.href : '';
    }
    const ref = templater.streamRef(u.href, 'live');
    const added = builder.addChannel({
      num: e.chno,
      name: title,
      categoryId: categoryFor(e.group),
      logo: logo,
      epgKey: e.tvgId || '',
      ref: ref,
      // Adult marking comes from the group (category) name; channel titles alone are too ambiguous.
      adult: false,
      radio: e.radio,
      catchupDays: e.catchupDays,
      userAgent: e.userAgent,
      referrer: e.referrer ? (checkUrl(e.referrer, { kind: 'userSource' }).ok ? e.referrer : '') : ''
    });
    if (added) {
      counts.live++;
    } else {
      counts.duplicate++;
    }
  }

  const parser = createM3uParser(onEntry);
  let parserStopped = false;
  let parsed = 0;
  // Parsing happens in the slicer (time-sliced when timers are given), not inside the XHR event.
  const slicer = createSlicer(function (piece) {
    parsed += piece.length;
    if (!parser.push(piece)) {
      // Verdict reached (not a playlist, HLS stream, entry cap): stop downloading.
      parserStopped = true;
      h.abort();
      return false;
    }
    if (o.onProgress && parsed - lastProgress >= 262144) {
      lastProgress = parsed;
      o.onProgress({ chars: parsed, channels: builder.channelCount() });
    }
    return true;
  }, o.timers);
  const h: HttpHandle<StreamSummary> = o.http.stream({
    url: src.href,
    policy: { kind: 'userSource' },
    credentialOrigin: origin,
    maxChars: o.maxChars,
    idleTimeoutMs: o.idleTimeoutMs,
    totalTimeoutMs: o.totalTimeoutMs,
    onChunk: function (text) {
      chars += text.length;
      slicer.push(text);
    }
  });

  function finish(summary: M3uSummary): ImportResult {
    const warnings: string[] = [];
    if (summary.verdict === 'not-playlist') {
      return fail('not-playlist', 'the address did not return an M3U playlist');
    }
    if (summary.verdict === 'hls-stream') {
      // The URL is a single HLS stream: offer it as one channel.
      builder.addChannel({
        num: 1, name: o.name, categoryId: '', logo: '', epgKey: '', ref: templater.streamRef(src.ok ? src.href : '', 'live'),
        adult: false, radio: false, catchupDays: null, userAgent: '', referrer: ''
      });
      counts.live = 1;
      warnings.push('single HLS stream');
    }
    if (summary.truncated) {
      warnings.push('entry limit reached; later entries ignored');
    }
    if (summary.malformed > 0) {
      warnings.push(summary.malformed + ' malformed entries');
    }
    if (summary.oversized > 0) {
      warnings.push(summary.oversized + ' over-long lines skipped');
    }
    if (counts.invalid > 0) {
      warnings.push(counts.invalid + ' entries without a valid http(s) stream address');
    }
    if (counts.live === 0) {
      return fail('empty', counts.movie + counts.series > 0 ? 'no live channels (movies/series only)' : 'the playlist has no playable channels');
    }
    const epg: EpgSource[] = [];
    for (let i = 0; i < summary.header.epgUrls.length; i++) {
      const c = checkUrl(summary.header.epgUrls[i], { kind: 'userSource' });
      if (c.ok) {
        const t = templater.template(c.href);
        epg.push(t.cred ? { kind: 'xmltv', url: t.url, cred: true } : { kind: 'xmltv', url: t.url });
      }
    }
    const built = builder.finish();
    return { ok: true, data: { payload: built.payload, counts: counts, categories: built.categories, epg: epg, warnings: warnings } };
  }

  return {
    result: h.result.then(function (r): ImportResult | Promise<ImportResult> {
      if (parserStopped) {
        return finish(parser.summary());
      }
      if (!r.ok) {
        slicer.cancel();
        return fail(mapHttpCode(r.error.kind, r.error.status), r.error.kind === 'http' ? 'HTTP ' + r.error.status : r.error.kind);
      }
      return slicer.drained().then(function (): ImportResult {
        if (aborted) {
          return fail('aborted', 'aborted');
        }
        return finish(parserStopped ? parser.summary() : parser.end());
      });
    }),
    abort: function () {
      aborted = true;
      slicer.cancel();
      h.abort();
    }
  };
}
