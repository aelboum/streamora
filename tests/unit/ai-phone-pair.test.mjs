// AI-02 phone pairing (docs/AI-02-PHONE-PAIRING.md): end-to-end encrypted API-key entry by QR.
// Covers the TV crypto (envelopes, tampering, wrong keys, wipe), the QR payload (decoded back from
// the SVG on screen with jsQR; no secret in it), the relay Worker (one-time mailbox, expiry,
// cancel, limits, headers, never holds plaintext), and full runs: real phone page script + real
// Worker + TV screen, with Save, Discard, Back, expiry and a failing store. Fake keys only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import jsQR from 'jsqr';
import nacl from 'tweetnacl';
import {
  b64url, fromB64url, createPairSession, pairUrl, checkCode, openEnvelope, sessionIdFor, SID_RE, PAIR_TTL_MS
} from '../../src/ai/pairing/pair-crypto.ts';
import { createPhonePairScreen, keyPurpose, PHONE_PAIR_SCREEN, maskKey } from '../../src/screens/ai-phone-pair-screen.ts';
import { createAiEngine } from '../../src/ai/ai-engine.ts';
import { qrMatrix, qrImage } from '../../src/components/qr-code.ts';
import { parseXtreamPayload, xtreamPurpose, parseM3uPayload, m3uPurpose } from '../../src/screens/playlist-pair.ts';
import { createPlaylistForm } from '../../src/screens/playlist-form-screen.ts';
import { createPairPanel } from '../../src/components/pair-panel.ts';
import { createConfirmDialog } from '../../src/screens/confirm-dialog.ts';
import { xtreamFromLink } from '../../src/content/credential-template.ts';
import worker, { validEnvelope, TTL_MS, MAX_FAILED_POSTS } from '../../relay/src/worker.js';
import { localEnv } from '../../relay/local-relay.mjs';
import { createRouter } from '../../src/navigation/router.ts';
import { createDomHost } from '../../src/app/dom-host.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createFakeDocument } from '../fakes/fake-dom.mjs';
import { FAKE_KEY } from '../fakes/fake-gemini.mjs';

const BASE = 'https://pair.example.test';
const t = createTranslator('en');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const kvStore = () => createKeyValueStore(createMemoryLocalStore(), createLogger(100));

/** Phone-side sealing, independent of the page script (same algorithm). */
function seal(tvPk, payload, phone = nacl.box.keyPair()) {
  const n = nacl.randomBytes(24);
  const c = nacl.box(new TextEncoder().encode(JSON.stringify(payload)), n, tvPk, phone.secretKey);
  return { env: { v: 1, epk: b64url(phone.publicKey), n: b64url(n), c: b64url(c) }, phone };
}

/** Rebuilds the QR module grid from the SVG path on screen and decodes it with jsQR. */
function decodeQrDataUri(uri) {
  const svg = decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  const full = Number(/viewBox="0 0 (\d+) /.exec(svg)[1]);
  const d = /<path d="([^"]+)"/.exec(svg)[1];
  const grid = new Uint8Array(full * full);
  const re = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  let m;
  while ((m = re.exec(d))) { for (let x = 0; x < Number(m[3]); x++) { grid[Number(m[2]) * full + Number(m[1]) + x] = 1; } }
  const S = 4;
  const w = full * S;
  const rgba = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const v = grid[Math.floor(y / S) * full + Math.floor(x / S)] ? 0 : 255;
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  }
  const r = jsQR(rgba, w, w);
  return r ? r.data : null;
}

// ---------------------------------------------------------------- crypto

