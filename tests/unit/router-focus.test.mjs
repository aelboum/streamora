import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/navigation/router.ts';
import { createFocusManager } from '../../src/navigation/focus.ts';
import { createLogger } from '../../src/utils/log.ts';

function host() {
  const layers = [];
  return {
    layers,
    createLayer(id, overlay) {
      const l = { id, overlay, visible: false, removed: false, element: {}, show() { this.visible = true; }, hide() { this.visible = false; }, remove() { this.removed = true; } };
      layers.push(l);
      return l;
    }
  };
}

function screen(name, events, opts = {}) {
  return () => ({
    mount: (l) => { events.push(name + ':mount'); if (opts.mountThrows) throw new Error('boom'); l.element.name = name; },
    onShow: () => events.push(name + ':show'),
    onHide: () => events.push(name + ':hide'),
    onKey: (e) => { events.push(name + ':key:' + e.key); return !!opts.consumeKeys; },
    onBack: () => { events.push(name + ':back'); return !!opts.consumeBack; },
    destroy: () => events.push(name + ':destroy')
  });
}
const key = (k) => ({ key: k, repeat: false, heldMs: 0, code: 0 });

test('screen registration, push/pop lifecycle and stack', () => {
  const ev = [];
  const h = host();
  const r = createRouter(h, createLogger());
  r.register('home', screen('home', ev));
  r.register('details', screen('details', ev));
  assert.equal(r.isRegistered('home'), true);
  assert.throws(() => r.register('Bad Id', screen('x', ev)));
  assert.equal(r.resetTo('home'), true);
  assert.equal(r.push('details'), true);
  assert.deepEqual(r.stack(), ['home', 'details']);
  assert.equal(r.pop(), true);
  assert.equal(r.pop(), false, 'root is never popped');
  assert.deepEqual(ev, ['home:mount', 'home:show', 'details:mount', 'home:hide', 'details:show', 'details:hide', 'details:destroy', 'home:show']);
  assert.equal(h.layers[1].removed, true);
  assert.equal(h.layers[0].visible, true);
});

test('Back rules: overlay first, then screen, then pop, then root handler', () => {
  const ev = [];
  const r = createRouter(host(), createLogger());
  let rootBack = 0;
  r.setRootBackHandler(() => { rootBack++; });
  r.register('home', screen('home', ev));
  r.register('details', screen('details', ev));
  r.register('dialog', screen('dialog', ev));
  r.resetTo('home');
  r.push('details');
  r.openOverlay('dialog');
  r.handleKey(key('back'));
  assert.equal(r.overlay(), null, 'overlay closed by Back');
  r.handleKey(key('back'));
  assert.deepEqual(r.stack(), ['home'], 'screen popped');
  r.handleKey(key('back'));
  assert.equal(rootBack, 1, 'root back handler');
  assert.deepEqual(r.stack(), ['home']);
});

test('overlays are modal; screens can consume Back', () => {
  const ev = [];
  const r = createRouter(host(), createLogger());
  r.register('home', screen('home', ev, { consumeBack: true }));
  r.register('dialog', screen('dialog', ev));
  r.resetTo('home');
  r.openOverlay('dialog');
  assert.equal(r.handleKey(key('left')), true);
  assert.equal(ev.includes('home:key:left'), false);
  r.closeOverlay();
  let root = 0;
  r.setRootBackHandler(() => root++);
  r.handleKey(key('back'));
  assert.equal(root, 0, 'consumed by screen');
});

test('failures are contained: unknown screens, throwing factories and mounts', () => {
  const ev = [];
  const log = createLogger();
  const h = host();
  const r = createRouter(h, log);
  r.register('home', screen('home', ev));
  r.register('broken', () => { throw new Error('factory'); });
  r.register('badmount', screen('badmount', ev, { mountThrows: true }));
  r.resetTo('home');
  assert.equal(r.push('nope'), false);
  assert.equal(r.push('broken'), false);
  assert.equal(r.push('badmount'), false);
  assert.deepEqual(r.stack(), ['home']);
  assert.equal(h.layers.filter((l) => !l.removed).length, 1);
  assert.equal(log.entries().filter((e) => e.level === 'error').length, 3);
});

test('focus: row, column and grid movement with neighbours and memory', () => {
  const rendered = [];
  const fm = createFocusManager((z, i, f) => { if (f) rendered.push(z + i); });
  let gridSize = 7;
  fm.register({ id: 'nav', kind: 'column', size: () => 3, neighbours: { right: 'grid' } });
  fm.register({ id: 'grid', kind: 'grid', columns: 3, size: () => gridSize, neighbours: { left: 'nav', up: 'tabs' } });
  fm.register({ id: 'tabs', kind: 'row', size: () => 2, neighbours: { down: 'grid' } });
  fm.focus('nav', 1);
  assert.equal(fm.move('right'), true);
  assert.deepEqual(fm.current(), { zone: 'grid', index: 0 });
  fm.move('right'); fm.move('right');
  assert.equal(fm.move('right'), false, 'no wrap at row end');
  fm.move('down'); // 2 -> 5
  assert.deepEqual(fm.current(), { zone: 'grid', index: 5 });
  fm.move('down'); // partial last row (index 6 only) -> last item
  assert.deepEqual(fm.current(), { zone: 'grid', index: 6 });
  fm.move('left'); // 6 is column 0 -> neighbour nav (memory index 1)
  assert.deepEqual(fm.current(), { zone: 'nav', index: 1 });
  fm.move('right');
  assert.deepEqual(fm.current(), { zone: 'grid', index: 6 }, 'memory restored');
  fm.focus('grid', 1);
  fm.move('up');
  assert.deepEqual(fm.current(), { zone: 'tabs', index: 0 });
});

test('focus: never lost when a zone shrinks or empties', () => {
  let n = 5;
  const fm = createFocusManager(() => {});
  fm.register({ id: 'list', kind: 'column', size: () => n, neighbours: {}, fallback: 'menu' });
  fm.register({ id: 'menu', kind: 'row', size: () => 2, neighbours: {} });
  fm.focus('list', 4);
  n = 2;
  fm.refresh('list');
  assert.deepEqual(fm.current(), { zone: 'list', index: 1 });
  n = 0;
  fm.refresh('list');
  assert.deepEqual(fm.current(), { zone: 'menu', index: 0 });
  fm.unregister('menu');
  assert.equal(fm.current(), null, 'nothing focusable left');
});

test('focus: select calls the zone handler', () => {
  const picked = [];
  const fm = createFocusManager(() => {});
  fm.register({ id: 'b', kind: 'row', size: () => 2, neighbours: {}, onSelect: (i) => picked.push(i) });
  assert.equal(fm.select(), false);
  fm.focus('b', 1);
  assert.equal(fm.select(), true);
  assert.deepEqual(picked, [1]);
});
