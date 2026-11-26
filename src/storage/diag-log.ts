// DI-1: small persistent diagnostics log for storage-integrity events. Survives restarts and is
// kept in release builds, so an unexplained data problem leaves evidence behind.
//
// Stored in the FileStore (not localStorage, which may be the failing part) as one small file,
// ss-diag.json, atomically replaced; at most MAX_ENTRIES entries (oldest dropped first).
// Privacy: entries hold an event code and a few whitelisted fields whose values are numbers,
// booleans or short codes. Free text, URLs, server addresses, user names and passwords cannot pass
// the filter (only known field names; no ':' '/' '@' '?' '=' or spaces in values).
import type { FileStore } from '../app/platform/platform.ts';

export const DIAG_FILE = 'ss-diag.json';
const MAX_ENTRIES = 60;
const CODE_RE = /^[A-Za-z0-9._-]{1,48}$/;
const FIELDS = ['key', 'status', 'reason', 'slot', 'why', 'state', 'entries', 'valid', 'invalid', 'backup',
  'removed', 'kept', 'files', 'count', 'code', 'id', 'chars', 'op'];

export interface DiagEntry {
  t: number;
  e: string;
  d?: Record<string, number | boolean | string>;
}

export interface DiagLog {
  record(event: string, data?: Record<string, unknown>): void;
  entries(): DiagEntry[];
  /** Resolves when everything recorded so far has been written (or the write failed). */
  flush(): Promise<void>;
}

function clean(data: Record<string, unknown> | undefined): Record<string, number | boolean | string> | undefined {
  if (!data) { return undefined; }
  const out: Record<string, number | boolean | string> = {};
  let n = 0;
  for (let i = 0; i < FIELDS.length; i++) {
    const k = FIELDS[i];
    if (!Object.prototype.hasOwnProperty.call(data, k)) { continue; }
    const v = data[k];
    if ((typeof v === 'number' && isFinite(v)) || typeof v === 'boolean' || (typeof v === 'string' && CODE_RE.test(v))) {
      out[k] = v;
      n++;
    }
  }
  return n ? out : undefined;
}

function isEntry(x: unknown): x is DiagEntry {
  const e = x as DiagEntry;
  return !!e && typeof e === 'object' && typeof e.t === 'number' && typeof e.e === 'string' && CODE_RE.test(e.e);
}

export function createDiagLog(files: FileStore | null, now: () => number): DiagLog {
  let list: DiagEntry[] = [];
  let loaded = !files;
  let dirty = false;
  let writing: Promise<void> = Promise.resolve();

  function persist(): void {
    if (!files || !loaded || !dirty) { return; }
    dirty = false;
    const text = JSON.stringify({ v: 1, entries: list });
    const fs = files;
    writing = writing.then(function () {
      return fs.write(DIAG_FILE, text).then(null, function () { /* best effort: never breaks the app */ });
    });
  }

  if (files) {
    const fs = files;
    writing = fs.read(DIAG_FILE).then(function (text) {
      if (!text) { return; }
      try {
        const o = JSON.parse(text);
        const old: DiagEntry[] = [];
        if (o && Object.prototype.toString.call(o.entries) === '[object Array]') {
          for (let i = 0; i < o.entries.length; i++) {
            const x = o.entries[i];
            if (isEntry(x)) {
              const e: DiagEntry = { t: x.t, e: x.e };
              const d = clean(x.d);
              if (d) { e.d = d; }
              old.push(e);
            }
          }
        }
        list = old.concat(list);
        if (list.length > MAX_ENTRIES) { list = list.slice(list.length - MAX_ENTRIES); }
      } catch (e) { /* unreadable log: start a new one */ }
    }, function () { /* unreadable: start a new one */ }).then(function () {
      loaded = true;
      persist();
    });
  }

  return {
    record: function (event, data) {
      if (!CODE_RE.test(event)) { return; }
      const entry: DiagEntry = { t: now(), e: event };
      const d = clean(data);
      if (d) { entry.d = d; }
      list.push(entry);
      if (list.length > MAX_ENTRIES) { list.splice(0, list.length - MAX_ENTRIES); }
      dirty = true;
      persist();
    },
    entries: function () { return list.slice(); },
    flush: function () {
      persist();
      return writing.then(function () { return undefined; });
    }
  };
}
