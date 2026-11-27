// EliteStream phone-pairing relay (Cloudflare Worker + one Durable Object per pairing session).
// docs/AI-02-PHONE-PAIRING.md.
//
// The relay is a blind mailbox. It stores ONE sealed envelope per session for at most 5 minutes
// and hands it to the TV once. It never receives the TV public key (that stays in the QR fragment),
// so it cannot decrypt an envelope or forge one the TV would accept. It keeps no logs of bodies.
//
// API (session id = 22 base64url characters, chosen by the TV):
//   GET  /v1/s/<sid>          TV poll. First call opens the session. → {state:"waiting"} |
//                             {state:"ready", env:{…}} (the envelope is deleted as it is returned) |
//                             {state:"delivered"|"cancelled"|"expired"}
//   GET  /v1/s/<sid>/status   phone: state only, never the envelope
//   POST /v1/s/<sid>          phone: body = envelope {v:1, epk, n, c} (≤ 2048 bytes), once per session
//   POST /v1/s/<sid>/cancel   TV cancel
// Everything else is served from ./public (the phone page) by the static-assets binding.

export const TTL_MS = 5 * 60000;
/** The session record is removed this long after it was opened (alarm). */
export const PURGE_MS = 10 * 60000;
export const MAX_BODY = 2048;
export const MAX_FAILED_POSTS = 5;
const SID_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  // The TV app runs from a packaged origin (file:// / null): any origin may call the API, never
  // with credentials. Envelopes are end-to-end encrypted, so reading one gains nothing.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600'
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status: status, headers: API_HEADERS });
}

/** Strict envelope check: exactly {v, epk, n, c} with the right sizes. */
export function validEnvelope(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) { return false; }
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'c,epk,n,v' || o.v !== 1) { return false; }
  if (typeof o.epk !== 'string' || o.epk.length !== 43 || !B64URL_RE.test(o.epk)) { return false; }
  if (typeof o.n !== 'string' || o.n.length !== 32 || !B64URL_RE.test(o.n)) { return false; }
  return typeof o.c === 'string' && o.c.length >= 24 && o.c.length <= 1600 && B64URL_RE.test(o.c);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/v1\/s\/([^\/]+)(\/status|\/cancel)?$/.exec(url.pathname);
    if (!m) {
      if (url.pathname.indexOf('/v1/') === 0) { return json(404, { error: 'not-found' }); }
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('not found', { status: 404 });
    }
    if (request.method === 'OPTIONS') { return new Response(null, { status: 204, headers: API_HEADERS }); }
    const sid = m[1];
    if (!SID_RE.test(sid)) { return json(400, { error: 'bad-session' }); }
    const op = m[2] === '/status' ? 'status' : m[2] === '/cancel' ? 'cancel' : request.method === 'POST' ? 'put' : 'take';
    if ((op === 'status' || op === 'take') && request.method !== 'GET') { return json(405, { error: 'method' }); }
    if ((op === 'cancel' || op === 'put') && request.method !== 'POST') { return json(405, { error: 'method' }); }
    let body = '';
    if (op === 'put') {
      const len = Number(request.headers.get('Content-Length') || '0');
      if (len > MAX_BODY) { return json(413, { error: 'too-large' }); }
      body = await request.text();
      if (body.length > MAX_BODY) { return json(413, { error: 'too-large' }); }
    }
    const stub = env.PAIR.get(env.PAIR.idFromName(sid));
    return stub.fetch('https://pair.internal/' + op, { method: 'POST', body: body });
  }
};

/**
 * One pairing session. State in Durable Object storage:
 *   s = { created, state: 'waiting'|'ready'|'delivered'|'cancelled'|'expired', failed }
 *   e = envelope (only while state is 'ready')
 */
export class PairSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const now = Date.now();
    const st = this.state.storage;
    let s = (await st.get('s')) || null;
    if (s && (s.state === 'waiting' || s.state === 'ready') && now - s.created > TTL_MS) {
      s.state = 'expired';
      await st.delete('e');
      await st.put('s', s);
    }

    if (op === 'take') {
      if (!s) {
        s = { created: now, state: 'waiting', failed: 0 };
        await st.put('s', s);
        await st.setAlarm(now + PURGE_MS);
        return json(200, { state: 'waiting' });
      }
      if (s.state === 'ready') {
        const e = await st.get('e');
        s.state = 'delivered';
        await st.delete('e');
        await st.put('s', s);
        return json(200, { state: 'ready', env: e });
      }
      return json(200, { state: s.state });
    }
    if (op === 'status') {
      return json(200, { state: s ? s.state : 'unknown' });
    }
    if (op === 'cancel') {
      if (s && (s.state === 'waiting' || s.state === 'ready')) { s.state = 'cancelled'; await st.delete('e'); await st.put('s', s); }
      return json(200, { ok: true });
    }
    if (op === 'put') {
      if (!s) { return json(404, { error: 'unknown-session' }); }
      if (s.failed >= MAX_FAILED_POSTS) { return json(429, { error: 'locked' }); }
      if (s.state !== 'waiting') { return json(409, { error: s.state }); }
      let o = null;
      try { o = JSON.parse(await request.text()); } catch (x) { o = null; }
      if (!validEnvelope(o)) {
        s.failed++;
        await st.put('s', s);
        return json(400, { error: 'bad-envelope' });
      }
      s.state = 'ready';
      await st.put('e', { v: 1, epk: o.epk, n: o.n, c: o.c });
      await st.put('s', s);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not-found' });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
