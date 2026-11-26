// Live controller (channel selection and switching, state, watchdog, reconnects, cleanup) with a
// scriptable engine and a deterministic clock; AVPlay engine call order against a fake webapis.avplay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveController } from '../../src/player/live-controller.ts';
import { createAvplayEngine, mapAvTracks } from '../../src/player/avplay-engine.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeClock } from '../fakes/fake-clock.mjs';
import { createFakeEngine } from '../fakes/fake-engine.mjs';
import { createFakeDocument } from '../fakes/fake-dom.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const ch = (id) => ({ id, num: Number(id) || 1, name: 'Ch ' + id, categoryId: 'c', adult: false, streamRef: { kind: 'url', url: 'http://s.example/' + id + '.ts' } });

function setup(opts = {}) {
  const clock = createFakeClock();
  const fe = createFakeEngine();
  const played = [];
  const states = [];
  const ctl = createLiveController({
    engine: opts.noEngine ? null : fe.engine,
    resolve: opts.resolve || ((c) => Promise.resolve(c.id === 'nosrc' ? null : { url: 'http://s.example/' + c.id + '.ts?username=u&password=p', type: 'ts', live: true })),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 400, retryDelaysMs: [2000, 5000, 10000],
    log: createLogger(200), onPlaying: (c) => played.push(c.id)
  });
  ctl.onChange((s) => states.push(s.phase));
  return { ctl, fe, clock, played, states };
}

test('selectNow: loading -> playing with the 2 s buffer; startup time measured; onPlaying once', async () => {
  const { ctl, fe, clock, played } = setup();
  ctl.selectNow(ch('1'));
  assert.equal(ctl.state().phase, 'loading');
  await tick();
  assert.equal(fe.loads().length, 1);
  assert.equal(fe.loads()[0].bufferSec, 2, 'measured two-second startup buffer');
  fe.prepared();
  await tick();
  assert.equal(ctl.state().phase, 'loading', 'prepared but no picture yet');
  clock.advance(3850);
  fe.picture();
  assert.equal(ctl.state().phase, 'playing');
  assert.equal(ctl.state().startupMs, 3850);
  fe.emit({ type: 'buffering', percent: 0 });
  assert.equal(ctl.state().phase, 'buffering');
  fe.emit({ type: 'buffering', percent: 60 });
  assert.equal(ctl.state().bufferPercent, 60);
  fe.emit({ type: 'buffering', percent: 100 });
  assert.equal(ctl.state().phase, 'playing');
  assert.deepEqual(played, ['1']);
});

test('zapping: rapid selections open only the last channel after the 400 ms debounce; old stream stopped at once', async () => {
  const { ctl, fe, clock } = setup();
  ctl.selectNow(ch('1'));
  await tick();
  fe.prepared(); fe.picture();
  const stopsBefore = fe.calls.filter((c) => c.op === 'stop').length;
  ctl.select(ch('2'));
  assert.equal(fe.calls.filter((c) => c.op === 'stop').length, stopsBefore + 1, 'cleanup on channel change');
  assert.equal(ctl.state().phase, 'tuning');
  assert.equal(ctl.state().channel.id, '2', 'banner shows the new channel immediately');
  clock.advance(200);
  ctl.select(ch('3'));
  clock.advance(200);
  ctl.select(ch('4'));
  clock.advance(399);
  await tick();
  assert.equal(fe.loads().length, 1, 'nothing opened while zapping');
  clock.advance(1);
  await tick();
  assert.equal(fe.loads().length, 2);
  assert.match(fe.loads()[1].url, /\/4\.ts/);
});

test('callbacks of an old channel are ignored after switching', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const { ctl, fe } = setup({ resolve: (c) => (c.id === 'slow' ? slow : Promise.resolve({ url: 'http://s.example/' + c.id + '.ts', type: 'ts', live: true })) });
  ctl.selectNow(ch('slow'));
  ctl.selectNow(ch('5'));
  await tick();
  release({ url: 'http://s.example/slow.ts', type: 'ts', live: true });
  await tick();
  assert.deepEqual(fe.loads().map((l) => l.url), ['http://s.example/5.ts'], 'the stale resolve never loads');
  assert.equal(ctl.state().channel.id, '5');
});

test('dead channel: error shown, no automatic retry; Retry reloads', async () => {
  const { ctl, fe, clock } = setup();
  ctl.selectNow(ch('1'));
  await tick();
  fe.failPrepare('connection');
  await tick();
  assert.deepEqual([ctl.state().phase, ctl.state().error], ['error', 'connection']);
  clock.advance(60000);
  await tick();
  assert.equal(fe.loads().length, 1, 'no loop on a dead channel');
  ctl.retry();
  await tick();
  assert.equal(fe.loads().length, 2);
});

