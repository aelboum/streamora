// Dedicated network client for AI providers (AI-02). Deliberately separate from http-client.ts,
// which stays the only client for playlists, EPG and stream metadata and never sends headers.
//
// Rules (docs/AI-02-REPORT.md, Security):
//   1. Only https URLs whose origin is on the allow-list given at creation (Gemini:
//      https://generativelanguage.googleapis.com). Anything else is refused before a request is made.
//   2. The API key travels only in a request header supplied by the caller. A URL that carries a
//      `key=` query parameter or userinfo is refused, so the key can never end up in a URL, a log
//      line or a redirect target. withCredentials is always false (no cookies).
//   3. Redirects: as soon as headers arrive the final URL (responseURL) is checked; a request that
//      ended on another origin is aborted and its body discarded ('redirect-blocked').
//   4. Nothing is logged here. Results carry a kind and an HTTP status only, plus the parsed JSON
//      body (providers map their own error bodies; callers must not log bodies either).
//   5. Every request settles exactly once: own timeout timer (XHR timeout support on Tizen 3.0 is
//      unverified), response size cap, abort() supported.
// A CORS refusal or a TLS failure on old WebViews both surface as status 0 → 'network'.
import { originOf } from './url.ts';
import type { XhrLike } from '../app/platform/platform.ts';

export type AiHttpErrorKind = 'invalid-url' | 'unavailable' | 'timeout' | 'aborted' | 'network' | 'http' | 'parse' | 'too-large' | 'redirect-blocked';

export interface AiHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  /** Extra request headers (e.g. the provider's API-key header). Content-Type is set for bodies. */
  headers?: Record<string, string>;
  /** JSON-serialisable request body (POST only). */
  body?: unknown;
  timeoutMs: number;
  /** Largest accepted response, in characters. */
  maxChars: number;
}

export type AiHttpResult =
  | { ok: true; status: number; json: unknown; retryAfterMs: number }
  | { ok: false; kind: AiHttpErrorKind; status: number; json: unknown; retryAfterMs: number };

export interface AiHttpHandle {
  promise: Promise<AiHttpResult>;
  abort(): void;
}

export interface AiHttpClient {
  request(r: AiHttpRequest): AiHttpHandle;
}

export interface AiHttpDeps {
  xhrFactory: (() => XhrLike) | null;
  /** Exact origins (scheme://host[:port]) that may be contacted. Must be https. */
  allowedOrigins: string[];
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** True when the URL is https, on the allow-list, has no userinfo and no `key=` query parameter. */
export function aiUrlAllowed(url: string, allowedOrigins: string[]): boolean {
  if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\//i.test(url)) {
    return false;
  }
  if (/^https:\/\/[^\/?#]*@/i.test(url) || /[?&]key=/i.test(url)) {
    return false;
  }
  const o = originOf(url);
  return !!o && allowedOrigins.indexOf(o) >= 0;
}

/** Retry-After header in seconds → ms (0 when absent or unreadable; CORS may hide the header). */
function retryAfter(x: XhrLike): number {
  try {
    const v = x.getResponseHeader ? x.getResponseHeader('Retry-After') : null;
    const n = v ? parseInt(v, 10) : NaN;
    return isFinite(n) && n > 0 ? Math.min(n, 3600) * 1000 : 0;
  } catch (e) {
    return 0;
  }
}

export function createAiHttpClient(d: AiHttpDeps): AiHttpClient {
  const allowed: string[] = [];
  for (let i = 0; i < d.allowedOrigins.length; i++) {
    const o = originOf(d.allowedOrigins[i]);
    if (o && /^https:\/\//i.test(o)) { allowed.push(o); }
  }

  return {
    request: function (r: AiHttpRequest): AiHttpHandle {
      let settle: (res: AiHttpResult) => void = function () { /* replaced below */ };
      const promise = new Promise<AiHttpResult>(function (resolve) { settle = resolve; });
      let done = false;
      let timer: unknown = null;
      let x: XhrLike | null = null;

      function finish(res: AiHttpResult): void {
        if (done) { return; }
        done = true;
        if (timer !== null) { d.clearTimer(timer); timer = null; }
        if (x) {
          x.onreadystatechange = null; x.onload = null; x.onerror = null; x.ontimeout = null; x.onabort = null; x.onprogress = null;
        }
        settle(res);
      }
      function fail(kind: AiHttpErrorKind, status: number, json: unknown, retryMs: number): void {
        finish({ ok: false, kind: kind, status: status, json: json, retryAfterMs: retryMs });
      }
      function stop(): void {
        if (x) { try { x.abort(); } catch (e) { /* already closed */ } }
      }
      function refused(kind: AiHttpErrorKind): AiHttpHandle {
        fail(kind, 0, null, 0);
        return { promise: promise, abort: function () { /* nothing started */ } };
      }

      if (!aiUrlAllowed(r.url, allowed) || (r.method !== 'GET' && r.method !== 'POST') || (r.method === 'GET' && r.body !== undefined)) {
        return refused('invalid-url');
      }
      const headers = r.headers || {};
      for (const k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && (!HEADER_NAME.test(k) || typeof headers[k] !== 'string' || /[\r\n]/.test(headers[k]))) {
          return refused('invalid-url');
        }
      }
      let body: string | null = null;
      if (r.method === 'POST') {
        try { body = JSON.stringify(r.body === undefined ? {} : r.body); } catch (e) { return refused('invalid-url'); }
      }
      if (!d.xhrFactory) {
        return refused('unavailable');
      }

      const origin = originOf(r.url);
      try {
        x = d.xhrFactory();
        const xx = x;
        xx.open(r.method, r.url, true);
        xx.withCredentials = false;
        for (const k in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, k)) { xx.setRequestHeader(k, headers[k]); }
        }
        if (body !== null) { xx.setRequestHeader('Content-Type', 'application/json'); }
        xx.onreadystatechange = function () {
          if (done) { return; }
          if (xx.readyState >= 2 && xx.responseURL && originOf(xx.responseURL) !== origin) {
            stop();
            fail('redirect-blocked', 0, null, 0);
            return;
          }
          if (xx.readyState === 3 && xx.responseText && xx.responseText.length > r.maxChars) {
            stop();
            fail('too-large', xx.status, null, 0);
            return;
          }
          if (xx.readyState !== 4) { return; }
          const status = xx.status;
          if (status === 0) { fail('network', 0, null, 0); return; }
          const text = xx.responseText || '';
          if (text.length > r.maxChars) { fail('too-large', status, null, 0); return; }
          let json: unknown = null;
          let parsed = true;
          if (text) {
            try { json = JSON.parse(text); } catch (e) { parsed = false; }
          }
          const ra = retryAfter(xx);
          if (status >= 200 && status < 300) {
            if (!parsed) { fail('parse', status, null, 0); return; }
            finish({ ok: true, status: status, json: json, retryAfterMs: 0 });
          } else {
            fail('http', status, parsed ? json : null, ra);
          }
        };
        xx.onerror = function () { fail('network', 0, null, 0); };
        xx.ontimeout = function () { fail('timeout', 0, null, 0); };
        xx.onabort = function () { fail('aborted', 0, null, 0); };
        timer = d.setTimer(function () {
          timer = null;
          if (!done) { stop(); fail('timeout', 0, null, 0); }
        }, Math.max(1000, r.timeoutMs));
        xx.send(body);
      } catch (e) {
        fail('network', 0, null, 0);
      }
      return {
        promise: promise,
        abort: function () { if (!done) { stop(); fail('aborted', 0, null, 0); } }
      };
    }
  };
}
