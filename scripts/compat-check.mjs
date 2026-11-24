// npm run compat: applies scripts/lib/compat-rules.mjs to every file in src/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSource } from './lib/compat-rules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function listTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

export function runCompatCheck() {
  const files = listTs(join(root, 'src'));
  const findings = [];
  for (const f of files) {
    const rel = relative(root, f).split(sep).join('/');
    findings.push(...checkSource(readFileSync(f, 'utf8'), rel));
  }
  return { files: files.length, findings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { files, findings } = runCompatCheck();
  for (const x of findings) console.error(`${x.file}:${x.line}  ${x.rule}  ${x.message}`);
  console.log(`compat-check: ${files} files, ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
}
