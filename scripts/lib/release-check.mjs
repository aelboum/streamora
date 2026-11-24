// Proves a release build contains no development-only logging code and that config.xml matches
// the approved security policy exactly (ARCHITECTURE.md rev 3 §6.3).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVILEGES, CSP } from './config-xml.mjs';

/** Strings that only exist in the dev log sink (src/dev/log-sink.ts, src/dev/sink-url.ts). */
export const DEV_ONLY_MARKERS = [
  'SS_DEV_LOG_SINK_V1',
  'dev log sink',
  'private LAN IPv4',
  '/ingest'
];

function unescapeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * @param {string} dir dist/release
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkReleaseDir(dir) {
  const errors = [];
  for (const f of ['app.js', 'app.css', 'index.html', 'config.xml', 'icon.png']) {
    if (!existsSync(join(dir, f))) {
      errors.push('missing ' + f);
    }
  }
  if (errors.length) {
    return { ok: false, errors };
  }
  const js = readFileSync(join(dir, 'app.js'), 'utf8');
  for (const m of DEV_ONLY_MARKERS) {
    if (js.indexOf(m) >= 0) {
      errors.push('app.js contains dev-only marker: ' + m);
    }
  }
  if (/http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(js)) {
    errors.push('app.js contains a plain-HTTP IP address');
  }

  const cfg = readFileSync(join(dir, 'config.xml'), 'utf8');
  const access = cfg.match(/<access\b[^>]*\/>/g) || [];
  if (access.length !== 1 || access[0] !== '<access origin="*" subdomains="true"/>') {
    errors.push('config.xml must declare exactly the approved access rule');
  }
  const csp = /<tizen:content-security-policy>([^<]*)<\/tizen:content-security-policy>/.exec(cfg);
  if (!csp) {
    errors.push('config.xml has no content security policy');
  } else {
    const value = unescapeXml(csp[1]);
    if (value !== CSP) {
      errors.push('content security policy differs from the approved policy');
    }
    if (/unsafe-/.test(value)) {
      errors.push('content security policy allows unsafe sources');
    }
  }
  const privs = (cfg.match(/<tizen:privilege name="([^"]+)"\/>/g) || []).map((p) => /name="([^"]+)"/.exec(p)[1]).sort();
  const want = PRIVILEGES.slice().sort();
  if (privs.join(',') !== want.join(',')) {
    errors.push('privileges differ from the approved set: ' + privs.join(', '));
  }
  return { ok: errors.length === 0, errors };
}
