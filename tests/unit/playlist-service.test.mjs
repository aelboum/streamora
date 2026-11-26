// PlaylistService: definitions and credentials, import into the catalogue store, incremental
// updates, interrupted-import recovery, cached loading, play-time resolution, credential hygiene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlaylistService, MAX_PLAYLISTS } from '../../src/services/playlist-service.ts';
import { createKeyValueStore, KV_PREFIX } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';

const m3u = (name) => readFileSync(new URL('../fixtures/m3u/' + name, import.meta.url), 'utf8');
const xt = (name) => readFileSync(new URL('../fixtures/xtream/' + name, import.meta.url), 'utf8');
const PASS = 'demo_pass_9f3k';
const PL_URL = 'http://provider.example:8080/get.php?username=demo_user&password=' + PASS + '&type=m3u_plus';
const XT_INPUT = { name: 'My Xtream', kind: 'xtream', server: 'provider.example:8080', username: 'demo_user', password: PASS };

/** Builds a service over memory stores. `stores` lets a second instance share them (simulated restart). */
function setup(route, stores) {
  const s = stores || {
    local: createMemoryLocalStore(), files: createMemoryFileStore(), keys: createMemoryKeyStore(), writes: [], failWrite: null
  };
  const files = {
    atomicReplace: true,
    read: (n) => s.files.read(n),
    write: (n, t) => {
      if (s.failWrite && s.failWrite(n)) return Promise.reject(new Error('disk error'));
      s.writes.push(n);
      return s.files.write(n, t);
    },
    remove: (n) => s.files.remove(n),
    list: () => s.files.list()
  };
  let t = 1763856000000;
  const now = () => (t += 7);
  const log = createLogger(2000, now);
  const kv = createKeyValueStore(s.local, log);
  const srv = createFakeServer((url, n) => route.fn(url, n));
  const svc = createPlaylistService({
    kv, catalogue: createCatalogueStore(files, { budgetChars: 5000000, maxChars: 20000000 }, now, log),
    secrets: createSecretStore(s.keys), http: createHttpClient({ xhrFactory: srv.factory }), now, log: log.child('playlists'),
    timers: { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) },
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000 }
  });
  return { svc, s, srv, log, kv };
}

function m3uRoute(body) {
  return { fn: () => ({ status: 200, body: body, chunk: 211 }) };
}

function xtreamRoute(overrides = {}) {
  return {
    fn: (url) => {
      const a = (/[?&]action=([a-z_]+)/.exec(url) || [])[1] || '';
      if (overrides[a]) return overrides[a]();
      if (a === '') return { status: 200, body: xt('auth-ok.json') };
      if (a === 'get_live_categories') return { status: 200, body: xt('live-categories.json') };
      if (a === 'get_live_streams') return { status: 200, body: xt('live-streams.json'), chunk: 50 };
      return { status: 404, body: '' };
    }
  };
}

/** Everything persisted outside the key store, plus the log. */
function persistedText(env) {
  const parts = [];
  for (const k of env.s.local.keys()) parts.push(k + '=' + env.s.local.getItem(k));
  return env.s.files.list().then((names) => {
    for (const n of names) parts.push(n + '=' + env.s.files.peek(n));
    parts.push(JSON.stringify(env.log.entries()));
    return parts.join('\n');
  });
}

