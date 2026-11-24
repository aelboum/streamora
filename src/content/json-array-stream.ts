// Incremental reader for a top-level JSON array (Xtream get_live_streams can be tens of MB).
// Each element is cut out of the text as it completes and parsed on its own with JSON.parse, so
// the full object graph of the response never exists in memory at once; callers turn each
// element into a compact record immediately.
//
// Only the unfinished current element is buffered between chunks. Inside strings the scan jumps
// with indexOf('"') (native), so long string values cost little.
// A response that is not an array (for example an Xtream error object) is captured, up to
// 64 KB, so the caller can inspect it.

export type JsonArrayVerdict = 'array' | 'not-array' | 'empty' | 'truncated' | 'too-large';

export interface JsonArraySummary {
  verdict: JsonArrayVerdict;
  elements: number;
  /** Elements that were not valid JSON (skipped). */
  invalid: number;
  /** Start of a non-array response (at most 64 KB), otherwise ''. */
  prefix: string;
  /** maxElements reached. */
  capped: boolean;
}

export interface JsonArrayStreamOptions {
  /** Largest single element (characters). Default 1,000,000. */
  maxElementChars?: number;
  maxElements?: number;
}

export interface JsonArrayStream {
  /** Returns false once reading has stopped (end of array, cap, oversized element). */
  push(text: string): boolean;
  end(): JsonArraySummary;
}

const BEFORE = 0;
const BETWEEN = 1;
const IN_ELEM = 2;
const DONE = 3;
const NOT_ARRAY = 4;
const PREFIX_MAX = 65536;

function isWs(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '﻿';
}

export function createJsonArrayStream(onElement: (value: unknown) => void, options?: JsonArrayStreamOptions): JsonArrayStream {
  const maxElem = (options && options.maxElementChars) || 1000000;
  const maxElements = (options && options.maxElements) || 1000000;
  const sum: JsonArraySummary = { verdict: 'empty', elements: 0, invalid: 0, prefix: '', capped: false };
  let state = BEFORE;
  let s = '';
  let pos = 0;
  let elemStart = 0;
  let depth = 0;
  let inStr = false;
  let stopped = false;

  function complete(end: number): void {
    const t = s.substring(elemStart, end);
    let v: unknown;
    let ok = true;
    try {
      v = JSON.parse(t);
    } catch (e) {
      ok = false;
    }
    if (ok) {
      sum.elements++;
      onElement(v);
      if (sum.elements >= maxElements) {
        sum.capped = true;
        sum.verdict = 'truncated';
        stopped = true;
      }
    } else {
      sum.invalid++;
    }
    state = BETWEEN;
    pos = end;
  }

  function scan(): void {
    while (pos < s.length && !stopped) {
      if (state === BEFORE) {
        const c = s.charAt(pos);
        if (isWs(c)) { pos++; continue; }
        if (c === '[') { state = BETWEEN; pos++; continue; }
        state = NOT_ARRAY;
        sum.verdict = 'not-array';
        sum.prefix = s.substring(pos, pos + PREFIX_MAX);
        pos = s.length;
        if (sum.prefix.length >= PREFIX_MAX) { stopped = true; }
        return;
      }
      if (state === NOT_ARRAY) {
        sum.prefix += s.substring(pos, pos + PREFIX_MAX - sum.prefix.length);
        pos = s.length;
        if (sum.prefix.length >= PREFIX_MAX) { stopped = true; }
        return;
      }
      if (state === BETWEEN) {
        const c = s.charAt(pos);
        if (isWs(c) || c === ',') { pos++; continue; }
        if (c === ']') { state = DONE; sum.verdict = 'array'; stopped = true; pos++; return; }
        state = IN_ELEM;
        elemStart = pos;
        depth = 0;
        inStr = false;
        continue;
      }
      // IN_ELEM
      if (inStr) {
        const q = s.indexOf('"', pos);
        if (q < 0) { pos = s.length; return; }
        let k = q - 1;
        let slashes = 0;
        while (k >= elemStart && s.charCodeAt(k) === 92) { slashes++; k--; }
        pos = q + 1;
        if (slashes % 2 === 1) { continue; } // escaped quote
        inStr = false;
        if (depth === 0) { complete(pos); }
        continue;
      }
      const c = s.charAt(pos);
      if (c === '"') { inStr = true; pos++; continue; }
      if (c === '{' || c === '[') { depth++; pos++; continue; }
      if (c === '}' || c === ']') {
        if (depth === 0) {
          if (pos === elemStart) {
            // Stray closer where a value should start: ']' ends the array, '}' is skipped as invalid.
            state = BETWEEN;
            if (c === '}') { sum.invalid++; pos++; }
            continue;
          }
          complete(pos); // primitive element ended by the array's ']'
          continue;
        }
        depth--;
        pos++;
        if (depth === 0) { complete(pos); }
        continue;
      }
      if (c === ',' && depth === 0) { complete(pos); continue; }
      pos++;
    }
  }

  return {
    push: function (chunk) {
      if (stopped) {
        return false;
      }
      s = s + chunk;
      scan();
      if (state === IN_ELEM) {
        s = s.substring(elemStart);
        pos -= elemStart;
        elemStart = 0;
        if (s.length > maxElem) {
          sum.verdict = 'too-large';
          stopped = true;
          s = '';
        }
      } else {
        s = s.substring(pos);
        pos = 0;
      }
      return !stopped;
    },
    end: function () {
      if (!stopped) {
        if (state === IN_ELEM && !inStr && depth === 0 && s.length > 0) {
          // "[1,2" without the closing bracket: last primitive is incomplete data.
          sum.verdict = 'truncated';
        } else if (state === IN_ELEM || state === BETWEEN) {
          sum.verdict = 'truncated';
        } else if (state === BEFORE) {
          sum.verdict = 'empty';
        }
        stopped = true;
      }
      s = '';
      return sum;
    }
  };
}
