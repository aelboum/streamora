// EliteStream website: build output, routing through the real Worker (www, trailing slash, 404),
// security and cache headers, links, CSP compatibility (no inline styles or scripts) and content.
// Run: npm run build && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import worker, { SECURITY_HEADERS } from '../worker.js';
import { createAssets } from '../preview.mjs';
import { PAGES, TITLES, FEATURES, FAQ } from '../src/data.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const env = { ASSETS: createAssets() };
const get = (path, host = 'elitestreamplayer.com', method = 'GET') => worker.fetch(new Request('https://' + host + path, { method }), env);
const pagePath = (p) => (p === 'home' ? '/' : '/' + p + '/');
const html = (p) => readFileSync(join(dist, p === 'home' ? '' : p, 'index.html'), 'utf8');

test('build: every designed page plus 404, hashed assets, fonts, logo', () => {
  assert.ok(existsSync(dist), 'run npm run build first');
  for (const p of PAGES) { assert.ok(existsSync(join(dist, p === 'home' ? '' : p, 'index.html')), p); }
  assert.ok(existsSync(join(dist, '404.html')));
  const files = readdirSync(dist);
  assert.ok(files.some((f) => /^styles\.[0-9a-f]{10}\.css$/.test(f)) && files.some((f) => /^site\.[0-9a-f]{10}\.js$/.test(f)));
  assert.deepEqual(readdirSync(join(dist, 'fonts')).sort(), ['LICENSE.txt', 'dm-sans-latin-opsz-normal.woff2', 'jetbrains-mono-latin-400-normal.woff2', 'sora-latin-400-normal.woff2', 'sora-latin-600-normal.woff2']);
  assert.ok(existsSync(join(dist, 'assets/mark.png')) && existsSync(join(dist, 'assets/favicon.png')));
});

test('routing: direct access and refresh work for every page; trailing slash; 404; www → apex', async () => {
  for (const p of PAGES) {
    const r = await get(pagePath(p));
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), new RegExp('<title>' + TITLES[p].replace(/[&]/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</title>'), p);
  }
  const noSlash = await get('/features');
  assert.equal(noSlash.status, 307);
  assert.equal(noSlash.headers.get('Location'), '/features/');
  const missing = await get('/no-such-page/');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /This page does not exist/);
  const www = await get('/support/?x=1', 'www.elitestreamplayer.com');
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('Location'), 'https://elitestreamplayer.com/support/?x=1');
  assert.equal((await get('/', 'elitestreamplayer.com', 'POST')).status, 405);
  assert.equal((await get('/', 'elitestreamplayer.com', 'HEAD')).status, 200);
});

test('headers: security on every response; long cache only for hashed files and fonts', async () => {
  const css = readdirSync(dist).find((f) => /^styles\./.test(f));
  for (const path of ['/', '/support/', '/no-such-page/', '/' + css, '/fonts/sora-latin-600-normal.woff2', '/assets/mark.png']) {
    const r = await get(path);
    for (const k in SECURITY_HEADERS) { assert.equal(r.headers.get(k), SECURITY_HEADERS[k], path + ' ' + k); }
  }
  assert.match(SECURITY_HEADERS['Content-Security-Policy'], /default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.equal((await get('/')).headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.equal((await get('/' + css)).headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await get('/fonts/sora-latin-600-normal.woff2')).headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await get('/assets/mark.png')).headers.get('Cache-Control'), 'public, max-age=604800');
});

test('pages work under the strict CSP: no inline styles, inline scripts (except JSON-LD) or external resources', () => {
  for (const p of PAGES.concat(['404'])) {
    const h = p === '404' ? readFileSync(join(dist, '404.html'), 'utf8') : html(p);
    assert.equal(/\sstyle=/.test(h), false, p + ': inline style');
    assert.equal(/\son[a-z]+=/.test(h), false, p + ': inline handler');
    const scripts = [...h.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    for (const s of scripts) { assert.ok(/src="\/site\.[0-9a-f]{10}\.js"/.test(s[1]) || /application\/ld\+json/.test(s[1]), p + ': inline script'); }
    for (const m of h.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
      assert.ok(/^\/[^/]/.test(m[1]) || m[1] === '/' || m[1] === '#main' || /^https:\/\/elitestreamplayer\.com\//.test(m[1]), p + ': ' + m[1]);
    }
  }
});

test('links: every internal link and asset resolves', async () => {
  const seen = new Set();
  for (const p of PAGES.concat(['404'])) {
    const h = p === '404' ? readFileSync(join(dist, '404.html'), 'utf8') : html(p);
    for (const m of h.matchAll(/\s(?:src|href)="(\/[^"#]*)"/g)) { seen.add(m[1]); }
  }
  assert.ok(seen.size >= 14, String(seen.size));
  for (const path of seen) { assert.equal((await get(path)).status, 200, path); }
});

test('content follows the design: navigation, current page, features, FAQ, statuses, no fake downloads', () => {
  const home = html('home');
  assert.match(home, /Your Entertainment\. Your Way\./);
  assert.match(home, /aria-current="page">Home</);
  for (const f of FEATURES) { assert.ok(home.includes(f.title.replace('&', '&amp;')), f.title); }
  assert.equal((home.match(/In development/g) || []).length, 4, 'four platforms, design default status');
  assert.match(html('features'), /aria-current="page">Features</);
  const support = html('support');
  assert.equal((support.match(/class="faq-group"/g) || []).length, FAQ.length);
  assert.equal((support.match(/class="faq-group" id="faq-g[0-9]+" hidden/g) || []).length, FAQ.length - 1, 'one topic shown at a time');
  const dl = html('downloads');
  assert.equal((dl.match(/Coming soon/g) || []).length, 4);
  assert.equal(/\.(apk|wgt|ipk)"/.test(dl), false, 'no download files are offered');
  assert.match(html('about'), /Legal &amp; trust/);
});

test('site.js: old prototype links (#/features) go to the real page; unknown hashes are ignored', () => {
  const code = readFileSync(join(dist, readdirSync(dist).find((f) => /^site\./.test(f))), 'utf8');
  function run(hash, pathname) {
    const replaced = [];
    const ctx = { location: { hash, pathname, replace: (u) => replaced.push(u) }, document: { readyState: 'loading', addEventListener() {} } };
    vm.runInNewContext(code, ctx);
    return replaced;
  }
  assert.deepEqual(run('#/features', '/'), ['/features/']);
  assert.deepEqual(run('#/', '/about/'), ['/']);
  assert.deepEqual(run('#/evil.example', '/'), []);
  assert.deepEqual(run('#/admin', '/'), []);
  assert.deepEqual(run('#main', '/'), []);
});
