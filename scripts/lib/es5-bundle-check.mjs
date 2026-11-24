// Output-level gate: the final bundle must parse as ECMAScript 5 and must not reference
// APIs confirmed missing on the TV. This catches anything the source rules, tsc or
// esbuild let through (including esbuild's own helper code).
import * as acorn from 'acorn';

const BANNED_IDENTIFIERS = ['URLSearchParams', 'AbortController', 'IntersectionObserver', 'ResizeObserver', 'fetch', 'eval'];
const BANNED_PROPERTIES = ['finally', 'padStart', 'padEnd', 'innerHTML', 'outerHTML', 'insertAdjacentHTML'];

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') {
    return;
  }
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        walk(c, fn);
      }
    } else if (child && typeof child.type === 'string') {
      walk(child, fn);
    }
  }
}

/**
 * @param {string} code bundle source
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkEs5Bundle(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 5, sourceType: 'script', locations: true });
  } catch (e) {
    return { ok: false, errors: ['not valid ES5: ' + e.message] };
  }
  const errors = [];
  walk(ast, (node) => {
    const line = node.loc ? node.loc.start.line : 0;
    if (node.type === 'Identifier' && BANNED_IDENTIFIERS.includes(node.name)) {
      errors.push('line ' + line + ': banned global ' + node.name);
    }
    if (node.type === 'MemberExpression') {
      const prop = !node.computed && node.property.type === 'Identifier' ? node.property.name
        : node.computed && node.property.type === 'Literal' ? String(node.property.value) : null;
      if (prop && BANNED_PROPERTIES.includes(prop)) {
        errors.push('line ' + line + ': banned member .' + prop);
      }
      if (prop && (prop === 'values' || prop === 'entries') && node.object.type === 'Identifier' && node.object.name === 'Object') {
        errors.push('line ' + line + ': banned Object.' + prop);
      }
    }
    if ((node.type === 'NewExpression' || node.type === 'CallExpression') && node.callee.type === 'Identifier' && node.callee.name === 'Function') {
      errors.push('line ' + line + ': Function constructor');
    }
  });
  return { ok: errors.length === 0, errors };
}
