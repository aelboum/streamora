// Stage 5.1 playback-recovery regressions (Part C): failed channels never poison the next one,
// stale callbacks never change the current channel, cleanup happens before the next open, and a
// prepare that stalls after its stream data arrived is reopened once inside the unchanged 15 s limit.
// Controller with the scriptable engine and a deterministic clock; engine with a fake
// webapis.avplay that delivers late callbacks of earlier sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveController } from '../../src/player/live-controller.ts';
import { createAvplayEngine } from '../../src/player/avplay-engine.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';
import { createFakeDocument } from '../fakes/fake-dom.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const ch = (id) => ({ id, num: Number(id) || 1, name: 'Ch ' + id, categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/' + id + '.ts' } });

function setup(opts = {}) {
  const clock = createFakeClock();
  const fe = createFakeEngine();
  const log = createLogger(500);
  const played = [];
  const ctl = createLiveController({
    engine: fe.engine,
    resolve: (c) => Promise.resolve({ url: 'http://s.example/' + c.id + '.ts', type: 'ts', live: true }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 400, retryDelaysMs: [2000, 5000, 10000],
    prepareStallMs: opts.stallMs === undefined ? 3000 : opts.stallMs,
    log, onPlaying: (c) => played.push(c.id)
  });
  return { ctl, fe, clock, log, played };
}

/** Opens `id` with OK and lets it fail the way AVPlay reports a dead channel (onerror before prepare, ≈ 11 s). */
async function failChannel(t, id, code = 'connection') {
  t.ctl.selectNow(ch(id));
  await tick();
  t.clock.advance(11000);
  t.fe.failPrepare(code);
  await tick();
  assert.equal(t.ctl.state().phase, 'error', id + ' failed');
  assert.equal(t.ctl.state().error, code);
}

async function playChannel(t, id, zap) {
  if (zap) {
    t.ctl.select(ch(id));
    t.clock.advance(400);
  } else {
    t.ctl.selectNow(ch(id));
  }
  await tick();
  assert.equal(t.fe.pendingUrl(), 'http://s.example/' + id + '.ts', 'the new channel is opening');
  t.clock.advance(3400);
  t.fe.prepared();
  await tick();
  t.clock.advance(500);
  t.fe.picture();
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().channel.id, t.ctl.state().error], ['playing', id, null]);
}

function stopsBeforeLastLoad(fe) {
  const i = fe.calls.map((c) => c.op).lastIndexOf('load');
  return fe.calls[i - 1] && fe.calls[i - 1].op === 'stop';
}

test('1. one failed channel, then a working channel plays; the old stream is stopped before the new open', async () => {
  const t = setup();
  await failChannel(t, '3');
  await playChannel(t, '1', true);
  assert.ok(stopsBeforeLastLoad(t.fe), 'stop() precedes the next load()');
  assert.deepEqual(t.played, ['1']);
});

test('2. two consecutive failed channels, then a working channel plays (the Stage 5 sequence)', async () => {
  const t = setup();
  await playChannel(t, '2', false);
  await failChannel(t, '3');
  await failChannel(t, '4');
  await playChannel(t, '1', true);
  assert.equal(t.ctl.state().attempt, 0);
  assert.ok(stopsBeforeLastLoad(t.fe));
});

