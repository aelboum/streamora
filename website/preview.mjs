// Local preview of the built site with the real Worker (worker.js) in front of an emulated
// ASSETS binding that follows the wrangler.toml settings: auto-trailing-slash and the 404 page.
//   npm run build && npm run preview   → http://127.0.0.1:8788  (www test: send Host www.elitestreamplayer.com)
// Also imported by the tests (createAssets).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

function file(rel) {
  const p = normalize(join(root, rel));
  if (!p.startsWith(root)) { return null; }
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

function serve(p, status) {
  return new Response(readFileSync(p), { status: status || 200, headers: { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' } });
}

/** Emulates the static-assets service (html_handling = auto-trailing-slash, not_found_handling = 404-page). */
export function createAssets() {
  return {
    fetch: async function (request) {
      const url = new URL(request.url);
      let path;
      try { path = decodeURIComponent(url.pathname); } catch (e) { path = '/'; }
      if (path.endsWith('/index.html')) { return new Response(null, { status: 307, headers: { Location: path.slice(0, -10) + url.search } }); }
      if (path.endsWith('/')) {
        const p = file(path + 'index.html');
        if (p) { return serve(p); }
      } else {
        const p = file(path);
        if (p && !p.endsWith('.html')) { return serve(p); }
        if (file(path + '/index.html')) { return new Response(null, { status: 307, headers: { Location: path + '/' + url.search } }); }
      }
      return serve(join(root, '404.html'), 404);
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const env = { ASSETS: createAssets() };
  const port = Number(process.env.PORT || 8788);
  createServer(async (req, res) => {
    const host = req.headers.host && /^www\./.test(req.headers.host) ? 'www.elitestreamplayer.com' : '127.0.0.1:' + port;
    const r = await worker.fetch(new Request('http://' + host + req.url, { method: req.method }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer()));
  }).listen(port, '127.0.0.1', () => console.log('preview: http://127.0.0.1:' + port));
}