test('pairing crypto: base64url round trip, session ids, QR URL carries only public data', () => {
  for (let n = 0; n < 40; n++) {
    const b = nacl.randomBytes(n);
    assert.deepEqual(Array.from(fromB64url(b64url(b))), Array.from(b));
  }
  assert.equal(fromB64url('a+b/'), null);
  const s = createPairSession('gemini');
  assert.match(s.sid, SID_RE);
  const url = pairUrl(BASE + '/', s);
  assert.match(url, /^https:\/\/pair\.example\.test\/#2\.[A-Za-z0-9_-]{43}\.gemini$/);
  assert.equal(url.split('#')[0], BASE + '/', 'nothing but the page address before the fragment');
  assert.equal(url.indexOf(b64url(s.publicKey)) > 0, true, 'public key in the fragment');
  assert.equal(url.indexOf(s.sid), -1, 'session id is derived, not carried');
  const tag = new TextEncoder().encode('ES-PAIR-SID');
  const mm = new Uint8Array(tag.length + 32);
  mm.set(tag);
  mm.set(s.publicKey, tag.length);
  assert.equal(s.sid, b64url(nacl.hash(mm).subarray(0, 16)), 'sid = SHA-512(tag || pk)[0..16]');
  assert.equal(sessionIdFor(s.publicKey), s.sid);
  // Real pairing URL: version 5 at level L (was version 7 at M with the session id in the URL).
  const real = qrMatrix(pairUrl('https://pair.elitestreamplayer.com', s), 'L');
  assert.ok(real.size <= 37, 'QR version <= 5 (' + real.size + ' modules)');
  const im = qrImage(pairUrl('https://pair.elitestreamplayer.com', s), 560, 'L');
  assert.equal(im.px % (real.size + 8), 0, 'whole pixels per module');
  assert.ok(im.px <= 560 && im.px >= 500, 'image ' + im.px + ' px');
  const ids = new Set();
  for (let i = 0; i < 500; i++) { ids.add(createPairSession('gemini').sid); }
  assert.equal(ids.size, 500);
});

test('pairing crypto: envelope opens only with the right TV key, untampered, right provider; wipe ends it', () => {
  const tv = createPairSession('gemini');
  const { env, phone } = seal(tv.publicKey, { v: 1, p: 'gemini', k: FAKE_KEY });
  const other = createPairSession('gemini');
  assert.deepEqual(other.open(env), { ok: false, reason: 'decrypt-failed' }, 'another TV cannot open it');
  const c = fromB64url(env.c); c[5] ^= 1;
  assert.equal(tv.open({ ...env, c: b64url(c) }).reason, 'decrypt-failed', 'tampered box refused');
  assert.equal(tv.open({ ...env, v: 2 }).reason, 'bad-envelope');
  assert.equal(tv.open({ ...env, epk: 'x' }).reason, 'bad-envelope');
  assert.equal(tv.open(seal(tv.publicKey, { v: 1, p: 'openai', k: FAKE_KEY }).env).reason, 'wrong-provider');
  assert.equal(tv.open(seal(tv.publicKey, { v: 1, p: 'gemini' }).env).reason, 'bad-payload');
  const r = tv.open(env);
  assert.equal(r.ok, true);
  assert.equal(r.key, FAKE_KEY);
  assert.equal(r.code, checkCode(tv.publicKey, phone.publicKey));
  assert.match(r.code, /^\d{3} \d{3}$/);
  tv.wipe();
  assert.deepEqual(tv.open(env), { ok: false, reason: 'wiped' });
  // A relay that substitutes its own envelope does not know the TV public key (fragment only):
  const forged = seal(nacl.box.keyPair().publicKey, { v: 1, p: 'gemini', k: 'AIzaATTACKER000000000000000000000000000' }).env;
  const tv2 = createPairSession('gemini');
  assert.equal(tv2.open(forged).reason, 'decrypt-failed');
  assert.equal(openEnvelope(null, tv2.publicKey, new Uint8Array(32), 'gemini').reason, 'bad-envelope');
});

// ---------------------------------------------------------------- relay

const req = (env, method, path, body) => worker.fetch(new Request(BASE + path, { method, body, headers: body ? { 'Content-Type': 'application/json' } : {} }), env);
const jsonOf = async (r) => ({ status: r.status, body: await r.json() });

test('relay: one-time mailbox — waiting, one envelope, delivered once, then gone; status never leaks it', async () => {
  const env = localEnv();
  const tv = createPairSession('gemini');
  const p = '/v1/s/' + tv.sid;
  assert.deepEqual(await jsonOf(await req(env, 'POST', p, JSON.stringify(seal(tv.publicKey, { v: 1, p: 'gemini', k: FAKE_KEY }).env))), { status: 404, body: { error: 'unknown-session' } }, 'only a session the TV opened');
  assert.deepEqual((await jsonOf(await req(env, 'GET', p))).body, { state: 'waiting' });
  const { env: e } = seal(tv.publicKey, { v: 1, p: 'gemini', k: FAKE_KEY });
  assert.equal((await req(env, 'POST', p, JSON.stringify(e))).status, 200);
  assert.deepEqual(await jsonOf(await req(env, 'POST', p, JSON.stringify(e))), { status: 409, body: { error: 'ready' } }, 'second envelope refused');
  assert.deepEqual((await jsonOf(await req(env, 'GET', p + '/status'))).body, { state: 'ready' }, 'status: state only');
  const stored = JSON.stringify([...env.PAIR.objects.get(tv.sid).storage.raw()]);
  assert.equal(stored.includes(FAKE_KEY), false, 'the relay never holds the key in plaintext');
  assert.equal(stored.includes(b64url(tv.publicKey)), false, 'the relay never sees the TV public key');
  const got = await jsonOf(await req(env, 'GET', p));
  assert.equal(got.body.state, 'ready');
  assert.deepEqual(got.body.env, e);
  assert.equal(tv.open(got.body.env).key, FAKE_KEY);
  assert.deepEqual((await jsonOf(await req(env, 'GET', p))).body, { state: 'delivered' }, 'handed over once');
  assert.equal(env.PAIR.objects.get(tv.sid).storage.raw().has('e'), false, 'envelope deleted on delivery');
  assert.ok(env.PAIR.objects.get(tv.sid).storage.alarmAt > 0, 'purge alarm set');
  await env.PAIR.objects.get(tv.sid).obj.alarm();
  assert.equal(env.PAIR.objects.get(tv.sid).storage.size(), 0, 'alarm removes the session record');
});

test('relay: expiry, cancel, strict envelope, attempt lock, size cap, bad ids, CORS and page headers', async () => {
  const env = localEnv();
  const realNow = Date.now;
  try {
    let now = 1e12;
    Date.now = () => now;
    const a = createPairSession('gemini');
    await req(env, 'GET', '/v1/s/' + a.sid);
    now += TTL_MS + 1;
    assert.deepEqual((await jsonOf(await req(env, 'GET', '/v1/s/' + a.sid))).body, { state: 'expired' });
    assert.equal((await req(env, 'POST', '/v1/s/' + a.sid, JSON.stringify(seal(a.publicKey, { v: 1, p: 'gemini', k: FAKE_KEY }).env))).status, 409);
  } finally { Date.now = realNow; }
  const b = createPairSession('gemini');
  await req(env, 'GET', '/v1/s/' + b.sid);
  assert.equal((await req(env, 'POST', '/v1/s/' + b.sid + '/cancel')).status, 200);
  assert.deepEqual((await jsonOf(await req(env, 'GET', '/v1/s/' + b.sid))).body, { state: 'cancelled' });

  const c = createPairSession('gemini');
  await req(env, 'GET', '/v1/s/' + c.sid);
  const good = seal(c.publicKey, { v: 1, p: 'gemini', k: FAKE_KEY }).env;
  assert.equal(validEnvelope(good), true);
  assert.equal(validEnvelope({ ...good, key: FAKE_KEY }), false, 'extra fields refused');
  assert.equal(validEnvelope({ ...good, n: 'short' }), false);
  for (let i = 0; i < MAX_FAILED_POSTS; i++) {
    assert.equal((await req(env, 'POST', '/v1/s/' + c.sid, JSON.stringify({ ...good, key: FAKE_KEY }))).status, 400);
  }
  assert.equal((await req(env, 'POST', '/v1/s/' + c.sid, JSON.stringify(good))).status, 429, 'locked after repeated bad posts');
  assert.equal((await req(env, 'POST', '/v1/s/' + c.sid, 'x'.repeat(5000))).status, 413);
  assert.equal((await req(env, 'GET', '/v1/s/short')).status, 400);
  assert.equal((await req(env, 'GET', '/v1/other')).status, 404);
  const r = await req(env, 'GET', '/v1/s/' + c.sid + '/status');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal((await worker.fetch(new Request(BASE + '/v1/s/' + c.sid, { method: 'OPTIONS' }), env)).status, 204);
  const page = await worker.fetch(new Request(BASE + '/'), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'; script-src 'self'/);
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal((await worker.fetch(new Request(BASE + '/_headers'), env)).status, 404);
});

test('relay files: phone page uses no storage or third-party code; vendored TweetNaCl is the npm 1.0.3 file', () => {
  const html = readFileSync(new URL('../../relay/public/index.html', import.meta.url), 'utf8');
  const js = code(readFileSync(new URL('../../relay/public/app.js', import.meta.url), 'utf8'));
  for (const bad of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'console.', 'XMLHttpRequest']) {
    assert.equal(js.includes(bad), false, 'phone page must not use ' + bad);
  }
  assert.deepEqual([...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]), ['/assets/mark.png', '/assets/mark.png', '/vendor/nacl-fast.min.js', '/app.js']);
  // Resources (scripts, styles, images, icons) are all local; links may only point to the website.
  assert.deepEqual([...html.matchAll(/<link [^>]*href="([^"]+)"/g)].map((m) => m[1]), ['/assets/favicon.png', '/site.css', '/app.css']);
  const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length > 0 && links.every((h) => /^https:\/\/elitestreamplayer\.com\/([a-z]+\/)?$/.test(h)), 'links only to the website');
  assert.equal(/\ssrc="https?:|url\(\s*['"]?https?:/.test(html), false, 'no external resources');
  // One design system: the page's site.css is the website stylesheet (copied by website/build.mjs).
  const siteCss = readFileSync(new URL('../../relay/public/site.css', import.meta.url), 'utf8');
  assert.equal(siteCss.replace(/^\/\*[^\n]*\*\/\n/, ''), readFileSync(new URL('../../website/src/styles.css', import.meta.url), 'utf8'));
  assert.equal(/https?:\/\//.test(siteCss + readFileSync(new URL('../../relay/public/app.css', import.meta.url), 'utf8')), false, 'styles load nothing external');
  assert.deepEqual([...js.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]), ['/v1/s/', '/v1/s/'], 'only the relay API');
  assert.equal(readFileSync(new URL('../../relay/public/vendor/nacl-fast.min.js', import.meta.url)).equals(
    readFileSync(new URL('../../node_modules/tweetnacl/nacl-fast.min.js', import.meta.url))), true);
  const toml = readFileSync(new URL('../../relay/wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /new_sqlite_classes = \["PairSession"\]/);
});

// ---------------------------------------------------------------- full runs

/** XHR stand-in that sends TV requests into the real Worker (async). */
function workerXhr(env, log) {
  return function () {
    return {
      readyState: 0, status: 0, responseText: '', responseURL: undefined, withCredentials: undefined, headers: {},
      onreadystatechange: null, onerror: null, ontimeout: null, onabort: null, onload: null, onprogress: null, aborted: false,
      open(m, u) { this.method = m; this.url = u; this.readyState = 1; },
      setRequestHeader(k, v) { this.headers[k] = v; },
      getResponseHeader() { return null; },
      send(body) {
        log.push({ method: this.method, url: this.url, body });
        worker.fetch(new Request(this.url, { method: this.method, body: this.method === 'POST' ? body : undefined, headers: this.headers }), env)
          .then((r) => r.text().then((txt) => {
            if (this.aborted) { return; }
            this.status = r.status; this.responseURL = this.url; this.readyState = 2;
            if (this.onreadystatechange) { this.onreadystatechange(); }
            this.responseText = txt; this.readyState = 4;
            if (this.onreadystatechange) { this.onreadystatechange(); }
          }));
      },
      abort() { this.aborted = true; }
    };
  };
}

/** Runs relay/public/app.js in a sandbox with a minimal DOM; fetch goes to the real Worker. */
function runPhonePage(env, fragment) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, hidden: true, textContent: '', value: '', type: 'password', className: '', disabled: false, onclick: null });
  const fetches = [];
  const ctx = {
    window: { nacl }, document: { getElementById: el }, location: { hash: fragment, pathname: '/' },
    history: { replaceState() { ctx.location.hash = ''; } }, navigator: {},
    fetch: (u, init) => { fetches.push({ u, init }); return worker.fetch(new Request(BASE + u, init), env); },
    TextEncoder, Uint8Array, setTimeout, Date, JSON, Math, String
  };
  vm.runInNewContext(readFileSync(new URL('../../relay/public/app.js', import.meta.url), 'utf8'), ctx);
  return { el, fetches, ctx };
}