test('3. a late error of an earlier channel does not touch the current one (controller and AVPlay engine)', async () => {
  // Controller: the old load's promise rejects after the switch.
  const t = setup();
  t.ctl.selectNow(ch('3'));
  await tick();
  const fe = t.fe;
  t.ctl.select(ch('1'));
  t.clock.advance(400);
  await tick();
  // Channel 1 prepares and plays; then the error that belonged to channel 3 arrives as an engine
  // event from a session the engine already closed (the real engine drops it, see below), and as
  // the rejection of channel 3's load promise (the controller drops it by generation).
  t.clock.advance(3400);
  fe.prepared();
  await tick();
  fe.picture();
  fe.rejectLoad(0, 'connection'); // channel 3's load fails late
  await tick();
  fe.emit({ type: 'buffering', percent: 100 });
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().channel.id, t.ctl.state().error], ['playing', '1', null]);

  // Engine: stale AVPlay callbacks of an earlier session never reach listeners.
  const av = fakeAvplay();
  const eng = createAvplayEngine({ webapis: { avplay: av }, document: createFakeDocument() });
  const events = [];
  eng.on((e) => events.push(e));
  const p1 = eng.load({ url: 'http://s.example/3.ts', type: 'ts', live: true }, { bufferSec: 2 });
  const l1 = av.listener;
  const err1 = av.err;
  eng.stop();
  const p2 = eng.load({ url: 'http://s.example/1.ts', type: 'ts', live: true }, { bufferSec: 2 });
  l1.onerror('PLAYER_ERROR_CONNECTION_FAILED'); // late, from session 1
  err1({ name: 'PLAYER_ERROR_CONNECTION_FAILED' });
  l1.onbufferingstart();
  l1.oncurrentplaytime(500);
  av.ok(); // session 2 prepared
  await p2;
  av.listener.oncurrentplaytime(100);
  assert.deepEqual(events, [{ type: 'playing' }], 'only the current session reports');
  let settled = false;
  p1.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.equal(settled, false, 'the abandoned load never settles, so it cannot report anything');
});

test('4. rapid channel changes while a channel is initialising open only the last one; earlier results are ignored', async () => {
  const t = setup();
  t.ctl.selectNow(ch('1'));
  await tick();
  t.clock.advance(1500); // channel 1 still preparing
  t.ctl.select(ch('2'));
  t.clock.advance(150);
  t.ctl.select(ch('3'));
  t.clock.advance(150);
  t.ctl.select(ch('4'));
  assert.equal(t.ctl.state().phase, 'tuning');
  assert.equal(t.ctl.state().channel.id, '4', 'the banner shows the last selection at once');
  t.clock.advance(400);
  await tick();
  assert.deepEqual(t.fe.loads().map((l) => l.url), ['http://s.example/1.ts', 'http://s.example/4.ts'], 'channels 2 and 3 never opened');
  // The watchdog of channel 1 (armed at 0 ms) must not fire for channel 4.
  t.clock.advance(14000);
  assert.notEqual(t.ctl.state().error, 'timeout');
  t.fe.prepared();
  await tick();
  t.fe.picture();
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().channel.id], ['playing', '4']);
});

test('5. repeated failures and recoveries stay reliable (20 cycles)', async () => {
  const t = setup();
  for (let i = 0; i < 20; i++) {
    await failChannel(t, '3', i % 2 ? 'connection' : 'format');
    await failChannel(t, '4');
    await playChannel(t, i % 2 ? '1' : '2', true);
  }
  assert.equal(t.played.length, 20);
  assert.equal(t.ctl.state().phase, 'playing');
});

test('6. cleanup after a timeout: the stream is stopped, nothing fires later, the next channel plays', async () => {
  const t = setup({ stallMs: 0 }); // stall reopen disabled: the plain 15 s limit
  t.ctl.selectNow(ch('1'));
  await tick();
  const loads = t.fe.loads().length;
  t.clock.advance(15000);
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().error], ['error', 'timeout']);
  assert.equal(t.fe.calls[t.fe.calls.length - 1].op, 'stop', 'stopped on timeout');
  assert.equal(t.fe.loads().length, loads, 'no automatic reload');
  t.clock.advance(60000);
  assert.equal(t.ctl.state().phase, 'error', 'no timers left');
  await playChannel(t, '2', true);
});

test('7. no stale callback changes the current channel: old load success, old events and old watchdog', async () => {
  const t = setup();
  t.ctl.selectNow(ch('1'));
  await tick();
  const fe = t.fe;
  // Keep channel 1's pending load, switch to 2 (which stops the engine and drops the pending).
  t.ctl.selectNow(ch('2'));
  await tick();
  t.clock.advance(3000);
  fe.prepared(); // channel 2 prepared
  await tick();
  t.clock.advance(800);
  fe.picture();
  assert.equal(t.ctl.state().channel.id, '2');
  fe.resolveLoad(0); // channel 1's prepare succeeds late
  fe.rejectLoad(0, 'format');
  await tick();
  t.clock.advance(20000); // channel 1's watchdog would have fired at 15 s
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().channel.id, t.ctl.state().error], ['playing', '2', null]);
});

