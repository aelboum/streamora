// EXPERIMENTAL QR pairing UI test server (dev only; docs/AI-02-QR-UI-TEST-REPORT.md).
//   node scripts/qr-test-server.mjs            → listens on port 8095 (all interfaces)
// Serves the phone test page and a tiny in-memory pairing API for the TV test screen:
//   GET  /p/                      phone page (pairing id read from the URL fragment, never sent)
//   GET  /p/app.js, /p/app.css    page assets
//   GET  /api/tv/<id>             TV poll: registers the id, returns { state }
//   POST /api/tv/<id>/cancel      TV cancel
//   POST /api/phone/confirm       phone: body must be exactly { id, provider } (≤ 200 bytes)
// It never receives keys: any body with other fields is refused (protocol.ts). Only private-LAN
// and loopback clients are served. Plain HTTP on the LAN is acceptable here ONLY because nothing
// secret is exchanged (fake test flow, ids that expire in 5 minutes). Do not reuse for real keys.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPairingRegistry, validPairingId } from '../src/dev/qr-pairing/protocol.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const PAGE_DIR = join(root, 'qr-test-page');
const PORT = Number(process.env.QR_TEST_PORT || 8095);

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
};

function privateClient(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(a);
}

function send(res, status, type, body) {
  res.writeHead(status, Object.assign({ 'Content-Type': type }, SECURITY_HEADERS));
  res.end(body);
}
const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));

/** Request handler (exported for tests). `registry` holds the in-memory pairings. */
export function createHandler(registry, log = console.log) {
  return function handle(req, res) {
    const client = String(req.socket && req.socket.remoteAddress || '');
    if (!privateClient(client)) { return json(res, 403, { error: 'lan-only' }); }
    const path = String(req.url || '').split('?')[0];
    // Logged by method and route only (no bodies; ids are short-lived test values and masked).
    log(new Date().toISOString().slice(11, 19) + ' ' + req.method + ' ' + path.replace(/[A-Z0-9]{10}/, '<id>'));
    if (req.method === 'GET' && (path === '/p/' || path === '/p')) { return send(res, 200, 'text/html; charset=utf-8', readFileSync(join(PAGE_DIR, 'index.html'))); }
    if (req.method === 'GET' && path === '/p/app.js') { return send(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(PAGE_DIR, 'app.js'))); }
    if (req.method === 'GET' && path === '/p/app.css') { return send(res, 200, 'text/css; charset=utf-8', readFileSync(join(PAGE_DIR, 'app.css'))); }
    let m = /^\/api\/tv\/([A-Z0-9]{10})$/.exec(path);
    if (req.method === 'GET' && m) {
      const s = registry.poll(m[1]);
      return s === 'invalid' ? json(res, 400, { state: 'invalid' }) : json(res, 200, { state: s });
    }
    m = /^\/api\/tv\/([A-Z0-9]{10})\/cancel$/.exec(path);
    if (req.method === 'POST' && m) { return json(res, validPairingId(m[1]) && registry.cancel(m[1]) ? 200 : 404, { ok: true }); }
    if (req.method === 'POST' && path === '/api/phone/confirm') {
      let body = '';
      let tooBig = false;
      req.on('data', (c) => { body += c; if (body.length > 200) { tooBig = true; } });
      req.on('end', () => {
        if (tooBig) { return json(res, 413, { result: 'bad-request' }); }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
        const r = registry.confirm(parsed, client);
        return json(res, r.result === 'confirmed' ? 200 : 400, r);
      });
      return undefined;
    }
    return json(res, 404, { error: 'not-found' });
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer(createHandler(createPairingRegistry(Date.now))).listen(PORT, () => {
    console.log('QR pairing test server on port ' + PORT + ' (LAN only, fake test flow; never enter a real key)');
  });
}
