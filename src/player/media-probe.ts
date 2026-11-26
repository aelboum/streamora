// Container header probe (Stage 7E). Reads the track table of an MP4/MOV or Matroska (MKV/WebM)
// file with a few small HTTP byte-range requests, because AVPlay reports languages cut to two
// letters ("tu", "po", "un") and never reports subtitle languages (Stage 7D, reproduced on the TV).
//
// What is read: only box / element headers and the small boxes that describe tracks (MP4: tkhd,
// mdhd, hdlr, elng, stsd with esds/dac3/dec3/btrt, udta/name; MKV: EBML header, SeekHead, Tracks,
// optional Tags with "BPS" statistics). Sample tables and media data are skipped, never fetched.
// Budget: at most MAX_BLOCKS blocks of BLOCK bytes per title (≤ 1.5 MB, usually 2–6 requests).
//
// Results are metadata only (language codes, codec names, channel counts, bitrates); the stream
// URL is never logged or returned. Nothing here is guessed: a field the file does not state is
// '' / 0 ("unknown").
import type { PlaybackSource } from '../models/content.ts';
import type { XhrLike } from '../app/platform/platform.ts';

export interface ProbeTrack {
  kind: 'video' | 'audio' | 'text';
  /** Language exactly as the container states it (ISO 639-2 or BCP 47), '' when not stated. */
  language: string;
  /** Track name / title from the container ('' when none or a muxer default such as "SoundHandler"). */
  name: string;
  /** Codec in lower case: aac, ac3, eac3, dts, mp3, mp2, opus, vorbis, flac, pcm, tx3g, srt, ass, pgs, … ('' unknown). */
  codec: string;
  /** Audio channels (0 unknown). */
  channels: number;
  /** Audio sample rate in Hz (0 unknown). */
  sampleRate: number;
  /** Average bitrate in bit/s as stated by the container (0 unknown). */
  bitrate: number;
  isDefault: boolean;
  forced: boolean;
  /** Stage 7F-E: MKV FlagHearingImpaired set (SDH). Only this explicit flag counts, never the name. */
  hearingImpaired: boolean;
  enabled: boolean;
}

export interface ProbeResult {
  container: 'mp4' | 'mkv';
  tracks: ProbeTrack[];
  /** HTTP range requests made. */
  requests: number;
}

/** Reads bytes [start, end] (inclusive) as a binary string; null on failure. total = file size or −1. */
export type RangeFetch = (start: number, end: number) => Promise<{ data: string; total: number } | null>;

export const BLOCK = 65536;
export const MAX_BLOCKS = 24;

// ---------------------------------------------------------------- block reader

interface Reader {
  /** Up to len bytes at off (shorter at the end of the file); null when the read failed or the budget is spent. */
  get(off: number, len: number): Promise<string | null>;
  total(): number;
  requests(): number;
}

function createReader(readRange: RangeFetch): Reader {
  const blocks: Record<string, string> = {};
  let size = -1;
  let reqs = 0;
  function block(i: number): Promise<string | null> {
    const key = String(i);
    if (Object.prototype.hasOwnProperty.call(blocks, key)) { return Promise.resolve(blocks[key]); }
    if (reqs >= MAX_BLOCKS || (size >= 0 && i * BLOCK >= size)) { return Promise.resolve(null); }
    reqs++;
    return readRange(i * BLOCK, i * BLOCK + BLOCK - 1).then(function (r) {
      if (!r) { return null; }
      if (r.total > 0) { size = r.total; }
      blocks[key] = r.data;
      return r.data;
    }, function () { return null; });
  }
  return {
    total: function () { return size; },
    requests: function () { return reqs; },
    get: function (off, len) {
      if (off < 0 || len <= 0) { return Promise.resolve(''); }
      const first = Math.floor(off / BLOCK);
      const last = Math.floor((off + len - 1) / BLOCK);
      const parts: string[] = [];
      function step(i: number): Promise<string | null> {
        if (i > last) {
          const all = parts.join('');
          const from = off - first * BLOCK;
          return Promise.resolve(all.substring(from, from + len));
        }
        return block(i).then(function (b) {
          if (b === null) { return parts.length ? step(last + 1) : null; }
          parts.push(b);
          // A short block is the end of the file.
          return b.length < BLOCK ? step(last + 1) : step(i + 1);
        });
      }
      return step(first);
    }
  };
}

