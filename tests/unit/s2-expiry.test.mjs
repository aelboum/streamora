// S2: Xtream subscription expiry — parsing, plausibility, time basis, time zones, storage apart from
// the playlist list, survival of failed updates, removal safeguards, display. Fake data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseExpiry, clockBasis, expiryView, CLOCK_SKEW_MS } from '../../src/content/expiry.ts';
import { createAccountInfoStore } from '../../src/services/account-info.ts';
import { subscriptionLines } from '../../src/screens/subscription-text.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createPlaylistService } from '../../src/services/playlist-service.ts';
import { createKeyValueStore, KV_PREFIX } from '../../src/storage/kv-store.ts';
import { createCatalogueStore } from '../../src/storage/catalogue-store.ts';
import { createSecretStore } from '../../src/storage/secret-store.ts';
import { createMemoryFileStore, createMemoryKeyStore, createMemoryLocalStore } from '../../src/app/platform/memory-stores.ts';
import { createHttpClient } from '../../src/api/http-client.ts';
import { createLogger } from '../../src/utils/log.ts';
import { createFakeServer } from '../fakes/fake-http-server.mjs';

const t = createTranslator('en');
const xt = (name) => readFileSync(new URL('../fixtures/xtream/' + name, import.meta.url), 'utf8');
const D = (y, m, d, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min);
const DAY = 86400000;
const PASS = 'demo_pass_9f3k';
const XT_INPUT = { name: 'My Xtream', kind: 'xtream', server: 'provider.example:8080', username: 'demo_user', password: PASS };

// ------------------------------------------------------------------ parsing and plausibility

test('parseExpiry: three distinct states with plausibility checks (invalid timestamps never become dates)', () => {
  const cases = [
    [{}, 'unknown', 'key missing'],
    [null, 'unknown', 'no user_info'],
    [{ exp_date: null }, 'unlimited'], [{ exp_date: 0 }, 'unlimited'], [{ exp_date: '0' }, 'unlimited'],
    [{ exp_date: '' }, 'unlimited'], [{ exp_date: 'null' }, 'unlimited'], [{ exp_date: ' NULL ' }, 'unlimited'],
    [{ exp_date: '1893456000' }, 1893456000000], [{ exp_date: 1893456000 }, 1893456000000], [{ exp_date: ' 1893456000 ' }, 1893456000000],
    [{ exp_date: '1893456000000' }, 1893456000000, 'milliseconds in range'],
    [{ exp_date: 'abc' }, 'unknown'], [{ exp_date: '-5' }, 'unknown'], [{ exp_date: -5 }, 'unknown'],
    [{ exp_date: '5' }, 'unknown', '1970: implausible'], [{ exp_date: 946684799 }, 'unknown', 'just before 2000'],
    [{ exp_date: 4102444800 }, 'unknown', '2100 and later'], [{ exp_date: '99999999999999' }, 'unknown', 'too large'],
    [{ exp_date: 1.5e9 + 0.5 }, 'unknown', 'not an integer'], [{ exp_date: true }, 'unknown'], [{ exp_date: {} }, 'unknown'],
    [{ exp_date: '1893456000x' }, 'unknown'], [{ exp_date: NaN }, 'unknown'], [{ exp_date: Infinity }, 'unknown']
  ];
  for (const [info, want, why] of cases) {
    const e = parseExpiry(info);
    if (typeof want === 'number') {
      assert.deepEqual(e, { kind: 'date', at: want }, JSON.stringify(info) + (why ? ' (' + why + ')' : ''));
    } else {
      assert.equal(e.kind, want, JSON.stringify(info) + (why ? ' (' + why + ')' : ''));
    }
  }
});

// ------------------------------------------------------------------ time basis

