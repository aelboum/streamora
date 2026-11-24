// Network failure recovery: retries a request when (and only when) the failure is retryable
// (network, timeout, HTTP 408/429/5xx). Aborting the returned handle cancels the current attempt
// and any pending retry.
import type { HttpHandle, HttpResult } from './http-client.ts';

export interface RetryPolicy {
  /** Total attempts including the first. */
  attempts: number;
  /** Delay before retry n (n = 1, 2, …); the last value repeats. */
  delaysMs: number[];
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, delaysMs: [2000, 5000] };

export interface RetryTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export function withRetry<T>(start: () => HttpHandle<T>, policy: RetryPolicy, timers: RetryTimers,
  onRetry?: (attempt: number, delayMs: number, kind: string) => void): HttpHandle<T> {
  let current: HttpHandle<T> | null = null;
  let pending: unknown = null;
  let aborted = false;
  let settle: (r: HttpResult<T>) => void = function () { /* replaced below */ };
  const result = new Promise<HttpResult<T>>(function (resolve) { settle = resolve; });
  const attempts = Math.max(1, Math.floor(policy.attempts));

  function run(attempt: number): void {
    if (aborted) {
      return;
    }
    current = start();
    current.result.then(function (r) {
      if (aborted) {
        return;
      }
      if (r.ok || !r.error.retryable || attempt >= attempts) {
        settle(r);
        return;
      }
      const delays = policy.delaysMs;
      const delay = delays.length ? delays[Math.min(attempt - 1, delays.length - 1)] : 0;
      if (onRetry) {
        onRetry(attempt + 1, delay, r.error.kind);
      }
      pending = timers.setTimer(function () {
        pending = null;
        run(attempt + 1);
      }, delay);
    });
  }

  run(1);
  return {
    result: result,
    abort: function () {
      if (aborted) {
        return;
      }
      aborted = true;
      if (pending !== null) {
        timers.clearTimer(pending);
        pending = null;
      }
      if (current) {
        current.abort();
      }
      settle({ ok: false, error: { kind: 'aborted', status: 0, message: 'request aborted', retryable: false } });
    }
  };
}
