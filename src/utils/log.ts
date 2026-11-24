// Structured, in-memory ring-buffer logger. Everything is redacted on entry (utils/redact.ts),
// so listeners (the dev-only LAN sink, the diagnostics screen) never see sensitive values.
// There is no remote telemetry.
import { redact, redactString } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  t: number;
  level: LogLevel;
  /** Component that wrote the entry (logger.child(name)). */
  component?: string;
  msg: string;
  data?: unknown;
  /** Error context: name, redacted message and an optional classification kind. */
  err?: { name: string; message: string; kind?: string };
}

export type LogListener = (entry: LogEntry) => void;

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown, err?: unknown): void;
  error(msg: string, data?: unknown, err?: unknown): void;
  /** Logger that tags entries with a component name; shares buffer, level and listeners. */
  child(component: string): Logger;
  setLevel(level: LogLevel): void;
  level(): LogLevel;
  entries(): LogEntry[];
  subscribe(listener: LogListener): () => void;
}

function errorContext(err: unknown): LogEntry['err'] {
  if (err === undefined || err === null) {
    return undefined;
  }
  if (typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; kind?: unknown };
    const out: { name: string; message: string; kind?: string } = {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: redactString(typeof e.message === 'string' ? e.message : String(err))
    };
    if (typeof e.kind === 'string') {
      out.kind = e.kind;
    }
    return out;
  }
  return { name: 'Error', message: redactString(String(err)) };
}

interface LoggerCore {
  buffer: LogEntry[];
  listeners: LogListener[];
  cap: number;
  clock: () => number;
  min: LogLevel;
}

function makeLogger(core: LoggerCore, component?: string): Logger {
  function write(level: LogLevel, msg: string, data?: unknown, err?: unknown): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[core.min]) {
      return;
    }
    const entry: LogEntry = { t: core.clock(), level: level, msg: redactString(msg) };
    if (component) {
      entry.component = component;
    }
    if (data !== undefined) {
      entry.data = redact(data);
    }
    const ctx = errorContext(err);
    if (ctx) {
      entry.err = ctx;
    }
    core.buffer.push(entry);
    if (core.buffer.length > core.cap) {
      core.buffer.shift();
    }
    const snapshot = core.listeners.slice();
    for (let i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](entry);
      } catch (e) {
        // A failing listener must never break logging or the app.
      }
    }
  }

  return {
    debug: function (m, d) { write('debug', m, d); },
    info: function (m, d) { write('info', m, d); },
    warn: function (m, d, e) { write('warn', m, d, e); },
    error: function (m, d, e) { write('error', m, d, e); },
    child: function (name) { return makeLogger(core, component ? component + '.' + name : name); },
    setLevel: function (level) { core.min = level; },
    level: function () { return core.min; },
    entries: function () { return core.buffer.slice(); },
    subscribe: function (listener) {
      core.listeners.push(listener);
      return function () {
        const i = core.listeners.indexOf(listener);
        if (i >= 0) {
          core.listeners.splice(i, 1);
        }
      };
    }
  };
}

export function createLogger(capacity?: number, now?: () => number, minLevel?: LogLevel): Logger {
  return makeLogger({
    buffer: [],
    listeners: [],
    cap: capacity || 200,
    clock: now || function () { return Date.now(); },
    min: minLevel || 'debug'
  });
}
