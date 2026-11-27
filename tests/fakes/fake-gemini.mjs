// AI-02: fake Gemini API for tests. Provides an XhrLike factory whose requests go to a handler
// instead of the network. Records method, URL, headers and the JSON body of every request.
//   handler(req, n) → { status, json | body, headers, delayMs, fail: 'network' | 'hang', finalUrl }
// Default handler: a minimal Gemini (models list + generateContent echo) that checks the API key.
export const FAKE_KEY = 'AIzaFAKEkey0000000000000000000000000000';
export const ORIGIN = 'https://generativelanguage.googleapis.com';

export function geminiError(status, statusText, reason, retryDelay) {
  const details = [];
  if (reason) { details.push({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }); }
  if (retryDelay) { details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }); }
  return { status, json: { error: { code: status, message: 'fake', status: statusText, details } } };
}

export const MODELS = [
  { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ['generateContent'] },
  { name: 'models/text-embedding-005', displayName: 'Embedding', inputTokenLimit: 2048, outputTokenLimit: 1, supportedGenerationMethods: ['embedContent'] }
];

export function header(req, name) {
  const h = req.headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
  return h ? h[1] : null;
}

export function defaultGemini(req) {
  const key = header(req, 'x-goog-api-key');
  if (key !== FAKE_KEY) { return geminiError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID'); }
  if (req.method === 'GET' && /\/v1beta\/models\?/.test(req.url)) { return { status: 200, json: { models: MODELS } }; }
  const m = /\/v1beta\/models\/([^:]+):generateContent$/.exec(req.url);
  if (req.method === 'POST' && m) {
    if (!MODELS.some((x) => x.name === 'models/' + m[1])) { return geminiError(404, 'NOT_FOUND'); }
    const text = req.body && req.body.contents && req.body.contents[0].parts[0].text;
    return { status: 200, json: { candidates: [{ content: { role: 'model', parts: [{ text: 'OK: ' + String(text).length }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } } };
  }
  return { status: 404, json: { error: { code: 404, status: 'NOT_FOUND' } } };
}

export function createFakeGemini(handler = defaultGemini) {
  const requests = [];
  let n = 0;
  function factory() {
    const x = {
      readyState: 0, status: 0, responseText: '', responseURL: undefined, timeout: 0, withCredentials: undefined,
      onreadystatechange: null, onprogress: null, onload: null, onerror: null, ontimeout: null, onabort: null,
      method: null, url: null, headersSet: [], aborted: false, respHeaders: {},
      open(method, url) { this.method = method; this.url = url; this.readyState = 1; },
      setRequestHeader(k, v) { this.headersSet.push([k, v]); },
      getResponseHeader(k) { const f = Object.keys(this.respHeaders).find((h) => h.toLowerCase() === k.toLowerCase()); return f ? this.respHeaders[f] : null; },
      send(body) {
        const req = { method: this.method, url: this.url, headers: this.headersSet.slice(), rawBody: body, body: body ? JSON.parse(body) : null, withCredentials: this.withCredentials };
        requests.push(req);
        const r = handler(req, n++) || { status: 404, body: '' };
        const deliver = () => {
          if (this.aborted || r.fail === 'hang') { return; }
          if (r.fail === 'network') { this.readyState = 4; this.status = 0; if (this.onreadystatechange) { this.onreadystatechange(); } if (this.onerror) { this.onerror(); } return; }
          this.respHeaders = r.headers || {};
          this.status = r.status;
          this.responseURL = r.finalUrl === undefined ? this.url : r.finalUrl;
          this.readyState = 2; if (this.onreadystatechange) { this.onreadystatechange(); }
          if (this.aborted) { return; }
          this.responseText = r.body !== undefined ? r.body : JSON.stringify(r.json === undefined ? {} : r.json);
          this.readyState = 4; if (this.onreadystatechange) { this.onreadystatechange(); }
          if (this.onload) { this.onload(); }
        };
        setTimeout(deliver, r.delayMs || 0);
      },
      abort() { this.aborted = true; this.readyState = 4; this.status = 0; }
    };
    return x;
  }
  return { factory, requests };
}
