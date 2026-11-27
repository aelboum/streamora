// The eight pages of the design (Home, Features, Platforms, AI, Screenshots, Downloads, Support,
// About) plus a 404 page built from the same pieces. Markup and text follow
// "EliteStream Website.dc.html" one to one; dynamic values come from data.mjs.
import { FEATURES, FAQ, PRINCIPLES, SHOTS, STATUS, aiItems, platforms } from './data.mjs';
import { esc } from './layout.mjs';

const CH_WIDTHS = ['w77', 'w69', 'w61', 'w53', 'w45', 'w82', 'w74']; // design: 40 + ((i*37) % 45) %
const EPG = [['er1', ['c-v55', 'c-w08', 'c-w08']], ['er2', ['c-w10', 'c-c35', 'c-w08']], ['er3', ['c-w10', 'c-w08', 'c-w06']]];

function pill(cls, text, small) {
  return '<span class="es-pill' + (small ? ' sm' : '') + ' ' + cls + '">' + esc(text) + '</span>';
}

export function home() {
  const plats = platforms();
  const ai = aiItems().slice(0, 4);
  const channels = CH_WIDTHS.map((w, i) => `
                <div class="mock-ch${i === 1 ? ' on' : ''}">
                  <span class="n">${100 + i + 1}</span>
                  <span class="logo"></span>
                  <span class="lines"><span class="l1 ${w}"></span><span class="l2"></span></span>
                </div>`).join('');
  const epg = EPG.map(([row, cells]) => '<div class="er ' + row + '">' + cells.map((c) => '<span class="' + c + '"></span>').join('') + '</div>').join('');
  return `
<div class="es-fade">
  <section class="hero" aria-labelledby="hero-h">
    <div class="hero-glow" aria-hidden="true"></div>
    <div class="hero-in">
      <div class="hero-badge"><span>MEDIA PLAYER</span>Built for Samsung, LG and Philips televisions</div>
      <h1 id="hero-h">Your Entertainment. Your Way.</h1>
      <p class="hero-sub">Experience a smarter way to enjoy your entertainment with EliteStream.</p>
      <div class="hero-btns">
        <a class="btn-primary" href="/about/">Discover EliteStream</a>
        <a class="btn-ghost" href="/features/">Explore Features</a>
      </div>

      <div class="mock-wrap">
        <div class="mock-glow" aria-hidden="true"></div>
        <div class="mock" role="img" aria-label="Illustrative concept of the EliteStream TV interface">
          <div class="mock-screen">
            <div class="mock-rail">
              <img src="/assets/mark.png" alt="" width="256" height="256">
              <i class="on"></i><i></i><i></i><i class="round"></i>
            </div>
            <div class="mock-list">
              <div class="mock-title">Live TV</div>
              <div class="mock-cats"><span>ALL</span><span>NEWS</span><span>SPORT</span><span>KIDS</span></div>${channels}
            </div>
            <div class="mock-main">
              <div class="mock-preview">
                <span>[ YOUR CONTENT PREVIEW ]</span>
                <div class="mock-osd">
                  <div class="row"><span class="t"></span><span class="live">LIVE</span></div>
                  <div class="bar"><i></i></div>
                </div>
              </div>
              <div class="mock-epg">
                <div class="times"><span>EPG</span><span>20:00</span><span>20:30</span><span>21:00</span></div>
                ${epg}
              </div>
            </div>
          </div>
        </div>
        <div class="mock-note">Illustrative interface concept — not a product screenshot</div>
      </div>

      <div class="compat">
        <div class="compat-h">PLATFORM COMPATIBILITY</div>
        <div class="compat-list">
          ${plats.map((p) => `<a href="/platforms/"><span class="dot ${p.cls}"></span><span class="name">${esc(p.short)}</span><span class="st">${esc(p.status)}</span></a>`).join('\n          ')}
        </div>
      </div>
    </div>
  </section>

  <section class="exp" aria-labelledby="exp-h">
    <div class="wrap">
      <div class="exp-top">
        <div>
          <div class="es-eyebrow">THE EXPERIENCE</div>
          <h2 class="h2-xl" id="exp-h">Everything you watch, in one calm interface.</h2>
        </div>
        <a href="/features/">All features →</a>
      </div>
      <div class="cat-grid">
        ${FEATURES.map((f) => `<a class="cat es-card" href="/features/">
          <span class="num ${f.accent}">${f.num}</span>
          <span class="t">${esc(f.title)}</span>
          <span class="d">${esc(f.blurb)}</span>
          <span class="c">${f.items.length} capabilities</span>
        </a>`).join('\n        ')}
      </div>
    </div>
  </section>

  <section class="ai-teaser" aria-labelledby="ai-teaser-h">
    <div class="ai-box">
      <div class="ai-box-glow" aria-hidden="true"></div>
      <div class="ai-box-in">
        <div>
          <div class="es-eyebrow lilac">ELITESTREAM AI</div>
          <h2 class="h2-l" id="ai-teaser-h">Intelligence that stays out of the way.</h2>
          <p>Search, translation and recommendations designed around the remote control. Each capability is clearly marked as released or on the roadmap.</p>
          <a class="btn-line" href="/ai/">Explore EliteStream AI</a>
        </div>
        <div class="ai-list">
          ${ai.map((a) => `<div class="ai-row"><span>${esc(a.name)}</span>${pill(a.cls, a.status, true)}</div>`).join('\n          ')}
        </div>
      </div>
    </div>
  </section>

  <section class="trust" aria-labelledby="trust-h">
    <div class="trust-in">
      <h2 id="trust-h">A player — not a content provider.</h2>
      <p>EliteStream does not supply television channels, movies or series. You connect your own lawful content sources and remain responsible for having the rights to access them.</p>
      <div><a class="es-arrow" href="/about/">Read our principles →</a></div>
    </div>
  </section>
</div>`;
}