// ---------------------------------------------------------------- byte helpers

function u8(s: string, i: number): number { return s.charCodeAt(i) & 0xff; }
function u16(s: string, i: number): number { return u8(s, i) * 256 + u8(s, i + 1); }
function u32(s: string, i: number): number { return u16(s, i) * 65536 + u16(s, i + 2); }
function u64(s: string, i: number): number { return u32(s, i) * 4294967296 + u32(s, i + 4); }
function fourcc(s: string, i: number): string { return s.substring(i, i + 4); }

/** Printable text from a binary string (UTF-8 decoded where valid), trimmed, at most 60 chars. */
export function cleanText(raw: string): string {
  let s = raw;
  const nul = s.indexOf('\u0000');
  if (nul >= 0) { s = s.substring(0, nul); }
  try { s = decodeURIComponent(escape(s)); } catch (e) { /* not UTF-8: keep the bytes as Latin-1 */ }
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\s+|\s+$/g, '');
  return s.length > 60 ? s.substring(0, 60) : s;
}

// Muxer defaults and technical strings that are not a track name ("SoundHandler", "aac:lang=und:delay=0").
const GENERIC_NAME = /handler|^core media|^gpac|^l-smash|^mainconcept|^apple|^isom|^mp4|^bento4|^dash|^text$|^sound$|^video$|^subtitle$|:lang=|delay=/i;
function usefulName(s: string): string { return s && !GENERIC_NAME.test(s) ? s : ''; }

function blank(kind: 'video' | 'audio' | 'text'): ProbeTrack {
  return { kind: kind, language: '', name: '', codec: '', channels: 0, sampleRate: 0, bitrate: 0, isDefault: false, forced: false, hearingImpaired: false, enabled: true };
}

// ---------------------------------------------------------------- MP4 / MOV

interface Box { type: string; off: number; size: number; hdr: number }

