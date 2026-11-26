// Minimal IndexedDB double for idb-file-store.ts (CP1): open with upgrade, one object store with
// out-of-line keys, get / put / delete, key cursor, transactions that complete asynchronously.
// No getAllKeys (as on Chromium 38). Failure switches: failOpen (error), blockOpen (blocked),
// failWrites (a readwrite transaction aborts, as on a quota error); the store then keeps its old data.
export function createFakeIndexedDB() {
  const dbs = {};
  const stats = { opens: 0, txs: 0 };
  const sw = { failOpen: false, blockOpen: false, failWrites: false, noKeyCursor: false };
  const later = (fn) => setImmediate(fn);

  function database(name) {
    const data = dbs[name] || (dbs[name] = { stores: {} });
    return {
      objectStoreNames: { contains: (s) => Object.prototype.hasOwnProperty.call(data.stores, s) },
      createObjectStore: (s) => { data.stores[s] = new Map(); return {}; },
      close() {},
      transaction(storeName, mode) {
        stats.txs++;
        const live = data.stores[storeName];
        if (!live) { throw new Error('NotFoundError'); }
        const work = new Map(live); // committed at the end, all or nothing
        let pending = 0;
        let failed = false;
        const tx = { oncomplete: null, onerror: null, onabort: null };
        function finish() {
          if (pending > 0) { return; }
          later(() => {
            if (pending > 0) { return; }
            if (failed) { if (tx.onabort) { tx.onabort({}); } return; }
            if (mode === 'readwrite') { live.clear(); for (const [k, v] of work) { live.set(k, v); } }
            if (tx.oncomplete) { tx.oncomplete({}); }
          });
        }
        function request(fn) {
          const req = { result: undefined, onsuccess: null, onerror: null };
          pending++;
          later(() => {
            try {
              req.result = fn();
              if (req.onsuccess) { req.onsuccess({}); }
            } catch (e) {
              failed = true;
              if (req.onerror) { req.onerror({}); }
            }
            pending--;
            finish();
          });
          return req;
        }
        function cursorRequest() {
          const keys = Array.from(work.keys()).sort();
          let i = 0;
          const req = { result: null, onsuccess: null, onerror: null };
          pending++;
          const step = () => later(() => {
            req.result = i < keys.length ? { key: keys[i], continue() { i++; pending++; step(); } } : null;
            if (req.onsuccess) { req.onsuccess({}); }
            pending--;
            finish();
          });
          step();
          return req;
        }
        tx.objectStore = () => {
          const store = {
            get: (k) => request(() => work.get(k)),
            put: (v, k) => request(() => {
              if (mode !== 'readwrite') { throw new Error('ReadOnlyError'); }
              if (sw.failWrites) { throw new Error('QuotaExceededError'); }
              work.set(k, v);
              return k;
            }),
            delete: (k) => request(() => {
              if (mode !== 'readwrite') { throw new Error('ReadOnlyError'); }
              work.delete(k);
            }),
            openCursor: () => cursorRequest()
          };
          if (!sw.noKeyCursor) { store.openKeyCursor = () => cursorRequest(); }
          return store;
        };
        later(finish); // a transaction with no requests completes too
        return tx;
      }
    };
  }

  const factory = {
    open(name, version) {
      stats.opens++;
      const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        if (sw.blockOpen) { if (req.onblocked) { req.onblocked({}); } return; }
        if (sw.failOpen) { if (req.onerror) { req.onerror({}); } return; }
        const isNew = !dbs[name];
        req.result = database(name);
        if (isNew && req.onupgradeneeded) { req.onupgradeneeded({ oldVersion: 0, newVersion: version }); }
        if (req.onsuccess) { req.onsuccess({}); }
      });
      return req;
    }
  };
  return { factory, sw, stats, peek: (db, key) => dbs[db] && dbs[db].stores.files ? dbs[db].stores.files.get(key) : undefined };
}