export function features() {
  return `
<div class="es-fade es-page">
  <div class="es-eyebrow">FEATURES</div>
  <h1 class="es-h1 w15">Designed for the big screen and the remote.</h1>
  <p class="es-lead">Four pillars shape EliteStream: live television, on‑demand libraries, intelligent assistance and a refined player.</p>
  <div class="feat-list">
    ${FEATURES.map((f) => `<article class="feat es-card">
      <div class="feat-text">
        <span class="num ${f.accent}">${f.num} — ${esc(f.title)}</span>
        <h2>${esc(f.headline)}</h2>
        <p>${esc(f.blurb)}</p>${f.note ? `
        <p class="note">${esc(f.note)}</p>` : ''}
      </div>
      <ul class="feat-items">
        ${f.items.map((it) => `<li><span class="n">${esc(it.name)}</span><span class="d">${esc(it.desc)}</span></li>`).join('\n        ')}
      </ul>
    </article>`).join('\n    ')}
  </div>
</div>`;
}

export function platformsPage() {
  return `
<div class="es-fade es-page">
  <div class="es-eyebrow">PLATFORMS</div>
  <h1 class="es-h1">One player. Four television platforms.</h1>
  <p class="es-lead">We only list a platform as available once it has been tested. Status is updated with every release.</p>
  <div class="legend">
    ${Object.keys(STATUS).map((k) => `<span><span class="dot lg ${STATUS[k].cls}"></span>${esc(k)}</span>`).join('\n    ')}
  </div>
  <div class="plat-grid">
    ${platforms().map((p) => `<article class="plat es-card">
      <div class="plat-top"><span class="num">${p.num}</span>${pill(p.cls, p.status)}</div>
      <div>
        <div class="brand">${esc(p.brand)}</div>
        <h2>${esc(p.os)}</h2>
      </div>
      <p>${esc(p.statusText)}</p>
      <a href="/downloads/">Download status →</a>
    </article>`).join('\n    ')}
  </div>
  <p class="fine">Specific TV models and OS versions will be published per platform once testing is complete. Compatibility with other devices is not claimed.</p>
</div>`;
}

export function ai() {
  return `
<div class="es-fade">
  <section class="ai-hero">
    <div class="ai-hero-glow" aria-hidden="true"></div>
    <div class="wrap">
      <div class="es-eyebrow lilac">ELITESTREAM AI</div>
      <h1 class="es-h1">A smarter layer on top of your library.</h1>
      <p class="es-lead w58">EliteStream AI is being built to help you find, understand and enjoy content — in your language, from the sofa. Every capability below is labelled with its current status.</p>
    </div>
  </section>
  <section class="ai-sec">
    <div class="ai-grid">
      ${aiItems().map((a) => `<article class="ai-card">
        <div class="top"><span class="num">${a.num}</span>${pill(a.cls, a.status)}</div>
        <h2>${esc(a.name)}</h2>
        <p>${esc(a.desc)}</p>
      </article>`).join('\n      ')}
    </div>
  </section>
  <section class="ai-notes">
    <div class="grid">
      <div class="note-box cyan">
        <div class="h">REQUIREMENTS</div>
        <p>AI functionality may require an internet connection and an API provider. Some features may need you to supply your own API key.</p>
      </div>
      <div class="note-box">
        <div class="h">THIRD‑PARTY SERVICES</div>
        <p>AI requests may be processed by third‑party providers under their own terms and privacy policies. Core playback never depends on AI.</p>
      </div>
    </div>
  </section>
</div>`;
}