test('clockBasis: TV clock unless a plausible server time differs by more than 24 h; fallback reasons recorded', () => {
  const now = D(2026, 11, 26);
  assert.deepEqual(clockBasis(null, now), { source: 'device', offsetMs: 0, reason: 'no-server-time' });
  assert.deepEqual(clockBasis(D(2001, 1, 1), now), { source: 'device', offsetMs: 0, reason: 'server-time-implausible' }, 'before 2024: no evidence');
  assert.deepEqual(clockBasis(D(2150, 1, 1), now), { source: 'device', offsetMs: 0, reason: 'server-time-implausible' });
  assert.deepEqual(clockBasis(now + CLOCK_SKEW_MS, now), { source: 'device', offsetMs: 0, reason: 'in-sync' }, 'exactly 24 h: TV clock');
  assert.deepEqual(clockBasis(now - 3 * 3600000, now), { source: 'device', offsetMs: 0, reason: 'in-sync' });
  const ahead = clockBasis(now + 3 * DAY, now);
  assert.deepEqual(ahead, { source: 'server', offsetMs: 3 * DAY, reason: 'device-clock-off' });
  const tvIn1970 = clockBasis(D(2026, 11, 26), D(1970, 1, 2));
  assert.equal(tvIn1970.source, 'server', 'a TV clock reset to 1970 is corrected by a plausible server time');
});

test('expiryView: days left, one day, today, expired; the recorded clock offset is applied', () => {
  const at = D(2027, 3, 12, 12);
  const dev = { source: 'device', offsetMs: 0, reason: 'in-sync' };
  assert.deepEqual(expiryView({ kind: 'date', at }, dev, at - 106 * DAY), { state: 'days', at, days: 106 });
  assert.deepEqual(expiryView({ kind: 'date', at }, dev, at - DAY), { state: 'days', at, days: 1 });
  assert.equal(expiryView({ kind: 'date', at }, dev, at - 3600000).state, 'today');
  assert.equal(expiryView({ kind: 'date', at }, dev, at).state, 'expired', 'expires at the instant');
  assert.equal(expiryView({ kind: 'date', at }, dev, at + DAY).state, 'expired');
  // TV clock 10 days behind the server: the server-based time is what counts.
  const srv = { source: 'server', offsetMs: 10 * DAY, reason: 'device-clock-off' };
  assert.equal(expiryView({ kind: 'date', at }, srv, at - 5 * DAY).state, 'expired', 'the TV thinks 5 days left; the server says expired');
  assert.deepEqual(expiryView({ kind: 'unlimited' }, dev, at), { state: 'unlimited' });
  assert.deepEqual(expiryView({ kind: 'unknown' }, dev, at), { state: 'unknown' });
});

test('time zones: the date and the days left follow the TV\'s local calendar (UTC, UTC+14, UTC−7)', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const script = [
    "const e = await import(" + JSON.stringify(pathToFileURL(root + 'src/content/expiry.ts').href) + ");",
    "const f = await import(" + JSON.stringify(pathToFileURL(root + 'src/screens/format.ts').href) + ");",
    "const at = Date.UTC(2026, 2, 12, 10, 30);",
    "const dev = { source: 'device', offsetMs: 0, reason: 'in-sync' };",
    "const a = e.expiryView({ kind: 'date', at }, dev, Date.UTC(2026, 2, 11, 12, 0));",
    "const b = e.expiryView({ kind: 'date', at }, dev, Date.UTC(2026, 2, 12, 9, 0));",
    "console.log(JSON.stringify([f.formatDate(at), a.state, a.days || 0, b.state, b.days || 0]));"
  ].join('\n');
  const run = (tz) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  assert.deepEqual(run('UTC'), ['2026-03-12', 'days', 1, 'today', 0]);
  assert.deepEqual(run('Pacific/Kiritimati'), ['2026-03-13', 'days', 1, 'days', 1], 'UTC+14: already the 13th locally');
  assert.deepEqual(run('America/Los_Angeles'), ['2026-03-12', 'days', 1, 'today', 0]);
});

// ------------------------------------------------------------------ import, storage, failed updates

