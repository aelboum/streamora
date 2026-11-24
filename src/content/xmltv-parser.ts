// Streaming XMLTV parser (ARCHITECTURE.md rev 3 §8, Stage 5). Pure: no DOM, no network.
//
// Input arrives in arbitrary chunks; only the unfinished tail (an open tag or the text of the
// element being read) is kept between chunks, so memory is bounded by the largest element, not the
// file. Elements read:
//   <channel id> <display-name/>… <icon src/> </channel>
//   <programme start stop channel> <title/> <sub-title/> <desc/> <category/> </programme>
// Everything else (credits, ratings, episode-num, …) is skipped. Entities (&amp; &lt; &gt; &quot;
// &apos; &#n; &#xh;) and CDATA are decoded; comments, processing instructions and DOCTYPE are
// skipped. Text is cleaned and capped. Malformed tags are skipped and counted.
//
// Times: "YYYYMMDDhhmmss ±hhmm" (seconds optional; offset optional, "Z" allowed). Without an
// offset the caller's default offset applies (UTC unless configured).
import { cleanText } from './text.ts';

export interface XmltvChannel {
  id: string;
  names: string[];
  icon: string;
}

export interface XmltvProgramme {
  channel: string;
  /** epoch ms (UTC) */
  start: number;
  stop: number;
  title: string;
  subTitle: string;
  desc: string;
  category: string;
}

export type XmltvVerdict = 'xmltv' | 'not-xmltv' | 'pending';

export interface XmltvSummary {
  verdict: XmltvVerdict;
  channels: number;
  programmes: number;
  /** Programmes without a valid channel, start or stop. */
  invalid: number;
  /** Tags that could not be read (too long, unterminated). */
  malformed: number;
}

export interface XmltvParserOptions {
  /** Offset in minutes applied to times without an explicit offset. Default 0 (UTC). */
  defaultOffsetMin?: number;
  maxTitle?: number;
  maxDesc?: number;
  /** Longest single tag (characters). Default 16,384. */
  maxTag?: number;
}

export interface XmltvParser {
  push(text: string): boolean;
  end(): XmltvSummary;
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) {
    return s;
  }
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, function (m, e: string) {
    if (e.charAt(0) === '#') {
      const code = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
        return '';
      }
      if (code > 0xffff) {
        const c = code - 0x10000;
        return String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
      }
      return String.fromCharCode(code);
    }
    return Object.prototype.hasOwnProperty.call(ENTITY, e) ? ENTITY[e] : m;
  });
}

/** XMLTV time to epoch ms; NaN when malformed. */
export function parseXmltvTime(s: string, defaultOffsetMin: number): number {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:(Z)|([+-])(\d{2}):?(\d{2}))?\s*$/.exec(s || '');
  if (!m) {
    return NaN;
  }
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const hh = +m[4];
  const mi = +m[5];
  const ss = m[6] ? +m[6] : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 60) {
    return NaN;
  }
  let offset = defaultOffsetMin;
  if (m[7]) {
    offset = 0;
  } else if (m[8]) {
    const oh = +m[9];
    const om = +m[10];
    if (oh > 14 || om > 59) {
      return NaN;
    }
    offset = (m[8] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  return Date.UTC(y, mo - 1, d, hh, mi, ss) - offset * 60000;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(tag)) !== null && n++ < 32) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] !== undefined ? m[2] : (m[3] || ''));
  }
  return out;
}

type Field = 'name' | 'title' | 'sub' | 'desc' | 'cat' | '';

