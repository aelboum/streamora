// Build-level checks: real dev and release builds, the ES5/compat/CSS gates, the approved
// config.xml policy, and that both TV probes are still intact and ES5-clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { build } from '../../scripts/build.mjs';
import { checkReleaseDir } from '../../scripts/lib/release-check.mjs';
import { runCompatCheck } from '../../scripts/compat-check.mjs';
import { checkSource } from '../../scripts/lib/compat-rules.mjs';
import { checkCss } from '../../scripts/lib/css-check.mjs';
import { checkEs5Bundle } from '../../scripts/lib/es5-bundle-check.mjs';
import { PRIVILEGES } from '../../scripts/lib/config-xml.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('dev and release builds succeed; release passes the release check', async () => {
  const dev = await build('dev', {});
  assert.equal(checkEs5Bundle(dev.js).ok, true);
  const rel = await build('release', {});
  assert.equal(checkEs5Bundle(rel.js).ok, true);
  const rc = checkReleaseDir(rel.out);
  assert.deepEqual(rc.errors, []);
  assert.ok(rel.js.length < dev.js.length, 'release is minified');
  assert.equal(rel.js.indexOf('SS_DEV_LOG_SINK_V1'), -1);
});

test('config.xml carries exactly the approved privileges, access rule and CSP', () => {
  const cfg = readFileSync(join(root, 'dist', 'release', 'config.xml'), 'utf8');
  for (const p of PRIVILEGES) assert.ok(cfg.includes('name="' + p + '"'), p);
  assert.equal((cfg.match(/<tizen:privilege /g) || []).length, PRIVILEGES.length);
  assert.ok(cfg.includes('<access origin="*" subdomains="true"/>'));
  assert.match(cfg, /script-src 'self';/);
  assert.doesNotMatch(cfg, /unsafe-/);
  assert.doesNotMatch(cfg, /unlimitedstorage/, 'privilege shown to have no effect is not requested');
});

test('source compatibility check: no findings in src/', () => {
  const r = runCompatCheck();
  assert.deepEqual(r.findings, []);
  assert.ok(r.files > 30);
});

test('the gates reject what the TV cannot run', () => {
  const bad = [
    ['async function f() {}', 'syntax/async'],
    ['const { a } = obj;', 'syntax/destructuring'],
    ['function f(a = 1) {}', 'syntax/default-param'],
    ['x?.y', 'syntax/optional-chaining'],
    ['for (const a of b) {}', 'syntax/for-of'],
    ['fetch("/x")', 'api/fetch'],
    ['p.finally(f)', 'api/finally'],
    ['el.innerHTML = s', 'api/innerHTML'],
    ['new Function("x")', 'api/Function'],
    ['Object.values(o)', 'api/Object.values']
  ];
  for (const [code, rule] of bad) {
    assert.ok(checkSource(code, 'src/x.ts').some((f) => f.rule === rule), code);
  }
  assert.ok(checkSource('tizen.application', 'src/services/x.ts').some((f) => f.rule === 'boundary/platform'));
  assert.deepEqual(checkSource('tizen.application', 'src/app/platform/x.ts'), []);
  assert.equal(checkCss('.a { display: grid; }').ok, false);
  assert.equal(checkCss('.a { color: var(--x); }').ok, false);
  assert.equal(checkEs5Bundle('var f = () => 1;').ok, false);
  assert.equal(checkEs5Bundle('var f = function () { return 1; };').ok, true);
});

test('both TV probes are intact and ES5-clean', () => {
  for (const [dir, file, id] of [['probe', 'probe.js', 'SSProbe001.Probe'], ['probe2', 'probe2.js', 'SSProbe002.Probe2']]) {
    const js = readFileSync(join(root, dir, 'app', file), 'utf8');
    assert.doesNotThrow(() => acorn.parse(js, { ecmaVersion: 5, sourceType: 'script' }), file);
    const cfg = readFileSync(join(root, dir, 'app', 'config.xml'), 'utf8');
    assert.ok(cfg.includes('id="' + id + '"'), id);
  }
});

test('CP1 --platform: default = every adapter (today); tizen / android bundles keep only their own adapter', async () => {
  const all = await build('release', {});
  const tz = await build('release', {}, 'tizen');
  const an = await build('release', {}, 'android');
  assert.ok(all.js.indexOf('ElitePlatform') >= 0 && all.js.indexOf('keymanager') >= 0, 'default bundle has both adapters');
  assert.equal(tz.js.indexOf('ElitePlatform'), -1, 'tizen bundle has no Android adapter');
  assert.ok(tz.js.indexOf('keymanager') >= 0);
  assert.equal(an.js.indexOf('keymanager'), -1, 'android bundle has no Tizen key manager');
  assert.ok(an.js.indexOf('ElitePlatform') >= 0);
  for (const b of [tz, an]) { assert.equal(checkEs5Bundle(b.js).ok, true); }
  assert.deepEqual(checkReleaseDir(tz.out).errors, [], 'tizen platform build passes the full release check');
  assert.deepEqual(checkReleaseDir(an.out, { config: false }).errors, [], 'android build: no config.xml, no dev code');
  await assert.rejects(build('release', {}, 'webos-unknown'));
});