function setup(route, stores, start) {
  const s = stores || { local: createMemoryLocalStore(), files: createMemoryFileStore(), keys: createMemoryKeyStore() };
  let clock = start || D(2025, 11, 23, 0, 0);
  const now = () => (clock += 7);
  const log = createLogger(500, now);
  const kv = createKeyValueStore(s.local, log);
  const accounts = createAccountInfoStore(kv);
  const srv = createFakeServer((url, n) => route.fn(url, n));
  const svc = createPlaylistService({
    kv, catalogue: createCatalogueStore(s.files, { budgetChars: 5000000, maxChars: 20000000 }, now, log),
    secrets: createSecretStore(s.keys), http: createHttpClient({ xhrFactory: srv.factory }), now, log: log.child('playlists'),
    timers: { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) },
    retry: { attempts: 1, delaysMs: [] },
    limits: { requestTimeoutMs: 5000, maxResponseChars: 2000000, maxPlaylistChars: 50000000, idleTimeoutMs: 5000, totalTimeoutMs: 60000 },
    accounts
  });
  return { svc, s, kv, accounts, log, setClock: (v) => { clock = v; } };
}

/** Xtream routes; `auth` customises the user_info / server_info of the login answer. */
function xtRoute(auth) {
  const r = {
    authFail: false, liveFail: false,
    fn: (url) => {
      const a = (/[?&]action=([a-z_]+)/.exec(url) || [])[1] || '';
      if (a === '') {
        if (r.authFail) return { fail: 'network' };
        const body = JSON.parse(xt('auth-ok.json'));
        if (auth) auth(body);
        return { status: 200, body: JSON.stringify(body) };
      }
      if (r.liveFail) return { status: 500, body: '' };
      if (a === 'get_live_categories') return { status: 200, body: xt('live-categories.json') };
      if (a === 'get_live_streams') return { status: 200, body: xt('live-streams.json'), chunk: 50 };
      return { status: 404, body: '' };
    }
  };
  return r;
}

test('import stores the expiry apart from the playlist list (no credentials), with the time basis', async () => {
  const env = setup(xtRoute());
  const p = (await env.svc.add(XT_INPUT)).playlist;
  const listBefore = env.s.local.getItem(KV_PREFIX + 'playlists');
  assert.equal((await env.svc.refresh(p.id).result).ok, true);
  const info = env.accounts.get(p.id);
  assert.deepEqual(info.expiry, { kind: 'date', at: 1893456000000 });
  assert.equal(info.status, 'Active');
  assert.deepEqual(info.clock, { source: 'device', offsetMs: 0, reason: 'in-sync' });
  const raw = env.s.local.getItem(KV_PREFIX + 'account.' + p.id);
  for (const secret of ['demo_user', PASS, 'provider.example', 'cdn-elsewhere', 'http']) {
    assert.equal(raw.includes(secret), false, 'not stored: ' + secret);
  }
  const listAfter = JSON.parse(env.s.local.getItem(KV_PREFIX + 'playlists')).d;
  assert.equal(listAfter.length, 1, 'the playlist list is still one valid entry');
  assert.ok(listBefore, 'the list existed before');
});

test('a later update that fails before (or after) authentication keeps the known expiry', async () => {
  const route = xtRoute();
  const env = setup(route);
  const p = (await env.svc.add(XT_INPUT)).playlist;
  await env.svc.refresh(p.id).result;
  const first = env.accounts.get(p.id);
  route.authFail = true; // network failure before authentication
  assert.equal((await env.svc.refresh(p.id).result).ok, false);
  assert.deepEqual(env.accounts.get(p.id), first, 'unchanged after a failure before login');
  route.authFail = false;
  route.liveFail = true; // login works, the channel list fails afterwards
  assert.equal((await env.svc.refresh(p.id).result).ok, false);
  const second = env.accounts.get(p.id);
  assert.deepEqual(second.expiry, first.expiry, 'still there (refreshed at login)');
  assert.ok(second.checkedAt > first.checkedAt, 'the successful login refreshed the record');
});