export function createXmltvParser(onChannel: (c: XmltvChannel) => void, onProgramme: (p: XmltvProgramme) => void,
  options?: XmltvParserOptions): XmltvParser {
  const offsetMin = options && options.defaultOffsetMin ? options.defaultOffsetMin : 0;
  const maxTitle = (options && options.maxTitle) || 200;
  const maxDesc = (options && options.maxDesc) || 500;
  const maxTag = (options && options.maxTag) || 16384;
  const sum: XmltvSummary = { verdict: 'pending', channels: 0, programmes: 0, invalid: 0, malformed: 0 };
  let buf = '';
  let started = false;
  let stopped = false;
  let chan: XmltvChannel | null = null;
  let prog: XmltvProgramme | null = null;
  let field: Field = '';
  let text = '';
  let textCap = 0;

  function openField(f: Field, cap: number): void {
    field = f;
    text = '';
    textCap = cap;
  }

  function addText(t: string): void {
    if (field && text.length < textCap * 2) {
      text += t;
    }
  }

  function closeField(): void {
    const v = cleanText(decodeEntities(text), field === 'desc' ? maxDesc : maxTitle);
    if (chan && field === 'name' && v && chan.names.length < 5) {
      chan.names.push(v);
    } else if (prog) {
      if (field === 'title' && !prog.title) { prog.title = v; }
      if (field === 'sub' && !prog.subTitle) { prog.subTitle = v; }
      if (field === 'desc' && !prog.desc) { prog.desc = v; }
      if (field === 'cat' && !prog.category) { prog.category = v; }
    }
    field = '';
    text = '';
  }

  function finishProgramme(): void {
    const p = prog as XmltvProgramme;
    prog = null;
    field = '';
    if (!p.channel || isNaN(p.start) || isNaN(p.stop) || p.stop <= p.start || p.stop - p.start > 86400000 * 2) {
      sum.invalid++;
      return;
    }
    sum.programmes++;
    onProgramme(p);
  }

  function onTag(raw: string): void {
    if (raw.charAt(1) === '?' || raw.charAt(1) === '!') {
      return; // declaration or DOCTYPE (comments and CDATA are handled in consume)
    }
    const closing = raw.charAt(1) === '/';
    const selfClosing = raw.charAt(raw.length - 2) === '/';
    const nm = /^<\/?\s*([A-Za-z_][-A-Za-z0-9_:.]*)/.exec(raw);
    if (!nm) {
      sum.malformed++;
      return;
    }
    const name = nm[1].toLowerCase();
    if (!started) {
      if (name !== 'tv') {
        sum.verdict = 'not-xmltv';
        stopped = true;
        return;
      }
      started = true;
      sum.verdict = 'xmltv';
      return;
    }
    if (closing) {
      if (field && ((field === 'name' && name === 'display-name') || (field === 'title' && name === 'title') ||
          (field === 'sub' && name === 'sub-title') || (field === 'desc' && name === 'desc') || (field === 'cat' && name === 'category'))) {
        closeField();
      } else if (name === 'channel' && chan) {
        if (chan.id) {
          sum.channels++;
          onChannel(chan);
        }
        chan = null;
      } else if (name === 'programme' && prog) {
        finishProgramme();
      }
      return;
    }
    if (name === 'channel' && !prog) {
      const a = attrs(raw);
      chan = selfClosing ? null : { id: cleanText(a.id || '', 128), names: [], icon: '' };
      return;
    }
    if (name === 'programme') {
      const a = attrs(raw);
      prog = {
        channel: cleanText(a.channel || '', 128), start: parseXmltvTime(a.start || '', offsetMin), stop: parseXmltvTime(a.stop || '', offsetMin),
        title: '', subTitle: '', desc: '', category: ''
      };
      if (selfClosing) { finishProgramme(); }
      return;
    }
    if (name === 'icon' && chan && !chan.icon) {
      chan.icon = cleanText(attrs(raw).src || '', 2048);
      return;
    }
    if (selfClosing) {
      return;
    }
    if (chan && name === 'display-name') { openField('name', maxTitle); }
    if (prog && name === 'title') { openField('title', maxTitle); }
    if (prog && name === 'sub-title') { openField('sub', maxTitle); }
    if (prog && name === 'desc') { openField('desc', maxDesc); }
    if (prog && name === 'category') { openField('cat', 60); }
  }

  function consume(final: boolean): void {
    let pos = 0;
    const n = buf.length;
    while (pos < n && !stopped) {
      const lt = buf.indexOf('<', pos);
      if (lt < 0) {
        addText(buf.substring(pos));
        pos = n;
        break;
      }
      if (lt > pos) {
        addText(buf.substring(pos, lt));
      }
      if (buf.substr(lt, 9) === '<![CDATA[') {
        const endC = buf.indexOf(']]>', lt + 9);
        if (endC < 0) { pos = lt; break; }
        if (field && text.length < textCap * 2) {
          // CDATA content is literal: escape '&' so entity decoding leaves it unchanged.
          text += buf.substring(lt + 9, endC).replace(/&/g, '&amp;');
        }
        pos = endC + 3;
        continue;
      }
      if (buf.substr(lt, 4) === '<!--') {
        const endM = buf.indexOf('-->', lt + 4);
        if (endM < 0) { pos = lt; break; }
        pos = endM + 3;
        continue;
      }
      const gt = buf.indexOf('>', lt + 1);
      if (gt < 0) {
        if (n - lt > maxTag) {
          sum.malformed++;
          pos = n; // garbage without a closing '>': drop it
        } else {
          pos = lt;
        }
        break;
      }
      if (gt - lt > maxTag) {
        sum.malformed++;
      } else {
        onTag(buf.substring(lt, gt + 1));
      }
      pos = gt + 1;
    }
    if (!started && !stopped) {
      const head = buf.substring(0, Math.min(buf.length, 512)).replace(/^﻿/, '').replace(/^\s+/, '');
      if (head.length > 0 && head.charAt(0) !== '<') {
        sum.verdict = 'not-xmltv'; // binary (.gz) or text that isn't XML
        stopped = true;
      }
    }
    buf = final || stopped ? '' : buf.substring(pos);
  }

  return {
    push: function (chunk) {
      if (stopped) {
        return false;
      }
      buf += chunk;
      consume(false);
      return !stopped;
    },
    end: function () {
      if (!stopped) {
        consume(true);
        if (sum.verdict === 'pending') {
          sum.verdict = 'not-xmltv';
        }
        stopped = true;
      }
      buf = '';
      return sum;
    }
  };
}