test('add: validation, definition without secrets, credentials only in the key store', async () => {
  const env = setup(m3uRoute(''));
  const bad = [
    [{ name: '', kind: 'm3u', url: PL_URL }, 'invalid-name'],
    [{ name: 'x', kind: 'm3u', url: 'javascript:alert(1)' }, 'invalid-url'],
    [{ name: 'x', kind: 'm3u', url: 'http://u:p@h.example/l.m3u' }, 'invalid-url'],
    [{ name: 'x', kind: 'xtream', server: 'h.example/path', username: 'a', password: 'b' }, 'invalid-url'],
    [{ name: 'x', kind: 'xtream', server: 'h.example', username: '', password: 'b' }, 'invalid-credentials'],
    [{ name: 'x', kind: 'm3u', url: PL_URL, epgUrl: 'file:///etc/x' }, 'invalid-url'],
    [{ name: 'x', kind: 'iptv', url: PL_URL }, 'invalid-url']
  ];
  for (const [input, code] of bad) {
    const r = await env.svc.add(input);
    assert.deepEqual([r.ok, r.code], [false, code], JSON.stringify(input));
  }
  assert.equal(env.s.keys.count(), 0);
  const a = await env.svc.add({ name: '  Home\u0000 list ', kind: 'm3u', url: PL_URL, epgUrl: 'http://epg.example.org/g.xml' });
  assert.equal(a.ok, true);
  assert.deepEqual(a.playlist, {
    id: a.playlist.id, name: 'Home list', kind: 'm3u', server: 'http://provider.example:8080', liveFormat: 'ts',
    addedAt: a.playlist.addedAt, epgUrl: 'http://epg.example.org/g.xml'
  });
  const x = await env.svc.add(XT_INPUT);
  assert.equal(x.playlist.server, 'http://provider.example:8080');
  assert.deepEqual(env.svc.list().map((p) => p.id), [a.playlist.id, x.playlist.id]);
  assert.equal(env.svc.activeId(), a.playlist.id, 'first playlist becomes active');
  assert.equal(env.s.keys.count(), 2);
  assert.match(await env.s.keys.load('ss_pl_' + x.playlist.id), /demo_pass_9f3k/);
  assert.equal((await persistedText(env)).indexOf(PASS), -1, 'no password in localStorage, files or logs');
});

test('add: playlist limit; secret-store failure leaves nothing behind', async () => {
  const env = setup(m3uRoute(''));
  for (let i = 0; i < MAX_PLAYLISTS; i++) assert.equal((await env.svc.add({ name: 'P' + i, kind: 'm3u', url: 'http://h.example/' + i + '.m3u' })).ok, true);
  assert.equal((await env.svc.add({ name: 'one more', kind: 'm3u', url: 'http://h.example/x.m3u' })).code, 'limit');
  const env2 = setup(m3uRoute(''));
  env2.s.keys.save = () => Promise.reject(new Error('keymanager unavailable'));
  const r = await env2.svc.add(XT_INPUT);
  assert.deepEqual([r.ok, r.code], [false, 'storage']);
  assert.equal(env2.svc.list().length, 0);
});

test('update, switch and remove', async () => {
  const env = setup(m3uRoute(''));
  const a = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  const b = (await env.svc.add(XT_INPUT)).playlist;
  env.svc.markCleartextNoticeSeen(b.id);
  let u = await env.svc.update(b.id, { name: 'Renamed', liveFormat: 'm3u8', epgUrl: 'http://epg.example.org/x.xml' });
  assert.deepEqual([u.playlist.name, u.playlist.liveFormat, u.playlist.epgUrl], ['Renamed', 'm3u8', 'http://epg.example.org/x.xml']);
  u = await env.svc.update(b.id, { epgUrl: null });
  assert.equal(u.playlist.epgUrl, undefined);
  u = await env.svc.update(b.id, { password: 'new_secret_1' });
  assert.equal(u.ok, true);
  assert.match(await env.s.keys.load('ss_pl_' + b.id), /"username":"demo_user","password":"new_secret_1"/, 'username kept, password replaced');
  assert.equal(env.svc.get(b.id).cleartextNoticeSeen, true, 'same server: notice state kept');
  u = await env.svc.update(b.id, { server: 'http://other.example:2095' });
  assert.equal(u.playlist.server, 'http://other.example:2095');
  assert.equal(env.svc.get(b.id).cleartextNoticeSeen, undefined, 'new server: notice shown again');
  assert.equal((await env.svc.update(b.id, { username: '' })).code, 'invalid-credentials');
  assert.equal((await env.svc.update('nope', { name: 'x' })).code, 'not-found');
  assert.equal(env.svc.setActive(b.id), true);
  assert.equal(env.svc.activeId(), b.id);
  assert.equal(env.svc.setActive('unknown'), false);
  env.s.files.poke('cat.' + b.id + '.live.json', 'x');
  await env.svc.remove(b.id);
  assert.equal(env.svc.get(b.id), null);
  assert.equal(await env.s.keys.load('ss_pl_' + b.id), null, 'credentials removed');
  assert.deepEqual(await env.s.files.list(), [], 'catalogue files removed');
  assert.equal(env.svc.activeId(), a.id, 'active moves to a remaining playlist');
});