test('watchdog: no picture within 15 s is a timeout and the stream is stopped', async () => {
  const { ctl, fe, clock } = setup();
  ctl.selectNow(ch('1'));
  await tick();
  fe.prepared();
  await tick();
  clock.advance(14999);
  assert.equal(ctl.state().phase, 'loading');
  clock.advance(1);
  assert.deepEqual([ctl.state().phase, ctl.state().error], ['error', 'timeout']);
  assert.equal(fe.calls[fe.calls.length - 1].op, 'stop');
});

test('drop during playback: 3 reconnects with 2/5/10 s back-off, then error; success resets the counter', async () => {
  const { ctl, fe, clock } = setup();
  ctl.selectNow(ch('1'));
  await tick(); fe.prepared(); fe.picture();
  fe.emit({ type: 'error', code: 'connection' });
  assert.deepEqual([ctl.state().phase, ctl.state().attempt], ['retrying', 1]);
  clock.advance(1999); await tick();
  assert.equal(fe.loads().length, 1);
  clock.advance(1); await tick();
  assert.equal(fe.loads().length, 2, 'reconnect after 2 s');
  fe.failPrepare('connection'); await tick();
  assert.deepEqual([ctl.state().phase, ctl.state().attempt], ['retrying', 2]);
  clock.advance(5000); await tick();
  assert.equal(fe.loads().length, 3);
  fe.failPrepare('connection'); await tick();
  clock.advance(10000); await tick();
  assert.equal(fe.loads().length, 4);
  fe.failPrepare('connection'); await tick();
  assert.deepEqual([ctl.state().phase, ctl.state().error], ['error', 'connection'], 'gives up after 3 attempts');
  // Recovery path: a reconnect that succeeds returns to playing with the counter reset.
  ctl.retry(); await tick(); fe.prepared(); fe.picture();
  fe.emit({ type: 'ended' });
  assert.equal(ctl.state().phase, 'retrying');
  clock.advance(2000); await tick(); fe.prepared(); fe.picture();
  assert.deepEqual([ctl.state().phase, ctl.state().attempt, ctl.state().error], ['playing', 0, null]);
});

test('pause/resume, suspend/restore (Home key), stop and destroy clean up', async () => {
  const { ctl, fe } = setup();
  ctl.selectNow(ch('1'));
  await tick(); fe.prepared(); fe.picture();
  ctl.togglePause();
  assert.equal(ctl.state().phase, 'paused');
  ctl.togglePause();
  assert.equal(ctl.state().phase, 'playing');
  ctl.suspend();
  assert.equal(fe.calls[fe.calls.length - 1].op, 'stop', 'hidden: stream released');
  ctl.restore();
  await tick();
  assert.equal(fe.loads().length, 2, 'visible again: reopened at the live edge');
  ctl.stop();
  assert.equal(ctl.state().phase, 'idle');
  ctl.destroy();
});

test('no engine, no source', async () => {
  const a = setup({ noEngine: true });
  a.ctl.selectNow(ch('1'));
  assert.deepEqual([a.ctl.state().phase, a.ctl.state().error], ['error', 'unavailable']);
  const b = setup();
  b.ctl.selectNow(ch('nosrc'));
  await tick();
  assert.deepEqual([b.ctl.state().phase, b.ctl.state().error], ['error', 'no-source']);
  assert.equal(b.fe.loads().length, 0);
});

test('the controller never logs stream URLs (they can carry credentials)', async () => {
  const log = createLogger(200);
  const fe = createFakeEngine();
  const clock = createFakeClock();
  const ctl = createLiveController({ engine: fe.engine, resolve: () => Promise.resolve({ url: 'http://p.example/live/user1/secret9/1.ts', type: 'ts', live: true }),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, bufferSec: 2, prepareTimeoutMs: 15000, zapDebounceMs: 400, retryDelaysMs: [2000], log });
  ctl.selectNow(ch('1')); await tick(); fe.prepared(); fe.picture();
  fe.emit({ type: 'error', code: 'connection' });
  clock.advance(2000); await tick(); fe.failPrepare('connection'); await tick();
  assert.equal(JSON.stringify(log.entries()).includes('secret9'), false);
  assert.ok(log.entries().length >= 2);
});

