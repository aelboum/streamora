// Source-level compatibility rules for src/**/*.ts, based on the Stage 1.5 TV probe
// (docs/PROBE-REPORT.md §4). The TypeScript compiler would down-level some of this
// syntax, but the project rule is that application source stays within the agreed subset.
import ts from 'typescript';

/** APIs confirmed missing on the TV, or banned by architecture decisions. */
export const BANNED_GLOBALS = {
  URLSearchParams: 'missing on Tizen 3.0 (probe)',
  AbortController: 'missing on Tizen 3.0 (probe); use HttpHandle.abort()',
  IntersectionObserver: 'missing on Tizen 3.0 (probe)',
  ResizeObserver: 'missing on Tizen 3.0 (probe)',
  fetch: 'banned (D4): use api/http-client.ts',
  eval: 'dynamic code execution is banned'
};

export const BANNED_MEMBERS = {
  finally: 'Promise.prototype.finally is missing on Tizen 3.0 (probe)',
  padStart: 'String.prototype.padStart is missing on Tizen 3.0 (probe)',
  padEnd: 'String.prototype.padEnd is not verified on Tizen 3.0',
  innerHTML: 'banned: never inject HTML',
  outerHTML: 'banned: never inject HTML',
  insertAdjacentHTML: 'banned: never inject HTML'
};

export const BANNED_OBJECT_STATICS = {
  values: 'Object.values is missing on Tizen 3.0 (probe)',
  entries: 'Object.entries is missing on Tizen 3.0 (probe)'
};

/**
 * Only these paths may reference platform globals (PLATFORM_GLOBALS). CP1: besides Tizen's `tizen` and
 * `webapis`, the Android bridge, IndexedDB (idb-file-store.ts) and the webOS / Titan OS APIs, so every
 * platform API stays behind the adapters in src/app/platform/.
 */
export const PLATFORM_GLOBALS = ['tizen', 'webapis', 'ElitePlatform', 'indexedDB', 'PalmSystem', 'webOS', 'webOSSystem', 'TitanSDK', 'SmartTvA_API'];
function isPlatformGlobal(name) { return PLATFORM_GLOBALS.indexOf(name) >= 0; }
export const PLATFORM_ALLOWED = [/^src\/app\/platform\//, /^src\/player\/avplay-engine\.ts$/, /^src\/types\/.*\.d\.ts$/];

/**
 * @param {string} text source code
 * @param {string} fileName path relative to the project root, with forward slashes
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
export function checkSource(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const platformOk = PLATFORM_ALLOWED.some((re) => re.test(fileName));

  function report(node, rule, message) {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file: fileName, line: line + 1, rule, message });
  }

  function isDeclarationName(node) {
    const p = node.parent;
    return p && (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) || ts.isMethodSignature(p)) && p.name === node;
  }

  function visit(node) {
    // ---- syntax ----
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      report(node, 'syntax/destructuring', 'destructuring is not supported on the TV');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left))) {
      report(node, 'syntax/destructuring', 'destructuring assignment is not supported on the TV');
    }
    if (ts.isParameter(node) && node.initializer) {
      report(node, 'syntax/default-param', 'default parameters are not supported on the TV');
    }
    if (ts.canHaveModifiers(node) && (ts.getModifiers(node) || []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      report(node, 'syntax/async', 'async functions are not supported on the TV');
    }
    if (ts.isAwaitExpression(node)) {
      report(node, 'syntax/async', 'await is not supported on the TV');
    }
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)) {
      report(node, 'syntax/exponent', 'the ** operator is not supported on the TV');
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) {
      report(node, 'syntax/optional-chaining', 'optional chaining is not supported on the TV');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      report(node, 'syntax/nullish', 'the ?? operator is not verified on the TV');
    }
    if (ts.isForOfStatement(node)) {
      report(node, 'syntax/for-of', 'for...of is banned (no downlevelIteration; use indexed loops or forEach)');
    }
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.asteriskToken) {
      report(node, 'syntax/generator', 'generators are banned in application source');
    }

    // ---- APIs ----
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const name = node.text;
      const parent = node.parent;
      const isMemberName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!isMemberName && Object.prototype.hasOwnProperty.call(BANNED_GLOBALS, name)) {
        report(node, 'api/' + name, BANNED_GLOBALS[name]);
      }
      if (!isMemberName && isPlatformGlobal(name) && !platformOk) {
        report(node, 'boundary/platform', '`' + name + '` may only be used in src/app/platform/');
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      if (Object.prototype.hasOwnProperty.call(BANNED_MEMBERS, member)) {
        report(node, 'api/' + member, BANNED_MEMBERS[member]);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Object' &&
          Object.prototype.hasOwnProperty.call(BANNED_OBJECT_STATICS, member)) {
        report(node, 'api/Object.' + member, BANNED_OBJECT_STATICS[member]);
      }
      if (isPlatformGlobal(member) && !platformOk &&
          ts.isIdentifier(node.expression) && /^(window|self|globalThis)$/.test(node.expression.text)) {
        report(node, 'boundary/platform', '`' + member + '` may only be used in src/app/platform/');
      }
      if (member === 'fetch' && ts.isIdentifier(node.expression) && /^(window|self|globalThis)$/.test(node.expression.text)) {
        report(node, 'api/fetch', BANNED_GLOBALS.fetch);
      }
      if (member === 'write' && ts.isIdentifier(node.expression) && node.expression.text === 'document') {
        report(node, 'api/document.write', 'banned: never inject HTML');
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const key = node.argumentExpression.text;
      if (Object.prototype.hasOwnProperty.call(BANNED_MEMBERS, key) ||
          Object.prototype.hasOwnProperty.call(BANNED_GLOBALS, key) ||
          (isPlatformGlobal(key) && !platformOk)) {
        report(node, 'api/' + key, 'banned member accessed by string: ' + key);
      }
    }
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      report(node, 'api/Function', 'the Function constructor is dynamic code execution');
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^set(Timeout|Interval)$/.test(node.expression.text) &&
        node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      report(node, 'api/string-timer', 'string arguments to timers are dynamic code execution');
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return findings;
}