function boxAt(r: Reader, off: number, end: number): Promise<Box | null> {
  if (off + 8 > end) { return Promise.resolve(null); }
  return r.get(off, 16).then(function (b) {
    if (b === null || b.length < 8) { return null; }
    let size = u32(b, 0);
    let hdr = 8;
    const type = fourcc(b, 4);
    if (size === 1) {
      if (b.length < 16) { return null; }
      size = u64(b, 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || !/^[\x20-\x7e]{4}$/.test(type)) { return null; }
    return { type: type, off: off, size: size, hdr: hdr };
  });
}

/** Calls visit for each child box in [start, end); visit returns a promise. At most 64 children. */
function children(r: Reader, start: number, end: number, visit: (b: Box) => Promise<void>): Promise<void> {
  let n = 0;
  function next(off: number): Promise<void> {
    if (off >= end || n++ >= 64) { return Promise.resolve(); }
    return boxAt(r, off, end).then(function (b) {
      if (!b) { return undefined; }
      return visit(b).then(function () { return next(b.off + b.size); });
    });
  }
  return next(start);
}

function body(r: Reader, b: Box, max: number): Promise<string> {
  return r.get(b.off + b.hdr, Math.min(max, b.size - b.hdr)).then(function (s) { return s || ''; });
}

/** ISO 639-2/T packed in mdhd (3 × 5 bits + 0x60). 'und' and invalid codes become ''. */
function mdhdLanguage(v: number): string {
  const a = ((v >> 10) & 31) + 0x60;
  const b = ((v >> 5) & 31) + 0x60;
  const c = (v & 31) + 0x60;
  if (a < 0x61 || a > 0x7a || b < 0x61 || b > 0x7a || c < 0x61 || c > 0x7a) { return ''; }
  const s = String.fromCharCode(a, b, c);
  return s === 'und' ? '' : s;
}

const AC3_KBPS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
const ACMOD_CH = [2, 1, 2, 3, 3, 4, 4, 5];
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** MPEG-4 descriptor length (1–4 bytes, 7 bits each). */
function descLen(s: string, i: number): { len: number; next: number } {
  let len = 0;
  let k = 0;
  while (k < 4 && i < s.length) {
    const c = u8(s, i++);
    len = len * 128 + (c & 0x7f);
    k++;
    if (!(c & 0x80)) { break; }
  }
  return { len: len, next: i };
}

function parseEsds(s: string, t: ProbeTrack): void {
  let i = 4; // version + flags
  if (u8(s, i) !== 0x03) { return; }
  let d = descLen(s, i + 1);
  i = d.next + 2; // ES_ID
  const flags = u8(s, i++);
  if (flags & 0x80) { i += 2; }
  if (flags & 0x40) { i += 1 + u8(s, i); }
  if (flags & 0x20) { i += 2; }
  if (u8(s, i) !== 0x04) { return; }
  d = descLen(s, i + 1);
  i = d.next;
  const oti = u8(s, i);
  const avg = u32(s, i + 9);
  if (avg > 0) { t.bitrate = avg; }
  if (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) { t.codec = 'aac'; } else if (oti === 0x69 || oti === 0x6b) { t.codec = 'mp3'; } else if (oti === 0xa5) { t.codec = 'ac3'; } else if (oti === 0xa6) { t.codec = 'eac3'; } else if (oti === 0xa9) { t.codec = 'dts'; }
  i += 13;
  if (t.codec === 'aac' && u8(s, i) === 0x05) {
    d = descLen(s, i + 1);
    const j = d.next;
    if (d.len >= 2 && j + 1 < s.length) {
      const bits = u16(s, j);
      const fi = (bits >> 7) & 15;
      let ch = (bits >> 3) & 15;
      if (fi === 15) {
        // explicit 24-bit frequency: the channel configuration follows it
        if (j + 4 < s.length) { ch = (u32(s, j + 1) >> 3) & 15; }
      } else if (AAC_RATES[fi]) { t.sampleRate = AAC_RATES[fi]; }
      if (ch >= 1 && ch <= 6) { t.channels = ch; } else if (ch === 7) { t.channels = 8; }
    }
  }
}

function parseAudioEntry(r: Reader, b: Box, t: ProbeTrack): Promise<void> {
  return r.get(b.off, Math.min(b.size, 4096)).then(function (s) {
    if (!s || s.length < 36) { return; }
    const fmt = fourcc(s, 4);
    const map: Record<string, string> = { 'mp4a': '', 'ac-3': 'ac3', 'ec-3': 'eac3', 'dtsc': 'dts', 'dtsh': 'dts', 'dtsl': 'dts', 'dtse': 'dts', 'Opus': 'opus', 'fLaC': 'flac', '.mp3': 'mp3', 'lpcm': 'pcm', 'sowt': 'pcm', 'twos': 'pcm', 'alac': 'alac' };
    if (Object.prototype.hasOwnProperty.call(map, fmt)) { t.codec = map[fmt]; }
    const ver = u16(s, 16);
    const ch = u16(s, 24);
    const rate = u16(s, 32);
    if (ch > 0) { t.channels = ch; }
    if (rate > 0) { t.sampleRate = rate; }
    let i = 36 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    // Child boxes of the sample entry (esds, dac3, dec3, btrt; QuickTime puts esds inside 'wave').
    let guard = 0;
    while (i + 8 <= s.length && guard++ < 16) {
      const size = u32(s, i);
      const type = fourcc(s, i + 4);
      if (size < 8) { break; }
      const p = s.substring(i + 8, i + size);
      if (type === 'esds') {
        parseEsds(p, t);
      } else if (type === 'wave') {
        const k = p.indexOf('esds');
        if (k >= 4) { parseEsds(p.substring(k + 4, k - 4 + u32(p, k - 4)), t); }
      } else if (type === 'dac3' && p.length >= 3) {
        const v = u8(p, 0) * 65536 + u8(p, 1) * 256 + u8(p, 2);
        const acmod = (v >> 11) & 7;
        const lfe = (v >> 10) & 1;
        const brc = (v >> 5) & 31;
        t.codec = 'ac3';
        t.channels = ACMOD_CH[acmod] + lfe;
        if (AC3_KBPS[brc]) { t.bitrate = AC3_KBPS[brc] * 1000; }
      } else if (type === 'dec3' && p.length >= 5) {
        const rateK = u16(p, 0) >> 3;
        const v = u8(p, 2) * 65536 + u8(p, 3) * 256 + u8(p, 4);
        const acmod = (v >> 9) & 7;
        const lfe = (v >> 8) & 1;
        const deps = (v >> 1) & 15;
        let chans = ACMOD_CH[acmod] + lfe;
        if (deps > 0 && p.length >= 6) {
          const loc = (v & 1) * 256 + u8(p, 5);
          const PAIR = [1, 1, 0, 0, 1, 1, 1, 0, 0]; // bit 8..0: Lc/Rc, Lrs/Rrs, Cs, Ts, Lsd/Rsd, Lw/Rw, Lvh/Rvh, Cvh, LFE2
          for (let k = 0; k < 9; k++) { if (loc & (1 << (8 - k))) { chans += PAIR[k] ? 2 : 1; } }
        }
        t.codec = 'eac3';
        t.channels = chans;
        if (rateK > 0) { t.bitrate = rateK * 1000; }
      } else if (type === 'btrt' && p.length >= 12) {
        const avg = u32(p, 8);
        if (avg > 0 && !t.bitrate) { t.bitrate = avg; }
      }
      i += size;
    }
  });
}

function parseTrak(r: Reader, trak: Box): Promise<ProbeTrack | null> {
  let kind: 'video' | 'audio' | 'text' | '' = '';
  let lang = '';
  let elng = '';
  let hdlrName = '';
  let udtaName = '';
  let enabled = true;
  let stsd: Box | null = null;
  const end = trak.off + trak.size;
  return children(r, trak.off + trak.hdr, end, function (b) {
    if (b.type === 'tkhd') {
      return body(r, b, 4).then(function (s) { if (s.length >= 4) { enabled = (u8(s, 3) & 1) === 1; } });
    }
    if (b.type === 'udta') {
      return children(r, b.off + b.hdr, b.off + b.size, function (c) {
        if (c.type !== 'name') { return Promise.resolve(); }
        return body(r, c, 256).then(function (s) { udtaName = usefulName(cleanText(s)); });
      });
    }
    if (b.type !== 'mdia') { return Promise.resolve(); }
    return children(r, b.off + b.hdr, b.off + b.size, function (m) {
      if (m.type === 'mdhd') {
        return body(r, m, 40).then(function (s) {
          const at = u8(s, 0) === 1 ? 32 : 20;
          if (s.length >= at + 2) { lang = mdhdLanguage(u16(s, at)); }
        });
      }
      if (m.type === 'elng') {
        return body(r, m, 64).then(function (s) { elng = cleanText(s.substring(4)); });
      }
      if (m.type === 'hdlr') {
        return body(r, m, 256).then(function (s) {
          const h = fourcc(s, 8);
          kind = h === 'soun' ? 'audio' : h === 'vide' ? 'video' : (h === 'sbtl' || h === 'text' || h === 'subt' || h === 'clcp') ? 'text' : '';
          // QuickTime writes a Pascal string, ISO a C string.
          let name = s.substring(24);
          if (name.length && u8(name, 0) === name.length - 1) { name = name.substring(1); }
          hdlrName = usefulName(cleanText(name));
        });
      }
      if (m.type !== 'minf') { return Promise.resolve(); }
      return children(r, m.off + m.hdr, m.off + m.size, function (n) {
        if (n.type !== 'stbl') { return Promise.resolve(); }
        return children(r, n.off + n.hdr, n.off + n.size, function (st) {
          if (st.type === 'stsd') { stsd = st; }
          return Promise.resolve();
        });
      });
    });
  }).then(function (): Promise<ProbeTrack | null> | ProbeTrack | null {
    if (!kind) { return null; }
    const t = blank(kind);
    t.language = elng && elng !== 'und' ? elng : lang;
    t.name = udtaName || hdlrName;
    t.enabled = enabled;
    const sd = stsd as Box | null;
    if (!sd) { return t; }
    const k = kind;
    // stsd: version/flags 4, entry_count 4, then the first sample entry.
    return boxAt(r, sd.off + sd.hdr + 8, sd.off + sd.size).then(function (e) {
      if (!e) { return t; }
      const codec = e.type;
      if (k === 'text') {
        const TEXT: Record<string, string> = { tx3g: 'tx3g', text: 'text', wvtt: 'webvtt', stpp: 'ttml', c608: 'cea608' };
        t.codec = TEXT[codec] || '';
        return t;
      }
      if (k !== 'audio') {
        t.codec = codec === 'avc1' || codec === 'avc3' ? 'h264' : codec === 'hvc1' || codec === 'hev1' ? 'hevc' : '';
        return t;
      }
      return parseAudioEntry(r, e, t).then(function () { return t; });
    });
  });
}

function probeMp4(r: Reader): Promise<ProbeTrack[] | null> {
  // Top level: ftyp, free, mdat (skipped by its size), moov (anywhere).
  let moov: Box | null = null;
  let n = 0;
  function next(off: number): Promise<void> {
    const total = r.total();
    if (n++ >= 32 || (total >= 0 && off >= total)) { return Promise.resolve(); }
    return boxAt(r, off, total >= 0 ? total : off + 1e15).then(function (b) {
      if (!b) { return undefined; }
      if (b.type === 'moov') { moov = b; return undefined; }
      return next(b.off + b.size);
    });
  }
  return next(0).then(function () {
    const mv = moov as Box | null;
    if (!mv) { return null; }
    const out: ProbeTrack[] = [];
    return children(r, mv.off + mv.hdr, mv.off + mv.size, function (b) {
      if (b.type !== 'trak') { return Promise.resolve(); }
      return parseTrak(r, b).then(function (t) { if (t) { out.push(t); } });
    }).then(function () { return out; });
  });
}

// ---------------------------------------------------------------- Matroska

interface Ebml { id: number; size: number; data: number; end: number }

/** EBML element at i of s (absolute offset base + i); null when its header does not fit the buffer. */
function ebmlAt(s: string, i: number, base: number): Ebml | null {
  if (i >= s.length) { return null; }
  const first = u8(s, i);
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) { len++; }
  if (len > 4 || i + len > s.length) { return null; }
  let id = 0;
  for (let k = 0; k < len; k++) { id = id * 256 + u8(s, i + k); }
  let j = i + len;
  if (j >= s.length) { return null; }
  const f2 = u8(s, j);
  let sl = 1;
  while (sl <= 8 && !(f2 & (0x80 >> (sl - 1)))) { sl++; }
  if (sl > 8 || j + sl > s.length) { return null; }
  let size = f2 & (0xff >> sl);
  let allOnes = size === (0xff >> sl);
  for (let k = 1; k < sl; k++) {
    const c = u8(s, j + k);
    size = size * 256 + c;
    if (c !== 0xff) { allOnes = false; }
  }
  j += sl;
  if (allOnes) { size = -1; }
  return { id: id, size: size, data: base + j, end: size < 0 ? -1 : base + j + size };
}

