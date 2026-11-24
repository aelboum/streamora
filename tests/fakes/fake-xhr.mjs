// Scriptable XMLHttpRequest double. Tests drive the network by calling the helpers on the
// created instance (headers(), chunk(), load(), fail(), timeout()).
export function createXhrRegistry() {
  const created = [];
  function factory() {
    const x = {
      readyState: 0,
      status: 0,
      responseText: '',
      responseURL: undefined,
      timeout: 0,
      withCredentials: undefined,
      onreadystatechange: null, onprogress: null, onload: null, onerror: null, ontimeout: null, onabort: null,
      method: null, url: null, sent: false, aborted: false, headersSet: [],
      open(method, url) { this.method = method; this.url = url; this.readyState = 1; },
      setRequestHeader(name, value) { this.headersSet.push([name, value]); },
      getResponseHeader() { return null; },
      send() { this.sent = true; },
      abort() { this.aborted = true; this.readyState = 4; this.status = 0; },

      // ---- test drivers ----
      /** Headers received: status and final URL (after any redirects). */
      headers(status, finalUrl) {
        this.status = status;
        if (finalUrl !== undefined) this.responseURL = finalUrl;
        this.readyState = 2;
        if (this.onreadystatechange) this.onreadystatechange();
      },
      chunk(text) {
        this.responseText += text;
        this.readyState = 3;
        if (this.onreadystatechange) this.onreadystatechange();
        if (this.onprogress) this.onprogress();
      },
      load() {
        this.readyState = 4;
        if (this.onreadystatechange) this.onreadystatechange();
        if (this.onload) this.onload();
      },
      /** Convenience: complete response in one go. */
      respond(status, text, finalUrl) {
        this.headers(status, finalUrl === undefined ? this.url : finalUrl);
        if (text) this.chunk(text);
        this.load();
      },
      fail() { this.readyState = 4; this.status = 0; if (this.onerror) this.onerror(); },
      timeoutNow() { this.readyState = 4; this.status = 0; if (this.ontimeout) this.ontimeout(); }
    };
    created.push(x);
    return x;
  }
  return { factory, created, last: () => created[created.length - 1] };
}
