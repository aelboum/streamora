// DEV BUILDS ONLY. Forwards redacted log entries to a LAN receiver (scripts/dev-sink.mjs).
// Release builds replace dev-hooks.ts with a no-op, so this file is never bundled there;
// scripts/release-check.mjs fails the release build if SINK_MARKER appears in the bundle.
import type { LogEntry, Logger } from '../utils/log.ts';
import { redact } from '../utils/redact.ts';
import type { XhrLike } from '../api/http-client.ts';
import { checkSinkUrl } from './sink-url.ts';

export const SINK_MARKER = 'SS_DEV_LOG_SINK_V1';

export interface LogSinkOptions {
  url: string;
  logger: Logger;
  xhrFactory?: () => XhrLike;
  intervalMs?: number;
  maxBatch?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export interface LogSink {
  readonly enabled: boolean;
  flush(): void;
  stop(): void;
}

export function startLogSink(options: LogSinkOptions): LogSink {
  const check = checkSinkUrl(options.url);
  if (!check.ok) {
    options.logger.warn('dev log sink disabled', { reason: check.reason });
    return { enabled: false, flush: function () { /* disabled */ }, stop: function () { /* disabled */ } };
  }
  const target = check.url;
  const makeXhr = options.xhrFactory || function () { return new XMLHttpRequest() as unknown as XhrLike; };
  const setTimer = options.setTimer || function (fn: () => void, ms: number) { return setTimeout(fn, ms); };
  const interval = options.intervalMs || 2000;
  const maxBatch = options.maxBatch || 50;
  let queue: LogEntry[] = [];
  let stopped = false;
  let timer: unknown = null;

  function flush(): void {
    timer = null;
    if (stopped || queue.length === 0) {
      return;
    }
    const batch = queue.slice(0, maxBatch);
    queue = queue.slice(maxBatch);
    try {
      const x = makeXhr();
      x.open('POST', target, true);
      // Only a content type is sent. No auth, cookies or other headers, ever.
      x.setRequestHeader('Content-Type', 'text/plain');
      x.timeout = 5000;
      x.send(JSON.stringify({ marker: SINK_MARKER, entries: redact(batch) }));
    } catch (e) {
      // The sink is optional: failures are dropped silently.
    }
    if (queue.length > 0) {
      schedule();
    }
  }

  function schedule(): void {
    if (timer === null && !stopped) {
      timer = setTimer(flush, interval);
    }
  }

  const unsubscribe = options.logger.subscribe(function (entry) {
    if (queue.length < 500) {
      queue.push(entry);
    }
    schedule();
  });

  return {
    enabled: true,
    flush: flush,
    stop: function () {
      stopped = true;
      unsubscribe();
    }
  };
}