function uintOf(s: string, from: number, len: number): number {
  let v = 0;
  for (let k = 0; k < len && k < 8; k++) { v = v * 256 + u8(s, from + k); }
  return v;
}

function floatOf(s: string, from: number, len: number): number {
  if (len === 4) {
    const v = u32(s, from);
    const sign = v >= 0x80000000 ? -1 : 1;
    const exp = Math.floor(v / 8388608) & 0xff;
    const man = v % 8388608;
    if (exp === 0) { return sign * man * Math.pow(2, -149); }
    return sign * (1 + man / 8388608) * Math.pow(2, exp - 127);
  }
  if (len === 8) {
    const hi = u32(s, from);
    const lo = u32(s, from + 4);
    const sign = hi >= 0x80000000 ? -1 : 1;
    const exp = Math.floor(hi / 1048576) & 0x7ff;
    const man = (hi % 1048576) * 4294967296 + lo;
    if (exp === 0) { return sign * man * Math.pow(2, -1074); }
    return sign * (1 + man / 4503599627370496) * Math.pow(2, exp - 1023);
  }
  return 0;
}

const MKV_CODEC: Array<[RegExp, string]> = [
  [/^A_AAC/, 'aac'], [/^A_AC3/, 'ac3'], [/^A_EAC3/, 'eac3'], [/^A_DTS/, 'dts'], [/^A_TRUEHD/, 'truehd'], [/^A_MPEG\/L3/, 'mp3'],
  [/^A_MPEG\/L2/, 'mp2'], [/^A_OPUS/, 'opus'], [/^A_VORBIS/, 'vorbis'], [/^A_FLAC/, 'flac'], [/^A_PCM/, 'pcm'],
  [/^S_TEXT\/UTF8/, 'srt'], [/^S_TEXT\/(ASS|SSA)/, 'ass'], [/^S_(ASS|SSA)/, 'ass'], [/^S_TEXT\/WEBVTT/, 'webvtt'], [/^D_WEBVTT/, 'webvtt'],
  [/^S_HDMV\/PGS/, 'pgs'], [/^S_VOBSUB/, 'vobsub'], [/^S_DVBSUB/, 'dvbsub'], [/^V_MPEG4\/ISO\/AVC/, 'h264'], [/^V_MPEGH\/ISO\/HEVC/, 'hevc']
];

