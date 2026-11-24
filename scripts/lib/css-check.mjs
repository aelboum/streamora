// CSS gate for features the TV does not support (docs/PROBE-REPORT.md §5).
const RULES = [
  [/display\s*:\s*(inline-)?grid/i, 'CSS Grid is not supported'],
  [/(^|[;{\s])(row-|column-)?gap\s*:/i, 'gap is not supported in flexbox on the TV'],
  [/var\(\s*--/i, 'CSS custom properties are not supported'],
  [/(^|[;{\s])--[a-z0-9-]+\s*:/i, 'CSS custom property declarations are not supported'],
  [/position\s*:\s*(-webkit-)?sticky/i, 'position: sticky is not supported'],
  [/\{\{[^}]*\}\}/, 'unresolved design-token placeholder'],
  [/@import/i, '@import is not allowed (single bundled stylesheet)'],
  [/url\(\s*['"]?(https?:)?\/\//i, 'remote URLs in CSS are not allowed']
];

/** @returns {{ok: boolean, errors: string[]}} */
export function checkCss(css) {
  const errors = [];
  const lines = css.split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const [re, msg] of RULES) {
      if (re.test(text)) {
        errors.push('line ' + (i + 1) + ': ' + msg + ': ' + text.trim());
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Replaces {{token}} placeholders; unknown tokens are left in place so checkCss fails. */
export function applyTokens(css, tokens) {
  return css.replace(/\{\{\s*([a-zA-Z0-9.]+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : m);
}
