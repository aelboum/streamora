/* ScreenShelf Device Probe. Plain ES5 on purpose: it must run on whatever engine the TV has.
 * Results live in window.__probe; the PC reads them over the remote inspector. */
(function () {
  'use strict';

  var R = window.__probe = {
    meta: { t0: window.__T0, version: '0.1.0' },
    js: [], css: [], viewport: [], keys: { supported: [], registered: [], events: [] },
    https: [], avplay: [], perf: [], log: [], done: {}
  };

  var logEl = document.getElementById('log');
  var phaseEl = document.getElementById('phase');
  var summaryEl = document.getElementById('summary');

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function log(msg) {
    var line = ((Date.now() - window.__T0) / 1000).toFixed(1) + 's ' + msg;
    R.log.push(line);
    var lines = R.log.slice(-28);
    logEl.textContent = lines.join('\n');
  }
  function phase(p) { phaseEl.textContent = p; log('== ' + p); }
  function rec(list, name, status, detail) {
    list.push({ name: name, status: status, detail: detail === undefined ? '' : String(detail) });
  }
  function check(list, name, fn) {
    try {
      var r = fn();
      if (r === true) { rec(list, name, 'PASS'); }
      else if (r === false || r === undefined || r === null) { rec(list, name, 'FAIL'); }
      else { rec(list, name, 'PASS', r); }
    } catch (e) { rec(list, name, 'FAIL', 'threw: ' + (e && e.message)); }
  }
  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function count(list) {
    var p = 0, f = 0, n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].status === 'PASS') { p++; } else if (list[i].status === 'FAIL') { f++; } else { n++; }
    }
    return p + ' pass / ' + f + ' fail' + (n ? ' / ' + n + ' n.t.' : '');
  }
  function updateSummary() {
    summaryEl.textContent = 'JS: ' + count(R.js) + '   CSS: ' + count(R.css) +
      '   HTTPS: ' + count(R.https) + '   AVPlay: ' + count(R.avplay);
  }

  /* ---------------- environment ---------------- */
  function envInfo() {
    R.meta.userAgent = navigator.userAgent;
    R.meta.innerWidth = window.innerWidth;
    R.meta.innerHeight = window.innerHeight;
    R.meta.devicePixelRatio = window.devicePixelRatio;
    R.meta.screen = screen.width + 'x' + screen.height;
    R.meta.hasTizen = typeof window.tizen !== 'undefined';
    R.meta.hasWebapis = typeof window.webapis !== 'undefined';
    try { R.meta.tizenPlatform = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch (e) { R.meta.tizenPlatform = 'n/a: ' + e.message; }
    try { R.meta.firmware = webapis.productinfo.getFirmware(); } catch (e) { R.meta.firmware = 'n/a: ' + e.message; }
    try { R.meta.model = webapis.productinfo.getRealModel(); } catch (e) { R.meta.model = 'n/a: ' + e.message; }
    try { R.meta.webapisVersion = webapis.productinfo.getVersion(); } catch (e) { R.meta.webapisVersion = 'n/a'; }
    try { R.meta.uhd = webapis.productinfo.isUdPanelSupported(); } catch (e) { R.meta.uhd = 'n/a'; }
    try { R.meta.avplayVersion = webapis.avplay.getVersion(); } catch (e) { R.meta.avplayVersion = 'n/a: ' + e.message; }
    var vp = R.viewport;
    rec(vp, 'innerWidth x innerHeight', window.innerWidth === 1920 && window.innerHeight === 1080 ? 'PASS' : 'FAIL', window.innerWidth + 'x' + window.innerHeight);
    rec(vp, 'devicePixelRatio', 'PASS', window.devicePixelRatio);
    rec(vp, 'screen', 'PASS', R.meta.screen);
    log('UA ' + navigator.userAgent);
  }

  /* ---------------- JavaScript ---------------- */
  function syntax(src) { return function () { return new Function(src)() === true; }; }

  function jsTests() {
    var L = R.js;
    check(L, 'ES5 strict mode', function () { return (function () { return this === undefined; })(); });
    check(L, 'ES5 getters/setters', function () { var o = { get a() { return 1; } }; return o.a === 1; });
    check(L, 'ES5 Object.defineProperty', function () { var o = {}; Object.defineProperty(o, 'x', { value: 2 }); return o.x === 2; });
    check(L, 'ES5 Function.prototype.bind', function () { return typeof Function.prototype.bind === 'function'; });
    check(L, 'JSON.parse/stringify', function () { return JSON.stringify(JSON.parse('{"a":[1,"x"]}')) === '{"a":[1,"x"]}'; });
    check(L, 'Date.now', function () { return typeof Date.now() === 'number'; });
    check(L, 'performance.now', function () { return typeof performance.now() === 'number'; });
    check(L, 'requestAnimationFrame', function () { return typeof window.requestAnimationFrame === 'function'; });
    check(L, 'XMLHttpRequest', function () { return typeof XMLHttpRequest === 'function' || typeof XMLHttpRequest === 'object'; });
    check(L, 'XHR responseType json', function () { var x = new XMLHttpRequest(); x.open('GET', 'index.html'); x.responseType = 'json'; return x.responseType === 'json'; });
    check(L, 'fetch', function () { return typeof window.fetch === 'function'; });
    check(L, 'AbortController', function () { return typeof window.AbortController === 'function'; });
    check(L, 'Promise', function () { return typeof Promise === 'function' && typeof Promise.all === 'function' && typeof Promise.race === 'function'; });
    check(L, 'Promise.prototype.finally', function () { return typeof Promise.prototype['finally'] === 'function'; });
    check(L, 'Map / Set / WeakMap', function () { return typeof Map === 'function' && typeof Set === 'function' && typeof WeakMap === 'function'; });
    check(L, 'Map.prototype.forEach', function () { var m = new Map(); m.set('a', 1); var n = 0; m.forEach(function (v) { n += v; }); return n === 1; });
    check(L, 'Symbol', function () { return typeof Symbol === 'function'; });
    check(L, 'Array forEach/map/filter/reduce/indexOf/isArray', function () { return [1, 2, 3].map(function (x) { return x * 2; }).filter(function (x) { return x > 2; }).reduce(function (a, b) { return a + b; }, 0) === 10 && [1, 2].indexOf(2) === 1 && Array.isArray([]); });
    check(L, 'Array.prototype.find/findIndex', function () { return [1, 2].find(function (x) { return x === 2; }) === 2 && [1, 2].findIndex(function (x) { return x === 2; }) === 1; });
    check(L, 'Array.prototype.includes', function () { return [1, 2].includes(2); });
    check(L, 'Array.from / Array.of', function () { return Array.from('ab').length === 2 && Array.of(1).length === 1; });
    check(L, 'Array.prototype.fill', function () { return [0, 0].fill(1)[1] === 1; });
    check(L, 'Object.keys / create / freeze', function () { return Object.keys({ a: 1 }).length === 1 && Object.isFrozen(Object.freeze({})) && typeof Object.create(null) === 'object'; });
    check(L, 'Object.assign', function () { return Object.assign({}, { a: 1 }).a === 1; });
    check(L, 'Object.values / entries', function () { return Object.values({ a: 1 })[0] === 1 && Object.entries({ a: 1 })[0][0] === 'a'; });
    check(L, 'String trim', function () { return ' a '.trim() === 'a'; });
    check(L, 'String startsWith/endsWith/includes/repeat', function () { return 'abc'.startsWith('a') && 'abc'.endsWith('c') && 'abc'.includes('b') && 'a'.repeat(2) === 'aa'; });
    check(L, 'String padStart', function () { return '1'.padStart(2, '0') === '01'; });
    check(L, 'Number.isNaN / isFinite', function () { return Number.isNaN(NaN) && Number.isFinite(1); });
    check(L, 'URL constructor', function () { var u = new URL('https://a.example/p?q=1'); return u.protocol === 'https:' && u.hostname === 'a.example'; });
    check(L, 'URLSearchParams', function () { return new URLSearchParams('a=1').get('a') === '1'; });
    check(L, 'Intl.NumberFormat', function () { return typeof Intl === 'object' && !!new Intl.NumberFormat('en').format(1); });
    check(L, 'addEventListener/removeEventListener', function () { var n = 0, d = document.createElement('div'); function h() { n++; } d.addEventListener('x', h); d.dispatchEvent(document.createEvent('Event').initEvent ? (function () { var e = document.createEvent('Event'); e.initEvent('x', false, false); return e; })() : null); d.removeEventListener('x', h); return n === 1; });
    check(L, 'CustomEvent constructor', function () { return !!new CustomEvent('x', { detail: 1 }); });
    check(L, 'classList', function () { var d = document.createElement('div'); d.classList.add('a'); d.classList.toggle('b'); return d.className === 'a b'; });
    check(L, 'dataset', function () { var d = document.createElement('div'); d.setAttribute('data-x', '1'); return d.dataset.x === '1'; });
    check(L, 'Element.closest / matches', function () { var a = document.createElement('div'), b = document.createElement('span'); a.className = 'p'; a.appendChild(b); return b.closest('.p') === a && a.matches('.p'); });
    check(L, 'MutationObserver', function () { return typeof MutationObserver === 'function'; });
    check(L, 'IntersectionObserver', function () { return typeof window.IntersectionObserver === 'function'; });
    check(L, 'ResizeObserver', function () { return typeof window.ResizeObserver === 'function'; });
    check(L, 'performance.memory', function () { return !!(performance.memory && performance.memory.usedJSHeapSize) && (Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB used'); });
    // ES2015+ syntax: evaluated from fixed strings only, to learn what the engine parses.
    check(L, 'syntax: let/const (sloppy)', syntax('let a = 1; const b = 2; return a + b === 3;'));
    check(L, 'syntax: arrow functions', syntax('var f = (x) => x * 2; return f(2) === 4;'));
    check(L, 'syntax: class', syntax('"use strict"; class A { m() { return 1; } } return new A().m() === 1;'));
    check(L, 'syntax: template literal', syntax('var a = 1; return `x${a}` === "x1";'));
    check(L, 'syntax: destructuring', syntax('var o = { a: 1 }; var { a } = o; return a === 1;'));
    check(L, 'syntax: default params', syntax('function f(x = 1) { return x; } return f() === 1;'));
    check(L, 'syntax: spread', syntax('function f(a, b) { return a + b; } return f(...[1, 2]) === 3;'));
    check(L, 'syntax: for...of', syntax('var n = 0; for (var x of [1, 2]) { n += x; } return n === 3;'));
    check(L, 'syntax: generators', syntax('function* g() { yield 1; } return g().next().value === 1;'));
    check(L, 'syntax: async/await', syntax('var f = async function () { await 1; }; return typeof f === "function";'));
    check(L, 'syntax: exponent **', syntax('return 2 ** 3 === 8;'));
    check(L, 'syntax: optional chaining', syntax('var o = null; return o?.a === undefined;'));
    check(L, 'localStorage set/get/remove', function () { localStorage.setItem('__p', 'v'); var ok = localStorage.getItem('__p') === 'v'; localStorage.removeItem('__p'); return ok && localStorage.getItem('__p') === null; });
    check(L, 'localStorage quota (stops at 8 MB)', function () {
      var chunk = new Array(512 * 1024 + 1).join('x'); // 512K chars, about 1 MB as UTF-16
      var i = 0;
      try { for (i = 0; i < 8; i++) { localStorage.setItem('__q' + i, chunk); } } catch (e) { /* quota reached */ }
      for (var j = 0; j < 8; j++) { localStorage.removeItem('__q' + j); }
      return i > 0 && ('stored about ' + i + ' MB' + (i === 8 ? ' (limit not reached)' : ''));
    });
    // Microtask order: then-callbacks must run before setTimeout(0).
    var order = [];
    setTimeout(function () { order.push('timeout'); }, 0);
    Promise.resolve().then(function () { order.push('micro'); });
    return delay(50).then(function () {
      rec(L, 'Promise microtask ordering', order[0] === 'micro' ? 'PASS' : 'FAIL', order.join(','));
      var t = now();
      return new Promise(function (res) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { rec(L, 'rAF fires', 'PASS', (now() - t).toFixed(1) + ' ms for 2 frames'); res(); }); });
        setTimeout(res, 1000);
      });
    }).then(function () {
      if (typeof window.fetch !== 'function') { rec(L, 'fetch GET local file', 'NOT TESTED', 'no fetch'); return null; }
      return fetch('subs.srt').then(function (r) { return r.text(); }).then(function (t) {
        rec(L, 'fetch GET local file', t.indexOf('Probe cue 1') >= 0 ? 'PASS' : 'FAIL');
      }, function (e) { rec(L, 'fetch GET local file', 'FAIL', e && e.message); });
    }).then(function () {
      return new Promise(function (res) {
        var x = new XMLHttpRequest();
        x.onload = function () { rec(L, 'XHR GET local file', x.responseText.indexOf('Probe cue 1') >= 0 ? 'PASS' : 'FAIL'); res(); };
        x.onerror = function () { rec(L, 'XHR GET local file', 'FAIL', 'onerror'); res(); };
        x.open('GET', 'subs.srt'); x.send();
      });
    });
  }

  /* ---------------- CSS ---------------- */
  function supports(p, v) { try { return !!(window.CSS && CSS.supports && CSS.supports(p, v)); } catch (e) { return false; } }
  function box(parent, style) { var d = document.createElement('div'); d.setAttribute('style', style); parent.appendChild(d); return d; }

  function cssTests() {
    var L = R.css, lab = document.getElementById('lab');
    lab.innerHTML = '';
    check(L, 'CSS.supports API', function () { return !!(window.CSS && CSS.supports); });
    // Flexbox: three flex:1 children of a 900px row must be 300px each.
    check(L, 'flexbox row + flex:1', function () {
      var c = box(lab, 'display:flex;width:900px;height:20px');
      var a = box(c, 'flex:1'), b = box(c, 'flex:1'); box(c, 'flex:1');
      var ok = Math.abs(a.offsetWidth - 300) <= 1 && Math.abs(b.offsetLeft - c.offsetLeft - 300) <= 1;
      lab.removeChild(c); return ok || ('widths ' + a.offsetWidth);
    });
    check(L, 'flexbox justify space-between + align center', function () {
      var c = box(lab, 'display:flex;justify-content:space-between;align-items:center;width:600px;height:100px');
      var a = box(c, 'width:100px;height:20px'), b = box(c, 'width:100px;height:20px');
      var ok = (b.offsetLeft - a.offsetLeft) === 500 && (a.offsetTop - c.offsetTop) === 40;
      lab.removeChild(c); return ok;
    });
    check(L, 'flexbox wrap + column', function () {
      var c = box(lab, 'display:flex;flex-wrap:wrap;width:200px');
      var a = box(c, 'width:150px;height:10px'), b = box(c, 'width:150px;height:10px');
      var ok = b.offsetTop > a.offsetTop;
      var d = box(lab, 'display:flex;flex-direction:column'); var e = box(d, 'height:10px'), f = box(d, 'height:10px');
      ok = ok && f.offsetTop === e.offsetTop + 10;
      lab.removeChild(c); lab.removeChild(d); return ok;
    });
    check(L, 'flexbox gap (needs Chrome 84)', function () {
      var c = box(lab, 'display:flex;gap:20px'); var a = box(c, 'width:10px;height:10px'), b = box(c, 'width:10px;height:10px');
      var ok = b.offsetLeft - a.offsetLeft === 30; lab.removeChild(c); return ok;
    });
    check(L, 'display:grid', function () { var c = box(lab, 'display:grid'); var ok = getComputedStyle(c).display === 'grid'; lab.removeChild(c); return ok; });
    check(L, 'CSS custom properties var()', function () { var c = box(lab, '--x:5px;width:var(--x)'); var ok = c.offsetWidth === 5; lab.removeChild(c); return ok; });
    check(L, 'position:sticky', function () { return supports('position', 'sticky') || supports('position', '-webkit-sticky'); });
    check(L, 'position absolute/relative/fixed', function () {
      var c = box(lab, 'position:relative;width:100px;height:100px;left:10px'), a = box(c, 'position:absolute;left:20px;top:30px;width:5px;height:5px');
      var f = box(lab, 'position:fixed;left:3px;top:4px;width:1px;height:1px');
      var rc = c.getBoundingClientRect(), ra = a.getBoundingClientRect(), rf = f.getBoundingClientRect();
      var ok = ra.left - rc.left === 20 && ra.top - rc.top === 30 && rf.left === 3 && rf.top === 4;
      lab.removeChild(c); lab.removeChild(f); return ok;
    });
    check(L, 'transform translate3d', function () {
      var c = box(lab, 'position:absolute;left:0;top:0;width:10px;height:10px;transform:translate3d(50px,0,0);-webkit-transform:translate3d(50px,0,0)');
      var ok = c.getBoundingClientRect().left - lab.getBoundingClientRect().left === 50; lab.removeChild(c); return ok;
    });
    check(L, 'transform scale', function () {
      var c = box(lab, 'position:absolute;left:0;top:0;width:100px;height:100px;transform:scale(1.5);-webkit-transform:scale(1.5)');
      var ok = Math.round(c.getBoundingClientRect().width) === 150; lab.removeChild(c); return ok;
    });
    check(L, 'unprefixed transform property', function () { return 'transform' in document.body.style; });
    check(L, 'calc() and vw/vh', function () { var c = box(lab, 'width:calc(50vw - 10px)'); var ok = c.offsetWidth === window.innerWidth / 2 - 10; lab.removeChild(c); return ok || ('got ' + c.offsetWidth); });
    check(L, 'overflow hidden clips', function () { var c = box(lab, 'width:50px;height:50px;overflow:hidden'); var a = box(c, 'width:200px;height:10px'); var ok = c.scrollWidth >= 200 && c.clientWidth === 50; lab.removeChild(c); return ok; });
    check(L, 'text-overflow ellipsis', function () { return supports('text-overflow', 'ellipsis'); });
    check(L, '-webkit-line-clamp', function () { return supports('-webkit-line-clamp', '2'); });
    check(L, 'object-fit cover', function () { return supports('object-fit', 'cover'); });
    check(L, 'border-radius / box-shadow / rgba', function () { return supports('border-radius', '8px') && supports('box-shadow', '0 0 4px rgba(0,0,0,.5)'); });
    check(L, 'linear-gradient', function () { return supports('background-image', 'linear-gradient(#000, #fff)'); });
    check(L, 'filter: blur', function () { return supports('filter', 'blur(2px)') || supports('-webkit-filter', 'blur(2px)'); });
    check(L, 'will-change', function () { return supports('will-change', 'transform'); });
    // Font: is a family called SamsungOne installed? Compare text width against the generic fallbacks.
    check(L, 'font SamsungOne installed', function () {
      var s = document.createElement('span'); s.textContent = 'ScreenShelf mmmmmwwwwiiiil 0123'; s.style.fontSize = '40px'; lab.appendChild(s);
      s.style.fontFamily = 'monospace'; var mono = s.offsetWidth; s.style.fontFamily = 'serif'; var serif = s.offsetWidth;
      s.style.fontFamily = 'SamsungOne, monospace'; var a = s.offsetWidth; s.style.fontFamily = 'SamsungOne, serif'; var b = s.offsetWidth;
      s.style.fontFamily = 'sans-serif'; var sans = s.offsetWidth;
      lab.removeChild(s);
      R.meta.fontWidths = { mono: mono, serif: serif, sans: sans, samsungOneMono: a, samsungOneSerif: b };
      return (a !== mono || b !== serif) ? ('present, width ' + a) : false;
    });
    var tr = new Promise(function (res) {
      var c = box(lab, 'position:absolute;left:0;top:0;width:10px;height:10px;background:#fff;transition:transform 200ms linear;-webkit-transition:-webkit-transform 200ms linear');
      var t = now(), fired = false;
      function done(name) { if (fired) { return; } fired = true; rec(L, 'transition + transitionend', 'PASS', name + ' after ' + (now() - t).toFixed(0) + ' ms'); lab.removeChild(c); res(); }
      c.addEventListener('transitionend', function () { done('transitionend'); });
      c.addEventListener('webkitTransitionEnd', function () { done('webkitTransitionEnd'); });
      c.offsetWidth; // force layout
      c.style.transform = 'translate3d(100px,0,0)'; c.style.webkitTransform = 'translate3d(100px,0,0)';
      setTimeout(function () { if (!fired) { fired = true; rec(L, 'transition + transitionend', 'FAIL', 'no end event in 1 s'); res(); } }, 1000);
    });
    return tr.then(imageTests);
  }

  function loadImg(src, w, h, fit) {
    return new Promise(function (res) {
      var img = new Image(), t = now();
      img.onload = function () { res({ ok: true, ms: now() - t, img: img }); };
      img.onerror = function () { res({ ok: false, ms: now() - t }); };
      if (w) { img.style.width = w + 'px'; img.style.height = h + 'px'; }
      if (fit) { img.style.objectFit = fit; }
      img.src = src;
    });
  }

  function imageTests() {
    var L = R.css, P = R.perf, lab = document.getElementById('lab');
    return loadImg('img/poster.jpg', 120, 180).then(function (r) {
      rec(P, 'local poster 240x360 JPEG load', r.ok ? 'PASS' : 'FAIL', r.ms.toFixed(1) + ' ms');
      if (r.ok) { lab.appendChild(r.img); rec(L, 'image downscale 240x360 to 120x180', r.img.offsetWidth === 120 && r.img.offsetHeight === 180 ? 'PASS' : 'FAIL', r.img.offsetWidth + 'x' + r.img.offsetHeight); }
      return loadImg('img/backdrop.jpg', 480, 270, 'cover');
    }).then(function (r) {
      rec(P, 'local backdrop 1920x1080 JPEG load', r.ok ? 'PASS' : 'FAIL', r.ms.toFixed(1) + ' ms');
      if (r.ok) { lab.appendChild(r.img); }
      // Twenty poster loads in parallel (cache-busting query so each is a separate request).
      var t = now(), list = [];
      for (var i = 0; i < 20; i++) { list.push(loadImg('img/poster.jpg?n=' + i)); }
      return Promise.all(list).then(function (rs) {
        var ok = 0; for (var j = 0; j < rs.length; j++) { if (rs[j].ok) { ok++; } }
        rec(P, '20 poster loads in parallel', ok === 20 ? 'PASS' : 'FAIL', ok + '/20 in ' + (now() - t).toFixed(0) + ' ms');
      });
    });
  }

  /* ---------------- performance ---------------- */
  function perfTests() {
    var P = R.perf, lab = document.getElementById('lab');
    var tm = performance.timing;
    if (tm && tm.navigationStart) {
      rec(P, 'navigationStart to DOMContentLoaded', 'PASS', (tm.domContentLoadedEventEnd - tm.navigationStart) + ' ms');
      rec(P, 'navigationStart to load', tm.loadEventEnd ? 'PASS' : 'NOT TESTED', tm.loadEventEnd ? (tm.loadEventEnd - tm.navigationStart) + ' ms' : 'load not finished');
      rec(P, 'navigationStart to first script', 'PASS', (window.__T0 - tm.navigationStart) + ' ms');
    } else { rec(P, 'performance.timing', 'FAIL', 'missing'); }
    rec(P, 'first paint (first rAF after script)', R.meta.firstFrameMs ? 'PASS' : 'NOT TESTED', R.meta.firstFrameMs ? R.meta.firstFrameMs.toFixed(0) + ' ms after first script' : '');
    try { if (performance.memory) { rec(P, 'JS heap used / limit', 'PASS', Math.round(performance.memory.usedJSHeapSize / 1048576) + ' / ' + Math.round(performance.memory.jsHeapSizeLimit / 1048576) + ' MB'); } else { rec(P, 'JS heap (performance.memory)', 'NOT TESTED', 'API missing'); } } catch (e) { rec(P, 'JS heap', 'FAIL', e.message); }
    try { rec(P, 'system memory available / total', 'PASS', Math.round(tizen.systeminfo.getAvailableMemory() / 1048576) + ' / ' + Math.round(tizen.systeminfo.getTotalMemory() / 1048576) + ' MB'); } catch (e) { rec(P, 'system memory', 'NOT TESTED', e.message); }

    // Carousel simulation: 7 rows x 13 cards, move focus 60 times, one step per frame.
    lab.innerHTML = '';
    var rows = [], r, c, track;
    for (r = 0; r < 7; r++) {
      track = box(lab, 'position:absolute;left:0;top:' + (r * 74) + 'px;height:70px;width:3000px;-webkit-transform:translate3d(0,0,0);transform:translate3d(0,0,0);-webkit-transition:-webkit-transform 180ms ease-out;transition:transform 180ms ease-out');
      for (c = 0; c < 13; c++) { box(track, 'position:absolute;left:' + (c * 130) + 'px;top:0;width:120px;height:70px;background:#2a2a38;border-radius:6px'); }
      rows.push(track);
    }
    R.meta.domNodes = document.getElementsByTagName('*').length;
    rec(P, 'DOM nodes in carousel test', 'PASS', R.meta.domNodes);
    return new Promise(function (res) {
      var steps = 0, frames = [], last = now(), focused = null;
      function step() {
        var t = now(); frames.push(t - last); last = t;
        var row = rows[steps % 7], card = row.children[(steps * 3) % 13];
        if (focused) { focused.style.background = '#2a2a38'; focused.style.webkitTransform = ''; focused.style.transform = ''; }
        card.style.background = '#4f8cff'; card.style.webkitTransform = 'scale(1.08)'; card.style.transform = 'scale(1.08)';
        focused = card;
        var x = -((steps % 5) * 130);
        row.style.webkitTransform = 'translate3d(' + x + 'px,0,0)'; row.style.transform = 'translate3d(' + x + 'px,0,0)';
        steps++;
        if (steps < 60) { requestAnimationFrame(step); } else {
          frames.shift();
          frames.sort(function (a, b) { return a - b; });
          var sum = 0; for (var i = 0; i < frames.length; i++) { sum += frames[i]; }
          var avg = sum / frames.length, p95 = frames[Math.floor(frames.length * 0.95)];
          rec(P, 'focus step + carousel translate per frame', avg < 34 ? 'PASS' : 'FAIL', 'avg ' + avg.toFixed(1) + ' ms (' + (1000 / avg).toFixed(0) + ' fps), p95 ' + p95.toFixed(1) + ' ms, max ' + frames[frames.length - 1].toFixed(1) + ' ms');
          lab.innerHTML = ''; res();
        }
      }
      requestAnimationFrame(step);
    });
  }

  /* ---------------- HTTPS ---------------- */
  var HTTPS = [
    ['ISRG Root X1 (Let\'s Encrypt RSA)', 'https://valid-isrgrootx1.letsencrypt.org/', true],
    ['ISRG Root X2 (Let\'s Encrypt ECDSA)', 'https://valid-isrgrootx2.letsencrypt.org/', true],
    ['GlobalSign Root CA (Google)', 'https://www.google.com/generate_204', true],
    ['GlobalSign Root CA (Cloudflare)', 'https://www.cloudflare.com/cdn-cgi/trace', true],
    ['DigiCert Global Root G2', 'https://www.digicert.com/', true],
    ['DigiCert Global Root G3 (ECC; Apple, Akamai streams)', 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8', true],
    ['DigiCert Global Root G3 (Akamai DASH)', 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd', true],
    ['Amazon Root CA 1', 'https://good.sca1a.amazontrust.com/', true],
    ['Starfield Root G2 (Mux)', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', true],
    ['USERTrust RSA (Sectigo)', 'https://sectigo.com/', true],
    ['ISRG Root X1 (Blender downloads)', 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4', true],
    ['GlobalSign Root CA (W3C media)', 'https://media.w3.org/2010/05/sintel/trailer.mp4', true],
    ['NEGATIVE expired certificate', 'https://expired.badssl.com/', false],
    ['NEGATIVE self-signed', 'https://self-signed.badssl.com/', false],
    ['NEGATIVE untrusted root', 'https://untrusted-root.badssl.com/', false],
    ['NEGATIVE wrong host name', 'https://wrong.host.badssl.com/', false],
    ['CONTROL plain HTTP (network up?)', 'http://neverssl.com/', true]
  ];

  function xhrProbe(url) {
    return new Promise(function (res) {
      var x = new XMLHttpRequest(), t = now(), finished = false;
      function end(kind) { if (finished) { return; } finished = true; res({ kind: kind, status: x.status, ms: now() - t }); }
      x.onreadystatechange = function () { if (x.readyState >= 2 && x.status > 0) { end('response'); try { x.abort(); } catch (e) { /* ignore */ } } };
      x.onerror = function () { end('error'); };
      x.ontimeout = function () { end('timeout'); };
      x.open('GET', url + (url.indexOf('?') < 0 ? '?' : '&') + 'probe=' + Date.now(), true);
      x.timeout = 15000;
      try { x.send(); } catch (e) { end('send-threw ' + e.message); }
    });
  }

  function httpsTests() {
    var i = 0;
    function next() {
      if (i >= HTTPS.length) { return Promise.resolve(); }
      var t = HTTPS[i++];
      return xhrProbe(t[1]).then(function (r) {
        var connected = r.kind === 'response';
        var status = (connected === t[2]) ? 'PASS' : 'FAIL';
        rec(R.https, t[0], status, (connected ? 'connected, HTTP ' + r.status : 'no connection (' + r.kind + ', status ' + r.status + ')') + ', ' + r.ms.toFixed(0) + ' ms, expected ' + (t[2] ? 'connect' : 'reject') + ' | ' + t[1]);
        log('https ' + status + ' ' + t[0]);
        updateSummary();
        return next();
      });
    }
    return next();
  }

  /* ---------------- AVPlay ---------------- */
  var STREAMS = [
    { name: 'MP4 H.264/AAC, Blender (ISRG X1), external SRT', url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4', srt: true, seekTo: 30000 },
    { name: 'MP4 H.264/AAC, W3C (GlobalSign)', url: 'https://media.w3.org/2010/05/sintel/trailer.mp4', seekTo: 30000 },
    { name: 'HLS TS, Apple bipbop 16x9 (WebVTT subs)', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8', seekTo: 60000 },
    { name: 'HLS TS advanced, Apple (alt audio + subs)', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8', seekTo: 60000 },
    { name: 'HLS fMP4 advanced, Apple', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8', seekTo: 60000 },
    { name: 'HLS TS, Mux Big Buck Bunny (Starfield)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', seekTo: 60000 },
    { name: 'DASH H.264, Akamai BBB 30fps', url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd', seekTo: 60000 },
    { name: 'DASH with subtitles, DASH-IF test vector', url: 'https://dash.akamaized.net/dash264/TestCases/4b/qualcomm/1/ED_OnDemand_5SecSeg_Subtitles.mpd', seekTo: 20000 },
    { name: 'ERROR CASE: missing manifest (expect clean error)', url: 'https://dash.akamaized.net/akamai/bbb_30fps/does-not-exist.mpd', expectError: true }
  ];

  function srtPath() {
    var p = decodeURIComponent(location.pathname);
    return p.substring(0, p.lastIndexOf('/') + 1) + 'subs.srt';
  }

  function avplayOne(s) {
    var av = webapis.avplay, out = { name: s.name, url: s.url, steps: {}, events: [], subtitles: [], tracks: null, errors: [] };
    var bufStart = 0;
    function step(k, v) { out.steps[k] = v; log('  ' + k + ': ' + v); }
    function stateIs() { try { return av.getState(); } catch (e) { return 'state-threw'; } }
    function cur() { try { return av.getCurrentTime(); } catch (e) { return -1; } }

    return new Promise(function (resolve) {
      var t0 = now();
      try { av.open(s.url); step('open', 'PASS ' + stateIs()); } catch (e) { step('open', 'FAIL ' + e.name + ' ' + e.message); resolve(out); return; }
      try {
        av.setListener({
          onbufferingstart: function () { bufStart = now(); out.events.push('bufferingstart@' + cur()); },
          onbufferingprogress: function (p) { if (p === 100 || p % 50 === 0) { out.events.push('buffering ' + p + '%'); } },
          onbufferingcomplete: function () { out.events.push('bufferingcomplete after ' + (now() - bufStart).toFixed(0) + ' ms'); },
          onstreamcompleted: function () { out.events.push('streamcompleted'); },
          oncurrentplaytime: function () { /* frequent; ignored */ },
          onevent: function (type, data) { out.events.push('event ' + type + ' ' + data); },
          onerror: function (type) { out.errors.push('onerror ' + type); log('  onerror ' + type); },
          onsubtitlechange: function (duration, text) { out.subtitles.push({ at: cur(), text: String(text).substring(0, 60), duration: duration }); }
        });
        step('setListener', 'PASS');
      } catch (e) { step('setListener', 'FAIL ' + e.message); }
      try { av.setDisplayRect(960, 0, 960, 540); step('setDisplayRect', 'PASS'); } catch (e) { step('setDisplayRect', 'FAIL ' + e.message); }
      if (s.srt) {
        try { av.setExternalSubtitlePath(srtPath()); step('setExternalSubtitlePath', 'PASS ' + srtPath()); } catch (e) { step('setExternalSubtitlePath', 'FAIL ' + e.name + ' ' + e.message); }
      }
      var timedOut = false;
      var guard = setTimeout(function () { timedOut = true; step('prepareAsync', 'FAIL timeout 40 s'); finish(); }, 40000);

      function finish() {
        try { av.stop(); step('stop', 'PASS ' + stateIs()); } catch (e) { step('stop', 'FAIL ' + e.message); }
        try { av.close(); step('close', 'PASS ' + stateIs()); } catch (e) { step('close', 'FAIL ' + e.message); }
        out.totalMs = Math.round(now() - t0);
        resolve(out);
      }

      try {
        av.prepareAsync(function () {
          if (timedOut) { return; }
          clearTimeout(guard);
          step('prepareAsync', 'PASS ' + (now() - t0).toFixed(0) + ' ms, state ' + stateIs());
          try { step('duration', av.getDuration() + ' ms'); } catch (e) { step('duration', 'FAIL ' + e.message); }
          try {
            var tr = av.getTotalTrackInfo(), list = [];
            for (var i = 0; i < tr.length; i++) { list.push({ index: tr[i].index, type: tr[i].type, extra: tr[i].extra_info }); }
            out.tracks = list; step('getTotalTrackInfo', 'PASS ' + list.length + ' tracks');
          } catch (e) { step('getTotalTrackInfo', 'FAIL ' + e.message); }
          try { av.setSilentSubtitle(false); } catch (e) { /* optional */ }
          var textIdx = -1, audio = [];
          if (out.tracks) {
            for (var j = 0; j < out.tracks.length; j++) {
              if (out.tracks[j].type === 'TEXT' && textIdx < 0) { textIdx = out.tracks[j].index; }
              if (out.tracks[j].type === 'AUDIO') { audio.push(out.tracks[j].index); }
            }
          }
          if (textIdx >= 0 && !s.srt) { try { av.setSelectTrack('TEXT', textIdx); step('select TEXT track', 'PASS index ' + textIdx); } catch (e) { step('select TEXT track', 'FAIL ' + e.message); } }
          var startT;
          try { av.play(); startT = cur(); step('play', 'PASS ' + stateIs()); } catch (e) { step('play', 'FAIL ' + e.message); finish(); return; }
          delay(s.srt ? 16000 : 7000).then(function () {
            var t = cur();
            step('playing advances', (t > startT + 2000 ? 'PASS' : 'FAIL') + ' position ' + t + ' ms');
            try { av.pause(); step('pause', 'PASS ' + stateIs()); } catch (e) { step('pause', 'FAIL ' + e.message); }
            var p1 = cur();
            return delay(2000).then(function () {
              var p2 = cur();
              step('paused holds position', (Math.abs(p2 - p1) < 300 ? 'PASS' : 'FAIL') + ' ' + p1 + ' -> ' + p2);
              if (audio.length > 1) {
                try { av.setSelectTrack('AUDIO', audio[1]); step('switch AUDIO track', 'PASS to index ' + audio[1]); } catch (e) { step('switch AUDIO track', 'FAIL ' + e.message); }
              } else { step('switch AUDIO track', 'NOT TESTED ' + audio.length + ' audio track(s)'); }
              return new Promise(function (res) {
                var ts = now();
                try {
                  av.seekTo(s.seekTo, function () { step('seekTo ' + s.seekTo, 'PASS ' + (now() - ts).toFixed(0) + ' ms, position ' + cur()); res(); },
                    function (e) { step('seekTo ' + s.seekTo, 'FAIL ' + (e && e.name)); res(); });
                } catch (e) { step('seekTo', 'FAIL threw ' + e.message); res(); }
                setTimeout(res, 15000);
              });
            });
          }).then(function () {
            try { av.play(); } catch (e) { /* ignore */ }
            return delay(4000);
          }).then(function () {
            var t = cur();
            step('plays after seek', (t >= s.seekTo ? 'PASS' : 'FAIL') + ' position ' + t);
            try { av.jumpForward(5000); step('jumpForward 5 s', 'PASS'); } catch (e) { step('jumpForward 5 s', 'FAIL ' + e.message); }
            return delay(2000);
          }).then(function () {
            try { av.jumpBackward(5000); step('jumpBackward 5 s', 'PASS'); } catch (e) { step('jumpBackward 5 s', 'FAIL ' + e.message); }
            try { av.setSpeed(2); step('setSpeed 2 (FF)', 'PASS'); } catch (e) { step('setSpeed 2 (FF)', 'FAIL ' + e.name + ' ' + e.message); }
            return delay(2000);
          }).then(function () {
            try { av.setSpeed(-2); step('setSpeed -2 (REW)', 'PASS'); } catch (e) { step('setSpeed -2 (REW)', 'FAIL ' + e.name + ' ' + e.message); }
            return delay(2000);
          }).then(function () {
            try { av.setSpeed(1); } catch (e) { /* ignore */ }
            finish();
          });
        }, function (e) {
          if (timedOut) { return; }
          clearTimeout(guard);
          step('prepareAsync', 'FAIL ' + (e && e.name) + ' ' + (e && e.message) + ' after ' + (now() - t0).toFixed(0) + ' ms');
          finish();
        });
      } catch (e) { clearTimeout(guard); step('prepareAsync', 'FAIL threw ' + e.message); finish(); }
    });
  }

  function avplayTests() {
    var L = R.avplay;
    if (!window.webapis || !webapis.avplay) { rec(L, 'webapis.avplay exists', 'FAIL', 'missing'); return Promise.resolve(); }
    rec(L, 'webapis.avplay exists', 'PASS', R.meta.avplayVersion);
    R.avplayRuns = [];
    var i = 0;
    function next() {
      if (i >= STREAMS.length) { return Promise.resolve(); }
      var s = STREAMS[i++];
      log('AVPlay: ' + s.name);
      return avplayOne(s).then(function (out) {
        R.avplayRuns.push(out);
        var prep = out.steps.prepareAsync || '';
        var played = (out.steps['playing advances'] || '').indexOf('PASS') === 0;
        if (s.expectError) {
          rec(L, s.name, prep.indexOf('FAIL') === 0 || out.errors.length ? 'PASS' : 'FAIL', prep + ' ' + out.errors.join(' '));
        } else {
          rec(L, s.name, played ? 'PASS' : 'FAIL', prep.substring(0, 80));
        }
        updateSummary();
        return delay(1500).then(next);
      });
    }
    return next();
  }

  /* ---------------- remote keys ---------------- */
  var WANT = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward',
    'MediaTrackPrevious', 'MediaTrackNext', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'ChannelUp', 'ChannelDown', 'Info', 'Menu', 'Tools', 'Caption'];
  var PRESS = ['Up', 'Down', 'Left', 'Right', 'Enter', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'Back'];

  function keySetup() {
    var K = R.keys;
    try {
      var sup = tizen.tvinputdevice.getSupportedKeys();
      for (var i = 0; i < sup.length; i++) { K.supported.push(sup[i].name + '=' + sup[i].code); }
    } catch (e) { K.supported.push('getSupportedKeys threw ' + e.message); }
    for (var j = 0; j < WANT.length; j++) {
      try { tizen.tvinputdevice.registerKey(WANT[j]); K.registered.push(WANT[j] + ' OK'); }
      catch (e) { K.registered.push(WANT[j] + ' FAIL ' + e.name); }
    }
    var held = {};
    document.addEventListener('keydown', function (e) {
      var t = now(), code = e.keyCode, info = held[code];
      var ev = { type: 'down', code: code, key: e.key || '', keyIdentifier: e.keyIdentifier || '', t: Math.round(t), repeat: !!e.repeat };
      if (info) { ev.sinceLast = Math.round(t - info.last); info.last = t; info.count++; } else { held[code] = { first: t, last: t, count: 1 }; }
      K.events.push(ev);
      if (K.events.length > 400) { K.events.shift(); }
      markKey(code);
      if (code === 10009) { e.preventDefault(); log('BACK received (default prevented, app stays open)'); }
    });
    document.addEventListener('keyup', function (e) {
      var t = now(), info = held[e.keyCode];
      K.events.push({ type: 'up', code: e.keyCode, t: Math.round(t), heldMs: info ? Math.round(t - info.first) : null, downs: info ? info.count : null });
      delete held[e.keyCode];
    });
  }

  var CODE_NAME = { 38: 'Up', 40: 'Down', 37: 'Left', 39: 'Right', 13: 'Enter', 10009: 'Back' };
  function markKey(code) {
    var name = CODE_NAME[code];
    if (!name) {
      for (var i = 0; i < R.keys.supported.length; i++) {
        var p = R.keys.supported[i].split('=');
        if (+p[1] === code) { name = p[0]; break; }
      }
    }
    log('key ' + code + (name ? ' ' + name : ''));
    var el = document.getElementById('key-' + name);
    if (el) { el.className = 'k ok'; }
  }

  function showKeyPanel() {
    var list = document.getElementById('keylist');
    for (var i = 0; i < PRESS.length; i++) {
      var s = document.createElement('span'); s.className = 'k'; s.id = 'key-' + PRESS[i]; s.textContent = PRESS[i]; list.appendChild(s);
    }
    document.getElementById('keys').className = '';
  }

  /* ---------------- run ---------------- */
  requestAnimationFrame(function () { R.meta.firstFrameMs = Date.now() - window.__T0; });

  function run(name, fn) {
    return function () {
      phase(name);
      var t = now();
      return Promise.resolve().then(fn).then(function () { R.done[name] = Math.round(now() - t) + ' ms'; updateSummary(); },
        function (e) { R.done[name] = 'crashed: ' + (e && e.message); log(name + ' crashed ' + (e && e.message)); });
    };
  }

  /* ---------------- reporting to the dev PC (probe only, LAN, plain HTTP) ---------------- */
  // Results go to tools/collector.mjs on the development PC. Commands are a fixed allowlist:
  // nothing received from the PC is ever executed as code.
  var COLLECTOR = 'http://192.168.1.180:8099';
  function post(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', COLLECTOR + '/report?tag=' + encodeURIComponent(tag), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(JSON.stringify(R));
    } catch (e) { log('report failed ' + e.message); }
  }
  var busy = false;
  function poll() {
    var x = new XMLHttpRequest();
    x.onload = function () {
      var cmd = String(x.responseText || '');
      if (cmd === 'avplay' && !busy) { busy = true; window.__probeAV().then(function () { busy = false; post('avplay'); }); }
      else if (cmd === 'report') { post('manual'); }
      else if (cmd === 'exit') { post('exit'); setTimeout(function () { tizen.application.getCurrentApplication().exit(); }, 500); }
    };
    x.onloadend = function () { setTimeout(poll, 2000); };
    try { x.open('GET', COLLECTOR + '/cmd', true); x.timeout = 4000; x.send(); } catch (e) { setTimeout(poll, 2000); }
  }
  var lastKeys = 0;
  setInterval(function () { if (R.keys.events.length !== lastKeys) { lastKeys = R.keys.events.length; post('keys'); } }, 3000);

  window.addEventListener('load', function () {
    envInfo();
    keySetup();
    post('start');
    poll();
    Promise.resolve()
      .then(run('javascript', jsTests))
      .then(run('css', cssTests))
      .then(run('performance', perfTests))
      .then(function () { post('base'); })
      .then(run('https', httpsTests))
      .then(function () { post('https'); phase('base tests done; waiting for PC'); showKeyPanel(); });
  });

  // AVPlay is started from the PC (command 'avplay') so the user can watch the video area.
  window.__probeAV = function () { return run('avplay', avplayTests)().then(function () { phase('avplay done'); }); };
})();
