// Streaming gzip (RFC 1952) / DEFLATE (RFC 1951) decoder with UTF-8 text output, for compressed
// XMLTV guides (Stage 5.1). Pure: no DOM, no network, no dependencies.
//
// Why this exists: Tizen 3.0 has no DecompressionStream and no streaming fetch. The guide arrives
// through XHR as a "binary string" (overrideMimeType 'text/plain; charset=x-user-defined': each
// character's low 8 bits are one byte), delivered progressively. This decoder takes those pieces
// in order and returns the decoded text produced so far, so the XMLTV parser consumes the guide
// piece by piece and the decompressed guide is never held in memory as a whole.
//
// Memory: 32 KiB window + 32 KiB output buffer + the unconsumed input tail (at most one block
// header normally) + the text of one push (bounded by the caller's piece size × the compression
// ratio). maxOutputBytes stops decoding with 'too-large' (decompression-bomb protection).
// Integrity: invalid codes, distances beyond the data, bad stored lengths → 'bad-data'; CRC-32 and
// ISIZE of every member are verified → 'checksum'; input ending early → 'truncated'.
// Multi-member files (concatenated gzip streams) are decoded in order; bytes after a complete
// member that are not another gzip member (zero padding, junk) are ignored, as gzip(1) does.
//
// The inflater resumes at symbol granularity: when input runs out in the middle of a symbol, a
// block header or the gzip header/trailer, the read position rolls back to the start of that unit
// and decoding continues when more input arrives.

export type GzipErrorCode = 'bad-header' | 'bad-data' | 'truncated' | 'checksum' | 'too-large' | 'empty';

export interface ByteTextDecoder {
  /** Bytes as a binary string (low 8 bits of each char). Returns the text decoded so far ('' when none or after an error). */
  push(bytes: string): string;
  /** End of input. Returns the remaining text; sets 'truncated' when the gzip data is incomplete, 'empty' when nothing arrived. */
  end(): string;
  error(): GzipErrorCode | null;
  /** null until the first two bytes have arrived; then whether the data is gzip. */
  compressed(): boolean | null;
  /** Decoded bytes so far (before UTF-8 decoding). */
  outputBytes(): number;
}

export interface ByteTextDecoderOptions {
  /** Hard limit on decoded bytes. */
  maxOutputBytes: number;
}

// ------------------------------------------------------------------ tables

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FAST_BITS = 10;
const FAST_SIZE = 1 << FAST_BITS;

/** Canonical Huffman code: a FAST_BITS lookup table plus counts/symbols for longer codes. */
interface Huffman {
  /** (symbol << 4) | length for codes up to FAST_BITS long; 0 = longer code or unused (slow path). */
  fast: Uint16Array;
  counts: Uint16Array;
  symbols: Uint16Array;
}

/** Builds a code from lengths; null when over-subscribed (invalid). Incomplete codes are accepted. */
function buildHuffman(lengths: Uint8Array, n: number): Huffman | null {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) {
    counts[lengths[i]]++;
  }
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) {
      return null;
    }
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) {
    offs[len + 1] = offs[len] + counts[len];
  }
  const symbols = new Uint16Array(n);
  for (let s = 0; s < n; s++) {
    if (lengths[s] !== 0) {
      symbols[offs[lengths[s]]++] = s;
    }
  }
  const fast = new Uint16Array(FAST_SIZE);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 15; len++) {
    for (let c = 0; c < counts[len]; c++) {
      const sym = symbols[k++];
      if (len <= FAST_BITS) {
        // The canonical code is MSB first; the stream is read LSB first.
        let rev = 0;
        for (let b = 0; b < len; b++) {
          rev |= ((code >> b) & 1) << (len - 1 - b);
        }
        for (let idx = rev; idx < FAST_SIZE; idx += 1 << len) {
          fast[idx] = (sym << 4) | len;
        }
      }
      code++;
    }
    code <<= 1;
  }
  return { fast: fast, counts: counts, symbols: symbols };
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): void {
  if (fixedLit) {
    return;
  }
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) { l[i] = 8; }
  for (let i = 144; i < 256; i++) { l[i] = 9; }
  for (let i = 256; i < 280; i++) { l[i] = 7; }
  for (let i = 280; i < 288; i++) { l[i] = 8; }
  fixedLit = buildHuffman(l, 288);
  const d = new Uint8Array(30);
  for (let i = 0; i < 30; i++) { d[i] = 5; }
  fixedDist = buildHuffman(d, 30);
}

