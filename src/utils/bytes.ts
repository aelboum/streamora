// Small byte helpers (no TextEncoder: it is unverified on the TV).

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return s;
}

/** Returns null for malformed input. */
export function fromHex(hex: string): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** ASCII-only encoding (PINs are digits). Throws on non-ASCII input. */
export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127) {
      throw new Error('non-ASCII input');
    }
    out[i] = c;
  }
  return out;
}

/**
 * Compares two byte arrays in time that depends only on their lengths, not their contents.
 * (JavaScript engines give no hard guarantee; this avoids early exit, which is the practical leak.)
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (i < a.length ? a[i] : 0) ^ (i < b.length ? b[i] : 0);
  }
  return diff === 0;
}

/** FNV-1a 32-bit over UTF-16 code units, as 8 hex characters. Integrity check only, not security. */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const hex = (h >>> 0).toString(16);
  return '00000000'.substring(hex.length) + hex;
}
