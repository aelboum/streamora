// EXPERIMENTAL QR pairing UI test (dev builds only; docs/AI-02-QR-UI-TEST-REPORT.md).
// Fake data only. Covers: pairing ids, QR payload contents (decoded back with jsQR) and the absence
// of sensitive data, the fake key check, the pairing registry (flow, invalid / expired / used /
// cancelled ids, wrong provider, extra fields refused, attempt lock), the test server (LAN only,
// headers, keys refused), the phone page (no storage, sends only id + provider), the TV screen
// (QR shown, Cancel focused, poll → confirmed, expiry, cancel) and isolation from production
// key storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import jsQR from 'jsqr';
import {
  newPairingId, validPairingId, formatPairingId, qrPayload, testServerUrl, looksSensitive, fakeKeyCheck,
  createPairingRegistry, PAIRING_TTL_MS, MAX_FAILED_ATTEMPTS, ID_ALPHABET
} from '../../src/dev/qr-pairing/protocol.ts';
import { qrMatrix, qrSvg, qrDataUri } from '../../src/dev/qr-pairing/qr-svg.ts';
import { createQrTestScreen, QR_TEST_SCREEN } from '../../src/dev/qr-pairing/screen.ts';
import { registerQrPairingTest } from '../../src/dev/dev-hooks.ts';
import { createHandler, SECURITY_HEADERS } from '../../scripts/qr-test-server.mjs';
import { createRouter } from '../../src/navigation/router.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createMemoryKeyStore } from '../../src/app/platform/memory-stores.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { createFakeGemini } from '../fakes/fake-gemini.mjs';
import { randomBytes } from 'node:crypto';

const rnd = (n) => Array.from(randomBytes(n));
/** Source without comments (checks look at code, not at documentation that names what is avoided). */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SERVER = 'http://192.168.1.50:8095';
const FAKE = 'TEST-GEMINI-123456';

// ---------------------------------------------------------------- ids and payload

test('QR test: pairing ids are random, unambiguous, 10 characters; server URL derived from the dev sink', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = newPairingId(rnd);
    assert.ok(validPairingId(id), id);
    seen.add(id);
  }
  assert.equal(seen.size, 2000, 'no repeats in 2000 ids');
  assert.equal(/[01ILO]/.test([...seen].join('')), false, 'no look-alike characters');
  assert.equal(validPairingId('ABCDE'), false);
  assert.equal(validPairingId('abcdefghjk'), false);
  assert.equal(validPairingId('ABCDEFGHJ0'), false);
  assert.equal(formatPairingId('ABCDEFGHJK'), 'ABCDE-FGHJK');
  // Biased bytes (≥ 248) are skipped, not folded.
  let calls = 0;
  const id = newPairingId(() => { calls++; return calls === 1 ? new Array(16).fill(255) : new Array(16).fill(0); });
  assert.equal(id, ID_ALPHABET.charAt(0).repeat(10));
  assert.equal(testServerUrl('http://192.168.1.50:8097/ingest'), SERVER);
  assert.equal(testServerUrl('https://example.com/ingest'), '', 'only private-LAN dev sinks');
  assert.equal(testServerUrl(''), '');
});

test('QR test: payload is address + id in the fragment only; decodes back exactly; nothing sensitive', () => {
  const id = newPairingId(rnd);
  const payload = qrPayload(SERVER, id);
  assert.equal(payload, SERVER + '/p/#' + id);
  assert.equal(looksSensitive(payload), false);
  for (const bad of ['x?key=1', 'AIzaSyA1234567890abcdef', FAKE, 'https://u:p@h/', 'sk-abcdefghijkl12']) {
    assert.equal(looksSensitive(bad), true, bad);
  }
  // Render the module matrix to pixels and decode with jsQR (an independent decoder).
  const m = qrMatrix(payload);
  const scale = 4, q = 4, size = (m.size + 2 * q) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.dark(r, c)) { continue; }
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const o = (((r + q) * scale + y) * size + (c + q) * scale + x) * 4;
          px[o] = px[o + 1] = px[o + 2] = 0;
        }
      }
    }
  }
  const decoded = jsQR(px, size, size);
  assert.ok(decoded, 'QR decodes');
  assert.equal(decoded.data, payload, 'decoded payload equals the intended payload');
  const svg = qrSvg(m);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.equal(svg.includes(id), false, 'the SVG holds modules, not the text');
  assert.match(qrDataUri(payload), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
});

