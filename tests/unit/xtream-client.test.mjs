// Xtream Codes API client: server/credential validation, authentication, typed and validated
// responses, streaming stream lists, EPG decoding, network failures, redirects, credential hygiene.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHttpClient } from '../../src/api/http-client.ts';
import {
  createXtreamClient, normalizeXtreamServer, splitXtreamUrl, buildXtreamStreamUrl, buildXtreamXmltvUrl
} from '../../src/api/xtream/xtream-client.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';

const fx = (name) => readFileSync(new URL('../fixtures/xtream/' + name, import.meta.url), 'utf8');
const SERVER = 'http://provider.example:8080';
const CRED = { username: 'demo_user', password: 'demo_pass_9f3k' };
const LIMITS = { requestTimeoutMs: 5000, maxResponseChars: 200000, maxListChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000 };
const TIMERS = { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) };

function action(url) {
  const m = /[?&]action=([a-z_]+)/.exec(url);
  return m ? m[1] : '';
}

function standardRoutes(overrides = {}) {
  return (url) => {
    const a = action(url);
    if (overrides[a]) return overrides[a](url);
    if (a === '') return { status: 200, body: fx('auth-ok.json') };
    if (a === 'get_live_categories') return { status: 200, body: fx('live-categories.json') };
    if (a === 'get_live_streams') return { status: 200, body: fx('live-streams.json'), chunk: 97 };
    if (a === 'get_short_epg' || a === 'get_simple_data_table') return { status: 200, body: fx('short-epg.json') };
    return { status: 404, body: '' };
  };
}

function client(handler, credentials = CRED, server = SERVER, retry = { attempts: 1, delaysMs: [] }) {
  const srv = createFakeServer(handler);
  const http = createHttpClient({ xhrFactory: srv.factory });
  return { srv, xc: createXtreamClient({ http, server, credentials, limits: LIMITS, retry, timers: TIMERS }) };
}

test('server address normalisation and URL validation', () => {
  assert.deepEqual(normalizeXtreamServer('provider.example:8080'), { ok: true, origin: 'http://provider.example:8080' });
  assert.deepEqual(normalizeXtreamServer(' https://Provider.Example/ '), { ok: true, origin: 'https://provider.example' });
  assert.deepEqual(normalizeXtreamServer('http://provider.example:8080/player_api.php'), { ok: true, origin: 'http://provider.example:8080' });
  for (const bad of ['', 'ftp://provider.example', 'javascript:alert(1)', 'http://u:p@provider.example', 'http://provider.example/some/path',
    'http://provider.example/?username=a', 'http://provider.example:99999', 'http://provider example']) {
    assert.equal(normalizeXtreamServer(bad).ok, false, bad);
  }
});

test('Xtream M3U links split into server and credentials', () => {
  assert.deepEqual(splitXtreamUrl('http://provider.example:8080/get.php?username=demo_user&password=demo%2Bpass&type=m3u_plus&output=ts'),
    { server: 'http://provider.example:8080', credentials: { username: 'demo_user', password: 'demo+pass' } });
  assert.equal(splitXtreamUrl('http://provider.example/list.m3u'), null);
  assert.equal(splitXtreamUrl('http://provider.example/get.php?username=a'), null);
  assert.equal(splitXtreamUrl('http://provider.example/get.php?username=a&password=%E0%A4%A'), null, 'malformed escape');
});

test('authentication: typed account; requests go only to the configured origin and carry nothing extra', async () => {
  const { srv, xc } = client(standardRoutes());
  const r = await xc.authenticate().result;
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.user, {
    auth: true, status: 'Active', expiresAt: 1893456000000, trial: false, activeConnections: 0, maxConnections: 2,
    allowedFormats: ['m3u8', 'ts', 'rtmp'],
    expiry: { kind: 'date', at: 1893456000000 } // S2: three-state expiry next to expiresAt
  });
  assert.deepEqual(r.data.server, { timezone: 'Europe/Amsterdam', serverTime: 1763856000000, protocol: 'http' });
  assert.equal(JSON.stringify(r.data).indexOf('demo_pass_9f3k'), -1, 'echoed password is not kept');
  assert.equal(JSON.stringify(r.data).indexOf('cdn-elsewhere'), -1, 'advertised server_info.url is not used');
  assert.equal(srv.requests.length, 1);
  assert.equal(srv.requests[0].url, SERVER + '/player_api.php?username=demo_user&password=demo_pass_9f3k');
  assert.equal(srv.requests[0].withCredentials, false);
  assert.deepEqual(srv.requests[0].headers, []);
});

