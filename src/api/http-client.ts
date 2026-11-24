// The only network layer (ARCHITECTURE.md rev 3 §6, decision D4).
// XMLHttpRequest only: fetch fails for packaged files on the TV and is untested remotely, and
// AbortController does not exist on Tizen 3.0. Requests never reject; every request settles
// exactly once with an HttpResult.
//
// Redirect security (SECURITY-DECISIONS.md S5). XHR follows redirects inside the engine and
// offers no hook to approve a redirect before it is followed, so pre-send validation cannot be
// enforced on Tizen 3.0. The client therefore:
//   1. never sends credentials in headers or cookies (no setRequestHeader, withCredentials = false),
//      so nothing the client adds can be forwarded to a redirect target;
//   2. requires every credential-bearing URL to declare its credential origin, which must equal the
//      request origin;
//   3. inspects the final URL (responseURL) as soon as headers arrive and aborts, discarding the
//      body, if a credentialed request ended anywhere but its credential origin, or if any request
//      ended on a URL the policy rejects;
//   4. callers build every follow-up credentialed URL from the configured origin, never from a
//      response URL.
// If the engine does not expose responseURL [A], the redirect state is reported as 'unknown'.
import { checkUrl, originOf } from './url.ts';
import type { UrlCheck, UrlPolicy } from './url.ts';
import { redactString } from '../utils/redact.ts';
import type { XhrLike } from '../app/platform/platform.ts';

export type { XhrLike };

export type HttpErrorKind = 'invalid-url' | 'timeout' | 'aborted' | 'network' | 'http' | 'parse' | 'too-large' | 'redirect-blocked';

export interface HttpError {
  kind: HttpErrorKind;
  /** HTTP status when one was received, otherwise 0. */
  status: number;
  message: string;
  /** True for failures a retry may fix (network, timeout, 408, 429, 5xx). */
  retryable: boolean;
}

/** 'none' = final URL equals the request URL; 'same-origin'/'cross-origin' = redirected; 'unknown' = engine lacks responseURL. */
export type RedirectState = 'none' | 'same-origin' | 'cross-origin' | 'unknown';

export type HttpResult<T> =
  | { ok: true; status: number; data: T; redirect: RedirectState }
  | { ok: false; error: HttpError };

export interface RequestOptions {
  url: string;
  policy: UrlPolicy;
  responseType: 'json' | 'text';
  /** Total time limit. Default 15 000 ms, clamped to 1..120 000. */
  timeoutMs?: number;
  /** Maximum response size in characters. Default 2 000 000. */
  maxChars?: number;
  /** Required when the URL carries credentials: the only origin allowed to answer. */
  credentialOrigin?: string;
}

export interface StreamOptions {
  url: string;
  policy: UrlPolicy;
  credentialOrigin?: string;
  /** Maximum response size in characters (hard cap; the download is aborted beyond it). */
  maxChars: number;
  /** No progress for this long fails with 'timeout'. Default 20 000 ms. */
  idleTimeoutMs?: number;
  /** Whole-download limit. Default 300 000 ms. */
  totalTimeoutMs?: number;
  /** Receives each newly arrived piece of text in order. Throwing aborts with 'parse'. */
  onChunk(text: string): void;
  /**
   * Binary download: the body is delivered as a binary string (each character's low 8 bits are one
   * byte; XHR overrideMimeType 'text/plain; charset=x-user-defined'). maxChars then counts bytes.
   * Fails with 'parse' when the engine cannot override the MIME type.
   */
  binary?: boolean;
  /** Called once with the Content-Type header (or '') when a successful status arrives. */
  onHeaders?(contentType: string): void;
}

export interface StreamSummary {
  chars: number;
  chunks: number;
}

export interface HttpHandle<T> {
  result: Promise<HttpResult<T>>;
  /** Cancels the request. The result settles with kind 'aborted' unless it already settled. */
  abort(): void;
}

