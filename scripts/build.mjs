// npm run build:dev | build:release
//   1. tsc (ES5, ES2015 modules) -> build/tsc/<mode>
//   2. esbuild bundle -> dist/<mode>/app.js (IIFE, target es5; release: minified, dev hooks swapped for a no-op)
//   3. acorn ES5 gate on the bundle
//   4. CSS: token substitution + feature gate -> dist/<mode>/app.css
//   5. index.html, icon.png, config.xml (generated per mode)
//   6. release only: development-logging exclusion check
// CP1: --platform <all|tizen|android|browser> (default all = today's bundle, every adapter, in
// dist/<mode>). Another value keeps only that platform's adapter (detect.ts) and writes
// dist/<mode>-<platform>; config.xml only for all and tizen.
// Dev sink endpoint (dev builds only): SS_DEV_SINK_URL=http://<private-ip>:<port>/ingest
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { checkEs5Bundle } from './lib/es5-bundle-check.mjs';
import { applyTokens, checkCss } from './lib/css-check.mjs';
import { renderConfig } from './lib/config-xml.mjs';
import { checkReleaseDir } from './lib/release-check.mjs';
import { checkSinkUrl } from '../src/dev/sink-url.ts';
import { tokens } from '../src/styles/tokens.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const CSS_ORDER = ['fonts.css', 'base.css', 'shell.css', 'playlists.css', 'live.css', 'vod.css'];

/** Release: resolve every import of dev/dev-hooks to the no-op stub. */
function releaseDevStub(tscDir) {
  return {
    name: 'release-dev-stub',
    setup(build) {
      build.onResolve({ filter: /[\\/]dev[\\/]dev-hooks\.js$/ }, () => ({
        path: join(tscDir, 'dev', 'dev-hooks.release.js')
      }));
    }
  };
}

function fail(msg, details) {
  console.error('BUILD FAILED: ' + msg);
  for (const d of details || []) console.error('  ' + d);
  process.exit(1);
}

export const PLATFORMS = ['all', 'tizen', 'android', 'browser'];

export async function build(mode, env, platform) {
  if (mode !== 'dev' && mode !== 'release') throw new Error('mode must be dev or release');
  const target = platform || 'all';
  if (PLATFORMS.indexOf(target) < 0) throw new Error('platform must be one of ' + PLATFORMS.join(', '));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;

  let sink = { url: '', origin: '' };
  const rawSink = (env.SS_DEV_SINK_URL || '').trim();
  if (mode === 'dev' && rawSink) {
    const c = checkSinkUrl(rawSink);
    if (!c.ok) fail('SS_DEV_SINK_URL rejected: ' + c.reason);
    sink = { url: c.url, origin: c.origin };
  }
  // Release builds ignore SS_DEV_SINK_URL entirely.

  const tag = target === 'all' ? mode : mode + '-' + target;
  const tscDir = join(root, 'build', 'tsc', tag);
  const out = join(root, 'dist', tag);
  rmSync(tscDir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // 1. TypeScript -> ES5
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', tscDir], { stdio: 'inherit' });
  } catch (e) {
    fail('tsc reported errors');
  }

  // 2. Bundle
  const result = await esbuild.build({
    entryPoints: [join(tscDir, 'app', 'main.js')],
    bundle: true,
    format: 'iife',
    target: 'es5',
    platform: 'browser',
    minify: mode === 'release',
    legalComments: 'none',
    charset: 'ascii',
    write: false,
    outfile: join(out, 'app.js'),
    define: {
      __SS_BUILD_MODE__: JSON.stringify(mode),
      __SS_VERSION__: JSON.stringify(version),
      __SS_DEV_SINK_URL__: JSON.stringify(mode === 'dev' ? sink.url : ''),
      __SS_PLATFORM__: JSON.stringify(target)
    },
    plugins: mode === 'release' ? [releaseDevStub(tscDir)] : [],
    logLevel: 'warning'
  });
  const js = result.outputFiles[0].text;

  // 3. ES5 gate
  const es5 = checkEs5Bundle(js);
  if (!es5.ok) fail('bundle is not ES5-clean', es5.errors);
  writeFileSync(join(out, 'app.js'), js);

  // 4. CSS
  const css = CSS_ORDER.map((f) => applyTokens(readFileSync(join(root, 'src', 'styles', f), 'utf8'), tokens)).join('\n');
  const cssCheck = checkCss(css);
  if (!cssCheck.ok) fail('CSS uses unsupported features', cssCheck.errors);
  writeFileSync(join(out, 'app.css'), css);

  // 5. Static files and config
  cpSync(join(root, 'src', 'index.html'), join(out, 'index.html'));
  cpSync(join(root, 'tizen', 'icon.png'), join(out, 'icon.png'));
  // Bundled fonts (WOFF2 + licence files), referenced by app.css as fonts/<file>.
  cpSync(join(root, 'src', 'fonts'), join(out, 'fonts'), { recursive: true });
  if (target === 'all' || target === 'tizen') {
    const template = readFileSync(join(root, 'tizen', 'config.template.xml'), 'utf8');
    writeFileSync(join(out, 'config.xml'), renderConfig(template, { mode, version, sinkOrigin: sink.origin || undefined }));
  }

  // 6. Release exclusion check
  if (mode === 'release') {
    const rc = checkReleaseDir(out, { config: target === 'all' || target === 'tizen' });
    if (!rc.ok) fail('release check failed', rc.errors);
  }

  const files = readdirSync(out).map((f) => f + ' (' + statSync(join(out, f)).size + ' B)');
  console.log(`build ${mode} ${version}${target === 'all' ? '' : ' [' + target + ']'}: OK -> dist/${tag}: ${files.join(', ')}`);
  if (mode === 'dev') console.log('dev sink: ' + (sink.url || 'not configured (set SS_DEV_SINK_URL)'));
  return { out, js, sink };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pi = process.argv.indexOf('--platform');
  build(process.argv[2], process.env, pi > 0 ? process.argv[pi + 1] : undefined).catch((e) => fail(e.message));
}
