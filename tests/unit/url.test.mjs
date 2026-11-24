import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, originOf, MAX_URL_LENGTH } from '../../src/api/url.ts';

const USER = { kind: 'userSource' };
const STRICT = { kind: 'strict', allowedHosts: ['api.example.com'] };

test('userSource accepts http and https on any host and port', () => {
  for (const u of ['http://iptv.example:8080/get.php', 'https://iptv.example/x.m3u', 'http://192.168.1.20:25461/player_api.php', 'http://[::1]:8000/a']) {
    const r = checkUrl(u, USER);
    assert.equal(r.ok, true, u);
  }
});

test('userSource reports a normalised origin', () => {
  const r = checkUrl('HTTP://IPTV.Example:8080/a?b=c', USER);
  assert.equal(r.ok, true);
  assert.equal(r.origin, 'http://iptv.example:8080');
  assert.equal(checkUrl('https://h.example:443/x', USER).origin, 'https://h.example');
  assert.equal(originOf('http://h.example/x'), 'http://h.example');
  assert.equal(originOf('not a url'), '');
});

test('dangerous schemes are rejected under every policy', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://h/x', 'about:blank', 'ws://h/x']) {
    assert.equal(checkUrl(u, USER).ok, false, u);
    assert.equal(checkUrl(u, STRICT).ok, false, u);
  }
});

test('userinfo, whitespace, control characters, relative and over-long URLs are rejected', () => {
  assert.deepEqual(checkUrl('http://user:pass@h.example/x', USER), { ok: false, reason: 'credentials in URL' });
  assert.equal(checkUrl('http://h.example/a b', USER).ok, false);
  assert.equal(checkUrl('http://h.example/a\u0000', USER).ok, false);
  assert.equal(checkUrl('/relative/path', USER).ok, false);
  assert.equal(checkUrl('', USER).ok, false);
  assert.equal(checkUrl('http://h.example/' + 'a'.repeat(MAX_URL_LENGTH), USER).ok, false);
  assert.equal(checkUrl(undefined, USER).ok, false);
});

test('strict policy keeps https, allowlisted host and port 443 only', () => {
  assert.equal(checkUrl('https://api.example.com/v1', STRICT).ok, true);
  assert.equal(checkUrl('http://api.example.com/v1', STRICT).ok, false);
  assert.equal(checkUrl('https://other.example.com/v1', STRICT).ok, false);
  assert.equal(checkUrl('https://api.example.com:8443/v1', STRICT).ok, false);
});