test('QR test: only the fake key format passes on the phone; real-looking keys are refused', () => {
  assert.equal(fakeKeyCheck(FAKE), 'ok');
  assert.equal(fakeKeyCheck('  ' + FAKE + ' '), 'ok');
  assert.equal(fakeKeyCheck('AIzaSyA1234567890abcdefghijklmnopqrstuv'), 'looks-real');
  assert.equal(fakeKeyCheck('sk-proj-abc'), 'looks-real');
  assert.equal(fakeKeyCheck('x'.repeat(40)), 'looks-real');
  assert.equal(fakeKeyCheck('hello'), 'bad-format');
  assert.equal(fakeKeyCheck(''), 'empty');
});

// ---------------------------------------------------------------- registry

test('QR test: pairing registry — fake flow, one-time use, invalid, expired, cancelled, wrong provider, extra fields', () => {
  let now = 1000000;
  const reg = createPairingRegistry(() => now);
  const id = newPairingId(rnd);
  assert.equal(reg.confirm({ id, provider: 'gemini' }, 'phone').result, 'invalid', 'unknown until the TV polls');
  assert.equal(reg.poll(id), 'waiting');
  assert.equal(reg.confirm({ id, provider: 'openai' }, 'phone').result, 'bad-provider');
  assert.equal(reg.confirm({ id, provider: 'gemini', key: FAKE }, 'phone').result, 'bad-request', 'a key field is refused: the server cannot receive keys');
  assert.equal(reg.confirm({ id, provider: 'gemini', token: 'x' }, 'phone').result, 'bad-request');
  assert.equal(reg.confirm('not json', 'phone').result, 'bad-request');
  assert.deepEqual(reg.confirm({ id, provider: 'gemini' }, 'phone'), { result: 'confirmed', provider: 'gemini' });
  assert.equal(reg.poll(id), 'confirmed');
  assert.equal(reg.confirm({ id, provider: 'gemini' }, 'phone').result, 'used', 'replay refused');
  assert.equal(reg.poll('BAD'), 'invalid');
  const id2 = newPairingId(rnd);
  reg.poll(id2);
  assert.equal(reg.cancel(id2), true);
  assert.equal(reg.poll(id2), 'cancelled');
  assert.equal(reg.confirm({ id: id2, provider: 'gemini' }, 'phone').result, 'cancelled');
  const id3 = newPairingId(rnd);
  reg.poll(id3);
  now += PAIRING_TTL_MS + 1;
  assert.equal(reg.poll(id3), 'expired');
  assert.equal(reg.confirm({ id: id3, provider: 'gemini' }, 'phone').result, 'expired');
});

test('QR test: brute force — the caller is locked after repeated failed attempts', () => {
  const now = 5000000;
  const reg = createPairingRegistry(() => now);
  const good = newPairingId(rnd);
  reg.poll(good);
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) { reg.confirm({ id: newPairingId(rnd), provider: 'gemini' }, 'attacker'); }
  assert.equal(reg.confirm({ id: good, provider: 'gemini' }, 'attacker').result, 'locked', 'even a valid id is refused while locked');
  assert.equal(reg.confirm({ id: good, provider: 'gemini' }, 'phone').result, 'confirmed', 'other clients are not affected');
});

// ---------------------------------------------------------------- test server and phone page

function call(handle, { method = 'GET', url, body, ip = '192.168.1.20' }) {
  return new Promise((resolve) => {
    const listeners = {};
    const req = { method, url, socket: { remoteAddress: ip }, on: (ev, fn) => { listeners[ev] = fn; } };
    const res = { status: 0, headers: null, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { resolve({ status: this.status, headers: this.headers, body: String(b) }); } };
    handle(req, res);
    if (method === 'POST') { if (body !== undefined) { listeners.data(body); } listeners.end(); }
  });
}

