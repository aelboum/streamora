import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapKeyCode, TIZEN_KEY_NAMES } from '../../src/navigation/keys.ts';
import { createKeyRouter } from '../../src/navigation/key-router.ts';

test('TV key codes map to remote keys (codes verified on the UE50MU6100)', () => {
  const expected = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 10009: 'back', 427: 'chUp', 428: 'chDown', 403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 19: 'pause', 415: 'play', 10252: 'playPause', 413: 'stop', 412: 'rewind', 417: 'fastForward' };
  for (const [code, key] of Object.entries(expected)) {
    assert.deepEqual(mapKeyCode(Number(code), false), { key }, code);
  }
  assert.deepEqual(mapKeyCode(48, false), { key: 'digit', digit: 0 });
  assert.deepEqual(mapKeyCode(57, false), { key: 'digit', digit: 9 });
  assert.equal(mapKeyCode(65, false), null);
});

test('browser development keys only when allowed', () => {
  assert.equal(mapKeyCode(27, false), null);
  assert.deepEqual(mapKeyCode(27, true), { key: 'back' });
  assert.deepEqual(mapKeyCode(8, true), { key: 'back' });
  assert.deepEqual(mapKeyCode(33, true), { key: 'chUp' });
});

test('registration list includes channel and colour keys', () => {
  for (const k of ['ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF3Blue']) assert.ok(TIZEN_KEY_NAMES.includes(k));
});

function router(overrides = {}) {
  let t = 0;
  const got = [];
  const kr = createKeyRouter({ now: () => t, throttleMs: 110, allowBrowserKeys: false, dispatch: (e) => { got.push(e); return true; }, ...overrides });
  const ev = (code) => { const e = { keyCode: code, prevented: false, preventDefault() { this.prevented = true; } }; return e; };
  return { kr, got, ev, at: (ms) => { t = ms; } };
}

test('Back is always default-prevented so the app is not closed by the engine', () => {
  const { kr, ev } = router();
  const e = ev(10009);
  kr.keyDown(e);
  assert.equal(e.prevented, true);
  const unknown = ev(65);
  kr.keyDown(unknown);
  assert.equal(unknown.prevented, false, 'unmapped keys pass through');
});

test('held keys: repeats detected by timing (event.repeat is unusable on the TV) and arrows throttled', () => {
  const { kr, got, ev, at } = router();
  at(0); kr.keyDown(ev(39));
  at(458); kr.keyDown(ev(39));   // first auto-repeat [M]
  at(566); kr.keyDown(ev(39));   // 108 ms later: below 110 ms throttle -> dropped
  at(674); kr.keyDown(ev(39));   // 216 ms after last delivered -> delivered
  kr.keyUp(ev(39));
  at(700); kr.keyDown(ev(39));   // fresh press
  assert.deepEqual(got.map((e) => [e.key, e.repeat, e.heldMs]), [['right', false, 0], ['right', true, 458], ['right', true, 674], ['right', false, 0]]);
});

test('non-arrow repeats are not throttled; digits carry their value', () => {
  const { kr, got, ev, at } = router();
  at(0); kr.keyDown(ev(13));
  at(10); kr.keyDown(ev(13));
  at(20); kr.keyDown(ev(53));
  assert.equal(got.length, 3);
  assert.equal(got[2].digit, 5);
});

test('with a text field focused only Back is routed', () => {
  const { kr, got, ev } = router({ textInputActive: () => true });
  kr.keyDown(ev(37));
  kr.keyDown(ev(13));
  kr.keyDown(ev(10009));
  assert.deepEqual(got.map((e) => e.key), ['back']);
});

test('attach/detach on a platform key input', () => {
  const downs = [];
  const ups = [];
  const keys = {
    registerKeys: () => [],
    onKeyDown: (cb) => { downs.push(cb); return () => downs.pop(); },
    onKeyUp: (cb) => { ups.push(cb); return () => ups.pop(); }
  };
  const { kr, got, ev } = router();
  const detach = kr.attach(keys);
  downs[0](ev(40));
  ups[0](ev(40));
  assert.equal(got.length, 1);
  detach();
  assert.equal(downs.length + ups.length, 0);
});
