import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogueStore, catalogueFileName } from '../../src/storage/catalogue-store.ts';
import { createMemoryFileStore } from '../../src/app/platform/memory-stores.ts';
import { createLogger } from '../../src/utils/log.ts';

const LIMITS = { budgetChars: 1000, maxChars: 5000 };
const isList = (x) => Array.isArray(x);
let t = 1000;
const now = () => t++;

function setup(limits = LIMITS) {
  const files = createMemoryFileStore();
  const log = createLogger();
  return { files, log, store: createCatalogueStore(files, limits, now, log) };
}

test('one file per playlist and section; round trip', async () => {
  const { files, store } = setup();
  const live = [{ id: '1', name: 'News' }, { id: '2', name: 'Sport ✓' }];
  const s = await store.save('pl1', 'live', live);
  assert.equal(s.ok, true);
  assert.equal(s.overBudget, false);
  assert.deepEqual(await files.list(), ['cat.pl1.live.json']);
  const r = await store.load('pl1', 'live', isList);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, live);
  assert.equal(typeof r.savedAt, 'number');
  assert.equal((await store.load('pl1', 'movie', isList)).status, 'missing');
});

test('file format: header line with length and checksum, then payload', async () => {
  const { files, store } = setup();
  await store.save('pl1', 'meta', { n: 1 });
  const text = files.peek('cat.pl1.meta.json');
  const [head, payload] = [text.slice(0, text.indexOf('\n')), text.slice(text.indexOf('\n') + 1)];
  const h = JSON.parse(head);
  assert.equal(h.f, 'ss-cat');
  assert.equal(h.v, 1);
  assert.equal(h.p, 'pl1');
  assert.equal(h.s, 'meta');
  assert.equal(h.n, payload.length);
  assert.match(h.c, /^[0-9a-f]{8}$/);
});

test('recovery: truncated, tampered, wrong-version, mismatched and invalid files are discarded', async () => {
  const cases = {
    truncated: (txt) => txt.slice(0, -3),
    tampered: (txt) => txt.replace('News', 'Nevs'),
    noHeader: () => '[1,2,3]',
    badHeader: (txt) => '{oops\n' + txt.slice(txt.indexOf('\n') + 1),
    wrongVersion: (txt) => txt.replace('"v":1', '"v":99'),
    wrongSection: (txt) => txt.replace('"s":"live"', '"s":"movie"'),
    foreign: (txt) => txt.replace('"f":"ss-cat"', '"f":"other"')
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const { files, store, log } = setup();
    await store.save('pl1', 'live', [{ id: '1', name: 'News' }]);
    files.poke('cat.pl1.live.json', mutate(files.peek('cat.pl1.live.json')));
    const r = await store.load('pl1', 'live', isList);
    assert.equal(r.status, 'corrupt', name);
    assert.equal(files.peek('cat.pl1.live.json'), null, name + ': corrupt file removed');
    assert.ok(log.entries().some((e) => e.msg === 'catalogue: discarding file'), name);
  }
  const { store } = setup();
  await store.save('pl1', 'live', { notAList: true });
  assert.equal((await store.load('pl1', 'live', isList)).status, 'corrupt');
});

test('budget flag and hard limit', async () => {
  const { store, files } = setup();
  const over = await store.save('pl1', 'live', ['x'.repeat(1500)]);
  assert.equal(over.ok, true);
  assert.equal(over.overBudget, true);
  const tooBig = await store.save('pl1', 'movie', ['x'.repeat(6000)]);
  assert.deepEqual(tooBig.ok, false);
  assert.equal(tooBig.reason, 'too-large');
  assert.equal(files.peek('cat.pl1.movie.json'), null);
});

test('unserialisable data and write errors are reported, not thrown', async () => {
  const { store } = setup();
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal((await store.save('pl1', 'live', cyclic)).reason, 'serialise');
  const failing = createCatalogueStore({ ...createMemoryFileStore(), write: () => Promise.reject(new Error('disk full')) }, LIMITS, now);
  const r = await failing.save('pl1', 'live', []);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'io');
  const unreadable = createCatalogueStore({ ...createMemoryFileStore(), read: () => Promise.reject(new Error('io')) }, LIMITS, now);
  assert.equal((await unreadable.load('pl1', 'live', isList)).status, 'error');
});

test('removePlaylist and cleanup', async () => {
  const { files, store } = setup();
  await store.save('keep', 'live', []);
  await store.save('keep', 'meta', {});
  await store.save('gone', 'live', []);
  await store.save('gone', 'series', []);
  files.poke('cat.keep.movie.json.tmp', 'partial');
  files.poke('cat.weird.json', 'x');
  files.poke('settings-backup.json', 'not ours');
  assert.equal(await store.removePlaylist('gone'), 2);
  await store.save('orphan', 'live', []);
  // DI-1 contract change: files whose owner is unknown (the orphan, the unrecognised name) are kept;
  // only temp files of known playlists and files of removed (tombstoned) playlists are deleted.
  const c = await store.cleanup([], ['keep']);
  assert.deepEqual(c, { removed: 1, kept: 2 });
  assert.deepEqual(await files.list(), ['cat.keep.live.json', 'cat.keep.meta.json', 'cat.orphan.live.json', 'cat.weird.json', 'settings-backup.json']);
  const c2 = await store.cleanup(['orphan'], ['keep']);
  assert.deepEqual(c2, { removed: 1, kept: 1 });
  assert.deepEqual(await files.list(), ['cat.keep.live.json', 'cat.keep.meta.json', 'cat.weird.json', 'settings-backup.json']);
});

test('playlist ids and sections are validated (no path tricks)', async () => {
  const { store } = setup();
  assert.throws(() => catalogueFileName('../x', 'live'));
  assert.throws(() => catalogueFileName('pl1', 'secrets'));
  await assert.rejects(store.save('A/B', 'live', []));
  await assert.rejects(store.load('pl1', 'nope', isList));
});

test('Stage 4: checksum reported on save/load; unchanged payload is not rewritten', async () => {
  const { files, store } = setup();
  let writes = 0;
  const write = files.write;
  files.write = (n, t) => { writes++; return write.call(files, n, t); };
  const a = await store.save('pl1', 'live', [1, 2, 3]);
  assert.equal(a.unchanged, false);
  assert.match(a.checksum, /^[0-9a-f]{8}$/);
  const l = await store.load('pl1', 'live', isList);
  assert.equal(l.checksum, a.checksum);
  const b = await store.save('pl1', 'live', [1, 2, 3], { unlessChecksum: a.checksum });
  assert.deepEqual([b.ok, b.unchanged, b.checksum, writes], [true, true, a.checksum, 1]);
  const c = await store.save('pl1', 'live', [1, 2, 4], { unlessChecksum: a.checksum });
  assert.deepEqual([c.unchanged, writes], [false, 2]);
  assert.notEqual(c.checksum, a.checksum);
});
