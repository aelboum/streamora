// FileStore on tizen.filesystem 'wgt-private' (the app's private directory).
// Verified on the TV (probe 2): resolve('wgt-private','rw'), createFile, openStream 'w'/'r',
// chunked write/read, deleteFile; about 1.5 MB/s each way.
// File.moveTo (atomic replace) and listFiles verified on the TV in Stage 3. If moveTo fails, the
// store falls back to a direct (non-atomic) write and reports atomicReplace = false; the catalogue
// header checksum then detects a torn file.
import type { FileStore } from './platform.ts';
import { checkFileName } from './common.ts';

const LOCATION = 'wgt-private';
const WRITE_CHUNK = 102400;    // 100 K characters per write call (≈ 65 ms at 1.5 MB/s)
const READ_CHUNK = 131072;     // 128 K characters per read call (≈ 85 ms)
// Stage 6.1 [TV]: single write calls occasionally block for ≈ 0.5 s (once 2.7 s) on the UE50MU6100,
// independent of the chunk size (16 K chunks were tried: same 515 ms worst case, as many stalls),
// so the chunk sizes stay as they were. See timings() and docs/STAGE-6.1-REPORT.md.
// The FileStream calls are synchronous. One chunk is handled per event-loop turn, so a 5 MB
// catalogue never blocks the UI for seconds (Stage 4B: a single loop blocked it for ≈ 3 s on the TV).
function nextTurn(fn: () => void): void {
  setTimeout(fn, 0);
}
const TMP_SUFFIX = '.tmp';

function isNotFound(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'NotFoundError';
}

function toError(e: unknown, what: string): Error {
  const name = e && typeof e === 'object' && (e as { name?: string }).name ? (e as { name: string }).name : 'Error';
  return new Error(what + ' failed (' + name + ')');
}

