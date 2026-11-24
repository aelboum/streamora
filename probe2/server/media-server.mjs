// Device probe 2: LAN test server + result collector (development PC only, plain HTTP, port 8099).
// Serves locally generated synthetic media (make-media.mjs), a continuous live MPEG-TS stream,
// a rolling live HLS stream, large text bodies and images. Receives probe results.
// Usage: node probe2/server/media-server.mjs
// Commands for the TV are queued by writing one word to probe2/results/next-cmd.txt.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, statSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { LIVE, LIVE_SRC } from './make-media.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = join(root, 'media');
const resultsDir = join(root, 'results');
const cmdFile = join(resultsDir, 'next-cmd.txt');
const iconFile = join(root, 'app', 'icon.png');
mkdirSync(resultsDir, { recursive: true });

const ALLOWED_CMDS = new Set(['avplay', 'quota', 'zap2', 'report', 'exit']);

// ---- persistent live encoders (like a real IPTV server: the stream is already running) ----
const broadcasters = new Map();
function broadcaster(variant) {
  if (broadcasters.has(variant)) { return broadcasters.get(variant); }
  const clients = new Set();
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...LIVE_SRC, ...LIVE[variant], '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  ff.stdout.on('data', (chunk) => { for (const c of clients) { c.write(chunk); } });
  const b = { clients, ff };
  broadcasters.set(variant, b);
  process.on('exit', () => { try { ff.kill(); } catch { /* ignore */ } });
  return b;
}
// Start them now so they are "already running" when the TV zaps.
broadcaster('h264_aac');
broadcaster('h264_mp2');
const TYPES = { '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.mkv': 'video/x-matroska', '.m3u8': 'application/vnd.apple.mpegurl', '.png': 'image/png' };

// ---- rolling live HLS (started once, segments in a temp dir) ----
const liveHlsDir = join(tmpdir(), 'ss-probe2-livehls');
rmSync(liveHlsDir, { recursive: true, force: true });
mkdirSync(liveHlsDir, { recursive: true });
const hlsProc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...LIVE_SRC, ...LIVE.h264_aac,
  '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6', '-hls_flags', 'delete_segments',
  '-hls_segment_filename', join(liveHlsDir, 'seg%05d.ts'), join(liveHlsDir, 'index.m3u8')], { stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => { try { hlsProc.kill(); } catch { /* ignore */ } });
process.on('SIGINT', () => process.exit(0));

// ---- large text bodies (M3U-like lines), cached per size ----
const textCache = new Map();
function bigText(mb) {
  if (textCache.has(mb)) { return textCache.get(mb); }
  const lines = ['#EXTM3U'];
  let size = 8, i = 0;
  while (size < mb * 1024 * 1024) {
    const a = `#EXTINF:-1 tvg-id="ch${i}.test" tvg-name="Channel ${i}" tvg-logo="http://logo.invalid/${i}.png" group-title="Group ${i % 40}",Channel ${i}`;
    const b = `http://stream.invalid/live/user/pass/${i}.ts`;
    lines.push(a, b);
    size += a.length + b.length + 2;
    i++;
  }
  const body = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const entry = { body, gz: gzipSync(body), entries: i };
  textCache.set(mb, entry);
  return entry;
}

function sendFile(req, res, file) {
  const st = statSync(file);
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[2] === '' || range[1] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
    if (start > end || start >= st.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${st.size}`); res.end(); return; }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', st.size);
  createReadStream(file).pipe(res);
}

function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  return p.startsWith(base + sep) ? p : null;
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  const log = (msg) => console.log(new Date().toISOString().slice(11, 19), req.method, path, msg || '');

  if (req.method === 'GET' && path === '/cmd') {
    let cmd = '';
    if (existsSync(cmdFile)) {
      const word = readFileSync(cmdFile, 'utf8').trim();
      unlinkSync(cmdFile);
      if (ALLOWED_CMDS.has(word)) { cmd = word; log('-> ' + cmd); }
    }
    res.end(cmd);
    return;
  }
  if (req.method === 'POST' && path === '/report') {
    const tag = (url.searchParams.get('tag') || 'report').replace(/[^a-z0-9-]/gi, '').slice(0, 20);
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) { req.destroy(); } else { chunks.push(c); } });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(body); } catch { res.statusCode = 400; res.end('bad json'); return; }
      writeFileSync(join(resultsDir, `latest-${tag}.json`), body);
      writeFileSync(join(resultsDir, 'latest.json'), body);
      log(`report ${tag} ${body.length} B`);
      res.end('ok');
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }

  if (path.startsWith('/media/')) {
    const f = safeJoin(mediaDir, path.slice(7));
    if (!f || !existsSync(f)) { res.statusCode = 404; res.end(); log('404'); return; }
    log(req.headers.range || '');
    sendFile(req, res, f);
    return;
  }
  if (path.startsWith('/livehls/')) {
    const f = safeJoin(liveHlsDir, path.slice(9));
    if (!f || !existsSync(f)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Cache-Control', 'no-cache');
    sendFile(req, res, f);
    return;
  }
  const live = /^\/live\/([a-z0-9_]+)\.ts$/.exec(path);
  if (live && LIVE[live[1]]) {
    log('live start');
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache');
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...LIVE_SRC, ...LIVE[live[1]], '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    ff.stdout.pipe(res);
    const stop = () => { try { ff.kill(); } catch { /* ignore */ } };
    res.on('close', () => { stop(); log('live closed'); });
    ff.on('exit', () => res.end());
    return;
  }
  const live2 = /^\/live2\/([a-z0-9_]+)\.ts$/.exec(path);
  if (live2 && LIVE[live2[1]]) {
    const b = broadcaster(live2[1]);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache');
    b.clients.add(res);
    log(`join (${b.clients.size} clients)`);
    res.on('close', () => { b.clients.delete(res); log('leave'); });
    return;
  }
  if (path === '/text/big.txt') {
    const mb = Math.max(1, Math.min(100, Number(url.searchParams.get('mb')) || 10));
    const t = bigText(mb);
    const gz = url.searchParams.get('gzip') === '1';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Entries', String(t.entries));
    res.setHeader('X-Uncompressed-Length', String(t.body.length));
    if (gz) { res.setHeader('Content-Encoding', 'gzip'); }
    const body = gz ? t.gz : t.body;
    res.setHeader('Content-Length', body.length);
    // Send in 64 KB slices with a small pause, so progress events can fire on the TV.
    let off = 0;
    (function pump() {
      if (off >= body.length) { res.end(); log(`sent ${mb} MB gzip=${gz}`); return; }
      const next = Math.min(off + 65536, body.length);
      res.write(body.subarray(off, next));
      off = next;
      setImmediate(pump);
    })();
    return;
  }
  if (path === '/img/logo.png') {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(iconFile));
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8099, '0.0.0.0', () => console.log('probe2 server on :8099; media', mediaDir, '; results', resultsDir));