function tvEnv(relayEnv, onSave) {
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), createLogger(50));
  const log = [];
  const engine = createAiEngine({
    kv: kvStore(), keyStore: createMemoryKeyStore(), files: null, xhrFactory: workerXhr(relayEnv, log), log: createLogger(10),
    now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), pairingUrl: BASE
  });
  const saved = [];
  router.register('home', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
  router.register(PHONE_PAIR_SCREEN, (_p, nav) => createPhonePairScreen({
    doc, t, http: engine.pairing.http, baseUrl: engine.pairing.baseUrl,
    purpose: keyPurpose(t, {
      provider: 'gemini', providerName: 'Google Gemini',
      validKey: (k) => /^[A-Za-z0-9_\-]{20,200}$/.test(k),
      saveKey: (k) => { saved.push(k); return onSave ? onSave(k) : Promise.resolve(); },
      onSaved: () => { saved.push('onSaved'); }
    }),
    now: () => Date.now(), pollMs: 5,
    setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimer: (h) => clearTimeout(h)
  }, nav));
  router.resetTo('home');
  const text = () => doc.body.textContent;
  const focused = () => doc.body.findAll('ss-button').filter((b) => /is-focused/.test(b.className)).map((b) => b.textContent);
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  return { doc, router, log, saved, text, focused, wait, engine, key: (k) => router.handleKey({ key: k }) };
}