let crcTable: Int32Array | null = null;

function crcTab(): Int32Array {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c;
    }
  }
  return crcTable;
}

// ------------------------------------------------------------------ UTF-8

interface Utf8 {
  write(b: Uint8Array, from: number, to: number): string;
  flush(): string;
}

/** Streaming UTF-8 → string; invalid sequences become U+FFFD; an incomplete tail waits for more bytes. */
function createUtf8(): Utf8 {
  let pend = 0;      // code point bits collected so far
  let need = 0;      // continuation bytes still expected
  let min = 0;       // smallest valid code point for the current sequence length
  const units: number[] = [];
  let out = '';

  function emit(cp: number): void {
    if (cp > 0xffff) {
      cp -= 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      units.push(cp);
    }
    if (units.length >= 8192) {
      out += String.fromCharCode.apply(null, units);
      units.length = 0;
    }
  }
  function take(): string {
    if (units.length) {
      out += String.fromCharCode.apply(null, units);
      units.length = 0;
    }
    const s = out;
    out = '';
    return s;
  }

  return {
    write: function (b, from, to) {
      for (let i = from; i < to; i++) {
        const c = b[i];
        if (need > 0) {
          if ((c & 0xc0) === 0x80) {
            pend = (pend << 6) | (c & 0x3f);
            if (--need === 0) {
              emit(pend < min || pend > 0x10ffff || (pend >= 0xd800 && pend <= 0xdfff) ? 0xfffd : pend);
            }
            continue;
          }
          need = 0;
          emit(0xfffd); // sequence cut short; this byte starts something new
        }
        if (c < 0x80) {
          emit(c);
        } else if ((c & 0xe0) === 0xc0) {
          pend = c & 0x1f; need = 1; min = 0x80;
        } else if ((c & 0xf0) === 0xe0) {
          pend = c & 0x0f; need = 2; min = 0x800;
        } else if ((c & 0xf8) === 0xf0) {
          pend = c & 0x07; need = 3; min = 0x10000;
        } else {
          emit(0xfffd);
        }
      }
      return take();
    },
    flush: function () {
      if (need > 0) {
        need = 0;
        emit(0xfffd);
      }
      return take();
    }
  };
}

// ------------------------------------------------------------------ decoder

type Stage = 'sniff' | 'plain' | 'header' | 'block' | 'stored' | 'codes' | 'trailer' | 'member-end' | 'done' | 'failed';

/** Thrown internally when input runs out in the middle of a unit; never escapes this module. */
const NEED = { need: true };