/** Children of an EBML payload: calls fn(element, payload string) for each, at most `max`. */
function eachChild(s: string, max: number, fn: (e: Ebml, p: string) => void): void {
  let i = 0;
  let g = 0;
  while (i < s.length && g++ < max) {
    const e = ebmlAt(s, i, 0);
    if (!e || e.size < 0 || e.end > s.length) { break; }
    fn(e, s.substring(e.data, e.end));
    i = e.end;
  }
}

/** Tracks element payload → tracks (and their UIDs for the BPS tags). */
function parseMkvTracks(s: string, uids: string[]): ProbeTrack[] {
  const out: ProbeTrack[] = [];
  eachChild(s, 128, function (e, te) {
    if (e.id !== 0xae) { return; }
    let type = 0;
    let codec = '';
    let lang = '';
    let bcp = '';
    let name = '';
    let uid = '';
    let def = true;
    let forced = false;
    let hi = false;
    let enabled = true;
    let ch = 0;
    let rate = 0;
    eachChild(te, 128, function (c, v) {
      if (c.id === 0x83) { type = uintOf(v, 0, v.length); } else if (c.id === 0x86) { codec = cleanText(v); } else if (c.id === 0x22b59c) { lang = cleanText(v); } else if (c.id === 0x22b59d) { bcp = cleanText(v); } else if (c.id === 0x536e) { name = usefulName(cleanText(v)); } else if (c.id === 0x73c5) { uid = v; } else if (c.id === 0x88) { def = uintOf(v, 0, v.length) === 1; } else if (c.id === 0x55aa) { forced = uintOf(v, 0, v.length) === 1; } else if (c.id === 0x55ab) { hi = uintOf(v, 0, v.length) === 1; } else if (c.id === 0xb9) { enabled = uintOf(v, 0, v.length) === 1; } else if (c.id === 0xe1) {
        eachChild(v, 32, function (x, xv) {
          if (x.id === 0x9f) { ch = uintOf(xv, 0, xv.length); } else if (x.id === 0xb5) { rate = Math.round(floatOf(xv, 0, xv.length)); }
        });
      }
    });
    const kind = type === 1 ? 'video' : type === 2 ? 'audio' : type === 17 ? 'text' : '';
    if (!kind) { return; }
    const t = blank(kind);
    // An absent Language element is left unknown rather than assumed (the spec default would be "eng").
    const l = bcp || lang;
    t.language = l === 'und' ? '' : l;
    t.name = name;
    t.isDefault = def;
    t.forced = forced;
    t.hearingImpaired = hi;
    t.enabled = enabled;
    t.channels = ch;
    t.sampleRate = rate;
    for (let q = 0; q < MKV_CODEC.length; q++) { if (MKV_CODEC[q][0].test(codec)) { t.codec = MKV_CODEC[q][1]; break; } }
    out.push(t);
    uids.push(uid);
  });
  return out;
}