export function screenshots() {
  return `
<div class="es-fade es-page">
  <div class="es-eyebrow">SCREENSHOTS &amp; EXPERIENCE</div>
  <h1 class="es-h1">See EliteStream on screen.</h1>
  <p class="es-lead">Genuine captures from the application will appear here. We never publish mock‑ups as product screenshots.</p>
  <div class="shots">
    ${SHOTS.map(([title, slot, wide]) => `<figure class="shot${wide ? ' wide' : ''}">
      <div class="frame"><span>[ screenshot: ${esc(slot)} ]</span></div>
      <figcaption><span>${esc(title)}</span><span>Awaiting capture</span></figcaption>
    </figure>`).join('\n    ')}
  </div>
</div>`;
}

export function downloads() {
  return `
<div class="es-fade es-page">
  <div class="es-eyebrow">DOWNLOADS</div>
  <h1 class="es-h1">Get EliteStream for your TV.</h1>
  <p class="es-lead">Downloads appear here only once an approved public release exists. No third‑party mirrors are endorsed.</p>
  <div class="dl-list">
    ${platforms().map((p) => `<article class="dl es-card">
      <div>
        <div class="brand">${esc(p.brand)}</div>
        <h2>${esc(p.os)}</h2>
      </div>
      <dl>
        <dt>VERSION</dt><dd>—</dd>
        <dt>RELEASED</dt><dd>—</dd>
        <dt>STATUS</dt><dd class="${p.cls}">${esc(p.status)}</dd>
      </dl>
      <p>Release notes and installation instructions will be published with the first public build.</p>
      <div class="act"><span class="soon" aria-disabled="true">Coming soon</span></div>
    </article>`).join('\n    ')}
  </div>
</div>`;
}

/** All groups are in the HTML (readable without JavaScript); site.js shows one group at a time. */
export function support() {
  return `
<div class="es-fade es-page">
  <div class="es-eyebrow">SUPPORT &amp; FAQ</div>
  <h1 class="es-h1">How can we help?</h1>
  <div class="faq">
    <nav class="faq-nav" aria-label="Support topics">
      ${FAQ.map(([name, qs], i) => `<button type="button" data-group="${i}" aria-controls="faq-g${i}" aria-pressed="${i === 0 ? 'true' : 'false'}"><span>${esc(name)}</span><span>${qs.length}</span></button>`).join('\n      ')}
    </nav>
    <div>
      ${FAQ.map(([name, qs], i) => `<section class="faq-group" id="faq-g${i}"${i === 0 ? '' : ' hidden'} aria-label="${esc(name)}">
        <h2>${esc(name)}</h2>
        ${qs.map(([q, a], j) => `<div class="faq-q">
          <button type="button" aria-expanded="${j === 0 ? 'true' : 'false'}" aria-controls="faq-a${i}-${j}"><span>${esc(q)}</span><span aria-hidden="true">${j === 0 ? '−' : '+'}</span></button>
          <p id="faq-a${i}-${j}"${j === 0 ? '' : ' hidden'}>${esc(a)}</p>
        </div>`).join('\n        ')}
      </section>`).join('\n      ')}
    </div>
  </div>
</div>`;
}

export function about() {
  return `
<div class="es-fade es-page about">
  <div class="about-top"><img src="/assets/mark.png" alt="EliteStream logo" width="56" height="56"><span class="es-eyebrow">ABOUT ELITESTREAM</span></div>
  <h1>Television software should feel effortless.</h1>
  <p class="intro">EliteStream is a cross‑platform entertainment player for Smart TVs. Our goal is a single, consistent experience across Samsung, LG and Philips televisions — fast to navigate with a remote, pleasant to look at, and honest about what it does.</p>
  <div class="principles">
    ${PRINCIPLES.map((p) => `<div class="principle es-card">
      <span class="num">${p.num}</span>
      <h2>${esc(p.t)}</h2>
      <p>${esc(p.d)}</p>
    </div>`).join('\n    ')}
  </div>
  <section class="legal" aria-labelledby="legal-h">
    <h2 id="legal-h">Legal &amp; trust</h2>
    <ul>
      <li>EliteStream is a media player, not an IPTV content provider.</li>
      <li>EliteStream does not supply television channels, movies or series.</li>
      <li>Users must provide their own lawful content sources and are responsible for ensuring they have the rights to access that content.</li>
      <li>AI services may involve third‑party providers, subject to their own terms.</li>
    </ul>
  </section>
</div>`;
}

/** Not in the design (a static host needs one); built only from the design's page pieces. */
export function notFound() {
  return `
<div class="es-fade es-page">
  <div class="es-eyebrow">404</div>
  <h1 class="es-h1">This page does not exist.</h1>
  <p class="es-lead">The address may be mistyped, or the page has moved.</p>
  <div class="nf-actions">
    <a class="btn-primary" href="/">Go to the home page</a>
    <a class="btn-ghost" href="/support/">Support &amp; FAQ</a>
  </div>
</div>`;
}

export const RENDER = { home, features, platforms: platformsPage, ai, screenshots, downloads, support, about };