const qrOf = (env) => decodeQrDataUri(env.doc.body.findAll('ss-pair__qr')[0].attributes.src);

test('phone pairing, full run: QR on the TV → real phone page encrypts → relay → TV shows code → Save', async () => {
  const relay = localEnv();
  const tv = tvEnv(relay);
  tv.router.push(PHONE_PAIR_SCREEN);
  await tv.wait();
  assert.match(tv.text(), /Google Gemini API key with phone/);
  assert.match(tv.text(), /Waiting for your phone/);
  assert.deepEqual(tv.focused(), ['Cancel']);
  const qr = qrOf(tv);
  assert.match(qr, /^https:\/\/pair\.example\.test\/#2\.[A-Za-z0-9_-]{43}\.gemini$/, 'QR on screen decodes to the pairing URL');
  assert.ok(tv.log.length >= 1 && tv.log.every((r) => r.url.indexOf(BASE + '/v1/s/') === 0), 'TV talks only to the relay');

  const phone = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  assert.equal(phone.el('form').hidden, false, 'phone form shown');
  assert.equal(phone.el('bad').hidden, true);
  assert.equal(phone.el('provider').textContent, 'Google Gemini API key');
  assert.equal(phone.el('keyBox').hidden, false, 'key field shown');
  assert.equal(phone.el('xtBox').hidden, true, 'Xtream fields hidden');
  assert.equal(phone.ctx.location.hash, '', 'fragment removed from the address bar');
  const phoneCode = phone.el('code').textContent;
  assert.match(phoneCode, /^\d{3} \d{3}$/);
  phone.el('key').value = '  ' + FAKE_KEY + ' ';
  phone.el('send').onclick();
  assert.equal(phone.el('key').value, '', 'field cleared at once');
  await tv.wait(120);
  const post = phone.fetches.find((f) => f.init && f.init.method === 'POST');
  const body = JSON.parse(post.init.body);
  assert.deepEqual(Object.keys(body).sort(), ['c', 'epk', 'n', 'v'], 'phone sends only the sealed envelope');
  assert.equal(post.init.body.includes(FAKE_KEY), false, 'no plaintext key on the wire');
  assert.equal(post.init.credentials, 'omit');

  assert.ok(tv.text().includes(phoneCode), 'TV shows the same check code as the phone');
  assert.match(tv.text(), /Key received \(AIza…0000, 39 characters\)/);
  assert.equal(tv.text().includes(FAKE_KEY), false, 'the key is never shown in full');
  assert.deepEqual(tv.focused(), ['Discard'], 'Discard is the initial focus');
  assert.deepEqual(tv.saved, [], 'nothing stored before the user confirms');
  tv.key('right'); tv.key('ok');
  await tv.wait();
  assert.deepEqual(tv.saved, [FAKE_KEY, 'onSaved']);
  assert.match(tv.text(), /The Google Gemini API key is stored on this TV/);
  const n = tv.log.length;
  await tv.wait(80);
  assert.equal(tv.log.length, n, 'polling stopped');
  await new Promise((r) => setTimeout(r, 2200)); // the phone page checks the status every 2 s
  assert.match(phone.el('doneMsg').textContent, /The TV received it\. Check that the TV shows code \d{3} \d{3}/);
  tv.key('ok');
  assert.equal(tv.router.stack().slice(-1)[0], 'home');
});

test('phone pairing: Discard stores nothing; Back cancels at the relay; bad links and keys; save failure', async () => {
  const relay = localEnv();
  const tv = tvEnv(relay);
  tv.router.push(PHONE_PAIR_SCREEN);
  await tv.wait();
  let qr = qrOf(tv);
  let phone = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  phone.el('key').value = FAKE_KEY;
  phone.el('send').onclick();
  await tv.wait(120);
  assert.deepEqual(tv.focused(), ['Discard']);
  tv.key('ok');
  await tv.wait();
  assert.deepEqual(tv.saved, [], 'Discard stores nothing');
  assert.equal(tv.router.stack().slice(-1)[0], 'home');

  tv.router.push(PHONE_PAIR_SCREEN);
  await tv.wait();
  qr = qrOf(tv);
  const sid = sessionIdFor(fromB64url(/#2\.([^.]+)\./.exec(qr)[1]));
  tv.key('back');
  await tv.wait();
  assert.equal(tv.router.stack().slice(-1)[0], 'home');
  assert.ok(tv.log.some((r) => r.method === 'POST' && r.url === BASE + '/v1/s/' + sid + '/cancel'), 'Back cancels at the relay');
  phone = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  phone.el('key').value = FAKE_KEY;
  phone.el('send').onclick();
  await tv.wait(40);
  assert.match(phone.el('doneMsg').textContent, /The TV closed this pairing/);

  const bad = runPhonePage(relay, '#v1.short.x.gemini');
  assert.equal(bad.el('bad').hidden, false, 'invalid link refused on the phone');
  const oldFmt = runPhonePage(relay, '#v1.' + 'A'.repeat(22) + '.' + b64url(createPairSession('gemini').publicKey) + '.gemini');
  assert.equal(oldFmt.el('form').hidden, false, 'v1 links still open the form');
  const wrongFmt = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  wrongFmt.el('key').value = 'AIza' + 'x'.repeat(10) + '.' + 'y'.repeat(24);
  wrongFmt.el('send').onclick();
  assert.match(wrongFmt.el('msg').textContent, /does not look like an API key: it has 39 characters and contains a dot \(\.\) at position 15/);
  assert.equal(wrongFmt.el('msg').textContent.indexOf('xxxx'), -1, 'the message never shows the value');
  assert.equal(wrongFmt.fetches.length, 0, 'nothing sent for an invalid key');
  const short = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  short.el('key').value = 'not a key';
  short.el('send').onclick();
  assert.match(short.el('msg').textContent, /too short for an API key \(7 characters\)/);
  // What copying adds (invisible characters, line breaks, quotes) is removed before checking.
  const padded = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  padded.el('key').value = ' “​' + 'AIza' + 'Q'.repeat(17) + '\n' + 'R'.repeat(18) + '﻿” ';
  padded.el('send').onclick();
  assert.equal(padded.fetches.length, 1, 'cleaned key is sent');
  // AI Studio auth keys (since 2026-05-28): "AQ." + letters, digits, -, _ and dots, ~53 characters.
  const aq = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  aq.el('key').value = 'AQ.Ab' + 'c'.repeat(20) + '.' + 'D-e_'.repeat(6) + 'x';
  aq.el('send').onclick();
  assert.equal(aq.fetches.length, 1, 'AQ. key is sent');

  const failing = tvEnv(relay, () => Promise.reject(new Error('store')));
  failing.router.push(PHONE_PAIR_SCREEN);
  await failing.wait();
  qr = qrOf(failing);
  phone = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  phone.el('key').value = FAKE_KEY;
  phone.el('send').onclick();
  await failing.wait(120);
  failing.key('right'); failing.key('ok');
  await failing.wait();
  assert.match(failing.text(), /could not be stored/);
  assert.deepEqual(failing.focused(), ['Cancel']);

  assert.equal(maskKey(FAKE_KEY), 'AIza…0000');
  assert.equal(maskKey('short'), '…');
  assert.equal(PAIR_TTL_MS, TTL_MS, 'TV and relay agree on the lifetime');
});

test('phone pairing: TV expires the code after 5 minutes and offers a new one', async () => {
  const relay = localEnv();
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), createLogger(50));
  let now = 5e12;
  const timers = [];
  const log = [];
  const engine = createAiEngine({ kv: kvStore(), keyStore: createMemoryKeyStore(), files: null, xhrFactory: workerXhr(relay, log), log: createLogger(10), now: () => now, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), pairingUrl: BASE });
  router.register('home', () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} }));
  router.register(PHONE_PAIR_SCREEN, (_p, nav) => createPhonePairScreen({
    doc, t, http: engine.pairing.http, baseUrl: engine.pairing.baseUrl,
    purpose: keyPurpose(t, { provider: 'gemini', providerName: 'Google Gemini', validKey: () => true, saveKey: () => Promise.resolve(), onSaved() {} }),
    now: () => now,
    setTimer: (fn, ms) => { const x = { fn, at: now + ms, done: false }; timers.push(x); return x; }, clearTimer: (x) => { if (x) { x.done = true; } }
  }, nav));
  router.resetTo('home');
  router.push(PHONE_PAIR_SCREEN);
  const run = async (adv = 0) => { now += adv; for (let i = 0; i < 4; i++) { for (const x of timers.slice()) { if (!x.done && x.at <= now) { x.done = true; x.fn(); } } await new Promise((r) => setTimeout(r, 10)); } };
  await run();
  assert.match(doc.body.textContent, /Code expires in (5:00|4:59)/);
  const first = doc.body.findAll('ss-pair__qr')[0].attributes.src;
  await run(PAIR_TTL_MS + 1000);
  assert.match(doc.body.textContent, /This code has expired/);
  assert.ok(log.some((r) => r.method === 'POST' && /\/cancel$/.test(r.url)));
  router.handleKey({ key: 'right' }); router.handleKey({ key: 'ok' });
  await run();
  assert.notEqual(doc.body.findAll('ss-pair__qr')[0].attributes.src, first, 'New code: fresh session and key pair');
  assert.match(doc.body.textContent, /Waiting for your phone/);
});