test('QR test server: LAN only, security headers, page served, keys refused, full fake flow', async () => {
  const logs = [];
  const handle = createHandler(createPairingRegistry(Date.now), (l) => logs.push(l));
  assert.equal((await call(handle, { url: '/p/', ip: '8.8.8.8' })).status, 403, 'public clients refused');
  const page = await call(handle, { url: '/p/' });
  assert.equal(page.status, 200);
  assert.match(page.body, /EXPERIMENTAL TEST ONLY – NEVER ENTER A REAL API KEY\./);
  assert.deepEqual(Object.keys(SECURITY_HEADERS).every((k) => page.headers[k] === SECURITY_HEADERS[k]), true);
  assert.match(page.headers['Content-Security-Policy'], /connect-src 'self'/);
  const id = newPairingId(rnd);
  assert.deepEqual(JSON.parse((await call(handle, { url: '/api/tv/' + id })).body), { state: 'waiting' });
  const withKey = await call(handle, { method: 'POST', url: '/api/phone/confirm', body: JSON.stringify({ id, provider: 'gemini', key: FAKE }) });
  assert.equal(JSON.parse(withKey.body).result, 'bad-request');
  const big = await call(handle, { method: 'POST', url: '/api/phone/confirm', body: 'x'.repeat(500) });
  assert.equal(big.status, 413);
  const ok = await call(handle, { method: 'POST', url: '/api/phone/confirm', body: JSON.stringify({ id, provider: 'gemini' }) });
  assert.equal(JSON.parse(ok.body).result, 'confirmed');
  assert.deepEqual(JSON.parse((await call(handle, { url: '/api/tv/' + id })).body), { state: 'confirmed' });
  assert.equal(logs.join('\n').includes(id), false, 'ids are masked in the server log');
  assert.equal(logs.join('\n').includes(FAKE), false);
});

test('QR test phone page: no storage APIs, sends only id + provider, fake format enforced, permanent warning', () => {
  const dir = new URL('../../scripts/qr-test-page/', import.meta.url);
  const js = code(readFileSync(new URL('app.js', dir), 'utf8'));
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'http://', 'https://', 'fetch(']) {
    assert.equal(js.includes(forbidden), false, 'page script does not use ' + forbidden);
  }
  assert.match(js, /x\.send\(JSON\.stringify\(\{ id: id, provider: provider\.value \}\)\)/, 'only id and provider are sent');
  assert.equal((js.match(/x\.send\(/g) || []).length, 1, 'one request only');
  assert.match(js, /FAKE_KEY_RE = \/\^TEST-\[A-Z\]\{2,20\}-\[0-9\]\{6\}\$\//);
  assert.match(html, /<p class="warn" id="warn">EXPERIMENTAL TEST ONLY – NEVER ENTER A REAL API KEY\.<\/p>/);
  assert.equal(/<script[^>]*src="http/.test(html) || /<link[^>]*href="http/.test(html), false, 'no third-party resources');
});

// ---------------------------------------------------------------- TV screen

