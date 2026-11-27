# EliteStream website (elitestreamplayer.com)

Date: 2026-11-27. **Status:** deployed 2026-11-27 (Worker `elitestream-site`, version da2a2aec; relay version 6b1df662). Nothing is committed.

## Source of truth

- The Claude Design project "EliteStream site prototype", file `EliteStream Website.dc.html` (https://claude.ai/design/p/63ea5a80-4667-498e-90ec-82cecb8a6e4e).
- The other project, "EliteStream Phase 1 directions", is the TV app design. It is not used here.
- The design is a single-page prototype with hash routes (`#/features`) and 8 views. The site turns it into 8 real pages with the same markup, text, sizes, colours, gradients, shadows, animation (`esFade`) and breakpoint (1000 px).

## Pages

| Path | Design view |
|---|---|
| `/` | Home: hero, interface concept, platform compatibility, the experience, AI teaser, "a player — not a content provider" |
| `/features/` | Features (4 pillars) |
| `/platforms/` | Platforms with status legend |
| `/ai/` | EliteStream AI |
| `/screenshots/` | Screenshot slots ("Awaiting capture") |
| `/downloads/` | Downloads ("Coming soon"; no files) |
| `/support/` | Support & FAQ (topics and accordion) |
| `/about/` | About, principles, legal & trust |
| (any other) | 404 page, built from the design's page pieces (not in the design) |

Old prototype links (`/#/features`) redirect to the real page. Only the 7 known page names are accepted.

## Implementation (`website/`)

- `src/data.mjs`: all text and data, verbatim from the design. Platform and AI statuses use the design's defaults: Samsung, LG, Philips Android and Philips Titan are "In development"; AI is "Planned". Change them here per release.
- `src/layout.mjs`, `src/pages.mjs`: the page markup.
- `src/styles.css`: the design's inline styles moved into classes, with the same values. This was needed for a strict Content-Security-Policy (no inline styles).
- `src/site.js` (2.9 KB): the only JavaScript. It handles the mobile menu, the FAQ, and the old `#/` links.
- **Fonts:** Sora (400/600), DM Sans (variable) and JetBrains Mono (400). These are the design's fonts, self-hosted from the pinned `@fontsource` packages (OFL) instead of Google Fonts. There are no third-party requests, and the CSP can stay strict.
- **Assets:** `public/assets/mark.png` and `favicon.png`, byte-identical to the design project's assets.
- `build.mjs` → `dist/`:
  - one `index.html` per page, plus `404.html`;
  - content-hashed CSS and JS;
  - fonts, `robots.txt` and `sitemap.xml`.
- It also copies the stylesheet, fonts and logo into `relay/public/` for the pairing page.
- `worker.js`: www → apex 301, GET/HEAD only, security headers and cache policy.
- `preview.mjs`: a local server that runs the real Worker in front of an emulated assets binding.
- `tests/site.test.mjs`: 7 tests covering build, routing, headers, CSP-safe markup, links, content and old links.

Commands: `cd website && npm install && npm run build && npm test`. Preview: `npm run preview` (http://127.0.0.1:8788).

**Weight (home):**
- HTML 11.8 KB (3.0 KB gzip);
- CSS 27 KB (5.4 KB gzip);
- JS 2.9 KB;
- fonts 114 KB total (2 preloaded);
- logo 67 KB (cached for a week).

## Pairing page (pair.elitestreamplayer.com)

- **Where the QR code lives:** on the TV (AI settings, Add M3U / Add Xtream, Edit playlist). Its waiting, expired and New code states are there.
- **What the phone page is:** the page the QR code opens: `relay/public/index.html`. It now uses the website's header, navigation, footer, fonts, background, cards, buttons and pills, through `site.css`.
- **Unchanged:** the pairing logic, encryption, element IDs and relay API.
- **States on the phone:**
  - invalid link;
  - form with check code;
  - sending;
  - sent, waiting for the TV;
  - received (success);
  - TV closed or expired, already sent, and no connection (errors);
  - field validation messages.
- **Retry:** the phone cannot create a code, so a retry means "Show a new code on the TV".
- **Header change:** `_headers` adds `font-src 'self'`. Everything else is unchanged: `no-store`, `no-referrer`, and `default-src 'none'`.

## Cloudflare

- **Method:** Workers static assets with a small Worker (Free plan). This is the same approach and the same login as the relay.
  - Pages was not used: it would need a new login with Pages permissions and dashboard steps for the custom domains.
  - Workers static assets are Cloudflare's current recommendation for static sites.
- **Config:** `website/wrangler.toml`.
  - Worker `elitestream-site`; `workers_dev = false`.
  - Custom domains: `elitestreamplayer.com` and `www.elitestreamplayer.com`.
  - Assets from `./dist`: `auto-trailing-slash`, the 404 page, `run_worker_first = true`.
- **Audit (2026-11-27, read-only):**
  - The zone uses Cloudflare nameservers.
  - The root domain and `www` have no DNS records (no A, AAAA, CNAME, MX or TXT). Only `pair.` exists, on the Worker `elitestream-pair`.
  - Deploying creates the two DNS records and certificates. Nothing existing is changed.
  - Not readable with the current minimal login: DNS record list, SSL mode, Always Use HTTPS. Nothing in this deployment depends on them, because the Workers custom domains get their own edge certificates.
- **Headers (all responses):**
  - CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; … frame-ancestors 'none'`;
  - HSTS, nosniff, `X-Frame-Options DENY`, `Referrer-Policy strict-origin-when-cross-origin`, `Permissions-Policy`, COOP.
- **Cache:**
  - hashed CSS/JS and fonts: 1 year, immutable;
  - logo and favicon: 1 week;
  - pages: always revalidated.
- **Secrets:** none. The site has no API keys, environment variables or forms.

## Deployment steps (only after the owner's approval)

1. `cd website && npm install && npm run build && npm test`
2. `WRANGLER_SEND_METRICS=false npx wrangler@4 deploy`. This creates the Worker and both custom domains.
3. Check:
   - `https://elitestreamplayer.com/` and every page, opened directly and after a refresh;
   - `https://www.elitestreamplayer.com/x` → 301 to `https://elitestreamplayer.com/x`;
   - `http://` redirects to HTTPS (Cloudflare edge);
   - the headers, with `curl -I`.
4. Pairing page restyle: `cd relay && WRANGLER_SEND_METRICS=false npx wrangler@4 deploy` (static files only; the Worker is unchanged).

## Known limits

- **Contrast:** the design's small grey captions (`#6E7891` on `#080B12`) fail WCAG AA contrast (Lighthouse accessibility 96). They were kept for design fidelity; a lighter grey would fix it if wanted.
- **Placeholder content:** Screenshots and Downloads show the design's placeholders ("Awaiting capture", "Coming soon"). Nothing is faked.
- **No contact form or backend:** the design has none. Support says a channel will open with the first release.
- **Logo size:** `mark.png` (256×256, 67 KB) is shown at 34–56 px. A smaller copy would save about 60 KB on the first visit; the design's asset was reused unchanged.