export function createByteTextDecoder(o: ByteTextDecoderOptions): ByteTextDecoder {
  const maxOut = o.maxOutputBytes;
  let inBuf = new Uint8Array(65536);
  let inLen = 0;
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let stage: Stage = 'sniff';
  let err: GzipErrorCode | null = null;
  let gz: boolean | null = null;
  let sawInput = false;

  const win = new Uint8Array(32768);
  let wpos = 0;
  let memberOut = 0;      // bytes output in the current member (window fill and ISIZE)
  let totalOut = 0;
  let crc = -1;
  let finalBlock = false;
  let storedLeft = 0;
  let lit: Huffman | null = null;
  let dist: Huffman | null = null;

  const OUT_SIZE = 32768;
  const outBuf = new Uint8Array(OUT_SIZE + 300);
  let outLen = 0;
  const utf8 = createUtf8();
  let text = '';

  function fail(code: GzipErrorCode): void {
    if (!err) {
      err = code;
    }
    stage = 'failed';
  }

  function flushOut(): void {
    if (outLen === 0) {
      return;
    }
    const t = crcTab();
    let c = crc;
    for (let i = 0; i < outLen; i++) {
      c = t[(c ^ outBuf[i]) & 0xff] ^ (c >>> 8);
    }
    crc = c;
    text += utf8.write(outBuf, 0, outLen);
    outLen = 0;
  }

  function put(b: number): void {
    win[wpos] = b;
    wpos = (wpos + 1) & 32767;
    outBuf[outLen++] = b;
    memberOut++;
    totalOut++;
  }

  function append(bytes: string): void {
    const n = bytes.length;
    if (pos > 0 && (pos >= 32768 || inLen + n > inBuf.length)) {
      inBuf.set(inBuf.subarray(pos, inLen), 0);
      inLen -= pos;
      pos = 0;
    }
    if (inLen + n > inBuf.length) {
      let size = inBuf.length;
      while (size < inLen + n) { size *= 2; }
      const bigger = new Uint8Array(size);
      bigger.set(inBuf.subarray(0, inLen), 0);
      inBuf = bigger;
    }
    for (let i = 0; i < n; i++) {
      inBuf[inLen++] = bytes.charCodeAt(i) & 0xff;
    }
  }

  // ---- bit reader, LSB first. need() pulls whole bytes; bitBuf stays below 24 bits.
  function need(n: number): boolean {
    while (bitCnt < n) {
      if (pos >= inLen) {
        return false;
      }
      bitBuf |= inBuf[pos++] << bitCnt;
      bitCnt += 8;
    }
    return true;
  }
  function bits(n: number): number {
    if (!need(n)) {
      throw NEED;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  }
  function byte(): number {
    return bits(8);
  }
  function decodeSym(h: Huffman): number {
    need(FAST_BITS); // as many bits as are available, up to FAST_BITS
    const e = h.fast[bitBuf & (FAST_SIZE - 1)];
    if (e !== 0) {
      const len = e & 15;
      if (len > bitCnt) {
        throw NEED;
      }
      bitBuf >>>= len;
      bitCnt -= len;
      return e >> 4;
    }
    // Slow path (codes longer than FAST_BITS, or an unused code): canonical decode bit by bit.
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - first < count) {
        return h.symbols[index + code - first];
      }
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    fail('bad-data');
    return -1;
  }

  function mark(): number[] { return [pos, bitBuf, bitCnt]; }
  function rollback(m: number[]): void { pos = m[0]; bitBuf = m[1]; bitCnt = m[2]; }
  function byteAlign(): void {
    const drop = bitCnt & 7;
    bitBuf >>>= drop;
    bitCnt -= drop;
  }

  function readHeader(): boolean {
    const m = mark();
    try {
      if (byte() !== 0x1f || byte() !== 0x8b || byte() !== 8) {
        fail('bad-header'); // not gzip, or not DEFLATE
        return false;
      }
      const flg = byte();
      if (flg & 0xe0) {
        fail('bad-header'); // reserved flags
        return false;
      }
      for (let i = 0; i < 6; i++) { byte(); } // MTIME, XFL, OS
      if (flg & 4) {
        const xlen = byte() | (byte() << 8);
        for (let i = 0; i < xlen; i++) { byte(); }
      }
      let n = 0;
      if (flg & 8) {
        while (byte() !== 0) { if (++n > 65536) { fail('bad-header'); return false; } }
      }
      if (flg & 16) {
        while (byte() !== 0) { if (++n > 131072) { fail('bad-header'); return false; } }
      }
      if (flg & 2) { byte(); byte(); }
    } catch (e) {
      if (e !== NEED) { throw e; }
      rollback(m);
      return false;
    }
    crc = -1;
    memberOut = 0;
    finalBlock = false;
    stage = 'block';
    return true;
  }

  function readBlockHeader(): boolean {
    const m = mark();
    try {
      finalBlock = bits(1) === 1;
      const type = bits(2);
      if (type === 0) {
        byteAlign();
        const len = byte() | (byte() << 8);
        const nlen = byte() | (byte() << 8);
        if ((len ^ 0xffff) !== nlen) {
          fail('bad-data');
          return false;
        }
        storedLeft = len;
        stage = 'stored';
        return true;
      }
      if (type === 1) {
        fixedTables();
        lit = fixedLit;
        dist = fixedDist;
        stage = 'codes';
        return true;
      }
      if (type === 3) {
        fail('bad-data');
        return false;
      }
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      if (hlit > 286 || hdist > 30) {
        fail('bad-data');
        return false;
      }
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) {
        cl[CL_ORDER[i]] = bits(3);
      }
      const clh = buildHuffman(cl, 19);
      if (!clh) {
        fail('bad-data');
        return false;
      }
      const total = hlit + hdist;
      const lens = new Uint8Array(total);
      let i = 0;
      while (i < total) {
        const sym = decodeSym(clh);
        if (sym < 0) {
          return false;
        }
        if (sym < 16) {
          lens[i++] = sym;
          continue;
        }
        let rep = 0;
        let val = 0;
        if (sym === 16) {
          if (i === 0) { fail('bad-data'); return false; }
          val = lens[i - 1];
          rep = 3 + bits(2);
        } else if (sym === 17) {
          rep = 3 + bits(3);
        } else {
          rep = 11 + bits(7);
        }
        if (i + rep > total) {
          fail('bad-data');
          return false;
        }
        while (rep-- > 0) { lens[i++] = val; }
      }
      if (lens[256] === 0) {
        fail('bad-data'); // no end-of-block code
        return false;
      }
      const l = buildHuffman(lens.subarray(0, hlit), hlit);
      const d = buildHuffman(lens.subarray(hlit), hdist);
      if (!l || !d) {
        fail('bad-data');
        return false;
      }
      lit = l;
      dist = d;
      stage = 'codes';
      return true;
    } catch (e) {
      if (e !== NEED) { throw e; }
      rollback(m);
      return false;
    }
  }

  function endOfBlock(): void {
    if (finalBlock) {
      byteAlign();
      stage = 'trailer';
    } else {
      stage = 'block';
    }
  }

  /** Decodes symbols until input runs out, the block ends, or the output buffer is full. */
  function codes(): boolean {
    const l = lit as Huffman;
    const d = dist as Huffman;
    while (outLen < OUT_SIZE) {
      const m = mark();
      try {
        const sym = decodeSym(l);
        if (sym < 0) {
          return false;
        }
        if (sym < 256) {
          put(sym);
          continue;
        }
        if (sym === 256) {
          endOfBlock();
          return true;
        }
        const li = sym - 257;
        if (li >= 29) {
          fail('bad-data');
          return false;
        }
        const len = LEN_BASE[li] + (LEN_EXTRA[li] ? bits(LEN_EXTRA[li]) : 0);
        const ds = decodeSym(d);
        if (ds < 0) {
          return false;
        }
        if (ds >= 30) {
          fail('bad-data');
          return false;
        }
        const dd = DIST_BASE[ds] + (DIST_EXTRA[ds] ? bits(DIST_EXTRA[ds]) : 0);
        if (dd > memberOut) {
          fail('bad-data'); // reaches before the start of the data
          return false;
        }
        for (let k = 0; k < len; k++) {
          put(win[(wpos - dd) & 32767]);
        }
      } catch (e) {
        if (e !== NEED) { throw e; }
        rollback(m);
        return false;
      }
    }
    return true;
  }

  function stored(): boolean {
    // Byte-aligned: whole bytes still in the bit buffer come first.
    while (storedLeft > 0 && outLen < OUT_SIZE) {
      if (bitCnt >= 8) {
        put(bitBuf & 0xff);
        bitBuf >>>= 8;
        bitCnt -= 8;
      } else if (pos < inLen) {
        put(inBuf[pos++]);
      } else {
        return false;
      }
      storedLeft--;
    }
    if (storedLeft === 0) {
      endOfBlock();
    }
    return true;
  }

  function trailer(): boolean {
    const m = mark();
    let c = 0;
    let size = 0;
    try {
      c = (byte() | (byte() << 8) | (byte() << 16) | (byte() << 24)) | 0;
      size = (byte() | (byte() << 8) | (byte() << 16) | (byte() << 24)) >>> 0;
    } catch (e) {
      if (e !== NEED) { throw e; }
      rollback(m);
      return false;
    }
    flushOut();
    if (c !== ((crc ^ -1) | 0) || size !== memberOut % 4294967296) {
      fail('checksum');
      return false;
    }
    stage = 'member-end';
    return true;
  }

  function memberEnd(): boolean {
    // Another member follows only when the next two bytes are the gzip magic.
    byteAlign();
    if (!need(16)) {
      return false; // fewer than two bytes so far; end() treats that as the end of the data
    }
    if ((bitBuf & 0xffff) === 0x8b1f) {
      stage = 'header';
      return true;
    }
    stage = 'done';
    return false;
  }

  function run(): void {
    let progress = true;
    while (progress && !err) {
      if (totalOut > maxOut) {
        fail('too-large');
        break;
      }
      switch (stage) {
        case 'header': progress = readHeader(); break;
        case 'block': progress = readBlockHeader(); break;
        case 'codes': progress = codes(); break;
        case 'stored': progress = stored(); break;
        case 'trailer': progress = trailer(); break;
        case 'member-end': progress = memberEnd(); break;
        default: progress = false;
      }
      if (outLen >= OUT_SIZE) {
        flushOut();
      }
    }
    if (!err) {
      flushOut();
      if (totalOut > maxOut) {
        fail('too-large');
      }
    }
  }

  function take(): string {
    const t = text;
    text = '';
    return err ? '' : t;
  }

  function plain(): string {
    const t = utf8.write(inBuf, pos, inLen);
    pos = inLen;
    return t;
  }

  return {
    push: function (bytes) {
      if (err || stage === 'done' || bytes.length === 0) {
        return '';
      }
      sawInput = true;
      append(bytes);
      if (stage === 'sniff') {
        if (inLen - pos < 2) {
          return '';
        }
        gz = inBuf[pos] === 0x1f && inBuf[pos + 1] === 0x8b;
        // Not gzip: a .gz URL served uncompressed, or already decoded by the browser because of
        // Content-Encoding. Treated as plain UTF-8 text.
        stage = gz ? 'header' : 'plain';
      }
      if (stage === 'plain') {
        totalOut += inLen - pos;
        if (totalOut > maxOut) {
          fail('too-large');
          return '';
        }
        return plain();
      }
      run();
      return take();
    },
    end: function () {
      if (err) {
        return '';
      }
      if (!sawInput) {
        fail('empty');
        return '';
      }
      if (stage === 'sniff') {
        gz = false; // a single byte
        stage = 'plain';
        totalOut += inLen - pos;
        return plain() + utf8.flush();
      }
      if (stage === 'plain') {
        return utf8.flush();
      }
      run();
      if (!err && stage === 'member-end') {
        stage = 'done';
      }
      if (!err && stage !== 'done') {
        fail('truncated');
      }
      return err ? '' : take() + utf8.flush();
    },
    error: function () { return err; },
    compressed: function () { return gz; },
    outputBytes: function () { return totalOut; }
  };
}

/**
 * True when text-mode data starts like gzip: the first byte 0x1f (the gzip magic's first byte) can
 * never start an XML document, and the second byte (0x8b) is usually lost to text decoding.
 */
export function startsLikeGzip(firstText: string): boolean {
  return firstText.charCodeAt(0) === 0x1f;
}

/** URL path ends in .gz / .gzip (query string and fragment ignored). */
export function gzipByName(url: string): boolean {
  const q = url.search(/[?#]/);
  const path = (q >= 0 ? url.substring(0, q) : url).toLowerCase();
  return /\.(gz|gzip)$/.test(path);
}