/** Tags payload: "BPS" statistics per TrackUID (written by mkvmerge). */
function applyMkvBps(s: string, tracks: ProbeTrack[], uids: string[]): void {
  eachChild(s, 256, function (tag, tb) {
    if (tag.id !== 0x7373) { return; }
    let uid = '';
    let bps = 0;
    eachChild(tb, 64, function (c, cb) {
      if (c.id === 0x63c0) {
        eachChild(cb, 16, function (x, xv) { if (x.id === 0x63c5) { uid = xv; } });
      } else if (c.id === 0x67c8) {
        let name = '';
        let val = '';
        eachChild(cb, 16, function (x, xv) {
          if (x.id === 0x45a3) { name = cleanText(xv); }
          if (x.id === 0x4487) { val = cleanText(xv); }
        });
        if (name === 'BPS' && /^\d{3,9}$/.test(val)) { bps = +val; }
      }
    });
    if (uid && bps > 0) {
      for (let q = 0; q < uids.length; q++) { if (uids[q] === uid && !tracks[q].bitrate) { tracks[q].bitrate = bps; } }
    }
  });
}

function readElement(r: Reader, off: number): Promise<{ e: Ebml; payload: string } | null> {
  return r.get(off, 16).then(function (h) {
    if (!h) { return null; }
    const e = ebmlAt(h, 0, off);
    if (!e || e.size < 0 || e.size > 512 * 1024) { return null; }
    return r.get(e.data, e.size).then(function (p) { return p === null || p.length < e.size ? null : { e: e, payload: p }; });
  });
}

