// npm run check:release: verifies dist/release excludes all development logging.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseDir } from './lib/release-check.mjs';

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'dist', 'release');
const r = checkReleaseDir(dir);
for (const e of r.errors) console.error('  ' + e);
console.log('release-check: ' + (r.ok ? 'OK (no development logging code or origins)' : 'FAILED'));
process.exit(r.ok ? 0 : 1);
