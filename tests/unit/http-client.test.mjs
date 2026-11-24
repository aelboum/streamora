import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, carriesCredentials } from '../../src/api/http-client.ts';
import { createXhrRegistry } from '../fakes/fake-xhr.mjs';
import { createFakeClock } from '../fakes/fake-clock.mjs';

const USER = { kind: 'userSource' };
const XT = 'http://iptv.example:8080';
const CRED_URL = XT + '/player_api.php?username=alice&password=s3cret';

function setup() {
  const xhr = createXhrRegistry();
  const clock = createFakeClock();
  const http = createHttpClient({ xhrFactory: xhr.factory, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { xhr, clock, http };
}

test('JSON request succeeds; GET, no headers, no cookies', async () => {
  const { xhr, http } = setup();
  const h = http.request({ url: 'http://h.example/a.json', policy: USER, responseType: 'json' });
  const x = xhr.last();
  assert.equal(x.method, 'GET');
  assert.equal(x.withCredentials, false);
  x.respond(200, '{"a":1}');
  const r = await h.result;
  assert.deepEqual(r, { ok: true, status: 200, data: { a: 1 }, redirect: 'none' });
  assert.deepEqual(x.headersSet, []);
});

test('text request and validator', async () => {
  const { xhr, http } = setup();
  const ok = http.request({ url: 'http://h.example/t', policy: USER, responseType: 'text' }, (v) => typeof v === 'string' && v.startsWith('#EXTM3U'));
  xhr.last().respond(200, '#EXTM3U\n');
  assert.equal((await ok.result).ok, true);
  const bad = http.request({ url: 'http://h.example/t', policy: USER, responseType: 'text' }, (v) => v === 'nope');
  xhr.last().respond(200, 'other');
  const r = await bad.result;
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'parse');
});

test('HTTP errors are classified; only 408/429/5xx are retryable', async () => {
  const cases = [[404, false], [401, false], [408, true], [429, true], [500, true], [503, true]];
  for (const [status, retryable] of cases) {
    const { xhr, http } = setup();
    const h = http.request({ url: 'http://h.example/x', policy: USER, responseType: 'text' });
    xhr.last().respond(status, 'err');
    const r = await h.result;
    assert.equal(r.error.kind, 'http');
    assert.equal(r.error.status, status);
    assert.equal(r.error.retryable, retryable, String(status));
  }
});

test('network failure, status 0 and invalid JSON', async () => {
  let s = setup();
  let h = s.http.request({ url: 'http://h.example/x', policy: USER, responseType: 'json' });
  s.xhr.last().fail();
  assert.deepEqual((await h.result).error, { kind: 'network', status: 0, message: 'connection failed', retryable: true });

  s = setup();
  h = s.http.request({ url: 'http://h.example/x', policy: USER, responseType: 'json' });
  s.xhr.last().load();
  assert.equal((await h.result).error.kind, 'network');

  s = setup();
  h = s.http.request({ url: 'http://h.example/x', policy: USER, responseType: 'json' });
  s.xhr.last().respond(200, '{not json');
  assert.equal((await h.result).error.kind, 'parse');
});

test('timeout: engine ontimeout and the backstop timer', async () => {
  let s = setup();
  let h = s.http.request({ url: 'http://h.example/x', policy: USER, responseType: 'text', timeoutMs: 5000 });
  assert.equal(s.xhr.last().timeout, 5000);
  s.xhr.last().timeoutNow();
  let r = await h.result;
  assert.equal(r.error.kind, 'timeout');
  assert.equal(r.error.retryable, true);

  s = setup();
  h = s.http.request({ url: 'http://h.example/x', policy: USER, responseType: 'text', timeoutMs: 5000 });
  s.clock.advance(5999);
  s.clock.advance(1);
  r = await h.result;
  assert.equal(r.error.kind, 'timeout');
  assert.equal(s.xhr.last().aborted, true);
  assert.equal(s.clock.pending(), 0);
});

test('abort settles once, aborts the XHR and ignores late events', async () => {
  const { xhr, http, clock } = setup();
  const h = http.request({ url: 'http://h.example/x', policy: USER, responseType: 'text' });
  const x = xhr.last();
  h.abort();
  h.abort();
  x.respond(200, 'late');
  const r = await h.result;
  assert.equal(r.error.kind, 'aborted');
  assert.equal(x.aborted, true);
  assert.equal(clock.pending(), 0);
});

test('response size limit aborts during download', async () => {
  const { xhr, http } = setup();
  const h = http.request({ url: 'http://h.example/x', policy: USER, responseType: 'text', maxChars: 10 });
  const x = xhr.last();
  x.headers(200, x.url);
  x.chunk('0123456789ABCDEF');
  const r = await h.result;
  assert.equal(r.error.kind, 'too-large');
  assert.equal(x.aborted, true);
});

test('invalid URLs never create a request', async () => {
  const { xhr, http } = setup();
  const r = await http.request({ url: 'file:///etc/passwd', policy: USER, responseType: 'text' }).result;
  assert.equal(r.error.kind, 'invalid-url');
  assert.equal(xhr.created.length, 0);
});

test('credential-bearing URLs must declare a matching credential origin', async () => {
  assert.equal(carriesCredentials(CRED_URL), true);
  assert.equal(carriesCredentials(XT + '/live/alice/s3cret/1.ts'), true);
  assert.equal(carriesCredentials('http://h.example/plain/list.m3u'), false);
  const { xhr, http } = setup();
  let r = await http.request({ url: CRED_URL, policy: USER, responseType: 'json' }).result;
  assert.equal(r.error.kind, 'invalid-url');
  r = await http.request({ url: CRED_URL, policy: USER, responseType: 'json', credentialOrigin: 'http://other.example:8080' }).result;
  assert.equal(r.error.kind, 'invalid-url');
  assert.equal(xhr.created.length, 0, 'no request may be sent');
  const h = http.request({ url: CRED_URL, policy: USER, responseType: 'json', credentialOrigin: XT });
  xhr.last().respond(200, '{"user_info":{}}');
  assert.equal((await h.result).ok, true);
});

test('REDIRECT: credentialed request redirected to another host is aborted at headers, body discarded', async () => {
  const { xhr, http } = setup();
  const h = http.request({ url: CRED_URL, policy: USER, responseType: 'text', credentialOrigin: XT });
  const x = xhr.last();
  x.headers(200, 'http://evil.example/collect');
  assert.equal(x.aborted, true, 'aborted as soon as headers arrive');
  x.chunk('secret page');
  x.load();
  const r = await h.result;
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'redirect-blocked');
  assert.equal(r.error.retryable, false);
  assert.doesNotMatch(r.error.message, /alice|s3cret|evil/);
});

