// Shared page shell: <head>, header (desktop nav ≥1000 px, mobile menu below) and footer, as in the
// design. Links use real paths (/features/) instead of the prototype's hash routes (#/features), so
// every page has its own URL that works on refresh and when opened directly.
import { NAV, OG, SITE_URL, TITLES, DESCRIPTIONS } from './data.mjs';

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function href(page) {
  return page === 'home' ? '/' : '/' + page + '/';
}

/**
 * @param {{ page: string, body: string, assets: { css: string, js: string }, status?: number }} o
 */
export function layout(o) {
  const page = o.page;
  const title = page === '404' ? 'Page not found – EliteStream' : TITLES[page];
  const desc = page === '404' ? DESCRIPTIONS.home : DESCRIPTIONS[page];
  const canonical = page === '404' ? '' : '<link rel="canonical" href="' + SITE_URL + href(page) + '">';
  const navLinks = NAV.map(([k, label]) =>
    '<a href="' + href(k) + '"' + (k === page ? ' aria-current="page"' : '') + '>' + esc(label) + '</a>').join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${canonical}
<meta property="og:title" content="${esc(page === 'home' ? OG.title : title)}">
<meta property="og:description" content="${esc(page === 'home' ? OG.description : desc)}">
<meta property="og:image" content="${SITE_URL}/assets/mark.png">
<meta property="og:type" content="website">
${page === '404' ? '' : '<meta property="og:url" content="' + SITE_URL + href(page) + '">'}
<meta name="theme-color" content="#080B12">
${page === '404' ? '<meta name="robots" content="noindex">' : ''}
<link rel="icon" href="/assets/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/assets/mark.png">
<link rel="preload" href="/fonts/sora-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/dm-sans-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${o.assets.css}">
<script src="${o.assets.js}" defer></script>
${page === 'home' ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"EliteStream","applicationCategory":"MultimediaApplication","operatingSystem":"Tizen, webOS, Android TV, Titan OS","description":"A cross-platform media player for compatible Smart TVs. EliteStream does not supply content."}</script>' : ''}
</head>
<body>
<div class="es-root">
<a class="es-skip" href="#main">Skip to content</a>
<header class="es-header">
  <nav class="es-nav" aria-label="Primary">
    <a class="es-brand" href="/">
      <img src="/assets/mark.png" alt="" width="34" height="34">
      <span>elitestream</span>
    </a>
    <div class="es-links">${navLinks}</div>
    <a class="es-cta" href="/downloads/">Get EliteStream</a>
    <button class="es-menu-btn" type="button" aria-label="Menu" aria-expanded="false" aria-controls="es-mobile">≡</button>
  </nav>
  <div class="es-mobile" id="es-mobile" hidden>
    ${NAV.map(([k, label]) => '<a href="' + href(k) + '"' + (k === page ? ' aria-current="page"' : '') + '>' + esc(label) + '</a>').join('\n    ')}
    <a class="es-mobile-cta" href="/downloads/">Get EliteStream</a>
  </div>
</header>

<main id="main">
${o.body}
</main>

<footer class="es-footer">
  <div class="cols">
    <div class="col brandcol">
      <a href="/"><img src="/assets/mark.png" alt="" width="30" height="30"><span>elitestream</span></a>
      <p>A cross‑platform media player. EliteStream does not provide content.</p>
    </div>
    <div class="col">
      <span class="h">PRODUCT</span>
      <a href="/features/">Features</a><a href="/platforms/">Platforms</a><a href="/ai/">EliteStream AI</a><a href="/screenshots/">Screenshots</a>
    </div>
    <div class="col">
      <span class="h">COMPANY</span>
      <a href="/downloads/">Downloads</a><a href="/support/">Support</a><a href="/about/">About</a>
    </div>
  </div>
  <div class="base">
    <span>© 2026 EliteStream. All rights reserved.</span>
    <span>Samsung, LG, Philips and their OS names are trademarks of their respective owners.</span>
  </div>
</footer>
</div>
</body>
</html>
`;
}