test('clock discrepancy: the expired check during an update uses the server clock when the TV clock is off', async () => {
  // Server time 2025-11-23 (fixture), expiry 2030. TV clock wrongly in 2031: TV-only would say expired.
  const env = setup(xtRoute(), null, D(2031, 6, 1));
  const p = (await env.svc.add(XT_INPUT)).playlist;
  assert.equal((await env.svc.refresh(p.id).result).ok, true, 'not expired on the server clock');
  const info = env.accounts.get(p.id);
  assert.equal(info.clock.source, 'server');
  assert.equal(info.clock.reason, 'device-clock-off');
  const lines = subscriptionLines('xtream', info, D(2031, 6, 1), t, true);
  assert.match(lines[0].value, /^Until 2030-01-01 · \d+ days left$/);
  assert.match(lines.find((l) => l.label === 'Time basis').value, /^Server clock \(the TV clock is off by \d+ days\)$/);

  // No (trustworthy) server time: fall back to the TV clock and report it.
  const env2 = setup(xtRoute((b) => { delete b.server_info.timestamp_now; }), null, D(2031, 6, 1));
  const p2 = (await env2.svc.add(XT_INPUT)).playlist;
  const r2 = await env2.svc.refresh(p2.id).result;
  assert.deepEqual([r2.ok, r2.code], [false, 'expired'], 'TV clock fallback: expired');
  const info2 = env2.accounts.get(p2.id);
  assert.equal(info2.clock.reason, 'no-server-time');
  assert.deepEqual(info2.expiry, { kind: 'date', at: 1893456000000 }, 'stored even though the import failed afterwards');
  assert.match(subscriptionLines('xtream', info2, D(2031, 6, 1), t, true).find((l) => l.label === 'Time basis').value, /no server time/);
});

test('invalid / unlimited / unknown exp_date are stored as such and never shown as a date', async () => {
  for (const [value, want] of [[null, 'No expiration'], ['0', 'No expiration'], ['abc', 'Unknown'], ['5', 'Unknown']]) {
    const env = setup(xtRoute((b) => { b.user_info.exp_date = value; }));
    const p = (await env.svc.add(XT_INPUT)).playlist;
    assert.equal((await env.svc.refresh(p.id).result).ok, true, 'an implausible date does not fail the import as expired');
    assert.equal(subscriptionLines('xtream', env.accounts.get(p.id), D(2026, 1, 1), t, false)[0].value, want, String(value));
  }
  const env = setup(xtRoute((b) => { delete b.user_info.exp_date; }));
  const p = (await env.svc.add(XT_INPUT)).playlist;
  await env.svc.refresh(p.id).result;
  assert.equal(env.accounts.get(p.id).expiry.kind, 'unknown', 'missing key: unknown, not unlimited');
});

// ------------------------------------------------------------------ removal safeguards (DI-1 exception)

test('explicit removal deletes that playlist\'s expiry record only; remove-all deletes them all', async () => {
  const env = setup(xtRoute());
  const a = (await env.svc.add(XT_INPUT)).playlist;
  const b = (await env.svc.add({ ...XT_INPUT, name: 'Other' })).playlist;
  await env.svc.refresh(a.id).result;
  await env.svc.refresh(b.id).result;
  env.s.local.setItem(KV_PREFIX + 'account.pzzzzzzzz01', JSON.stringify({ v: 1, d: env.accounts.get(a.id) })); // unrecognised playlist
  await env.svc.remove(a.id);
  assert.equal(env.accounts.get(a.id), null, 'removed with its playlist');
  assert.ok(env.accounts.get(b.id), 'other playlist kept');
  assert.ok(env.s.local.getItem(KV_PREFIX + 'account.pzzzzzzzz01'), 'unrecognised playlist kept');
  await env.svc.recover();
  assert.ok(env.s.local.getItem(KV_PREFIX + 'account.pzzzzzzzz01'), 'start-up cleanup never touches expiry records');
  await env.svc.removeAll();
  assert.equal(env.accounts.get(b.id), null, 'explicit wipe');
  assert.ok(env.s.local.getItem(KV_PREFIX + 'account.pzzzzzzzz01'), 'not in the list: not part of the wipe');
});