test('M3U refresh end to end: catalogue persisted, loaded back, status recorded', async () => {
  const env = setup(m3uRoute(m3u('provider-extended.m3u')));
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  assert.equal((await env.svc.loadLive(p.id)).status, 'missing');
  const progress = [];
  const r = await env.svc.refresh(p.id, (x) => progress.push(x)).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.counts, { live: 10, movie: 2, series: 1, invalid: 0, duplicate: 1 });
  assert.equal(r.unchanged, false);
  assert.deepEqual(await env.s.files.list(), ['cat.' + p.id + '.live.json', 'cat.' + p.id + '.meta.json']);
  const l = await env.svc.loadLive(p.id);
  assert.equal(l.status, 'ok');
  assert.equal(l.catalogue.channels.length, 10);
  assert.equal(l.catalogue.categories.length, 8);
  assert.equal(l.meta.kind, 'm3u');
  assert.deepEqual(l.meta.counts, r.counts);
  const def = env.svc.get(p.id);
  assert.equal(def.lastStatus.ok, true);
  assert.equal(typeof def.lastLoadedAt, 'number');
  assert.equal(env.svc.importing(), null);
  assert.equal(env.kv.get('import.journal', () => true, null), null, 'journal cleared');
  assert.equal((await persistedText(env)).indexOf(PASS), -1, 'no password in catalogue, KV or logs');
});

test('incremental update: unchanged catalogue is not rewritten; a change is', async () => {
  const route = m3uRoute(m3u('provider-extended.m3u'));
  const env = setup(route);
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  await env.svc.refresh(p.id).result;
  const live = 'cat.' + p.id + '.live.json';
  const writesAfterFirst = env.s.writes.filter((n) => n === live).length;
  const second = await env.svc.refresh(p.id).result;
  assert.equal(second.ok, true);
  assert.equal(second.unchanged, true);
  assert.equal(env.s.writes.filter((n) => n === live).length, writesAfterFirst, 'live section not rewritten');
  assert.equal((await env.svc.loadLive(p.id)).status, 'ok', 'meta still matches the kept live file');
  route.fn = () => ({ status: 200, body: m3u('provider-extended.m3u').replace(/,News Two$/m, ',News Two Plus') });
  const third = await env.svc.refresh(p.id).result;
  assert.equal(third.unchanged, false);
  assert.equal(env.s.writes.filter((n) => n === live).length, writesAfterFirst + 1);
  const l = await env.svc.loadLive(p.id);
  assert.ok(l.catalogue.channels.some((c) => c.name === 'News Two Plus'));
});

test('Xtream refresh: account details recorded; expired account keeps the old catalogue', async () => {
  const route = xtreamRoute();
  const env = setup(route);
  const p = (await env.svc.add(XT_INPUT)).playlist;
  const r = await env.svc.refresh(p.id).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.counts, { live: 7, movie: 0, series: 0, invalid: 3, duplicate: 1 });
  const st = env.svc.get(p.id).lastStatus;
  assert.deepEqual([st.ok, st.expiresAt, st.maxConnections], [true, 1893456000000, 2]);
  const l = await env.svc.loadLive(p.id);
  assert.equal(l.catalogue.channels.length, 7);
  assert.deepEqual(l.meta.epg, [{ kind: 'xtream' }]);
  const orphan = l.catalogue.channels.find((c) => c.name === 'Unknown Category');
  assert.equal(orphan.categoryId, '_');
  assert.equal(l.catalogue.channels.find((c) => c.name === 'Sport Max 1').logo, undefined, 'javascript: icon dropped');
  assert.equal(l.catalogue.channels.find((c) => c.name === 'Late Night').adult, true);
  route.fn = xtreamRoute({ '': () => ({ status: 200, body: xt('auth-expired.json') }) }).fn;
  const e = await env.svc.refresh(p.id).result;
  assert.deepEqual([e.ok, e.code], [false, 'expired']);
  assert.equal(env.svc.get(p.id).lastStatus.code, 'expired');
  assert.equal((await env.svc.loadLive(p.id)).status, 'ok', 'previous catalogue still usable');
  assert.equal((await persistedText(env)).indexOf(PASS), -1);
});

