import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../../src/api/http-client.ts';
import { withRetry } from '../../src/api/retry.ts';
import { createXhrRegistry } from '../fakes/fake-xhr.mjs';
import { createFakeClock, flush } from '../fakes/fake-clock.mjs';

const USER = { kind: 'userSource' };

function setup() {
  const xhr = createXhrRegistry();
  const clock = createFakeClock();
  const http = createHttpClient({ xhrFactory: xhr.factory, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const start = () => http.request({ url: 'http://h.example/x', policy: USER, responseType: 'text' });
  return { xhr, clock, start };
}

test('retries a network failure after the configured delay, then succeeds', async () => {
  const { xhr, clock, start } = setup();
  const retries = [];
  const h = withRetry(start, { attempts: 3, delaysMs: [2000, 5000] }, clock, (n, d, k) => retries.push([n, d, k]));
  xhr.last().fail();
  await flush();
  assert.equal(xhr.created.length, 1);
  clock.advance(1999);
  assert.equal(xhr.created.length, 1);
  clock.advance(1);
  assert.equal(xhr.created.length, 2);
  xhr.last().respond(200, 'ok');
  const r = await h.result;
  assert.equal(r.ok, true);
  assert.deepEqual(retries, [[2, 2000, 'network']]);
});

test('does not retry non-retryable failures (404)', async () => {
  const { xhr, clock, start } = setup();
  const h = withRetry(start, { attempts: 3, delaysMs: [10] }, clock);
  xhr.last().respond(404, 'nope');
  const r = await h.result;
  assert.equal(r.error.status, 404);
  clock.advance(1000);
  assert.equal(xhr.created.length, 1);
});

test('gives up after the attempt limit with the last error', async () => {
  const { xhr, clock, start } = setup();
  const h = withRetry(start, { attempts: 3, delaysMs: [100, 200] }, clock);
  xhr.last().respond(503, '');
  await flush();
  clock.advance(100);
  xhr.last().respond(503, '');
  await flush();
  clock.advance(200);
  xhr.last().respond(502, '');
  const r = await h.result;
  assert.equal(xhr.created.length, 3);
  assert.equal(r.error.status, 502);
});

test('abort cancels a pending retry and the in-flight request', async () => {
  const { xhr, clock, start } = setup();
  const h = withRetry(start, { attempts: 5, delaysMs: [1000] }, clock);
  xhr.last().fail();
  await flush();
  h.abort();
  clock.advance(10000);
  assert.equal(xhr.created.length, 1);
  assert.equal((await h.result).error.kind, 'aborted');
});
