// Local emulation of the pairing relay for tests and a desktop check (never deployed).
//   node relay/local-relay.mjs [--port 8787]   → http://localhost:8787/#v1.<sid>.<pk>.gemini
// Runs relay/src/worker.js unchanged with an in-memory stand-in for the Durable Object namespace
// and the static-assets binding. Listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { PairSession } from './src/worker.js';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** In-memory Durable Object storage (get/put/delete/deleteAll/setAlarm). */
export function memoryStorage() {
  const m = new Map();
  return {
    alarmAt: 0,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { return m.delete(k); },
    async deleteAll() { m.clear(); },
    async setAlarm(t) { this.alarmAt = t; },
    size() { return m.size; },
    raw() { return m; }
  };
}

/** Durable Object namespace stand-in: one PairSession per name, requests serialised per object. */
export function memoryNamespace() {
  const objects = new Map();
  return {
    objects,
    idFromName(name) { return name; },
    get(id) {
      if (!objects.has(id)) {
        const storage = memoryStorage();
        objects.set(id, { storage, obj: new PairSession({ storage }, {}), queue: Promise.resolve() });
      }
      const o = objects.get(id);
      return {
        fetch(url, init) {
          const run = o.queue.then(() => o.obj.fetch(new Request(url, init)));
          o.queue = run.catch(() => undefined);
          return run;
        }
      };
    }
  };
}

/** Static-assets stand-in, including the _headers rules for every page response. */
export function memoryAssets() {
  const headerLines = readFileSync(join(PUBLIC, '_headers'), 'utf8').split(/\r?\n/).slice(1);
  const headers = {};
  for (const l of headerLines) {
    const i = l.indexOf(':');
    if (i > 0) { headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  }
  return {
    headers,
    async fetch(request) {
      let p = new URL(request.url).pathname;
      if (p === '/') { p = '/index.html'; }
      const file = normalize(join(PUBLIC, p));
      if (!file.startsWith(normalize(PUBLIC)) || p === '/_headers' || !existsSync(file)) { return new Response('not found', { status: 404 }); }
      const ext = file.slice(file.lastIndexOf('.'));
      return new Response(readFileSync(file), { status: 200, headers: Object.assign({ 'Content-Type': TYPES[ext] || 'application/octet-stream' }, headers) });
    }
  };
}

export function localEnv() {
  return { PAIR: memoryNamespace(), ASSETS: memoryAssets() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pi = process.argv.indexOf('--port');
  const port = pi > 0 ? Number(process.argv[pi + 1]) : 8787;
  const env = localEnv();
  createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) { chunks.push(c); }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request('http://localhost:' + port + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env);
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
    console.log(new Date().toISOString().slice(11, 19) + ' ' + req.method + ' ' + req.url.replace(/[A-Za-z0-9_-]{22}/, '<sid>') + ' ' + r.status);
  }).listen(port, '127.0.0.1', () => console.log('local pairing relay on http://localhost:' + port));
}
