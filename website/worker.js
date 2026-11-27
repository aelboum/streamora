// EliteStream website Worker (Cloudflare Workers static assets, Free plan).
//   - www.elitestreamplayer.com → 301 to https://elitestreamplayer.com (same path and query)
//   - only GET and HEAD
//   - every response gets the security headers and a cache policy:
//       hashed CSS/JS and fonts: 1 year, immutable · logo/favicon: 1 week · pages: always revalidated
// The pages themselves are static files (dist/), served by the ASSETS binding with
// html_handling "auto-trailing-slash" and the 404 page for unknown paths.

export const APEX = 'elitestreamplayer.com';

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

export function cacheControl(pathname) {
  if (/^\/fonts\//.test(pathname) || /^\/(styles|site)\.[0-9a-f]{10}\.(css|js)$/.test(pathname)) { return 'public, max-age=31536000, immutable'; }
  if (/^\/assets\//.test(pathname)) { return 'public, max-age=604800'; }
  return 'public, max-age=0, must-revalidate';
}

export function withHeaders(res, pathname) {
  const r = new Response(res.body, res);
  for (const k in SECURITY_HEADERS) { r.headers.set(k, SECURITY_HEADERS[k]); }
  if (res.status < 300) { r.headers.set('Cache-Control', cacheControl(pathname)); }
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.' + APEX) {
      return withHeaders(Response.redirect('https://' + APEX + url.pathname + url.search, 301), url.pathname);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return withHeaders(new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' } }), url.pathname);
    }
    return withHeaders(await env.ASSETS.fetch(request), url.pathname);
  }
};