export interface HttpClientOptions {
  xhrFactory: () => XhrLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface HttpClient {
  request<T>(opts: RequestOptions, validate?: (x: unknown) => x is T): HttpHandle<T>;
  stream(opts: StreamOptions): HttpHandle<StreamSummary>;
}

const DEFAULT_TIMEOUT = 15000;
const MAX_TIMEOUT = 120000;
const DEFAULT_MAX_CHARS = 2000000;
const DEFAULT_IDLE = 20000;
const DEFAULT_TOTAL = 300000;
const BACKSTOP_MS = 1000;
const HEADERS_RECEIVED = 2;

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function err(kind: HttpErrorKind, status: number, message: string): HttpError {
  const retryable = kind === 'network' || kind === 'timeout' || (kind === 'http' && isRetryableStatus(status));
  return { kind: kind, status: status, message: message, retryable: retryable };
}

/** True when the URL visibly carries credentials (query parameters, Xtream path, userinfo, opaque token). */
export function carriesCredentials(url: string): boolean {
  return redactString(url) !== url;
}

type Preflight = { ok: true; check: UrlCheck & { ok: true } } | { ok: false; error: HttpError };

function preflight(url: string, policy: UrlPolicy, credentialOrigin: string | undefined): Preflight {
  const check = checkUrl(url, policy);
  if (!check.ok) {
    return { ok: false, error: err('invalid-url', 0, check.reason) };
  }
  if (credentialOrigin !== undefined) {
    if (originOf(credentialOrigin + '/') !== check.origin) {
      return { ok: false, error: err('invalid-url', 0, 'credential origin does not match the request origin') };
    }
  } else if (carriesCredentials(check.href)) {
    return { ok: false, error: err('invalid-url', 0, 'credential-bearing URL without a declared credential origin') };
  }
  return { ok: true, check: check };
}

/** Classifies the final URL. Returns an error when the response must be discarded. */
function finalUrlCheck(x: XhrLike, requested: UrlCheck & { ok: true }, policy: UrlPolicy, credentialOrigin: string | undefined):
  { state: RedirectState; error?: HttpError } {
  const finalUrl = x.responseURL;
  if (typeof finalUrl !== 'string' || finalUrl === '') {
    return { state: 'unknown' };
  }
  if (finalUrl === requested.href) {
    return { state: 'none' };
  }
  const c = checkUrl(finalUrl, policy);
  if (!c.ok) {
    return { state: 'cross-origin', error: err('redirect-blocked', x.status, 'redirected to a disallowed URL: ' + c.reason) };
  }
  const state: RedirectState = c.origin === requested.origin ? 'same-origin' : 'cross-origin';
  if (credentialOrigin !== undefined && c.origin !== requested.origin) {
    return { state: state, error: err('redirect-blocked', x.status, 'credentialed request was redirected to another origin; response discarded') };
  }
  return { state: state };
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const makeXhr = options.xhrFactory;
  const setTimer = options.setTimer || function (fn: () => void, ms: number) { return setTimeout(fn, ms); };
  const clearTimer = options.clearTimer || function (h: unknown) { clearTimeout(h as number); };

  /** Shared request machinery: single settle, abort, timers, listener cleanup. */
  function base<T>() {
    let settle: (r: HttpResult<T>) => void = function () { /* replaced below */ };
    const result = new Promise<HttpResult<T>>(function (resolve) { settle = resolve; });
    const state = { done: false, xhr: null as XhrLike | null, timers: [] as unknown[] };
    function finish(r: HttpResult<T>, abortXhr?: boolean): void {
      if (state.done) {
        return;
      }
      state.done = true;
      for (let i = 0; i < state.timers.length; i++) {
        clearTimer(state.timers[i]);
      }
      state.timers = [];
      const x = state.xhr;
      state.xhr = null;
      if (x) {
        x.onreadystatechange = x.onprogress = x.onload = x.onerror = x.ontimeout = x.onabort = null;
        if (abortXhr) {
          try { x.abort(); } catch (e) { /* already finished */ }
        }
      }
      settle(r);
    }
    function fail(e: HttpError, abortXhr?: boolean): void {
      finish({ ok: false, error: e }, abortXhr);
    }
    const handle: HttpHandle<T> = {
      result: result,
      abort: function () { fail(err('aborted', 0, 'request aborted'), true); }
    };
    return { state: state, finish: finish, fail: fail, handle: handle };
  }

  function request<T>(opts: RequestOptions, validate?: (x: unknown) => x is T): HttpHandle<T> {
    const b = base<T>();
    const pre = preflight(opts.url, opts.policy, opts.credentialOrigin);
    if (!pre.ok) {
      b.fail(pre.error);
      return b.handle;
    }
    const requested = pre.check;
    const timeout = Math.max(1, Math.min(MAX_TIMEOUT, opts.timeoutMs || DEFAULT_TIMEOUT));
    const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
    let redirect: RedirectState = 'unknown';

    try {
      const x = makeXhr();
      b.state.xhr = x;
      x.open('GET', requested.href, true);
      x.timeout = timeout;
      x.withCredentials = false;
      x.onreadystatechange = function () {
        if (x.readyState >= HEADERS_RECEIVED && x.status > 0 && !b.state.done) {
          const f = finalUrlCheck(x, requested, opts.policy, opts.credentialOrigin);
          redirect = f.state;
          if (f.error) {
            b.fail(f.error, true);
          }
        }
      };
      x.onload = function () {
        const status = x.status;
        if (status === 0) {
          b.fail(err('network', 0, 'no response'));
          return;
        }
        const f = finalUrlCheck(x, requested, opts.policy, opts.credentialOrigin);
        redirect = f.state;
        if (f.error) {
          b.fail(f.error);
          return;
        }
        if (status < 200 || status > 299) {
          b.fail(err('http', status, 'HTTP ' + status));
          return;
        }
        const text = x.responseText || '';
        if (text.length > maxChars) {
          b.fail(err('too-large', status, 'response larger than ' + maxChars + ' characters'));
          return;
        }
        let data: unknown = text;
        if (opts.responseType === 'json') {
          try {
            data = JSON.parse(text);
          } catch (e) {
            b.fail(err('parse', status, 'invalid JSON'));
            return;
          }
        }
        if (validate && !validate(data)) {
          b.fail(err('parse', status, 'response failed validation'));
          return;
        }
        b.finish({ ok: true, status: status, data: data as T, redirect: redirect });
      };
      x.onprogress = function () {
        if (x.responseText && x.responseText.length > maxChars) {
          b.fail(err('too-large', x.status, 'response larger than ' + maxChars + ' characters'), true);
        }
      };
      // A TLS failure looks identical to any other connection failure on this engine.
      x.onerror = function () { b.fail(err('network', 0, 'connection failed')); };
      x.ontimeout = function () { b.fail(err('timeout', 0, 'timed out after ' + timeout + ' ms')); };
      x.onabort = function () { b.fail(err('aborted', 0, 'request aborted')); };
      // Backstop in case the engine never fires ontimeout.
      b.state.timers.push(setTimer(function () {
        b.fail(err('timeout', 0, 'timed out after ' + timeout + ' ms'), true);
      }, timeout + BACKSTOP_MS));
      x.send(null);
    } catch (e) {
      b.fail(err('network', 0, 'request could not be sent'));
    }
    return b.handle;
  }

  function stream(opts: StreamOptions): HttpHandle<StreamSummary> {
    const b = base<StreamSummary>();
    const pre = preflight(opts.url, opts.policy, opts.credentialOrigin);
    if (!pre.ok) {
      b.fail(pre.error);
      return b.handle;
    }
    if (!(opts.maxChars > 0)) {
      b.fail(err('invalid-url', 0, 'maxChars is required for streams'));
      return b.handle;
    }
    const requested = pre.check;
    const idle = Math.max(1, opts.idleTimeoutMs || DEFAULT_IDLE);
    const total = Math.max(1, Math.min(10 * MAX_TIMEOUT, opts.totalTimeoutMs || DEFAULT_TOTAL));
    let offset = 0;
    let chunks = 0;
    let redirect: RedirectState = 'unknown';
    let idleTimer: unknown = null;
    let headersChecked = false;

    function armIdle(): void {
      if (idleTimer !== null) {
        clearTimer(idleTimer);
        const i = b.state.timers.indexOf(idleTimer);
        if (i >= 0) {
          b.state.timers.splice(i, 1);
        }
      }
      idleTimer = setTimer(function () {
        b.fail(err('timeout', 0, 'no data for ' + idle + ' ms'), true);
      }, idle);
      b.state.timers.push(idleTimer);
    }

    function checkHeaders(x: XhrLike): boolean {
      if (headersChecked) {
        return true;
      }
      headersChecked = true;
      const f = finalUrlCheck(x, requested, opts.policy, opts.credentialOrigin);
      redirect = f.state;
      if (f.error) {
        b.fail(f.error, true);
        return false;
      }
      if (x.status < 200 || x.status > 299) {
        b.fail(err('http', x.status, 'HTTP ' + x.status), true);
        return false;
      }
      if (opts.onHeaders) {
        let ct = '';
        try { ct = (x.getResponseHeader && x.getResponseHeader('Content-Type')) || ''; } catch (e) { /* not exposed */ }
        opts.onHeaders(ct);
      }
      return !b.state.done;
    }

    function deliver(x: XhrLike): boolean {
      const text = x.responseText || '';
      if (text.length <= offset) {
        return true;
      }
      if (text.length > opts.maxChars) {
        b.fail(err('too-large', x.status, 'download larger than ' + opts.maxChars + ' characters'), true);
        return false;
      }
      const piece = text.substring(offset);
      offset = text.length;
      chunks++;
      try {
        opts.onChunk(piece);
      } catch (e) {
        b.fail(err('parse', x.status, 'chunk consumer failed: ' + (e instanceof Error ? e.message : 'error')), true);
        return false;
      }
      return true;
    }

    try {
      const x = makeXhr();
      b.state.xhr = x;
      x.open('GET', requested.href, true);
      x.timeout = total;
      x.withCredentials = false;
      if (opts.binary) {
        if (typeof x.overrideMimeType !== 'function') {
          b.fail(err('parse', 0, 'binary downloads are not supported by this engine'));
          return b.handle;
        }
        x.overrideMimeType('text/plain; charset=x-user-defined');
      }
      x.onreadystatechange = function () {
        if (x.readyState >= HEADERS_RECEIVED && x.status > 0 && !b.state.done) {
          checkHeaders(x);
        }
      };
      x.onprogress = function () {
        if (b.state.done || x.status === 0 || !checkHeaders(x)) {
          return;
        }
        armIdle();
        deliver(x);
      };
      x.onload = function () {
        if (x.status === 0) {
          b.fail(err('network', 0, 'no response'));
          return;
        }
        if (!checkHeaders(x)) {
          return;
        }
        const f = finalUrlCheck(x, requested, opts.policy, opts.credentialOrigin);
        if (f.error) {
          b.fail(f.error);
          return;
        }
        if (!deliver(x)) {
          return;
        }
        b.finish({ ok: true, status: x.status, data: { chars: offset, chunks: chunks }, redirect: redirect });
      };
      x.onerror = function () { b.fail(err('network', 0, 'connection failed')); };
      x.ontimeout = function () { b.fail(err('timeout', 0, 'timed out after ' + total + ' ms')); };
      x.onabort = function () { b.fail(err('aborted', 0, 'request aborted')); };
      b.state.timers.push(setTimer(function () {
        b.fail(err('timeout', 0, 'timed out after ' + total + ' ms'), true);
      }, total + BACKSTOP_MS));
      armIdle();
      x.send(null);
    } catch (e) {
      b.fail(err('network', 0, 'request could not be sent'));
    }
    return b.handle;
  }

  return { request: request, stream: stream };
}
