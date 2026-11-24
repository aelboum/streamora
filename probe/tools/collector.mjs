// Receives probe results from the TV over the LAN and hands it fixed commands.
// Usage: node collector.mjs            (listens on 0.0.0.0:8099)
// Commands are queued by writing a word to probe/results/next-cmd.txt:
//   avplay | report | exit
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set(['avplay', 'report', 'exit']);
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const cmdFile = join(out, 'next-cmd.txt');
mkdirSync(out, { recursive: true });

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/cmd') {
    let cmd = '';
    if (existsSync(cmdFile)) {
      const word = readFileSync(cmdFile, 'utf8').trim();
      unlinkSync(cmdFile);
      if (ALLOWED.has(word)) { cmd = word; console.log(new Date().toISOString(), 'sent command', cmd); }
    }
    res.end(cmd);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/report') {
    const tag = (url.searchParams.get('tag') || 'report').replace(/[^a-z0-9-]/gi, '').slice(0, 20);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }
      writeFileSync(join(out, `latest-${tag}.json`), body);
      writeFileSync(join(out, 'latest.json'), body);
      console.log(new Date().toISOString(), 'report', tag, body.length, 'bytes');
      res.end('ok');
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8099, '0.0.0.0', () => console.log('collector on :8099 ->', out));