test('unreadable, missing or quarantined playlists never lose their expiry record', async () => {
  const env = setup(xtRoute());
  const p = (await env.svc.add(XT_INPUT)).playlist;
  await env.svc.refresh(p.id).result;
  const record = env.s.local.getItem(KV_PREFIX + 'account.' + p.id);
  // 1. Damaged playlist list (protected): removal is refused, the record stays.
  const good = env.s.local.getItem(KV_PREFIX + 'playlists');
  env.s.local.setItem(KV_PREFIX + 'playlists', good.slice(0, 20));
  const prot = setup(xtRoute(), env.s);
  assert.equal(prot.svc.storageState().status, 'protected');
  await assert.rejects(prot.svc.remove(p.id), /protected/);
  await assert.rejects(prot.svc.removeAll(), /protected/);
  await prot.svc.recover();
  assert.equal(env.s.local.getItem(KV_PREFIX + 'account.' + p.id), record, 'kept while protected');
  // 2. Missing playlist list (wiped key, catalogue files left): protected, record kept.
  env.s.local.removeItem(KV_PREFIX + 'playlists');
  const miss = setup(xtRoute(), env.s);
  await miss.svc.whenChecked();
  assert.equal(miss.svc.storageState().status, 'protected');
  await assert.rejects(miss.svc.remove(p.id));
  assert.equal(env.s.local.getItem(KV_PREFIX + 'account.' + p.id), record, 'kept while missing');
  // 3. A damaged expiry record: read as "not checked", quarantined and kept (never deleted).
  env.s.local.setItem(KV_PREFIX + 'playlists', good);
  env.s.local.setItem(KV_PREFIX + 'account.' + p.id, '{"v":1,"d":{"expiry":');
  const q = setup(xtRoute(), env.s);
  assert.equal(q.accounts.get(p.id), null);
  assert.equal(env.s.local.getItem(KV_PREFIX + 'account.' + p.id), '{"v":1,"d":{"expiry":', 'damaged record kept in place');
  assert.equal(q.kv.quarantined('account.' + p.id), '{"v":1,"d":{"expiry":', 'and quarantined');
  assert.equal(subscriptionLines('xtream', q.accounts.get(p.id), D(2026, 1, 1), t, false)[0].value, 'Unknown · not checked yet');
});

test('an expiry update never writes or invalidates the playlist list', async () => {
  const route = xtRoute((b) => { b.user_info.exp_date = 'garbage'; b.user_info.status = 'Disabled<script>'; });
  const env = setup(route);
  const p = (await env.svc.add(XT_INPUT)).playlist;
  const writes = [];
  const set = env.s.local.setItem.bind(env.s.local);
  env.s.local.setItem = (k, v) => { writes.push(k); set(k, v); };
  await env.svc.refresh(p.id).result;
  assert.ok(writes.includes(KV_PREFIX + 'account.' + p.id));
  const list = JSON.parse(env.s.local.getItem(KV_PREFIX + 'playlists')).d;
  assert.equal(list.length, 1);
  assert.equal(env.svc.storageState().status, 'ok', 'list still verified');
  assert.equal(env.accounts.get(p.id).status, '', 'an unsafe status string is not stored');
});

// ------------------------------------------------------------------ display

test('display: date and days, one day, today, expired, no expiration, unknown, not checked, M3U; status separate', () => {
  const at = D(2027, 3, 12, 12);
  const info = (expiry, status = 'Active') => ({ expiry, status, trial: false, maxConnections: 2, checkedAt: D(2026, 11, 26), clock: { source: 'device', offsetMs: 0, reason: 'in-sync' } });
  const v = (i, now) => subscriptionLines('xtream', i, now, t, false);
  assert.equal(v(info({ kind: 'date', at }), at - 106 * DAY)[0].value, 'Until 2027-03-12 · 106 days left');
  assert.equal(v(info({ kind: 'date', at }), at - DAY)[0].value, 'Until 2027-03-12 · 1 day left');
  assert.equal(v(info({ kind: 'date', at }), at - 3600000)[0].value, 'Ends today (2027-03-12)');
  assert.equal(v(info({ kind: 'date', at }), at + DAY)[0].value, 'Expired on 2027-03-12');
  assert.equal(v(info({ kind: 'unlimited' }), at)[0].value, 'No expiration');
  assert.equal(v(info({ kind: 'unknown' }), at)[0].value, 'Unknown');
  assert.equal(subscriptionLines('xtream', null, at, t, false)[0].value, 'Unknown · not checked yet');
  assert.deepEqual(subscriptionLines('m3u', null, at, t, true), [{ label: 'Subscription', value: 'Not available for M3U playlists' }]);
  // Status is its own line, never derived from (or mixed into) the expiry.
  const disabled = v(info({ kind: 'date', at }, 'Disabled'), at - 10 * DAY);
  assert.deepEqual(disabled.map((l) => l.label), ['Subscription', 'Account status']);
  assert.match(disabled[0].value, /10 days left/);
  assert.equal(disabled[1].value, 'Disabled');
  const expiredStatus = v(info({ kind: 'unknown' }, 'Expired'), at);
  assert.deepEqual(expiredStatus.map((l) => l.value), ['Unknown', 'Expired'], 'status Expired does not invent a date');
  assert.equal(v(info({ kind: 'date', at }), at).length, 1, 'Active: no status line');
  // Dutch
  const nl = subscriptionLines('xtream', info({ kind: 'date', at }), at - 5 * DAY, createTranslator('nl'), true);
  assert.equal(nl[0].value, 'Tot 2027-03-12 · nog 5 dagen');
  assert.equal(nl.find((l) => l.label === 'Tijdsbasis').value, 'Klok van de tv');
});