test('AI engine: pairing only when configured (https); its client reaches only the relay', async () => {
  const base = { kv: kvStore(), keyStore: createMemoryKeyStore(), files: null, xhrFactory: null, log: createLogger(10), now: () => 0, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };
  assert.equal(createAiEngine(base).pairing.baseUrl, 'https://pair.elitestreamplayer.com', 'default: AI_PAIRING_URL');
  assert.equal(createAiEngine({ ...base, pairingUrl: '' }).pairing, null, 'empty: not offered');
  assert.equal(createAiEngine({ ...base, pairingUrl: 'http://pair.example.test' }).pairing, null, 'plain http refused');
  const e = createAiEngine({ ...base, pairingUrl: BASE + '/' });
  assert.equal(e.pairing.baseUrl, BASE);
  const r = await e.pairing.http.request({ method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models', timeoutMs: 1000, maxChars: 100 }).promise;
  assert.equal(r.kind, 'invalid-url', 'the pairing client cannot reach other origins');
});

// ---- Xtream login with the phone ----------------------------------------------------------------

test('Xtream payload: only complete, plain details are accepted', () => {
  const ok = { p: 'xtream', x: { s: ' http://line.example.test:8080/ ', u: ' alice ', w: ' pw with space ', n: 'Home' } };
  assert.deepEqual(parseXtreamPayload(ok), { server: 'http://line.example.test:8080', username: 'alice', password: ' pw with space ', name: 'Home' });
  const bad = [
    { p: 'gemini', x: ok.x },
    { p: 'xtream' },
    { p: 'xtream', x: { s: 'ftp://h', u: 'a', w: 'b' } },
    { p: 'xtream', x: { s: 'http://user@h', u: 'a', w: 'b' } },
    { p: 'xtream', x: { s: 'http://h', u: '', w: 'b' } },
    { p: 'xtream', x: { s: 'http://h', u: 'a', w: '' } },
    { p: 'xtream', x: { s: 'http://h', u: 'a\nb', w: 'c' } },
    { p: 'xtream', x: { s: 'http://h', u: 'a', w: 'c', n: 'x'.repeat(65) } },
    { p: 'xtream', x: { s: 'http://h', u: 'a'.repeat(257), w: 'c' } }
  ];
  for (const b of bad) { assert.equal(parseXtreamPayload(b), null, JSON.stringify(b).slice(0, 80)); }
  // The API-key screen refuses an Xtream payload and the other way round.
  const kp = keyPurpose(t, { provider: 'gemini', providerName: 'G', validKey: () => true, saveKey: () => Promise.resolve(), onSaved() {} });
  assert.equal(kp.accept({ p: 'xtream', x: ok.x }).ok, false);
  assert.equal(xtreamPurpose(t, () => {}).accept({ p: 'gemini', k: FAKE_KEY }).ok, false);
});

test('Xtream with the phone, full run: form → QR → phone page splits a get.php link → TV code → form filled → Save', async () => {
  const relay = localEnv();
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), createLogger(50));
  const log = [];
  const engine = createAiEngine({
    kv: kvStore(), keyStore: createMemoryKeyStore(), files: null, xhrFactory: workerXhr(relay, log), log: createLogger(10),
    now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), pairingUrl: BASE
  });
  const added = [];
  const playlists = {
    add(def) { added.push(def); return Promise.resolve({ ok: true, playlist: { id: 'p1' } }); },
    update() { return Promise.resolve({ ok: true, playlist: { id: 'p1' } }); },
    get() { return null; },
    credentialsPersistent() { return true; }
  };
  const blank = () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} });
  router.register('home', blank);
  router.register('playlist-details', blank);
  router.register('playlist-form', (p, nav) => createPlaylistForm({ doc, playlists, t }, p, nav));
  router.register(PHONE_PAIR_SCREEN, (p, nav) => createPhonePairScreen({
    doc, t, http: engine.pairing.http, baseUrl: engine.pairing.baseUrl, purpose: xtreamPurpose(t, p.fill),
    now: () => Date.now(), pollMs: 5, setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimer: (h) => clearTimeout(h)
  }, nav));
  router.resetTo('home');
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const key = (k) => router.handleKey({ key: k });

  router.push('playlist-form', { mode: 'add-xtream' });
  assert.match(doc.body.textContent, /Fill in with phone \(QR\)/);
  key('ok'); // first row: Fill in with phone
  await wait();
  assert.equal(router.stack().slice(-1)[0], PHONE_PAIR_SCREEN);
  assert.match(doc.body.textContent, /Xtream login with phone/);
  const qr = decodeQrDataUri(doc.body.findAll('ss-pair__qr')[0].attributes.src);
  assert.match(qr, /^https:\/\/pair\.example\.test\/#2\.[A-Za-z0-9_-]{43}\.xtream$/);

  const phone = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  assert.equal(phone.el('provider').textContent, 'Xtream login');
  assert.equal(phone.el('xtBox').hidden, false);
  assert.equal(phone.el('keyBox').hidden, true);
  phone.el('xtServer').value = 'http://line.example.test:8080/get.php?username=alice&password=s3cret%21&type=m3u_plus&output=ts';
  phone.el('xtName').value = 'Home';
  phone.el('send').onclick();
  assert.equal(phone.el('xtServer').value, 'http://line.example.test:8080', 'link split into the server');
  assert.equal(phone.el('xtPass').value, '', 'password field cleared after sealing');
  await wait(200);

  const tvText = doc.body.textContent;
  assert.match(tvText, /Login received: server http:\/\/line\.example\.test:8080, username 5 characters, password 7 characters/);
  assert.ok(tvText.indexOf(phone.el('code').textContent) >= 0, 'TV shows the same check code as the phone');
  assert.equal(/alice|s3cret/.test(tvText), false, 'username and password never shown');
  const posted = phone.fetches.filter((f) => f.init && f.init.method === 'POST').map((f) => f.init.body).join('');
  assert.equal(/alice|s3cret|line\.example/.test(posted), false, 'the relay only sees ciphertext');

  key('right'); // Discard → Use these details
  key('ok');
  await wait();
  assert.equal(router.stack().slice(-1)[0], 'playlist-form', 'back on the form');
  assert.match(doc.body.textContent, /Filled in from your phone/);
  assert.equal(/s3cret/.test(doc.body.textContent), false, 'password shown as dots on the form');
  assert.match(doc.body.textContent, /alice/, 'username shown on the form, as when typed');
  key('ok'); // Save is focused
  await wait();
  assert.deepEqual(added.map((a) => [a.kind, a.server, a.username, a.password, a.name]),
    [['xtream', 'http://line.example.test:8080', 'alice', 's3cret!', 'Home']]);
});