/** AVPlay's buffering reports of a stream whose data arrives (≈ 3.2 s after the open on the TV). */
function dataArrives(t) {
  t.fe.emit({ type: 'buffering', percent: 0 });
  t.fe.emit({ type: 'buffering', percent: 100 });
}

test('stall: buffering reported but no prepare 3 s later reopens the stream once, inside the unchanged 15 s limit', async () => {
  const t = setup();
  t.ctl.selectNow(ch('1'));
  await tick();
  t.clock.advance(3200);
  dataArrives(t);
  t.clock.advance(2999);
  assert.equal(t.fe.loads().length, 1, 'a normal prepare follows within 0.2-0.42 s; nothing happens before 3 s');
  t.clock.advance(1);
  await tick();
  assert.equal(t.fe.loads().length, 2, 'reopened 3 s after the first buffering report');
  assert.ok(stopsBeforeLastLoad(t.fe), 'the stalled session is closed first');
  assert.equal(t.ctl.state().phase, 'loading');
  assert.ok(t.log.entries().some((e) => e.msg === 'live: prepare stalled; reopening'));
  t.clock.advance(3400);
  dataArrives(t);
  t.fe.prepared();
  await tick();
  t.clock.advance(500);
  t.fe.picture();
  assert.equal(t.ctl.state().phase, 'playing');
  assert.equal(t.ctl.state().startupMs, 6200 + 3900, 'start-up time counts from the original OK');
});

test('stall: at most one reopen per tune; the 15 s limit still ends a second stall', async () => {
  const t = setup();
  t.ctl.selectNow(ch('1'));
  await tick();
  t.clock.advance(3200);
  dataArrives(t);
  t.clock.advance(3000);
  await tick();
  t.clock.advance(3200);
  dataArrives(t);
  t.clock.advance(5599);
  await tick();
  assert.equal(t.fe.loads().length, 2, 'no second reopen');
  t.clock.advance(1);
  assert.deepEqual([t.ctl.state().phase, t.ctl.state().error], ['error', 'timeout'], 'timeout at 15 s, not later');
});

test('stall: never for dead channels (no buffering), prepared streams, or a channel already left', async () => {
  const dead = setup();
  await failChannel(dead, '3'); // no buffering report before the error at 11 s
  assert.equal(dead.fe.loads().length, 1, 'a dead channel is not reopened');
  assert.equal(dead.ctl.state().error, 'connection', 'and keeps its own error');

  const prepared = setup();
  prepared.ctl.selectNow(ch('1'));
  await tick();
  prepared.clock.advance(3200);
  dataArrives(prepared);
  prepared.clock.advance(200);
  prepared.fe.prepared();
  await tick();
  prepared.clock.advance(5000); // prepared, picture not yet
  assert.equal(prepared.fe.loads().length, 1, 'prepared streams are never reopened');

  const left = setup();
  left.ctl.selectNow(ch('1'));
  await tick();
  left.clock.advance(3200);
  dataArrives(left);
  left.ctl.stop();
  left.clock.advance(10000);
  assert.equal(left.fe.loads().length, 1);
  assert.equal(left.ctl.state().phase, 'idle');

  const off = setup({ stallMs: 0 });
  off.ctl.selectNow(ch('1'));
  await tick();
  off.clock.advance(3200);
  dataArrives(off);
  off.clock.advance(11800);
  assert.equal(off.fe.loads().length, 1, 'prepareStallMs 0 disables the reopen');
  assert.equal(off.ctl.state().error, 'timeout');
});

function fakeAvplay() {
  const av = {
    calls: [],
    listener: null,
    open: () => av.calls.push('open'),
    close: () => av.calls.push('close'),
    stop: () => { av.calls.push('stop'); },
    play: () => av.calls.push('play'),
    pause: () => {},
    getState: () => 'IDLE',
    setListener: (l) => { av.listener = l; },
    setDisplayRect: () => {},
    setBufferingParam: () => {},
    suspend: () => {},
    restore: () => {},
    prepareAsync: (ok, err) => { av.calls.push('prepareAsync'); av.ok = ok; av.err = err; }
  };
  return av;
}
