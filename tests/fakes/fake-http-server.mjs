// Auto-responding XMLHttpRequest double: a handler maps each request URL to a response, which
// is delivered asynchronously in chunks (headers -> progress events -> load), like the TV's XHR.
// Supports simulated redirects (finalUrl / responseURL), network failures, mid-body connection
// drops and hanging requests. Complements fake-xhr.mjs (manually driven, single request).
// Binary bodies (Buffer): with overrideMimeType('...x-user-defined') each byte becomes one
// character the way browsers map x-user-defined (0x00-0x7F as is, 0x80-0xFF to U+F780-U+F7FF);
// without it the bytes are decoded as UTF-8 (invalid bytes become U+FFFD), like a text download.
// Response headers come from `headers`; `contentEncoding: 'gzip'` delivers the body gunzipped, as
// the browser does for Content-Encoding.
import { gunzipSync } from 'node:zlib';

function userDefined(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 8192) {
    const codes = [];
    const end = Math.min(buf.length, i + 8192);
    for (let j = i; j < end; j++) codes.push(buf[j] < 0x80 ? buf[j] : 0xf700 + buf[j]);
    out += String.fromCharCode.apply(null, codes);
  }
  return out;
}

export function createFakeServer(handler, defaults = {}) {
  const requests = [];
  function factory() {
    const x = {
      readyState: 0, status: 0, responseText: '', responseURL: undefined, timeout: 0, withCredentials: undefined,
      onreadystatechange: null, onprogress: null, onload: null, onerror: null, ontimeout: null, onabort: null,
      url: null, aborted: false, headersSet: [],
      open(method, url) { this.method = method; this.url = url; this.readyState = 1; },
      setRequestHeader(n, v) { this.headersSet.push([n, v]); },
      responseHeaders: {}, mime: null,
      getResponseHeader(n) { const h = this.responseHeaders; for (const k in h) if (k.toLowerCase() === n.toLowerCase()) return h[k]; return null; },
      overrideMimeType(m) { this.mime = m; },
      send() {
        requests.push({ url: this.url, withCredentials: this.withCredentials, headers: this.headersSet.slice(), mime: this.mime });
        setImmediate(() => run(this, requests.length));
      },
      abort() { this.aborted = true; this.readyState = 4; this.status = 0; }
    };
    return x;
  }
  function fire(x, name) { if (!x.aborted && x[name]) x[name](); }
  function run(x, n) {
    if (x.aborted) return;
    const r = handler(x.url, n) || { status: 404, body: '' };
    if (r.fail === 'network') { x.readyState = 4; x.status = 0; fire(x, 'onerror'); return; }
    if (r.fail === 'hang') return;
    let body = r.body || '';
    if (Buffer.isBuffer(body)) {
      const bytes = r.contentEncoding === 'gzip' ? gunzipSync(body) : body;
      body = x.mime && /x-user-defined/.test(x.mime) ? userDefined(bytes) : bytes.toString('utf8');
    }
    x.responseHeaders = r.headers || {};
    const step = r.chunk || defaults.chunk || 65536;
    const dropAt = r.dropAt === undefined ? -1 : r.dropAt;
    x.status = r.status;
    x.responseURL = r.finalUrl === undefined ? x.url : r.finalUrl;
    x.readyState = 2;
    fire(x, 'onreadystatechange');
    let i = 0;
    function next() {
      if (x.aborted) return;
      if (dropAt >= 0 && i >= dropAt) { x.readyState = 4; x.status = 0; fire(x, 'onerror'); return; }
      if (i < body.length) {
        x.responseText += body.substring(i, i + step);
        i += step;
        x.readyState = 3;
        fire(x, 'onreadystatechange');
        fire(x, 'onprogress');
        setImmediate(next);
      } else {
        x.readyState = 4;
        fire(x, 'onreadystatechange');
        fire(x, 'onload');
      }
    }
    next();
  }
  return { factory, requests };
}