test('REDIRECT: credentialed https -> http downgrade on the same host is blocked', async () => {
  const { xhr, http } = setup();
  const url = 'https://secure.example/player_api.php?username=a&password=b';
  const h = http.request({ url, policy: USER, responseType: 'text', credentialOrigin: 'https://secure.example' });
  xhr.last().headers(200, 'http://secure.example/player_api.php?username=a&password=b');
  assert.equal((await h.result).error.kind, 'redirect-blocked');
});

test('REDIRECT: same-origin redirect of a credentialed request is allowed and reported', async () => {
  const { xhr, http } = setup();
  const h = http.request({ url: CRED_URL, policy: USER, responseType: 'text', credentialOrigin: XT });
  const x = xhr.last();
  x.headers(200, XT + '/other');
  x.chunk('ok');
  x.load();
  const r = await h.result;
  assert.equal(r.ok, true);
  assert.equal(r.redirect, 'same-origin');
});

test('REDIRECT: uncredentialed cross-origin redirect is allowed; disallowed scheme is blocked', async () => {
  let s = setup();
  let h = s.http.request({ url: 'http://cdn.example/list.m3u', policy: USER, responseType: 'text' });
  s.xhr.last().respond(200, '#EXTM3U', 'http://mirror.example/list.m3u');
  let r = await h.result;
  assert.equal(r.ok, true);
  assert.equal(r.redirect, 'cross-origin');

  s = setup();
  h = s.http.request({ url: 'http://cdn.example/list.m3u', policy: USER, responseType: 'text' });
  s.xhr.last().headers(200, 'file:///etc/passwd');
  r = await h.result;
  assert.equal(r.error.kind, 'redirect-blocked');
});

