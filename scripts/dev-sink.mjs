// npm run dev-sink [-- --port 8099]
// PC-side receiver for the dev-only log sink. Appends each batch to logs/dev-sink/<date>.jsonl.
// Also serves the synthetic IPTV fixtures used by the on-TV self-test (scripts/lib/tv-fixtures.mjs)
// on this port, and on port+1 as a second origin for cross-origin redirect checks.
// Development use only; never part of the app package.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleFixture } from './lib/tv-fixtures.mjs';
import { handleLiveFixture, stopBroadcasters } from './lib/tv-fixtures-live.mjs';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.SS_DEV_SINK_PORT || 8099);
const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'logs', 'dev-sink');
mkdirSync(dir, { recursive: true });

function origins(req, ownPort) {
  const host = String(req.headers.host || '127.0.0.1:' + ownPort).replace(/:\d+$/, '');
  return { main: 'http://' + host + ':' + port, other: 'http://' + host + ':' + (port + 1) };
}

createServer((req, res) => {
  if (req.method === 'GET') {
    const o = origins(req, port + 1);
    if (handleFixture(req, res, o.other, o.main)) {
      console.log('[fixture second origin :' + (port + 1) + '] ' + req.url.replace(/(username|password)=[^&]*/g, '$1=…'));
      return;
    }
  }
  res.statusCode = 404;
  res.end();
}).listen(port + 1, '0.0.0.0');

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'GET') {
    const o = origins(req, port);
    const started = Date.now();
    if (handleFixture(req, res, o.main, o.other) || handleLiveFixture(req, res, o.main)) {
      res.on('finish', () => console.log('[fixture] ' + req.url.replace(/(username|password)=[^&]*/g, '$1=…') + ' ' + res.statusCode + ' ' + (Date.now() - started) + ' ms'));
      return;
    }
  }
  if (req.method !== 'POST' || req.url !== '/ingest') {
    res.statusCode = 404;
    res.end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.statusCode = 400; res.end(); return; }
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const file = join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
    for (const e of entries) {
      appendFileSync(file, JSON.stringify({ from: req.socket.remoteAddress, ...e }) + '\n');
      console.log(`[${e.level}] ${e.msg}${e.data !== undefined ? ' ' + JSON.stringify(e.data) : ''}`);
    }
    res.end('ok');
  });
}).listen(port, '0.0.0.0', () => console.log(`dev-sink listening on :${port}, writing ${dir}`));

process.on('SIGINT', () => { stopBroadcasters(); process.exit(0); });
process.on('SIGTERM', () => { stopBroadcasters(); process.exit(0); });