test('failed refresh keeps the previous catalogue; busy and abort', async () => {
  const route = m3uRoute(m3u('provider-extended.m3u'));
  const env = setup(route);
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  await env.svc.refresh(p.id).result;
  route.fn = () => ({ fail: 'network' });
  const f = await env.svc.refresh(p.id).result;
  assert.deepEqual([f.ok, f.code], [false, 'network']);
  assert.equal(env.svc.get(p.id).lastStatus.code, 'network');
  assert.equal((await env.svc.loadLive(p.id)).catalogue.channels.length, 10);

  route.fn = () => ({ fail: 'hang' });
  const job = env.svc.refresh(p.id);
  assert.equal((await env.svc.refresh(p.id).result).code, 'busy');
  await new Promise((r) => setImmediate(r));
  job.abort();
  const ab = await job.result;
  assert.deepEqual([ab.ok, ab.code], [false, 'aborted']);
  assert.equal(env.svc.importing(), null);
  assert.equal((await env.svc.loadLive(p.id)).status, 'ok');
});

test('interrupted import: detected after a restart; temp and orphaned files cleaned up', async () => {
  const route = m3uRoute(m3u('provider-extended.m3u'));
  const env = setup(route);
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  await env.svc.refresh(p.id).result;
  route.fn = () => ({ fail: 'hang' });
  env.svc.refresh(p.id); // never completes: the app "crashes" here
  await new Promise((r) => setImmediate(r));
  assert.ok(env.kv.get('import.journal', () => true, null), 'journal written while importing');
  env.s.files.poke('cat.' + p.id + '.live.json.tmp', 'half-written');
  env.s.files.poke('cat.zzz.live.json', 'orphan of a deleted playlist');
  env.s.files.poke('other.json', 'not ours');

  const restarted = setup(m3uRoute(''), env.s);
  const rep = await restarted.svc.recover();
  // DI-1 contract change: the orphan of an unknown playlist (no tombstone) is kept; the temp file goes.
  assert.deepEqual(rep, { interrupted: p.id, removedFiles: 1 });
  assert.equal(restarted.svc.get(p.id).lastStatus.code, 'interrupted');
  assert.deepEqual(await env.s.files.list(), ['cat.' + p.id + '.live.json', 'cat.' + p.id + '.meta.json', 'cat.zzz.live.json', 'other.json']);
  assert.equal((await restarted.svc.loadLive(p.id)).status, 'ok', 'last complete catalogue survives');
  assert.deepEqual(await restarted.svc.recover(), { interrupted: null, removedFiles: 0 }, 'idempotent');
});

test('crash between the live and meta writes is detected as inconsistent', async () => {
  const route = m3uRoute(m3u('provider-extended.m3u'));
  const env = setup(route);
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  await env.svc.refresh(p.id).result;
  route.fn = () => ({ status: 200, body: m3u('provider-extended.m3u').replace(/,News Two$/m, ',Changed') });
  env.s.failWrite = (n) => n.indexOf('.meta.json') > 0;
  const r = await env.svc.refresh(p.id).result;
  assert.deepEqual([r.ok, r.code], [false, 'storage']);
  const l = await env.svc.loadLive(p.id);
  assert.equal(l.status, 'inconsistent');
  env.s.failWrite = null;
  assert.equal((await env.svc.refresh(p.id).result).ok, true, 're-import repairs it');
  assert.equal((await env.svc.loadLive(p.id)).status, 'ok');
});

test('corrupt or tampered catalogue files are reported and removed', async () => {
  const env = setup(m3uRoute(m3u('provider-extended.m3u')));
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  await env.svc.refresh(p.id).result;
  const name = 'cat.' + p.id + '.live.json';
  const text = env.s.files.peek(name);
  env.s.files.poke(name, text.substring(0, text.length - 10));
  const l = await env.svc.loadLive(p.id);
  assert.equal(l.status, 'corrupt');
  assert.equal(env.s.files.peek(name), null);
  assert.equal((await env.svc.loadLive('../etc')).status, 'error');
});