test('Settings (real start-up): subscription row for the active playlist; M3U not available; pre-S2 expiry still shown', async () => {
  const { createAppContext, startApp } = await import('../../src/app/bootstrap.ts');
  const { createDomHost } = await import('../../src/app/dom-host.ts');
  const { createFakePlatform } = await import('../fakes/fake-platform.mjs');
  const { createFakeDocument } = await import('../fakes/fake-dom.mjs');
  const { createFakeClock } = await import('../fakes/fake-clock.mjs');
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const fp = createFakePlatform();
  const clk = createFakeClock();
  const ctx = createAppContext({ platform: fp.platform, build: { mode: 'release', version: '0.2.0', devSinkUrl: '' }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  await ctx.playlists.whenChecked();
  const x = (await ctx.playlists.add(XT_INPUT)).playlist;
  const m = (await ctx.playlists.add({ name: 'List', kind: 'm3u', url: 'http://provider.example:8080/get.php?username=u&password=p&type=m3u' })).playlist;
  const now = clk.now();
  ctx.accounts.save(x.id, { expiry: { kind: 'date', at: D(2029, 6, 15) }, status: 'Active', trial: false, maxConnections: 1, checkedAt: now, clock: { source: 'device', offsetMs: 0, reason: 'in-sync' } });
  const doc = createFakeDocument();
  const app = startApp(ctx, createDomHost(doc, doc.body), doc, clk.now);
  for (let i = 0; i < 6; i++) { await tick(); }
  const rowValue = (id) => { const r = doc.body.findAll('ss-set__row').find((n) => n.attributes['data-row'] === id); return r ? r.findAll('ss-set__value')[0].textContent : null; };
  ctx.playlists.setActive(x.id);
  app.router.push('settings');
  for (let i = 0; i < 4; i++) { await tick(); }
  assert.match(rowValue('subscription'), /^Until 2029-06-15 · \d+ days left$/);
  app.router.pop();
  ctx.playlists.setActive(m.id);
  app.router.push('settings');
  for (let i = 0; i < 4; i++) { await tick(); }
  assert.equal(rowValue('subscription'), 'Not available for M3U playlists');
  // A playlist imported before S2: no account record, but lastStatus.expiresAt from that import.
  app.router.pop();
  const list = JSON.parse(fp.platform.localStore.getItem(KV_PREFIX + 'playlists'));
  list.d[0].lastStatus = { ok: true, at: now, expiresAt: Date.UTC(2030, 0, 1) };
  fp.platform.localStore.setItem(KV_PREFIX + 'playlists', JSON.stringify(list));
  fp.platform.localStore.removeItem(KV_PREFIX + 'account.' + x.id);
  ctx.playlists.setActive(x.id);
  app.router.push('settings');
  for (let i = 0; i < 4; i++) { await tick(); }
  assert.match(rowValue('subscription'), /^Until 2030-01-01 · \d+ days left$/);
});