function tvEnv(handler) {
  const gem = createFakeGemini(handler);
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), createLogger(50));
  let now = 2000000;
  const timers = [];
  const deps = {
    doc, serverUrl: SERVER, xhrFactory: gem.factory, now: () => now, randomBytes: rnd, pollMs: 10,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, done: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) { t.done = true; } }
  };
  router.register('home', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
  router.register(QR_TEST_SCREEN, (_p, nav) => createQrTestScreen(deps, nav));
  router.resetTo('home');
  const run = async (advance = 0) => {
    now += advance;
    for (let round = 0; round < 6; round++) {
      for (const t of timers.slice()) { if (!t.done && t.at <= now) { t.done = true; t.fn(); } }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const text = () => doc.body.textContent;
  const focused = () => doc.body.findAll('ss-button').filter((b) => /is-focused/.test(b.className)).map((b) => b.textContent);
  return { gem, doc, router, run, text, focused, key: (k) => router.handleKey({ key: k }) };
}

test('QR test TV screen: QR + id shown, Cancel focused, poll → confirmed, no key anywhere', async () => {
  let state = 'waiting';
  const env = tvEnv((req) => (/\/api\/tv\//.test(req.url) ? { status: 200, json: { state } } : { status: 404, json: {} }));
  env.router.push(QR_TEST_SCREEN);
  await env.run();
  assert.match(env.text(), /EXPERIMENTAL TEST ONLY – NEVER ENTER A REAL API KEY/);
  assert.match(env.text(), /Pairing ID: [A-Z0-9]{5}-[A-Z0-9]{5}/);
  assert.match(env.text(), /Expires in 5:00|Expires in 4:59/);
  assert.deepEqual(env.focused(), ['Cancel'], 'Cancel is the initial focus');
  const img = env.doc.body.findAll('ss-qrtest__qr')[0];
  assert.match(img.attributes.src, /^data:image\/svg\+xml/);
  const polled = env.gem.requests.filter((r) => r.method === 'GET');
  assert.ok(polled.length >= 1);
  assert.ok(polled.every((r) => r.url.indexOf(SERVER + '/api/tv/') === 0 && !/key|token/i.test(r.url)));
  state = 'confirmed';
  await env.run(20);
  assert.match(env.text(), /Test pairing confirmed from the phone \(Gemini\)\. No key was transferred or stored\./);
  const n = env.gem.requests.length;
  await env.run(100);
  assert.equal(env.gem.requests.length, n, 'polling stops after confirmation');
});

test('QR test TV screen: expiry after 5 minutes, New code, Cancel and Back end the pairing', async () => {
  const env = tvEnv(() => ({ status: 200, json: { state: 'waiting' } }));
  env.router.push(QR_TEST_SCREEN);
  await env.run();
  const id1 = /Pairing ID: ([A-Z0-9-]+)/.exec(env.text())[1];
  await env.run(PAIRING_TTL_MS + 1000);
  assert.match(env.text(), /This code expired\. Choose New code\./);
  env.key('right'); env.key('ok'); // New code
  await env.run();
  const id2 = /Pairing ID: ([A-Z0-9-]+)/.exec(env.text())[1];
  assert.notEqual(id2, id1);
  assert.match(env.text(), /Waiting for the phone/);
  env.key('left'); env.key('ok'); // Cancel
  await env.run();
  assert.equal(env.router.stack().slice(-1)[0], 'home', 'Cancel closes the screen');
  assert.ok(env.gem.requests.some((r) => r.method === 'POST' && /\/cancel$/.test(r.url)), 'cancel sent to the test server');
  env.router.push(QR_TEST_SCREEN);
  await env.run();
  env.key('back');
  await env.run();
  assert.equal(env.router.stack().slice(-1)[0], 'home', 'Back closes the screen');
});

// ---------------------------------------------------------------- isolation

test('QR test isolation: no imports of key storage, AI settings or playlists; production keys untouched', async () => {
  const dir = new URL('../../src/dev/qr-pairing/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = code(readFileSync(new URL(f, dir), 'utf8'));
    for (const banned of ['/ai/', 'secret-store', 'kv-store', 'playlist', 'keyStore', 'setCredential', 'localStorage']) {
      assert.equal(src.includes(banned), false, f + ' must not reference ' + banned);
    }
  }
  // The dev hook registers the screen with only the documented dependencies; a full flow leaves
  // the production key store (and its Gemini alias) untouched.
  const keys = createMemoryKeyStore();
  await keys.save('ai_key_gemini', 'AIzaREALLOOKINGkey00000000000000000000');
  const before = await keys.load('ai_key_gemini');
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), createLogger(50));
  const gem = createFakeGemini(() => ({ status: 200, json: { state: 'confirmed' } }));
  const hadWindow = 'window' in globalThis;
  const hadDocument = 'document' in globalThis;
  globalThis.window = hadWindow ? globalThis.window : { crypto: globalThis.crypto };
  globalThis.document = doc;
  try {
    const ok = registerQrPairingTest({
      log: createLogger(50), build: { mode: 'dev', version: 't', devSinkUrl: 'http://192.168.1.50:8097/ingest' },
      platform: { xhrFactory: gem.factory, keyStore: { save() { throw new Error('the QR test must never write keys'); }, load: keys.load, remove() { throw new Error('no'); }, persistent: true } },
      app: { ctx: {}, started: { router }, root: doc.body }
    });
    assert.equal(ok, true);
    assert.equal(router.isRegistered(QR_TEST_SCREEN), true);
    router.register('home', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
    router.resetTo('home');
    router.push(QR_TEST_SCREEN);
    await new Promise((r) => setTimeout(r, 30));
    assert.match(doc.body.textContent, /Test pairing confirmed/);
    assert.equal(await keys.load('ai_key_gemini'), before, 'production Gemini key unchanged');
    assert.equal(registerQrPairingTest({ log: createLogger(5), build: { mode: 'release', version: 't', devSinkUrl: '' }, platform: {}, app: { started: { router } } }), false, 'not registered without a dev sink');
  } finally {
    if (!hadWindow) { delete globalThis.window; }
    if (!hadDocument) { delete globalThis.document; }
  }
  const release = readFileSync(new URL('../../src/dev/dev-hooks.release.ts', import.meta.url), 'utf8');
  assert.equal(/qr/i.test(release), false, 'the release stub has no QR code at all');
});