test('REDIRECT: engine without responseURL reports redirect state "unknown"', async () => {
  const { xhr, http } = setup();
  const h = http.request({ url: 'http://h.example/x', policy: USER, responseType: 'text' });
  const x = xhr.last();
  x.headers(200);
  x.chunk('body');
  x.load();
  const r = await h.result;
  assert.equal(r.ok, true);
  assert.equal(r.redirect, 'unknown');
});

test('STREAM: chunks arrive in order and the summary matches', async () => {
  const { xhr, http, clock } = setup();
  const got = [];
  const h = http.stream({ url: 'http://h.example/big.m3u', policy: USER, maxChars: 1000, onChunk: (t) => got.push(t) });
  const x = xhr.last();
  x.headers(200, x.url);
  x.chunk('#EXTM3U\n');
  x.chunk('#EXTINF:-1,A\nhttp://a\n');
  x.chunk('#EXTINF:-1,B\nhttp://b\n');
  x.load();
  const r = await h.result;
  assert.equal(r.ok, true);
  assert.equal(got.join(''), '#EXTM3U\n#EXTINF:-1,A\nhttp://a\n#EXTINF:-1,B\nhttp://b\n');
  assert.deepEqual(r.data, { chars: got.join('').length, chunks: 3 });
  assert.equal(clock.pending(), 0);
});

test('STREAM: idle timeout, size cap, consumer failure, HTTP error', async () => {
  let s = setup();
  let h = s.http.stream({ url: 'http://h.example/a', policy: USER, maxChars: 100, idleTimeoutMs: 3000, onChunk: () => {} });
  s.xhr.last().headers(200, s.xhr.last().url);
  s.xhr.last().chunk('abc');
  s.clock.advance(2999);
  s.xhr.last().chunk('def'); // progress re-arms the idle timer
  s.clock.advance(2999);
  s.clock.advance(1);
  assert.equal((await h.result).error.kind, 'timeout');

  s = setup();
  h = s.http.stream({ url: 'http://h.example/a', policy: USER, maxChars: 5, onChunk: () => {} });
  s.xhr.last().headers(200, s.xhr.last().url);
  s.xhr.last().chunk('0123456789');
  assert.equal((await h.result).error.kind, 'too-large');
  assert.equal(s.xhr.last().aborted, true);

  s = setup();
  h = s.http.stream({ url: 'http://h.example/a', policy: USER, maxChars: 100, onChunk: () => { throw new Error('bad line'); } });
  s.xhr.last().headers(200, s.xhr.last().url);
  s.xhr.last().chunk('x');
  assert.equal((await h.result).error.kind, 'parse');

  s = setup();
  let delivered = 0;
  h = s.http.stream({ url: 'http://h.example/a', policy: USER, maxChars: 100, onChunk: () => { delivered++; } });
  s.xhr.last().headers(404, s.xhr.last().url);
  s.xhr.last().chunk('not found page');
  const r = await h.result;
  assert.equal(r.error.kind, 'http');
  assert.equal(r.error.status, 404);
  assert.equal(delivered, 0);
});

test('STREAM: credentialed redirect is blocked before any data reaches the consumer', async () => {
  const { xhr, http } = setup();
  let delivered = 0;
  const h = http.stream({ url: XT + '/get.php?username=a&password=b&type=m3u_plus', policy: USER, credentialOrigin: XT, maxChars: 100, onChunk: () => { delivered++; } });
  const x = xhr.last();
  x.headers(200, 'http://elsewhere.example/get.php');
  x.chunk('#EXTM3U');
  x.load();
  assert.equal((await h.result).error.kind, 'redirect-blocked');
  assert.equal(delivered, 0);
});

test('STREAM: maxChars is mandatory', async () => {
  const { http } = setup();
  const r = await http.stream({ url: 'http://h.example/a', policy: USER, onChunk: () => {} }).result;
  assert.equal(r.ok, false);
});
