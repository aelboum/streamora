// Zap speed (after the TV diagnostics of 2026-11-25): a single CH±/▲▼ press tunes at once, rapid
// presses keep the debounce (AVPlay never gets a burst of loads), and "Loading…" hides once the
// engine is prepared and playing (ready) instead of waiting ~0.5 s for its first time report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveController } from '../../src/player/live-controller.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const ch = (id) => ({ id, num: Number(id) || 1, name: 'Ch ' + id, categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/' + id + '.ts' } });

function setup(quietMs) {
  const clock = createFakeClock();
  const fe = createFakeEngine();
  const ctl = createLiveController({
    engine: fe.engine,
    resolve: (c) => Promise.resolve({ url: 'http://s.example/' + c.id + '.ts', type: 'ts', live: true }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 400, zapQuietMs: quietMs, retryDelaysMs: [2000, 5000, 10000],
    prepareStallMs: 3000, log: createLogger(200)
  });
  return { ctl, fe, clock };
}
const urls = (fe) => fe.loads().map((l) => l.url.replace('http://s.example/', ''));

test('zap speed: a single press tunes at once; presses closer than 600 ms are debounced to the last one', async () => {
  const t = setup(600);
  t.ctl.select(ch('1'));
  await tick();
  assert.deepEqual(urls(t.fe), ['1.ts'], 'no 400 ms wait for a single zap');
  t.clock.advance(300);
  t.ctl.select(ch('2')); // 300 ms later: rapid
  t.clock.advance(200);
  t.ctl.select(ch('3')); // 200 ms later: rapid
  await tick();
  assert.deepEqual(urls(t.fe), ['1.ts'], 'rapid presses wait');
  assert.equal(t.ctl.state().phase, 'tuning');
  t.clock.advance(400);
  await tick();
  assert.deepEqual(urls(t.fe), ['1.ts', '3.ts'], 'only the last of the rapid presses opens, 400 ms after it');
  t.clock.advance(1000);
  t.ctl.select(ch('4')); // quiet again: at once
  await tick();
  assert.deepEqual(urls(t.fe), ['1.ts', '3.ts', '4.ts']);
});

test('zap speed: without zapQuietMs (the Live TV preview) every select keeps the debounce', async () => {
  const t = setup(undefined);
  t.ctl.select(ch('1'));
  await tick();
  assert.deepEqual(urls(t.fe), []);
  t.clock.advance(400);
  await tick();
  assert.deepEqual(urls(t.fe), ['1.ts']);
});

test('zap speed: "ready" once the engine is prepared, cleared on the next tune; not set by a failed load', async () => {
  const t = setup(600);
  t.ctl.select(ch('1'));
  await tick();
  assert.equal(t.ctl.state().ready, false);
  t.fe.prepared();
  await tick();
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().ready], ['loading', true], 'prepared: ready before the first time report');
  t.fe.picture();
  assert.equal(t.ctl.state().phase, 'playing');
  t.clock.advance(1000);
  t.ctl.select(ch('2'));
  await tick();
  assert.equal(t.ctl.state().ready, false, 'a new tune starts not ready');
  t.fe.failPrepare('connection');
  await tick();
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().ready], ['error', false]);
});