test('play-time resolution: Xtream refs, placeholders, plain URLs; never without the secret', async () => {
  const env = setup(m3uRoute(m3u('provider-extended.m3u')));
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  await env.svc.refresh(p.id).result;
  const ch = (await env.svc.loadLive(p.id)).catalogue.channels;
  const by = (n) => ch.find((c) => c.name === n);
  assert.deepEqual(await env.svc.resolvePlayback(p.id, by('News One HD')),
    { url: 'http://provider.example:8080/live/demo_user/' + PASS + '/1001.ts', type: 'ts', live: true });
  assert.equal((await env.svc.resolvePlayback(p.id, by('Sport Max 1'))).type, 'hls');
  assert.deepEqual(await env.svc.resolvePlayback(p.id, by('Kids Fun')), {
    url: 'http://cdn2.example.net:8000/demo_user/' + PASS + '/2001.ts', type: 'ts', live: true,
    userAgent: 'ExamplePlayer/2.1', referrer: 'http://portal.example.org/'
  });
  assert.deepEqual(await env.svc.resolvePlayback(p.id, by('Nieuws 24')),
    { url: 'http://free-tv.example.com/hls/nieuws24/index.m3u8?token=abc', type: 'hls', live: true, userAgent: 'KodiLike/19.0' });
  const x = (await env.svc.add(XT_INPUT)).playlist;
  await env.svc.update(x.id, { liveFormat: 'm3u8' });
  assert.equal((await env.svc.resolvePlayback(x.id, { id: '1', num: 1, name: 'n', categoryId: '1', adult: false, streamRef: { kind: 'xtream', type: 'live', id: '1001' } })).url,
    'http://provider.example:8080/live/demo_user/' + PASS + '/1001.m3u8');
  await env.s.keys.remove('ss_pl_' + p.id);
  assert.equal(await env.svc.resolvePlayback(p.id, by('News One HD')), null);
  assert.equal(await env.svc.resolvePlayback('unknown', by('News One HD')), null);
  assert.equal((await env.svc.refresh(p.id).result).code, 'no-credentials');
  assert.equal((await persistedText(env)).indexOf(PASS), -1, 'resolved URLs are never persisted or logged');
});

test('EPG references: header URL with placeholders resolved, user override, Xtream', async () => {
  const env = setup(m3uRoute(m3u('provider-extended.m3u')));
  const p = (await env.svc.add({ name: 'A', kind: 'm3u', url: PL_URL })).playlist;
  await env.svc.refresh(p.id).result;
  assert.deepEqual(await env.svc.resolveEpgSources(p.id), [
    { kind: 'xmltv', url: 'http://provider.example:8080/xmltv.php?username=demo_user&password=' + PASS },
    { kind: 'xmltv', url: 'http://epg.example.org/guide.xml.gz' }
  ]);
  await env.svc.update(p.id, { epgUrl: 'https://my-epg.example.org/all.xml' });
  assert.deepEqual(await env.svc.resolveEpgSources(p.id), [{ kind: 'xmltv', url: 'https://my-epg.example.org/all.xml' }]);
  const envX = setup(xtreamRoute());
  const x = (await envX.svc.add(XT_INPUT)).playlist;
  await envX.svc.refresh(x.id).result;
  assert.deepEqual(await envX.svc.resolveEpgSources(x.id), [
    { kind: 'xtream' }, { kind: 'xmltv', url: 'http://provider.example:8080/xmltv.php?username=demo_user&password=' + PASS }
  ]);
});

test('cleartext notice for http:// playlists only, shown once', async () => {
  const env = setup(m3uRoute(''));
  const h = (await env.svc.add({ name: 'H', kind: 'm3u', url: PL_URL })).playlist;
  const s = (await env.svc.add({ name: 'S', kind: 'm3u', url: 'https://secure.example.org/list.m3u' })).playlist;
  assert.equal(env.svc.needsCleartextNotice(h.id), true);
  assert.equal(env.svc.needsCleartextNotice(s.id), false);
  env.svc.markCleartextNoticeSeen(h.id);
  assert.equal(env.svc.needsCleartextNotice(h.id), false);
});

test('stored playlist list that fails validation is discarded, not trusted', async () => {
  const env = setup(m3uRoute(''));
  env.s.local.setItem(KV_PREFIX + 'playlists', JSON.stringify({ v: 1, d: [{ id: '../x', name: 'evil', kind: 'm3u', server: 'javascript:x' }] }));
  assert.deepEqual(env.svc.list(), []);
});
