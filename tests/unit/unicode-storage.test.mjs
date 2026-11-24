// Stage 5.2 regressions: an Xtream playlist (21,986 channels, about 4,800 non-ASCII characters in
// names) imported fine but could not be opened on the TV. Measured on the UE50MU6100: Tizen 3.0's
// FileStream miscounts multi-byte UTF-8 characters (text is shifted and extended on write/read;
// emoji are destroyed), so the live catalogue failed its checksum and was discarded, and an
// unchanged "Update" never rewrote the missing file.
// The file store below models the TV: any non-ASCII character it is given comes back damaged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCatalogueStore, escapeNonAscii } from '../../src/storage/catalogue-store.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createKeyValueStore } from '../../src/storage/kv-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';

const xt = (name) => readFileSync(new URL('../fixtures/xtream/' + name, import.meta.url), 'utf8');
const NON_ASCII = /[^\x00-\x7f]/;

/** A FileStore that damages non-ASCII text, as the TV's FileStream does. */
function tvLikeFiles() {
  const mem = createMemoryFileStore();
  return {
    atomicReplace: true,
    read: (n) => mem.read(n),
    write: (n, t) => mem.write(n, t.replace(/[^\x00-\x7f]/g, '�')),
    remove: (n) => mem.remove(n),
    list: () => mem.list(),
    peek: (n) => mem.read(n)
  };
}

const NAMES = ['⚽ Sport 1', 'News 🇳🇱', 'Ciné é', 'قناة', 'Sport ᴴᴰ', '1080ᵖ ▶ ™ €', 'lone ' + String.fromCharCode(0xdc00)];

test('escapeNonAscii: every non-ASCII character becomes a \\u escape that JSON.parse restores', () => {
  const s = JSON.stringify({ names: NAMES, cut: 'x' + String.fromCharCode(0xd83c) });
  const e = escapeNonAscii(s);
  assert.equal(NON_ASCII.test(e), false, 'pure ASCII');
  assert.deepEqual(JSON.parse(e), JSON.parse(s));
  assert.equal(escapeNonAscii('{"x":"plain"}'), '{"x":"plain"}', 'ASCII text is unchanged');
  assert.equal(escapeNonAscii('"é"'), '"\\u00e9"', 'four hex digits');
  assert.equal(escapeNonAscii('"ᴴ"'), '"\\u1d34"');
});

test('catalogue sections with accents, Arabic, superscripts and emoji survive a file store that damages non-ASCII text', async () => {
  const files = tvLikeFiles();
  const store = createCatalogueStore(files, { budgetChars: 5000000, maxChars: 20000000 }, () => 1);
  const data = { v: 1, names: NAMES };
  assert.equal((await store.save('pl1', 'live', data)).ok, true);
  assert.equal(NON_ASCII.test(await files.peek('cat.pl1.live.json')), false, 'the file is pure ASCII');
  const back = await store.load('pl1', 'live', (x) => !!x);
  assert.equal(back.status, 'ok', JSON.stringify(back));
  assert.deepEqual(back.data, data);
});

test('an unchanged section whose file is missing is written again', async () => {
  const files = tvLikeFiles();
  const store = createCatalogueStore(files, { budgetChars: 5000000, maxChars: 20000000 }, () => 1);
  const first = await store.save('pl1', 'live', { v: 1, x: 'a' });
  const same = await store.save('pl1', 'live', { v: 1, x: 'a' }, { unlessChecksum: first.checksum });
  assert.equal(same.unchanged, true, 'present and unchanged: not rewritten');
  await files.remove('cat.pl1.live.json');
  const again = await store.save('pl1', 'live', { v: 1, x: 'a' }, { unlessChecksum: first.checksum });
  assert.equal(again.unchanged, false, 'missing: rewritten');
  assert.equal((await store.load('pl1', 'live', (x) => !!x)).status, 'ok');
});

function service(files) {
  let t = 1763856000000;
  const now = () => (t += 7);
  const log = createLogger(2000, now);
  const srv = createFakeServer((url) => {
    const a = (/[?&]action=([a-z_]+)/.exec(url) || [])[1] || '';
    if (a === '') return { status: 200, body: xt('auth-ok.json') };
    if (a === 'get_live_categories') return { status: 200, body: xt('live-categories.json').replace('UK | News', 'UK | News 📰') };
    if (a === 'get_live_streams') {
      // The fixture's streams with the kinds of characters real provider names contain.
      const list = JSON.parse(xt('live-streams.json'));
      list.forEach((s, i) => { if (s && typeof s.name === 'string') s.name = NAMES[i % NAMES.length] + ' ' + s.name; });
      return { status: 200, body: JSON.stringify(list), chunk: 97 };
    }
    return { status: 200, body: '[]' };
  });
  const svc = createPlaylistService({
    kv: createKeyValueStore(createMemoryLocalStore(), log), catalogue: createCatalogueStore(files, { budgetChars: 5000000, maxChars: 20000000 }, now, log),
    secrets: createSecretStore(createMemoryKeyStore()), http: createHttpClient({ xhrFactory: srv.factory }), now, log: log.child('playlists'),
    timers: { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) }, retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000 }
  });
  return { svc, log };
}

const XT = { name: 'X', kind: 'xtream', server: 'provider.example:8080', username: 'synthetic_user', password: 'synthetic_pass' };

test('Xtream playlist with non-ASCII names: import, then Live TV loads every channel on a TV-like file store', async () => {
  const files = tvLikeFiles();
  const { svc } = service(files);
  const add = await svc.add(XT);
  const r = await svc.refresh(add.playlist.id).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  const l = await svc.loadLive(add.playlist.id);
  assert.equal(l.status, 'ok', JSON.stringify(l));
  assert.equal(l.catalogue.channels.length, r.counts.live);
  assert.ok(l.catalogue.channels.some((c) => c.name.indexOf('⚽') === 0), 'emoji kept in names');
  assert.ok(l.catalogue.channels.some((c) => c.name.indexOf('قناة') === 0), 'Arabic kept');
  assert.ok(l.catalogue.categories.some((c) => c.name === 'UK | News 📰'));
});

test('Update repairs a channel list that is missing on disk even when the provider data is unchanged', async () => {
  const files = tvLikeFiles();
  const { svc } = service(files);
  const add = await svc.add(XT);
  await svc.refresh(add.playlist.id).result;
  await files.remove('cat.' + add.playlist.id + '.live.json'); // as after a discarded corrupt file
  assert.equal((await svc.loadLive(add.playlist.id)).status, 'inconsistent');
  const again = await svc.refresh(add.playlist.id).result;
  assert.equal(again.ok, true);
  assert.equal(again.unchanged, false, 'rewritten although the content is the same');
  assert.equal((await svc.loadLive(add.playlist.id)).status, 'ok');
});