// ---- M3U link with the phone --------------------------------------------------------------------

test('M3U payload: only an http(s) link without spaces is accepted', () => {
  const link = 'http://line.example.test:8080/get.php?username=alice&password=s3cret&type=m3u_plus&output=ts';
  assert.deepEqual(parseM3uPayload({ p: 'm3u', x: { l: ' ' + link + ' ', e: 'https://epg.example.test/guide.xml.gz', n: 'Home' } }),
    { url: link, epg: 'https://epg.example.test/guide.xml.gz', name: 'Home' });
  assert.deepEqual(parseM3uPayload({ p: 'm3u', x: { l: link } }), { url: link, epg: '', name: '' });
  for (const x of [{ l: 'ftp://h/list.m3u' }, { l: 'http://h/a b.m3u' }, { l: '' }, { l: link, e: 'not a url' }, { l: link + '\n' + 'x' }, { l: link, n: 'x'.repeat(65) }, { l: 'http://h/' + 'x'.repeat(2050) }]) {
    assert.equal(parseM3uPayload({ p: 'm3u', x }), null, JSON.stringify(x).slice(0, 60));
  }
  assert.equal(parseM3uPayload({ p: 'xtream', x: { l: link } }), null);
  assert.equal(m3uPurpose(t, () => {}).accept({ p: 'xtream', x: { s: 'http://h', u: 'a', w: 'b' } }).ok, false);
  assert.equal(xtreamPurpose(t, () => {}).accept({ p: 'm3u', x: { l: link } }).ok, false);
});