export function createTizenFileStore(fs: TizenFileSystemManager): FileStore {
  let dirPromise: Promise<TizenFile> | null = null;
  // Stage 9: the next blocking write-side call waits for this gate (no key pressed for a moment).
  let gate: (() => Promise<void>) | null = null;
  function paced(fn: () => void): void {
    if (!gate) { nextTurn(fn); return; }
    // A gate that fails never blocks the write.
    gate().then(fn, fn);
  }
  // Longest synchronous FileStream/File call per operation (ms): which call blocks the UI.
  const slow: Record<string, number> = {};
  function timed<T>(op: string, fn: () => T): T {
    const t0 = Date.now();
    function note(): void {
      const ms = Date.now() - t0;
      if (!(slow[op] >= ms)) { slow[op] = ms; }
    }
    let r: T;
    try {
      r = fn();
    } catch (e) {
      note();
      throw e;
    }
    note();
    return r;
  }

  function dir(): Promise<TizenFile> {
    if (!dirPromise) {
      dirPromise = new Promise<TizenFile>(function (resolve, reject) {
        try {
          fs.resolve(LOCATION, resolve, function (e) { reject(toError(e, 'resolve ' + LOCATION)); }, 'rw');
        } catch (e) {
          reject(toError(e, 'resolve ' + LOCATION));
        }
      });
      dirPromise.then(null, function () { dirPromise = null; });
    }
    return dirPromise;
  }

  /** Returns the file or null when it does not exist. */
  function find(d: TizenFile, name: string): TizenFile | null {
    try {
      return timed('resolve', function () { return d.resolve(name); });
    } catch (e) {
      if (isNotFound(e)) {
        return null;
      }
      throw toError(e, 'resolve file');
    }
  }

  function deleteIfExists(d: TizenFile, name: string): Promise<void> {
    return new Promise<void>(function (resolve, reject) {
      let f: TizenFile | null;
      try { f = find(d, name); } catch (e) { reject(e); return; }
      if (!f) { resolve(); return; }
      try {
        const full = (f as TizenFile).fullPath;
        timed('deleteFile', function () { d.deleteFile(full, function () { resolve(); }, function (e) {
          if (isNotFound(e)) { resolve(); } else { reject(toError(e, 'deleteFile')); }
        }); });
      } catch (e) {
        reject(toError(e, 'deleteFile'));
      }
    });
  }

  function writeFile(d: TizenFile, name: string, text: string): Promise<TizenFile> {
    return pace().then(function () { return deleteIfExists(d, name); }).then(pace).then(function () {
      return new Promise<TizenFile>(function (resolve, reject) {
        let f: TizenFile;
        try { f = timed('createFile', function () { return d.createFile(name); }); } catch (e) { reject(toError(e, 'createFile')); return; }
        try {
          f.openStream('w', function (s) {
            let i = 0;
            function chunk(): void {
              try {
                if (i < text.length) {
                  const part = text.substring(i, i + WRITE_CHUNK);
                  timed('write', function () { s.write(part); });
                  i += WRITE_CHUNK;
                  paced(chunk);
                  return;
                }
                timed('closeW', function () { s.close(); });
                resolve(f);
              } catch (e) {
                try { s.close(); } catch (e2) { /* ignore */ }
                reject(toError(e, 'write'));
              }
            }
            chunk();
          }, function (e) { reject(toError(e, 'openStream w')); }, 'UTF-8');
        } catch (e) {
          reject(toError(e, 'openStream w'));
        }
      });
    });
  }

  /** Stage 9: resolves when the write gate lets the next blocking call run. */
  function pace(): Promise<void> {
    return new Promise<void>(function (resolve) { paced(resolve); });
  }

  function move(d: TizenFile, from: TizenFile, name: string): Promise<void> {
    return pace().then(function () { return moveNow(d, from, name); });
  }

  function moveNow(d: TizenFile, from: TizenFile, name: string): Promise<void> {
    return new Promise<void>(function (resolve, reject) {
      try {
        timed('moveTo', function () { d.moveTo(from.fullPath, d.fullPath + '/' + name, true, function () { resolve(); }, function (e) { reject(toError(e, 'moveTo')); }); });
      } catch (e) {
        reject(toError(e, 'moveTo'));
      }
    });
  }

  const store: FileStore & { atomicReplace: boolean } = {
    atomicReplace: true,
    setWriteGate: function (g) { gate = g; },
    timings: function () {
      const out: Record<string, number> = {};
      for (const k in slow) { if (Object.prototype.hasOwnProperty.call(slow, k)) { out[k] = slow[k]; } }
      return out;
    },

    read: function (name) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      return dir().then(function (d) {
        return new Promise<string | null>(function (resolve, reject) {
          let f: TizenFile | null;
          try { f = find(d, name); } catch (e) { reject(e); return; }
          if (!f) { resolve(null); return; }
          try {
            f.openStream('r', function (s) {
              const parts: string[] = [];
              function chunk(): void {
                try {
                  const part = timed('read', function () { return s.read(READ_CHUNK); });
                  if (part.length > 0) {
                    parts.push(part);
                  }
                  if (part.length > 0 && !s.eof) {
                    nextTurn(chunk);
                    return;
                  }
                  s.close();
                  resolve(parts.join(''));
                } catch (e) {
                  try { s.close(); } catch (e2) { /* ignore */ }
                  reject(toError(e, 'read'));
                }
              }
              chunk();
            }, function (e) { reject(toError(e, 'openStream r')); }, 'UTF-8');
          } catch (e) {
            reject(toError(e, 'openStream r'));
          }
        });
      });
    },

    write: function (name, text) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      return dir().then(function (d) {
        const tmpName = name + TMP_SUFFIX;
        return writeFile(d, tmpName, text).then(function (tmp) {
          return move(d, tmp, name).then(null, function () {
            // moveTo unavailable or failed: direct write (non-atomic), then drop the temp file.
            store.atomicReplace = false;
            return writeFile(d, name, text).then(function () { return deleteIfExists(d, tmpName); });
          });
        });
      });
    },

    remove: function (name) {
      try { checkFileName(name); } catch (e) { return Promise.reject(e); }
      return dir().then(function (d) {
        return deleteIfExists(d, name).then(function () { return deleteIfExists(d, name + TMP_SUFFIX); });
      });
    },

    list: function () {
      return dir().then(function (d) {
        return new Promise<string[]>(function (resolve, reject) {
          try {
            timed('listFiles', function () { d.listFiles(function (files) {
              const out: string[] = [];
              for (let i = 0; i < files.length; i++) {
                if (files[i].isFile) {
                  out.push(files[i].name);
                }
              }
              resolve(out.sort());
            }, function (e) { reject(toError(e, 'listFiles')); }); });
          } catch (e) {
            reject(toError(e, 'listFiles'));
          }
        });
      });
    }
  };
  return store;
}
