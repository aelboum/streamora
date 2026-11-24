// Streaming M3U / M3U8 playlist parser (ARCHITECTURE.md rev 3 §8). Pure: no DOM, no network.
//
// Input arrives in arbitrary text chunks (XHR onprogress); only the unfinished last line is kept
// between chunks, so memory use is bounded by the longest line, not the playlist size.
//
// Supported:
//   #EXTM3U [url-tvg|x-tvg-url|tvg-url="a,b"]       header and playlist EPG references
//   #EXTINF:<duration> key="value" key='v' key=v,<title>
//       tvg-id, tvg-name, tvg-logo, logo, group-title, tvg-chno, channel-number,
//       catchup, catchup-days, catchup-source, timeshift, user-agent, http-user-agent,
//       referrer, http-referrer, radio
//   #EXTGRP:<group>  #EXTVLCOPT:http-user-agent=… / http-referrer=…
//   plain (non-extended) playlists: one URL per line
//   CRLF, CR and LF line ends; UTF-8 BOM; double-encoded UTF-8 names (repaired)
// Detected and reported instead of parsed: HLS media/master playlists (#EXT-X-…), and
// responses that are clearly not playlists (HTML, JSON).
//
// Untrusted input rules: every field is cleaned (control/bidi characters removed) and capped;
// over-long lines are skipped without buffering them; the entry count is capped. URLs are
// passed through as text and validated by the caller (m3u-source.ts).
import { cleanText, repairMojibake, stripBom } from './text.ts';

export interface M3uEntry {
  title: string;
  duration: number;
  tvgId: string;
  tvgName: string;
  logo: string;
  group: string;
  chno: number | null;
  catchup: string;
  catchupDays: number | null;
  userAgent: string;
  referrer: string;
  radio: boolean;
  url: string;
  /** 1-based line number of the URL line. */
  line: number;
}

export interface M3uHeader {
  /** Started with #EXTM3U. */
  extended: boolean;
  /** EPG URLs from the header (unvalidated text). */
  epgUrls: string[];
}

export type M3uVerdict = 'playlist' | 'hls-stream' | 'not-playlist' | 'pending';

export interface M3uSummary {
  verdict: M3uVerdict;
  header: M3uHeader;
  lines: number;
  entries: number;
  /** #EXTINF without a URL, unreadable directives. */
  malformed: number;
  /** Lines longer than maxLineChars (skipped). */
  oversized: number;
  /** maxEntries reached; later entries were ignored. */
  truncated: boolean;
}

export interface M3uParserOptions {
  maxLineChars?: number;
  maxEntries?: number;
}

export interface M3uParser {
  /** Feeds the next piece of text. Returns false once parsing has stopped (verdict decided or entry cap reached). */
  push(text: string): boolean;
  /** Flushes the last line. */
  end(): M3uSummary;
  summary(): M3uSummary;
}

const MAX_TITLE = 200;
const MAX_GROUP = 100;
const MAX_ID = 128;
const MAX_UA = 256;
const MAX_URL_FIELD = 2048;
const DEFAULT_MAX_LINE = 8192;
const DEFAULT_MAX_ENTRIES = 500000;

interface Pending {
  duration: number;
  attrs: Record<string, string>;
  title: string;
  group: string;
  userAgent: string;
  referrer: string;
}

function isKeyChar(c: number): boolean {
  // A-Z a-z 0-9 _ - : .
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 58 || c === 46;
}

/** Parses `key="v" key='v' key=v` pairs up to the first unquoted comma. Returns the index after that comma (or -1). */
export function parseAttributes(s: string, start: number, out: Record<string, string>): number {
  // Character codes instead of charAt(): this runs once per #EXTINF line (hundreds of thousands on the TV).
  let i = start;
  const n = s.length;
  let count = 0;
  while (i < n) {
    let c = s.charCodeAt(i);
    while (i < n && (c === 32 || c === 9)) { c = s.charCodeAt(++i); }
    if (i >= n) { return -1; }
    if (c === 44) { return i + 1; } // ','
    const keyStart = i;
    while (i < n && isKeyChar(s.charCodeAt(i))) { i++; }
    const key = s.substring(keyStart, i).toLowerCase();
    if (key.length === 0 || i >= n || s.charCodeAt(i) !== 61) { // '='
      // Not an attribute: skip the token.
      while (i < n && s.charCodeAt(i) !== 32 && s.charCodeAt(i) !== 44) { i++; }
      if (key.length === 0 && i < n && s.charCodeAt(i) !== 44 && s.charCodeAt(i) !== 32) { i++; }
      continue;
    }
    i++; // '='
    let value: string;
    const q = s.charCodeAt(i);
    if (q === 34 || q === 39) { // '"' or "'"
      const close = s.indexOf(q === 34 ? '"' : "'", i + 1);
      if (close < 0) {
        // Unterminated quote: take the rest up to the last comma as the value.
        const lastComma = s.lastIndexOf(',');
        const stop = lastComma > i ? lastComma : n;
        value = s.substring(i + 1, stop);
        i = stop;
      } else {
        value = s.substring(i + 1, close);
        i = close + 1;
      }
    } else {
      const vs = i;
      while (i < n && s.charCodeAt(i) !== 32 && s.charCodeAt(i) !== 44) { i++; }
      value = s.substring(vs, i);
    }
    if (count++ < 64 && !Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = value.length > MAX_URL_FIELD ? value.substring(0, MAX_URL_FIELD) : value;
    }
  }
  return -1;
}

