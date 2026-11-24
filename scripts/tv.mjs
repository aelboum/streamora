// npm run tv:package|tv:install|tv:run|tv:uninstall -- [dev|release]
// Wraps the installed Tizen CLI. Signing uses the active development profile (probe-tizen).
// Environment overrides: TIZEN_CLI, SS_TV_SERIAL, SS_SIGN_PROFILE.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, TEMP_PACKAGE_ID } from './lib/config-xml.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const TIZEN = process.env.TIZEN_CLI || 'C:\\Development\\Tizen\\sdk\\tools\\ide\\bin\\tizen.bat';
const SDB = process.env.SDB || 'C:\\Development\\Tizen\\sdk\\tools\\sdb.exe';
const PROFILE = process.env.SS_SIGN_PROFILE || 'probe-tizen';
const APP_ID = TEMP_PACKAGE_ID + '.' + APP_NAME;

function run(cmd, args) {
  console.log('> ' + [cmd].concat(args).join(' '));
  // .bat files must go through cmd.exe on Windows.
  const out = cmd.toLowerCase().endsWith('.bat')
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', [cmd].concat(args).map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ')], { encoding: 'utf8' })
    : execFileSync(cmd, args, { encoding: 'utf8' });
  process.stdout.write(out);
  return out;
}

function serial() {
  if (process.env.SS_TV_SERIAL) return process.env.SS_TV_SERIAL;
  const lines = run(SDB, ['devices']).split(/\r?\n/).slice(1).filter((l) => /\bdevice\b/.test(l));
  if (lines.length !== 1) throw new Error('expected exactly one connected device, found ' + lines.length + ' (set SS_TV_SERIAL)');
  return lines[0].split(/\s+/)[0];
}

function pkg(mode) {
  const dist = join(root, 'dist', mode);
  if (!existsSync(join(dist, 'config.xml'))) throw new Error('dist/' + mode + ' missing; run npm run build:' + mode);
  const stage = join(root, 'build', 'pkg', mode);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(dist, stage, { recursive: true });
  run(TIZEN, ['package', '-t', 'wgt', '-s', PROFILE, '--', stage]);
  const wgt = readdirSync(stage).find((f) => f.endsWith('.wgt'));
  if (!wgt) throw new Error('no .wgt produced');
  return { dir: stage, wgt };
}

const [action, modeArg] = process.argv.slice(2);
const mode = modeArg || 'dev';
try {
  if (action === 'package') {
    const p = pkg(mode);
    console.log('packaged ' + join(p.dir, p.wgt));
  } else if (action === 'install') {
    const p = pkg(mode);
    run(TIZEN, ['install', '-s', serial(), '--name', p.wgt, '--', p.dir]);
  } else if (action === 'run') {
    run(TIZEN, ['run', '-s', serial(), '-p', APP_ID]);
  } else if (action === 'uninstall') {
    run(TIZEN, ['uninstall', '-s', serial(), '-p', APP_ID]);
  } else {
    console.error('usage: node scripts/tv.mjs package|install|run|uninstall [dev|release]');
    process.exit(2);
  }
} catch (e) {
  console.error('tv ' + action + ' failed: ' + e.message);
  if (e.stdout) process.stdout.write(String(e.stdout));
  process.exit(1);
}