test('M3U with the phone, full run: form → QR → phone page → TV code (link masked) → form filled → Save', async () => {
  const relay = localEnv();
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), createLogger(50));
  const engine = createAiEngine({
    kv: kvStore(), keyStore: createMemoryKeyStore(), files: null, xhrFactory: workerXhr(relay, []), log: createLogger(10),
    now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), pairingUrl: BASE
  });
  const added = [];
  const playlists = {
    add(def) { added.push(def); return Promise.resolve({ ok: true, playlist: { id: 'p1' } }); },
    update() { return Promise.resolve({ ok: true, playlist: { id: 'p1' } }); },
    get() { return null; },
    credentialsPersistent() { return true; }
  };
  const blank = () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} });
  router.register('home', blank);
  router.register('playlist-details', blank);
  router.register('confirm', (p, nav) => createConfirmDialog(doc, p, nav));
  router.register('playlist-form', (p, nav) => createPlaylistForm({ doc, playlists, t }, p, nav));
  router.register(PHONE_PAIR_SCREEN, (p, nav) => createPhonePairScreen({
    doc, t, http: engine.pairing.http, baseUrl: engine.pairing.baseUrl, purpose: m3uPurpose(t, p.fill),
    now: () => Date.now(), pollMs: 5, setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimer: (h) => clearTimeout(h)
  }, nav));
  router.resetTo('home');
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const key = (k) => router.handleKey({ key: k });

  router.push('playlist-form', { mode: 'add-m3u' });
  assert.match(doc.body.textContent, /Fill in with phone \(QR\)/);
  assert.match(doc.body.textContent, /Paste the playlist link on your phone/);
  key('ok');
  await wait();
  assert.match(doc.body.textContent, /M3U playlist with phone/);
  const qr = decodeQrDataUri(doc.body.findAll('ss-pair__qr')[0].attributes.src);
  assert.match(qr, /^https:\/\/pair\.example\.test\/#2\.[A-Za-z0-9_-]{43}\.m3u$/);

  const phone = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  assert.equal(phone.el('bad').hidden, true, 'the m3u kind is accepted');
  assert.equal(phone.el('provider').textContent, 'M3U playlist link');
  assert.equal(phone.el('m3uBox').hidden, false);
  assert.equal(phone.el('xtBox').hidden, true);
  assert.equal(phone.el('keyBox').hidden, true);
  const link = 'http://line.example.test:8080/get.php?username=alice&password=s3cret&type=m3u_plus&output=ts';
  phone.el('m3uLink').value = link;
  phone.el('m3uEpg').value = 'https://epg.example.test/guide.xml.gz';
  phone.el('send').onclick();
  assert.equal(phone.el('m3uLink').value, '', 'link field cleared after sealing');
  await wait(200);

  const tvText = doc.body.textContent;
  assert.match(tvText, /Playlist link received: http:\/\/line\.example\.test:8080\/get\.php/);
  assert.equal(/alice|s3cret/.test(tvText), false, 'credentials in the link are masked on the TV');
  assert.ok(tvText.indexOf(phone.el('code').textContent) >= 0, 'same check code');
  const posted = phone.fetches.filter((f) => f.init && f.init.method === 'POST').map((f) => f.init.body).join('');
  assert.equal(/alice|s3cret|line\.example/.test(posted), false, 'the relay only sees ciphertext');

  key('right');
  key('ok'); // Use this link
  await wait();
  assert.equal(router.stack().slice(-1)[0], 'playlist-form');
  assert.match(doc.body.textContent, /Filled in from your phone/);
  assert.equal(/alice|s3cret/.test(doc.body.textContent), false, 'link masked on the form');
  key('ok'); // Save
  // The link is an Xtream login (get.php with username and password): offered as Xtream.
  assert.equal(router.overlay(), 'confirm');
  assert.match(doc.body.textContent, /This is an Xtream link/);
  key('ok'); // Add as Xtream account
  await wait();
  assert.deepEqual(added.map((a) => [a.kind, a.server, a.username, a.password, a.epgUrl]),
    [['xtream', 'http://line.example.test:8080', 'alice', 's3cret', 'https://epg.example.test/guide.xml.gz']]);
});