test('authentication failures: auth 0, HTTP 401/403, not an Xtream response, invalid input', async () => {
  let r = await client(standardRoutes({ '': () => ({ status: 200, body: fx('auth-refused.json') }) })).xc.authenticate().result;
  assert.deepEqual([r.ok, r.code], [false, 'auth']);
  for (const status of [401, 403]) {
    r = await client(() => ({ status, body: 'no' })).xc.authenticate().result;
    assert.deepEqual([r.ok, r.code, r.status], [false, 'auth', status]);
  }
  r = await client(() => ({ status: 200, body: '{"hello":"world"}' })).xc.authenticate().result;
  assert.equal(r.code, 'invalid-response');
  r = await client(() => ({ status: 200, body: '<html>maintenance</html>' })).xc.authenticate().result;
  assert.equal(r.code, 'invalid-response');
  const noCred = client(standardRoutes(), { username: '', password: 'x' });
  r = await noCred.xc.authenticate().result;
  assert.equal(r.code, 'auth');
  assert.equal(noCred.srv.requests.length, 0, 'nothing is sent with invalid credentials');
  const badServer = client(standardRoutes(), CRED, 'gopher://x');
  assert.equal((await badServer.xc.authenticate().result).code, 'invalid-url');
  assert.equal(badServer.srv.requests.length, 0);
});

test('expired account is reported with its status (the source decides)', async () => {
  const r = await client(standardRoutes({ '': () => ({ status: 200, body: fx('auth-expired.json') }) })).xc.authenticate().result;
  assert.equal(r.ok, true);
  assert.equal(r.data.user.status, 'Expired');
  assert.equal(r.data.user.expiresAt, 1600000000000);
});

test('live categories: validated, de-duplicated, invalid entries dropped', async () => {
  const r = await client(standardRoutes()).xc.liveCategories().result;
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, [
    { id: '1', name: 'UK | News', parentId: null }, { id: '2', name: 'UK | Sports', parentId: null },
    { id: '3', name: 'NL | Kinderen', parentId: null }, { id: '4', name: 'XXX | Adults', parentId: null }
  ]);
  const notList = await client(standardRoutes({ get_live_categories: () => ({ status: 200, body: '{"user_info":{"auth":0}}' }) })).xc.liveCategories().result;
  assert.equal(notList.code, 'invalid-response');
});

test('live streams are streamed element by element and validated field by field', async () => {
  const got = [];
  const { srv, xc } = client(standardRoutes());
  const r = await xc.liveStreams((s) => got.push(s)).result;
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { count: 8, invalid: 3 });
  assert.deepEqual(got[0], {
    streamId: '1001', num: 1, name: 'News One HD', icon: 'http://logos.example.org/uk/news-one.png', epgChannelId: 'news.one.uk',
    categoryId: '1', adult: false, archiveDays: 3
  });
  assert.equal(got[1].epgChannelId, '', 'null epg id');
  assert.equal(got[1].archiveDays, null);
  assert.equal(got[2].icon, 'javascript:alert(1)', 'client keeps text; the source validates the URL');
  assert.equal(got[3].categoryId, '3', 'falls back to category_ids[0]');
  assert.equal(got[3].name, 'Kids "Fun" [NL] {x}');
  assert.equal(got[4].adult, true);
  assert.equal(got.find((s) => s.streamId === '9300').name, '<img src=x onerror=alert(1)>evil', 'bidi override removed, markup inert');
  assert.ok(!got.some((s) => s.streamId === '12/../../x'), 'path-like id rejected');
  assert.match(srv.requests[0].url, /action=get_live_streams$/);
  const one = client(standardRoutes());
  await one.xc.liveStreams(() => {}, '3').result;
  assert.match(one.srv.requests[0].url, /action=get_live_streams&category_id=3$/);
  assert.equal((await one.xc.liveStreams(() => {}, '3&x=1').result).code, 'invalid-url');
});

test('live streams: auth error object, non-array, truncated list, consumer failure', async () => {
  let r = await client(standardRoutes({ get_live_streams: () => ({ status: 200, body: fx('auth-refused.json') }) })).xc.liveStreams(() => {}).result;
  assert.equal(r.code, 'auth');
  r = await client(standardRoutes({ get_live_streams: () => ({ status: 200, body: '{"error":"x"}' }) })).xc.liveStreams(() => {}).result;
  assert.equal(r.code, 'invalid-response');
  r = await client(standardRoutes({ get_live_streams: () => ({ status: 200, body: '[{"stream_id":1,"name":"A"},{"stream_id":2,' }) })).xc.liveStreams(() => {}).result;
  assert.equal(r.code, 'invalid-response');
  r = await client(standardRoutes()).xc.liveStreams(() => { throw new Error('disk full'); }).result;
  assert.equal(r.code, 'invalid-response');
});