function probeMkv(r: Reader): Promise<ProbeTrack[] | null> {
  return r.get(0, 64).then(function (head) {
    if (!head) { return null; }
    const ebml = ebmlAt(head, 0, 0);
    if (!ebml || ebml.id !== 0x1a45dfa3 || ebml.end < 0) { return null; }
    return r.get(ebml.end, 16).then(function (sh) {
      const seg = sh ? ebmlAt(sh, 0, ebml.end) : null;
      if (!seg || seg.id !== 0x18538067) { return null; }
      const segData = seg.data;
      let tracksAt = -1;
      let tagsAt = -1;
      let n = 0;
      // Walk the top-level children until Tracks or the first Cluster; remember SeekHead targets.
      function walk(off: number): Promise<void> {
        if (n++ >= 24 || tracksAt >= 0) { return Promise.resolve(); }
        return r.get(off, 16).then(function (h) {
          const e = h ? ebmlAt(h, 0, off) : null;
          if (!e || e.size < 0) { return undefined; }
          if (e.id === 0x1654ae6b) { tracksAt = off; return undefined; }
          if (e.id === 0x1f43b675) { return undefined; }
          if (e.id === 0x114d9b74 && e.size < 65536) {
            return r.get(e.data, e.size).then(function (p) {
              eachChild(p || '', 64, function (sk, sb) {
                if (sk.id !== 0x4dbb) { return; }
                let sid = 0;
                let pos = -1;
                eachChild(sb, 8, function (x, xv) {
                  if (x.id === 0x53ab) { sid = uintOf(xv, 0, xv.length); }
                  if (x.id === 0x53ac) { pos = uintOf(xv, 0, xv.length); }
                });
                if (sid === 0x1654ae6b && pos >= 0 && tracksAt < 0) { tracksAt = segData + pos; }
                if (sid === 0x1254c367 && pos >= 0) { tagsAt = segData + pos; }
              });
              return tracksAt >= 0 ? undefined : walk(e.end);
            });
          }
          return walk(e.end);
        });
      }
      return walk(segData).then(function (): Promise<ProbeTrack[] | null> | null {
        if (tracksAt < 0) { return null; }
        return readElement(r, tracksAt).then(function (tr): Promise<ProbeTrack[] | null> | ProbeTrack[] | null {
          if (!tr || tr.e.id !== 0x1654ae6b) { return null; }
          const uids: string[] = [];
          const tracks = parseMkvTracks(tr.payload, uids);
          if (tagsAt < 0) { return tracks; }
          return readElement(r, tagsAt).then(function (tg) {
            if (tg && tg.e.id === 0x1254c367) { applyMkvBps(tg.payload, tracks, uids); }
            return tracks;
          });
        });
      });
    });
  });
}