// ---- Add forms: QR code on the left, input fields on the right ------------------------------------

test('Add Xtream form: QR panel on the left, fields on the right; phone details fill the fields, Save focused', async () => {
  const relay = localEnv();
  const doc = createFakeDocument();
  const router = createRouter(createDomHost(doc, doc.body), createLogger(50));
  const engine = createAiEngine({
    kv: kvStore(), keyStore: createMemoryKeyStore(), files: null, xhrFactory: workerXhr(relay, []), log: createLogger(10),
    now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), pairingUrl: BASE
  });
  const added = [];
  const playlists = {
    add(def) { added.push(def); return Promise.resolve({ ok: true, playlist: { id: 'p1' } }); },
    update() { return Promise.resolve({ ok: true, playlist: { id: 'p1' } }); },
    get() { return null; },
    credentialsPersistent() { return true; }
  };
  const blank = () => ({ mount() {}, onShow() {}, onHide() {}, onKey: () => false, onBack: () => false, destroy() {} });
  router.register('home', blank);
  router.register('playlist-details', blank);
  router.register(PHONE_PAIR_SCREEN, blank); // registered, but the Add form embeds the panel instead
  const pairPanel = (purpose, ev) => createPairPanel({
    doc, t, http: engine.pairing.http, baseUrl: engine.pairing.baseUrl, purpose, now: () => Date.now(), pollMs: 5,
    setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimer: (h) => clearTimeout(h), qrMaxPx: 420, embedded: true
  }, ev);
  router.register('playlist-form', (p, nav) => createPlaylistForm({ doc, playlists, t, pairPanel }, p, nav));
  router.resetTo('home');
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const key = (k) => router.handleKey({ key: k });
  const focused = () => doc.body.findAll('is-focused').map((b) => b.textContent);

  router.push('playlist-form', { mode: 'add-xtream' });
  await wait();
  const split = doc.body.findAll('ss-form-split');
  assert.equal(split.length, 1, 'split layout');
  const [left, right] = split[0].childNodes;
  assert.match(left.className, /ss-form-split__pair/);
  assert.equal(left.findAll('ss-pair__qr').length, 1, 'QR code in the left panel');
  assert.match(right.textContent, /Name/);
  assert.equal(/Fill in with phone/.test(right.textContent), false, 'no phone row among the fields');
  const img = left.findAll('ss-pair__qr')[0];
  assert.ok(parseInt(img.style.width, 10) <= 420, 'QR fits the left panel');
  assert.equal(focused().length, 1);
  assert.match(focused()[0], /Name/, 'focus starts on the first field');
  key('left');
  assert.deepEqual(focused(), ['New code'], 'Left moves to the panel');
  key('right');
  assert.match(focused()[0], /Name/, 'Right moves back to the fields');

  const qr = decodeQrDataUri(img.attributes.src);
  assert.match(qr, /#2\.[A-Za-z0-9_-]{43}\.xtream$/);
  const phone = runPhonePage(relay, qr.slice(qr.indexOf('#')));
  phone.el('xtServer').value = 'https://panel.example.test';
  phone.el('xtUser').value = 'bob';
  phone.el('xtPass').value = 'hunter22';
  phone.el('send').onclick();
  await wait(200);
  assert.ok(left.textContent.indexOf(phone.el('code').textContent) >= 0, 'check code in the left panel');
  assert.deepEqual(focused(), ['Discard'], 'details arrived: focus on Discard in the panel');
  key('right');
  key('ok'); // Use these details
  await wait();
  assert.equal(router.stack().slice(-1)[0], 'playlist-form', 'still on the form');
  assert.match(left.textContent, /Filled in on the right/);
  assert.match(doc.body.textContent, /Filled in from your phone/);
  assert.deepEqual(focused(), ['Save'], 'Save focused');
  assert.match(right.textContent, /panel\.example\.test/);
  assert.equal(/hunter22/.test(doc.body.textContent), false, 'password shown as dots');
  key('ok');
  await wait();
  assert.deepEqual(added.map((a) => [a.kind, a.server, a.username, a.password]), [['xtream', 'https://panel.example.test', 'bob', 'hunter22']]);
});

test('xtreamFromLink: get.php / player_api.php links with a login become an Xtream server and login', () => {
  assert.deepEqual(xtreamFromLink('http://line.example.test:8080/get.php?username=alice&password=s3cret&type=m3u_plus&output=ts'),
    { server: 'http://line.example.test:8080', username: 'alice', password: 's3cret' });
  assert.deepEqual(xtreamFromLink(' https://h.test/pre/fix/player_api.php?username=ab&password=c%26d '),
    { server: 'https://h.test/pre/fix', username: 'ab', password: 'c&d' });
  for (const u of ['http://h.test/list.m3u', 'http://h.test/get.php?type=m3u', 'http://u@h.test/get.php?username=ab&password=cd', 'ftp://h.test/get.php?username=ab&password=cd', '']) {
    assert.equal(xtreamFromLink(u), null, u);
  }
});
