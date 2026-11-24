// Generates tizen config.xml for a build mode from tizen/config.template.xml.
// ARCHITECTURE.md rev 3 §6.3: user-entered IPTV hosts are unknown at build time, so both modes
// declare a wildcard origin for http/https data, media and images. Scripts stay 'self' only.
// The dev log sink (dev builds only) is covered by the same policy; release builds strip it.

export const PRIVILEGES = [
  'http://tizen.org/privilege/internet',
  'http://tizen.org/privilege/tv.inputdevice',
  'http://tizen.org/privilege/filesystem.read',
  'http://tizen.org/privilege/filesystem.write',
  'http://tizen.org/privilege/keymanager'
];

export const ACCESS = '  <access origin="*" subdomains="true"/>';
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: http: https:; media-src http: https:; connect-src http: https:";

/** Temporary development identifiers. Not the permanent package namespace (open question). */
export const TEMP_PACKAGE_ID = 'SShelfDev1';
export const APP_NAME = 'ScreenShelf';

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {string} template contents of tizen/config.template.xml
 * @param {{mode: 'dev'|'release', version: string, sinkOrigin?: string}} opts
 */
export function renderConfig(template, opts) {
  if (opts.mode !== 'dev' && opts.mode !== 'release') {
    throw new Error('unknown mode ' + opts.mode);
  }
  if (opts.mode === 'release' && opts.sinkOrigin) {
    throw new Error('release builds must not have a dev sink origin');
  }
  if (!/^\d+\.\d+\.\d+$/.test(opts.version)) {
    throw new Error('version must be x.y.z');
  }
  const privileges = PRIVILEGES.map((p) => '  <tizen:privilege name="' + p + '"/>').join('\n');
  return template
    .split('{{PACKAGE_ID}}').join(TEMP_PACKAGE_ID)
    .split('{{APP_NAME}}').join(APP_NAME)
    .split('{{VERSION}}').join(opts.version)
    .split('{{MODE}}').join(opts.mode)
    .split('{{PRIVILEGES}}').join(privileges)
    .split('{{ACCESS}}').join(ACCESS)
    .split('{{CSP}}').join(escapeXml(CSP));
}