test('EPG endpoints: base64 titles decoded, bad timestamps dropped, stream id validated', async () => {
  const { srv, xc } = client(standardRoutes());
  const r = await xc.shortEpg('1001', 4).result;
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, [
    { start: 1763881200000, end: 1763884800000, title: 'Morning News', desc: 'Headlines and weather — live.', channelId: 'news.one.uk' },
    { start: 1763884800000, end: 1763888400000, title: 'Café Ünïon', desc: '', channelId: 'news.one.uk' },
    { start: 1763888400000, end: 1763892000000, title: '', desc: '', channelId: 'news.one.uk' }
  ]);
  assert.match(srv.requests[0].url, /action=get_short_epg&stream_id=1001&limit=4$/);
  const t = await xc.epgTable('1001').result;
  assert.equal(t.ok, true);
  assert.match(srv.requests[1].url, /action=get_simple_data_table&stream_id=1001$/);
  assert.equal((await xc.shortEpg('1/../2', 4).result).code, 'invalid-url');
  const bad = await client(standardRoutes({ get_short_epg: () => ({ status: 200, body: '[]' }) })).xc.shortEpg('1', 2).result;
  assert.equal(bad.code, 'invalid-response');
});

test('network failures: retry on connection failure and 5xx, no retry on 404; abort', async () => {
  let n = 0;
  const flaky = client((url) => (++n < 3 ? (n === 1 ? { fail: 'network' } : { status: 503, body: '' }) : { status: 200, body: fx('auth-ok.json') }),
    CRED, SERVER, { attempts: 3, delaysMs: [1, 1] });
  assert.equal((await flaky.xc.authenticate().result).ok, true);
  assert.equal(flaky.srv.requests.length, 3);

  const notFound = client(() => ({ status: 404, body: '' }), CRED, SERVER, { attempts: 3, delaysMs: [1] });
  const r = await notFound.xc.authenticate().result;
  assert.deepEqual([r.code, r.status], ['http', 404]);
  assert.equal(notFound.srv.requests.length, 1);

  const down = client(() => ({ fail: 'network' }), CRED, SERVER, { attempts: 2, delaysMs: [1] });
  assert.equal((await down.xc.authenticate().result).code, 'network');

  const hang = client(() => ({ fail: 'hang' }));
  const h = hang.xc.liveStreams(() => {});
  setImmediate(() => h.abort());
  assert.equal((await h.result).code, 'aborted');

  const dropped = client(standardRoutes({ get_live_streams: () => ({ status: 200, body: fx('live-streams.json'), chunk: 100, dropAt: 300 }) }));
  assert.equal((await dropped.xc.liveStreams(() => {}).result).code, 'network', 'connection dropped mid-list');
});

test('redirects: a response redirected to another origin is discarded; same-origin is accepted', async () => {
  const away = client(() => ({ status: 200, body: fx('auth-ok.json'), finalUrl: 'http://evil.example/collect' }));
  const r = await away.xc.authenticate().result;
  assert.equal(r.code, 'redirect-blocked');
  const downgrade = client(() => ({ status: 200, body: fx('auth-ok.json'), finalUrl: 'http://provider.example/player_api.php' }), CRED, 'https://provider.example');
  assert.equal((await downgrade.xc.authenticate().result).code, 'redirect-blocked', 'https -> http downgrade');
  const same = client(() => ({ status: 200, body: fx('auth-ok.json'), finalUrl: SERVER + '/v2/player_api.php' }));
  assert.equal((await same.xc.authenticate().result).ok, true);
  const streams = client(standardRoutes({ get_live_streams: () => ({ status: 200, body: fx('live-streams.json'), finalUrl: 'http://cdn.example/list.json' }) }));
  const got = [];
  assert.equal((await streams.xc.liveStreams((s) => got.push(s)).result).code, 'redirect-blocked');
  assert.equal(got.length, 0, 'no element of a redirected response reaches the consumer');
});

test('errors and results never contain the credentials', async () => {
  const results = [];
  const handlers = [() => ({ fail: 'network' }), () => ({ status: 500, body: 'password=demo_pass_9f3k' }), () => ({ status: 200, body: 'not json demo_pass_9f3k' }),
    () => ({ status: 200, body: fx('auth-ok.json'), finalUrl: 'http://evil.example/' }), () => ({ status: 200, body: 'x'.repeat(300000) })];
  for (const h of handlers) results.push(await client(h).xc.authenticate().result);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r).indexOf('demo_pass_9f3k'), -1, JSON.stringify(r));
    assert.equal(JSON.stringify(r).indexOf('demo_user'), -1, JSON.stringify(r));
  }
  assert.equal(results[4].code, 'too-large');
});

test('play-time URL builders encode credentials and validate references', () => {
  assert.equal(buildXtreamStreamUrl(SERVER, { username: 'a b', password: 'p/w?' }, 'live', '1001', 'ts'),
    SERVER + '/live/a%20b/p%2Fw%3F/1001.ts');
  assert.throws(() => buildXtreamStreamUrl(SERVER, CRED, 'live', '../1', 'ts'));
  assert.throws(() => buildXtreamStreamUrl(SERVER, CRED, 'live', '1', 'ts?x'));
  assert.equal(buildXtreamXmltvUrl(SERVER, CRED), SERVER + '/xmltv.php?username=demo_user&password=demo_pass_9f3k');
});