function fakeAvplay() {
  const calls = [];
  let listener = null;
  const av = {
    calls,
    open: (u) => calls.push('open'),
    close: () => calls.push('close'),
    stop: () => { calls.push('stop'); throw new Error('not playing'); },
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    getState: () => 'IDLE',
    setListener: (l) => { calls.push('setListener'); listener = l; },
    setDisplayRect: (x, y, w, h) => calls.push('setDisplayRect ' + [x, y, w, h].join(',')),
    setBufferingParam: (a, b, v) => calls.push('setBufferingParam ' + a + ' ' + v),
    setStreamingProperty: (n, v) => calls.push('setStreamingProperty ' + n),
    suspend: () => calls.push('suspend'),
    restore: () => calls.push('restore'),
    prepareAsync: (ok, err) => { calls.push('prepareAsync'); av.ok = ok; av.err = err; },
    fire: (name, arg) => listener && listener[name](arg),
    fireN: (name, ...args) => listener && listener[name](...args)
  };
  return av;
}

test('AVPlay engine: verified call order, 2 s buffering, user agent, error mapping, stale sessions ignored, safe teardown', async () => {
  assert.equal(createAvplayEngine({ document: createFakeDocument() }), null, 'no webapis: no engine');
  const av = fakeAvplay();
  const doc = createFakeDocument();
  const eng = createAvplayEngine({ webapis: { avplay: av }, document: doc });
  const events = [];
  eng.on((e) => events.push(e));
  const p = eng.load({ url: 'http://s.example/1.ts', type: 'ts', live: true, userAgent: 'UA/1' }, { bufferSec: 2 });
  assert.deepEqual(av.calls.filter((c) => !/^(stop|close)$/.test(c)), [
    'open', 'setListener', 'setDisplayRect 0,0,1920,1080',
    'setBufferingParam PLAYER_BUFFER_FOR_PLAY 2', 'setBufferingParam PLAYER_BUFFER_FOR_RESUME 2', 'setStreamingProperty USER_AGENT', 'prepareAsync'
  ]);
  assert.equal(doc.body.childNodes[0].attributes.type, 'application/avplayer');
  av.ok();
  await p;
  assert.ok(av.calls.includes('play'));
  av.fire('onbufferingstart');
  av.fire('onbufferingprogress', 50);
  av.fire('oncurrentplaytime', 0);
  av.fire('oncurrentplaytime', 1200);
  av.fire('oncurrentplaytime', 1300);
  av.fire('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
  assert.deepEqual(events, [{ type: 'buffering', percent: 0 }, { type: 'buffering', percent: 50 }, { type: 'playing' }, { type: 'error', code: 'connection' }]);
  // A new load: callbacks of the previous session no longer reach listeners.
  const p2 = eng.load({ url: 'http://s.example/2.ts', type: 'ts', live: true }, { bufferSec: 2 });
  const oldErr = av.err;
  av.fire('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
  await assert.rejects(p2, (e) => e === 'format', 'error before prepare rejects the load');
  oldErr && oldErr({ name: 'x' });
  eng.stop();
  eng.stop(); // never throws, even though avplay.stop throws
  eng.destroy();
  assert.equal(doc.body.childNodes.length, 0, 'video object removed');
});

test('AVPlay tracks: extra_info mapped, audio/text selection, subtitles off by default, cues with duration', async () => {
  const all = [
    { type: 'VIDEO', index: 0, extra_info: '{"fourCC":"H264"}' },
    { type: 'AUDIO', index: 1, extra_info: '{"language":"eng","channels":"6","fourCC":"AC3"}' },
    { type: 'AUDIO', index: 2, extra_info: '{"language":"dut","channels":"2"}' },
    { type: 'TEXT', index: 3, extra_info: '{"track_lang":"nld","subtitle_type":"text"}' },
    { type: 'TEXT', index: 4, extra_info: 'not json' }
  ];
  assert.deepEqual(mapAvTracks(all, [{ type: 'AUDIO', index: 2 }], -1), [
    // Stage 7E: channels, sample rate, bitrate and the unambiguous codecs are passed on (0 / '' = not stated).
    { kind: 'audio', id: 1, language: 'eng', label: '5.1 · AC3', selected: false, channels: 6, sampleRate: 0, bitrate: 0, codec: 'ac3' },
    { kind: 'audio', id: 2, language: 'dut', label: 'Stereo', selected: true, channels: 2, sampleRate: 0, bitrate: 0, codec: '' },
    { kind: 'text', id: 3, language: 'nld', label: '', selected: false },
    { kind: 'text', id: 4, language: '', label: '', selected: false }
  ]);
  const av = fakeAvplay();
  let silent = null;
  av.getTotalTrackInfo = () => all;
  av.getCurrentStreamInfo = () => [{ type: 'AUDIO', index: 1 }];
  av.setSelectTrack = (type, i) => av.calls.push('select ' + type + ' ' + i);
  av.setSilentSubtitle = (b) => { silent = b; };
  const eng = createAvplayEngine({ webapis: { avplay: av }, document: createFakeDocument() });
  const events = [];
  eng.on((e) => events.push(e));
  const p = eng.load({ url: 'http://s.example/1.mkv', type: 'mkv', live: false }, { bufferSec: 0 });
  av.ok();
  await p;
  assert.equal(silent, true, 'subtitles start off');
  assert.ok(events.some((e) => e.type === 'tracks'));
  av.fireN('onsubtitlechange', 2000, 'ignored while off');
  assert.ok(!events.some((e) => e.type === 'subtitle'));
  eng.selectTrack('text', 3);
  assert.ok(av.calls.includes('select TEXT 3'));
  assert.equal(silent, false);
  assert.equal(eng.tracks().find((t) => t.id === 3).selected, true);
  av.fireN('onsubtitlechange', 30, '<i>Hallo</i>');
  assert.deepEqual(events.filter((e) => e.type === 'subtitle').map((e) => e.text), ['<i>Hallo</i>']);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events.filter((e) => e.type === 'subtitle').map((e) => e.text), ['<i>Hallo</i>', ''], 'cleared after its duration');
  eng.selectTrack('audio', 2);
  assert.ok(av.calls.includes('select AUDIO 2'));
  eng.selectTrack('text', -1);
  assert.equal(silent, true);
  eng.stop();
});

test('AVPlay seek: done callback; a failing seek marks the title not seekable (seek-failed, no further seekTo); start position seeks before play', async () => {
  const av = fakeAvplay();
  let mode = 'ok';
  const seeks = [];
  av.seekTo = (ms, ok, err) => { seeks.push(ms); if (mode === 'ok') { ok(); } else if (mode === 'err') { err({ name: 'PLAYER_ERROR_SEEK_FAILED' }); } };
  av.getCurrentTime = () => 1000;
  const eng = createAvplayEngine({ webapis: { avplay: av }, document: createFakeDocument() });
  const events = [];
  eng.on((e) => events.push(e.type));
  let p = eng.load({ url: 'http://s.example/1.mkv', type: 'mkv', live: false }, { bufferSec: 0 });
  av.ok();
  await p;
  eng.seek(30000);
  assert.deepEqual(seeks, [30000]);
  assert.ok(!events.includes('seek-failed'));
  mode = 'err';
  eng.seek(60000);
  assert.ok(events.includes('seek-failed'));
  eng.seek(90000);
  assert.deepEqual(seeks, [30000, 60000], 'no seekTo after a failure on the same title');
  assert.equal(events.filter((x) => x === 'seek-failed').length, 2, 'each attempt is reported');
  // Next title: seekable again; a start position is applied after prepare and before play.
  mode = 'ok';
  av.calls.length = 0;
  p = eng.load({ url: 'http://s.example/2.mkv', type: 'mkv', live: false }, { bufferSec: 0, startMs: 120000 });
  av.calls.push('prepared');
  av.ok();
  await p;
  assert.deepEqual(seeks.slice(-1), [120000]);
  const order = av.calls.filter((c) => c === 'prepared' || c === 'play');
  assert.deepEqual(order, ['prepared', 'play'], 'play only after the start seek answered');
  eng.stop();
});

test('AVPlay seek queue: one seekTo at a time (AVPlay drops overlapping ones); queued target runs after the answer; slow answers are not "not seekable"', async () => {
  const av = fakeAvplay();
  const calls = [];
  const pending = [];
  av.seekTo = (ms, ok) => { calls.push(ms); pending.push(ok); }; // answers only when the test says so
  av.getCurrentTime = () => 5000;
  const eng = createAvplayEngine({ webapis: { avplay: av }, document: createFakeDocument() });
  const events = [];
  eng.on((e) => events.push(e.type));
  const p = eng.load({ url: 'http://s.example/q.mp4', type: 'mp4', live: false }, { bufferSec: 0 });
  av.ok();
  await p;
  eng.seek(15000);
  eng.seek(25000);
  eng.seek(35000);
  assert.deepEqual(calls, [15000], 'only one seek in flight');
  await new Promise((r) => setTimeout(r, 4500));
  assert.ok(!events.includes('seek-failed'), 'a seek answering after 4.5 s is not a failure');
  pending.shift()();
  assert.deepEqual(calls, [15000, 35000], 'after the answer the latest queued target runs (25 s skipped)');
  pending.shift()();
  assert.ok(!events.includes('seek-failed'));
  eng.stop();
});