// ---------------------------------------------------------------- entry points

/** Probes with any range reader (tests read local files). */
export function probeWith(readRange: RangeFetch): Promise<ProbeResult | null> {
  const r = createReader(readRange);
  return r.get(0, 12).then(function (head): Promise<ProbeResult | null> | null {
    if (!head || head.length < 8) { return null; }
    if (u32(head, 0) === 0x1a45dfa3) {
      return probeMkv(r).then(function (t): ProbeResult | null { return t ? { container: 'mkv', tracks: t, requests: r.requests() } : null; });
    }
    const box = fourcc(head, 4);
    if (box === 'ftyp' || box === 'moov' || box === 'free' || box === 'mdat' || box === 'wide' || box === 'skip') {
      return probeMp4(r).then(function (t): ProbeResult | null { return t ? { container: 'mp4', tracks: t, requests: r.requests() } : null; });
    }
    return null;
  }).then(function (x) { return x; }, function () { return null; });
}

/**
 * Range reader over XHR (binary string). Only a `Range` header is sent — never credentials — and
 * redirects are followed by the engine exactly as AVPlay follows them for the same stream URL.
 * The URL is never logged. timeoutMs per request.
 */
export function xhrRangeFetch(xhrFactory: () => XhrLike, url: string, timeoutMs: number): RangeFetch {
  return function (start, end) {
    return new Promise(function (resolve) {
      let x: XhrLike;
      try { x = xhrFactory(); } catch (e) { resolve(null); return; }
      let done = false;
      function finish(v: { data: string; total: number } | null): void {
        if (done) { return; }
        done = true;
        x.onreadystatechange = x.onerror = x.ontimeout = x.onabort = null;
        resolve(v);
      }
      x.onreadystatechange = function () {
        if (x.readyState !== 4) { return; }
        if (x.status !== 206) { finish(null); return; }
        const cr = x.getResponseHeader ? x.getResponseHeader('Content-Range') || '' : '';
        const m = /\/(\d+)\s*$/.exec(cr);
        let s = x.responseText || '';
        if (s.length > end - start + 1) { s = s.substring(0, end - start + 1); }
        finish({ data: s, total: m ? +m[1] : -1 });
      };
      x.onerror = function () { finish(null); };
      x.ontimeout = function () { finish(null); };
      x.onabort = function () { finish(null); };
      try {
        x.open('GET', url, true);
        x.timeout = timeoutMs;
        x.withCredentials = false;
        if (x.overrideMimeType) { x.overrideMimeType('text/plain; charset=x-user-defined'); }
        x.setRequestHeader('Range', 'bytes=' + start + '-' + end);
        x.send(null);
      } catch (e) { finish(null); }
    });
  };
}

/** Probes a playback source (VOD only; mp4/mov/m4v/mkv/webm containers). */
export function probeSource(xhrFactory: () => XhrLike, src: PlaybackSource, timeoutMs: number): Promise<ProbeResult | null> {
  if (src.live || !/^(mp4|m4v|mov|mkv|webm)$/i.test(String(src.type || ''))) { return Promise.resolve(null); }
  return probeWith(xhrRangeFetch(xhrFactory, src.url, timeoutMs));
}
