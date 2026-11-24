// Text helpers for untrusted playlist and provider metadata. Everything here returns plain
// strings that are only ever rendered as text (textContent), never as HTML.
//
// No TextDecoder or atob: neither is verified on Tizen 3.0, so UTF-8 and base64 decoding are
// implemented here (small, tested on Windows).

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const WS_RE = /[\s ]+/g;

/** Removes a leading byte-order mark. */
export function stripBom(s: string): string {
  return s.length > 0 && s.charCodeAt(0) === 0xfeff ? s.substring(1) : s;
}

const NEEDS_CLEAN_RE = /[\u0000-\u001f\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u2066-\u2069\u3000\ufeff]|\s\s|^\s|\s$/;

/**
 * Cleans a display string: control, zero-width and bidi-override characters removed, whitespace
 * collapsed, trimmed and capped at `max` characters. Never returns null.
 */
export function cleanText(s: string, max: number): string {
  if (typeof s !== 'string' || s.length === 0) {
    return '';
  }
  // Fast path (the common case): nothing to remove, short enough.
  if (s.length <= max && !NEEDS_CLEAN_RE.test(s)) {
    return s;
  }
  let out = s.length > max * 4 ? s.substring(0, max * 4) : s;
  out = out.replace(CONTROL_RE, '').replace(WS_RE, ' ');
  out = out.replace(/^ +| +$/g, '');
  if (out.length > max) {
    out = out.substring(0, max);
  }
  return out;
}

/** Decodes UTF-8 bytes. Invalid sequences become U+FFFD; with `strict`, null is returned instead. */
export function utf8Decode(bytes: ArrayLike<number>, strict?: boolean): string | null {
  const parts: string[] = [];
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    let cp = -1;
    let need = 0;
    if (b < 0x80) {
      cp = b;
    } else if (b >= 0xc2 && b <= 0xdf) {
      need = 1; cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2; cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3; cp = b & 0x07;
    }
    // A truncated sequence at the end of the input is invalid.
    let ok = cp >= 0 && i + need < n;
    if (ok && need > 0) {
      for (let k = 1; ok && k <= need; k++) {
        const c = bytes[i + k];
        if ((c & 0xc0) !== 0x80) {
          ok = false;
        } else {
          cp = (cp << 6) | (c & 0x3f);
        }
      }
      // Reject overlong forms, surrogates and values beyond U+10FFFF.
      if (ok && ((need === 2 && cp < 0x800) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff))) {
        ok = false;
      }
    }
    if (!ok) {
      if (strict) {
        return null;
      }
      out += '�';
      i++;
    } else {
      if (cp >= 0x10000) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else {
        out += String.fromCharCode(cp);
      }
      i += need + 1;
    }
    if (out.length > 4096) {
      parts.push(out);
      out = '';
    }
  }
  parts.push(out);
  return parts.join('');
}

const MOJIBAKE_RE = /[Â-ô][\u0080-¿]/;

/**
 * Repairs double-encoded UTF-8 ("CafÃ©" becomes "Café"): a string whose characters are all
 * below U+0100 and that contains UTF-8 lead/continuation pairs is reinterpreted as UTF-8 bytes.
 * Returned unchanged when that reinterpretation is not valid UTF-8.
 */
export function repairMojibake(s: string): string {
  if (!MOJIBAKE_RE.test(s)) {
    return s;
  }
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) {
      return s;
    }
    bytes.push(c);
  }
  const fixed = utf8Decode(bytes, true);
  return fixed === null ? s : fixed;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: number[] = (function () {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) { t.push(-1); }
  for (let j = 0; j < B64.length; j++) { t[B64.charCodeAt(j)] = j; }
  t['-'.charCodeAt(0)] = 62; // base64url alphabet
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** Decodes base64 (standard or URL alphabet, padding optional) to bytes; null when malformed or too big. */
export function base64Decode(s: string, maxBytes: number): number[] | null {
  if (typeof s !== 'string') {
    return null;
  }
  const clean = s.replace(/[\s=]+/g, '');
  if (clean.length % 4 === 1 || Math.floor((clean.length * 3) / 4) > maxBytes) {
    return null;
  }
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 256 ? B64_INDEX[c] : -1;
    if (v < 0) {
      return null;
    }
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

/** Base64 text as sent by Xtream EPG endpoints, decoded as UTF-8 and cleaned; '' when malformed. */
export function decodeBase64Text(s: unknown, maxChars: number): string {
  if (typeof s !== 'string' || s.length === 0) {
    return '';
  }
  const bytes = base64Decode(s, maxChars * 4);
  if (bytes === null) {
    return '';
  }
  return cleanText(utf8Decode(bytes) || '', maxChars);
}

/** Integer from a number or numeric string (Xtream sends both); null otherwise. */
export function toInt(v: unknown): number | null {
  if (typeof v === 'number') {
    return isFinite(v) ? Math.floor(v) : null;
  }
  if (typeof v === 'string' && /^\s*-?\d{1,15}\s*$/.test(v)) {
    return parseInt(v, 10);
  }
  return null;
}

/** Id from a string or number; null for anything else, empty, too long or containing whitespace/control characters. */
export function toId(v: unknown, max: number): string | null {
  let s: string;
  if (typeof v === 'number' && isFinite(v)) {
    s = String(Math.floor(v));
  } else if (typeof v === 'string') {
    s = v.replace(/^\s+|\s+$/g, '');
  } else {
    return null;
  }
  if (s.length === 0 || s.length > max || /[\u0000-\u001f\u007f\s]/.test(s)) {
    return null;
  }
  return s;
}

/** Truthy flags as Xtream sends them: 1, "1", true, "true". */
export function toFlag(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true';
}
