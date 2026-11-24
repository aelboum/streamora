import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../../src/utils/log.ts';
import { redact, redactString, REDACTED } from '../../src/utils/redact.ts';

test('credentials in URLs are removed: query parameters, Xtream paths, userinfo, opaque tokens', () => {
  const cases = [
    ['http://h.example:8080/player_api.php?username=alice&password=s3cret&action=get_live_streams', /alice|s3cret/],
    ['http://h.example:8080/live/alice/s3cret/1234.ts', /alice|s3cret/],
    ['http://h.example/timeshift/alice/s3cret/60/2026-11-22:20-00/12.ts', /alice|s3cret/],
    ['http://alice:s3cret@h.example/list.m3u', /alice|s3cret/],
    ['http://h.example/playlist/Ab3dEf6hIj9kLm2nOp5qRs8t/m3u', /Ab3dEf6hIj9kLm2nOp5qRs8t/],
    ['https://h.example/get.php?token=abc123&type=m3u', /abc123/],
    ['Authorization: Bearer eyJhbGciOi.xyz', /eyJhbGciOi/],
    ['contact me@example.com', /me@example\.com/]
  ];
  for (const [input, leak] of cases) {
    const out = redactString(input);
    assert.doesNotMatch(out, leak, input);
    assert.match(out, /\[redacted\]/, input);
  }
  assert.equal(redactString('http://h.example/channels/news.m3u8'), 'http://h.example/channels/news.m3u8', 'harmless URLs kept');
  assert.match(redactString('http://h.example:8080/live/a/b/1.ts'), /\/live\/\[redacted\]\/\[redacted\]\/1\.ts/);
});

test('sensitive object keys are redacted at any depth; header maps never logged', () => {
  const out = redact({ username: 'alice', password: 'x', nested: { pin: '1234', mapping: 'ok', token: 't', headers: { a: 1 } }, items: [{ apiKey: 'k' }] });
  assert.equal(out.username, REDACTED);
  assert.equal(out.password, REDACTED);
  assert.equal(out.nested.pin, REDACTED);
  assert.equal(out.nested.mapping, 'ok');
  assert.equal(out.nested.token, REDACTED);
  assert.equal(out.nested.headers, REDACTED);
  assert.equal(out.items[0].apiKey, REDACTED);
});

test('long strings are truncated, deep and wide objects are bounded', () => {
  assert.ok(redactString('x'.repeat(2000)).length <= 501);
  let deep = { v: 1 };
  for (let i = 0; i < 10; i++) deep = { deep };
  assert.match(JSON.stringify(redact(deep)), /\[depth\]/);
});

test('logger: levels, components, structured error context, redaction on entry', () => {
  let t = 0;
  const log = createLogger(3, () => ++t, 'info');
  const seen = [];
  log.subscribe((e) => seen.push(e));
  log.debug('hidden');
  const net = log.child('net');
  net.error('request failed http://h.example/live/u/p/1.ts', { url: 'http://h.example/get.php?password=pw' }, { name: 'HttpError', message: 'GET http://h.example/get.php?username=u&password=pw failed', kind: 'network' });
  assert.equal(seen.length, 1);
  const e = seen[0];
  assert.equal(e.level, 'error');
  assert.equal(e.component, 'net');
  assert.deepEqual(e.err.kind, 'network');
  assert.doesNotMatch(JSON.stringify(e), /pw|\/u\/p\//);
  log.info('a'); log.info('b'); log.info('c');
  assert.equal(log.entries().length, 3, 'ring buffer capacity');
  log.setLevel('error');
  log.warn('dropped');
  assert.equal(log.entries().some((x) => x.msg === 'dropped'), false);
  assert.equal(log.level(), 'error');
});

test('a failing listener never breaks logging', () => {
  const log = createLogger();
  log.subscribe(() => { throw new Error('listener bug'); });
  log.info('still works');
  assert.equal(log.entries().length, 1);
});

test('Stage 4: Xtream M3U stream URLs without a type prefix are redacted; ordinary paths are not', async () => {
  const { redactString } = await import('../../src/utils/redact.ts');
  const { carriesCredentials } = await import('../../src/api/http-client.ts');
  assert.equal(redactString('http://p.example:8080/demo_user/demo_pass_9f3k/1001'), 'http://p.example:8080/[redacted]/[redacted]/1001');
  assert.equal(redactString('open http://p.example/u1/p1/1001.m3u8 failed'), 'open http://p.example/[redacted]/[redacted]/1001.m3u8 failed');
  assert.equal(redactString('http://cdn.example.org/img/logos/123.png'), 'http://cdn.example.org/img/logos/123.png');
  assert.equal(redactString('http://cdn.example.org/a/b.png'), 'http://cdn.example.org/a/b.png');
  assert.equal(carriesCredentials('http://p.example:8080/demo_user/demo_pass_9f3k/1001.ts'), true);
  assert.equal(carriesCredentials('http://logos.example.org/uk/news-one.png'), false);
});