function attr(a: Record<string, string>, names: string[]): string {
  for (let i = 0; i < names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(a, names[i]) && a[names[i]] !== '') {
      return a[names[i]];
    }
  }
  return '';
}

function text(s: string, max: number): string {
  return cleanText(repairMojibake(s), max);
}

function intOrNull(s: string): number | null {
  return /^\s*\d{1,6}\s*$/.test(s) ? parseInt(s, 10) : null;
}

export function createM3uParser(onEntry: (e: M3uEntry) => void, options?: M3uParserOptions): M3uParser {
  const maxLine = (options && options.maxLineChars) || DEFAULT_MAX_LINE;
  const maxEntries = (options && options.maxEntries) || DEFAULT_MAX_ENTRIES;
  const header: M3uHeader = { extended: false, epgUrls: [] };
  const sum: M3uSummary = { verdict: 'pending', header: header, lines: 0, entries: 0, malformed: 0, oversized: 0, truncated: false };
  let rest = '';
  let skipping = false;   // inside an over-long line
  let first = true;       // before the first non-empty line
  let stopped = false;
  let pending: Pending | null = null;

  function stop(verdict: M3uVerdict): void {
    if (sum.verdict === 'pending' || verdict !== 'playlist') {
      sum.verdict = verdict;
    }
    stopped = true;
  }

  function onHeader(line: string): void {
    header.extended = true;
    const a: Record<string, string> = {};
    parseAttributes(line, 7, a);
    const raw = attr(a, ['url-tvg', 'x-tvg-url', 'tvg-url']);
    if (raw) {
      const parts = raw.split(',');
      for (let i = 0; i < parts.length && header.epgUrls.length < 5; i++) {
        const u = parts[i].replace(/^\s+|\s+$/g, '');
        if (u) { header.epgUrls.push(u); }
      }
    }
  }

  function onExtinf(line: string): void {
    if (pending) {
      sum.malformed++; // previous #EXTINF had no URL
    }
    let i = 8; // after '#EXTINF:'
    const n = line.length;
    const ds = i;
    while (i < n && line.charAt(i) !== ' ' && line.charAt(i) !== ',' && line.charAt(i) !== '\t') { i++; }
    const d = parseFloat(line.substring(ds, i));
    const attrs: Record<string, string> = {};
    const after = parseAttributes(line, i, attrs);
    pending = {
      duration: isFinite(d) ? d : -1,
      attrs: attrs,
      title: after >= 0 ? line.substring(after) : '',
      group: '', userAgent: '', referrer: ''
    };
  }

  function emit(url: string, lineNo: number): void {
    if (sum.entries >= maxEntries) {
      sum.truncated = true;
      stop('playlist');
      return;
    }
    const p = pending;
    pending = null;
    const a = p ? p.attrs : {};
    const e: M3uEntry = {
      title: text(p ? p.title : '', MAX_TITLE),
      duration: p ? p.duration : -1,
      tvgId: cleanText(attr(a, ['tvg-id', 'channel-id']), MAX_ID),
      tvgName: text(attr(a, ['tvg-name']), MAX_TITLE),
      logo: cleanText(attr(a, ['tvg-logo', 'logo']), MAX_URL_FIELD),
      group: text(attr(a, ['group-title']) || (p ? p.group : ''), MAX_GROUP),
      chno: intOrNull(attr(a, ['tvg-chno', 'channel-number', 'tvg-num'])),
      catchup: cleanText(attr(a, ['catchup', 'catchup-type']), 32),
      catchupDays: intOrNull(attr(a, ['catchup-days', 'timeshift'])),
      userAgent: cleanText(attr(a, ['user-agent', 'http-user-agent']) || (p ? p.userAgent : ''), MAX_UA),
      referrer: cleanText(attr(a, ['referrer', 'http-referrer']) || (p ? p.referrer : ''), MAX_URL_FIELD),
      radio: attr(a, ['radio']) === 'true',
      url: url,
      line: lineNo
    };
    sum.entries++;
    onEntry(e);
  }

  function onLine(raw: string): void {
    sum.lines++;
    const n0 = raw.length;
    const c0 = n0 ? raw.charCodeAt(0) : 0;
    const c1 = n0 ? raw.charCodeAt(n0 - 1) : 0;
    // Trim only when needed (regex replace on every line is measurable on the TV).
    const line = c0 === 32 || c0 === 9 || c1 === 32 || c1 === 9 ? raw.replace(/^[ \t]+|[ \t]+$/g, '') : raw;
    if (line.length === 0) {
      return;
    }
    if (first) {
      first = false;
      const c = line.charAt(0);
      if (c === '<' || c === '{' || c === '[') {
        stop('not-playlist');
        return;
      }
      if (line.substring(0, 7).toUpperCase() === '#EXTM3U') {
        onHeader(line);
        return;
      }
      if (c === '#' && line.substring(0, 8).toUpperCase() !== '#EXTINF:') {
        // Unknown leading directive: tolerated, but a playlist must still follow.
        return;
      }
    }
    if (line.charAt(0) === '#') {
      const upper = line.substring(0, 12).toUpperCase();
      if (upper.indexOf('#EXTINF:') === 0) {
        onExtinf(line);
      } else if (upper.indexOf('#EXT-X-') === 0) {
        // HLS tags: a stream manifest, not a channel list (unless channel entries were already seen).
        if (sum.entries === 0) {
          stop('hls-stream');
        }
      } else if (upper.indexOf('#EXTGRP:') === 0) {
        if (pending) { pending.group = line.substring(8); }
      } else if (upper.indexOf('#EXTVLCOPT:') === 0) {
        if (pending) {
          const opt = line.substring(11);
          const eq = opt.indexOf('=');
          const k = eq > 0 ? opt.substring(0, eq).toLowerCase() : '';
          if (k === 'http-user-agent') { pending.userAgent = opt.substring(eq + 1); }
          if (k === 'http-referrer' || k === 'http-referer') { pending.referrer = opt.substring(eq + 1); }
        }
      }
      // Other comments/directives (#KODIPROP, #EXTM3U repeated, plain comments) are ignored.
      return;
    }
    emit(line, sum.lines);
  }

  function consume(s: string): void {
    let start = 0;
    // indexOf jumps line to line (native scan); the next CR/LF positions are cached so a text
    // without CR is not rescanned for every line.
    let nl = -2;
    let cr = -2;
    while (!stopped) {
      if (nl !== -1 && nl < start) { nl = s.indexOf('\n', start); }
      if (cr !== -1 && cr < start) { cr = s.indexOf('\r', start); }
      const i = nl < 0 ? cr : (cr < 0 ? nl : Math.min(nl, cr));
      if (i < 0) {
        break;
      }
      if (skipping) {
        skipping = false;
      } else if (i - start > maxLine) {
        sum.oversized++;
        sum.lines++;
      } else {
        onLine(s.substring(start, i));
      }
      start = i + 1;
    }
    if (stopped) {
      rest = '';
      return;
    }
    const tail = s.substring(start);
    if (skipping) {
      rest = '';
    } else if (tail.length > maxLine) {
      sum.oversized++;
      sum.lines++;
      skipping = true;
      rest = '';
    } else {
      rest = tail;
    }
  }

  return {
    push: function (chunk) {
      if (stopped) {
        return false;
      }
      let s = rest + chunk;
      if (first && sum.lines === 0) {
        s = stripBom(s);
        // Decide on the first visible character: an HTML or JSON body may have no line break at all.
        const m = /^\s*(\S)/.exec(s.length > 256 ? s.substring(0, 256) : s);
        if (m && (m[1] === '<' || m[1] === '{' || m[1] === '[')) {
          stop('not-playlist');
          rest = '';
          return false;
        }
      }
      rest = '';
      consume(s);
      return !stopped;
    },
    end: function () {
      if (!stopped) {
        if (rest.length > 0 && !skipping) {
          onLine(rest);
        }
        rest = '';
        if (pending) {
          sum.malformed++;
          pending = null;
        }
        if (sum.verdict === 'pending') {
          sum.verdict = sum.entries > 0 || header.extended ? 'playlist' : 'not-playlist';
        }
        stopped = true;
      }
      return sum;
    },
    summary: function () { return sum; }
  };
}
