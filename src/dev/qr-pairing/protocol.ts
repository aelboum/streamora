// EXPERIMENTAL QR pairing UI test (dev builds only; docs/AI-02-QR-UI-TEST-REPORT.md).
// A usability and compatibility experiment: QR rendering on the TV, scanning with a phone, a
// simulated confirmation. It is NOT a key transfer and never handles real or fake keys:
//   - the phone page checks a FAKE test key locally and sends only {id, provider};
//   - the test server refuses any other field (it is technically unable to receive a key);
//   - the TV module gets no key store, settings or playlist access (tested).
// Shared by the TV screen (screen.ts), the test server (scripts/qr-test-server.mjs) and tests.

/** Pairing ids: 10 characters from an alphabet without look-alikes (≈ 49.5 bits). */
export const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ID_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;
export const PAIRING_TTL_MS = 5 * 60000;
export const MAX_FAILED_ATTEMPTS = 10;
export const LOCK_MS = 5 * 60000;
export const PROVIDERS = ['gemini'];
/** Only this FAKE format is accepted by the test page; anything else is refused locally. */
export const FAKE_KEY_RE = /^TEST-[A-Z]{2,20}-[0-9]{6}$/;

/** Random pairing id from a cryptographic source (rejection sampling, no modulo bias). */
export function newPairingId(randomBytes: (n: number) => number[]): string {
  let out = '';
  const limit = 256 - (256 % ID_ALPHABET.length);
  while (out.length < 10) {
    const bytes = randomBytes(16);
    for (let i = 0; i < bytes.length && out.length < 10; i++) {
      if (bytes[i] < limit) { out += ID_ALPHABET.charAt(bytes[i] % ID_ALPHABET.length); }
    }
  }
  return out;
}

export function validPairingId(id: unknown): boolean {
  return typeof id === 'string' && ID_RE.test(id);
}

/** "ABCDE-FGHJK" for reading out. */
export function formatPairingId(id: string): string {
  return id.substring(0, 5) + '-' + id.substring(5);
}

/** The QR payload: test page address with the pairing id in the fragment (never sent to a server). */
export function qrPayload(serverUrl: string, id: string): string {
  return serverUrl.replace(/\/+$/, '') + '/p/#' + id;
}

/**
 * Test server base URL from the dev log-sink URL: same private-LAN host, port 8095.
 * Returns '' when the sink URL is not a plain http://<private IPv4>:<port>/… address.
 */
export function testServerUrl(devSinkUrl: string): string {
  const m = /^http:\/\/((?:10|172|192)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}):[0-9]{2,5}(?:\/|$)/.exec(devSinkUrl || '');
  return m ? 'http://' + m[1] + ':8095' : '';
}

/** True when a string looks like it carries a credential (used to prove the QR payload is clean). */
export function looksSensitive(s: string): boolean {
  return /AIza[0-9A-Za-z_\-]{10,}/.test(s) || /sk-[A-Za-z0-9]{10,}/.test(s) || /TEST-[A-Z]+-[0-9]{6}/.test(s) ||
    /[?&](?:key|token|password|pass|apikey|api_key)=/i.test(s) || /\/\/[^\/#]*@/.test(s);
}

/** Classification of a phone-entered value: only the fake format passes. */
export function fakeKeyCheck(value: string): 'ok' | 'empty' | 'looks-real' | 'bad-format' {
  const v = typeof value === 'string' ? value.replace(/^\s+|\s+$/g, '') : '';
  if (!v) { return 'empty'; }
  if (FAKE_KEY_RE.test(v)) { return 'ok'; }
  if (/^AIza/.test(v) || /^sk-/.test(v) || v.length >= 30) { return 'looks-real'; }
  return 'bad-format';
}

export type PairingState = 'waiting' | 'confirmed' | 'expired' | 'cancelled';
export type ConfirmResult = 'confirmed' | 'invalid' | 'expired' | 'used' | 'cancelled' | 'bad-provider' | 'locked' | 'bad-request';

export interface PairingRegistry {
  /** TV side: registers the id on first poll and reports its state. */
  poll(id: string): PairingState | 'invalid';
  /** Phone side: body must be exactly {id, provider}. `client` identifies the caller for attempt limits. */
  confirm(body: unknown, client: string): { result: ConfirmResult; provider?: string };
  cancel(id: string): boolean;
  /** Number of pairings held (tests). */
  size(): number;
}

interface Entry { created: number; state: PairingState; provider: string }

/** In-memory pairing registry with expiry, one-time confirmation, cancellation and attempt limits. */
export function createPairingRegistry(now: () => number): PairingRegistry {
  const map: Record<string, Entry> = {};
  const failed: Record<string, { n: number; until: number }> = {};

  function sweep(): void {
    const t = now();
    for (const k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k) && t - map[k].created > 2 * PAIRING_TTL_MS) { delete map[k]; }
    }
  }
  function state(e: Entry): PairingState {
    if (e.state === 'waiting' && now() - e.created > PAIRING_TTL_MS) { e.state = 'expired'; }
    return e.state;
  }
  function fail(client: string, result: ConfirmResult): { result: ConfirmResult } {
    const f = failed[client] || { n: 0, until: 0 };
    f.n++;
    if (f.n >= MAX_FAILED_ATTEMPTS) { f.until = now() + LOCK_MS; f.n = 0; }
    failed[client] = f;
    return { result: result };
  }

  return {
    poll: function (id: string) {
      if (!validPairingId(id)) { return 'invalid'; }
      sweep();
      if (!map[id]) { map[id] = { created: now(), state: 'waiting', provider: '' }; }
      return state(map[id]);
    },
    confirm: function (body: unknown, client: string) {
      const f = failed[client];
      if (f && f.until > now()) { return { result: 'locked' }; }
      const o = body as Record<string, unknown>;
      const keys = o && typeof o === 'object' ? Object.keys(o).sort().join(',') : '';
      // Exactly {id, provider}: any other field (a key, a token, …) is refused outright.
      if (keys !== 'id,provider' || typeof o.id !== 'string' || typeof o.provider !== 'string') { return fail(client, 'bad-request'); }
      if (!validPairingId(o.id) || !map[o.id]) { return fail(client, 'invalid'); }
      if (PROVIDERS.indexOf(o.provider) < 0) { return fail(client, 'bad-provider'); }
      const e = map[o.id];
      const s = state(e);
      if (s === 'expired') { return { result: 'expired' }; }
      if (s === 'cancelled') { return { result: 'cancelled' }; }
      if (s === 'confirmed') { return { result: 'used' }; }
      e.state = 'confirmed';
      e.provider = o.provider;
      return { result: 'confirmed', provider: o.provider };
    },
    cancel: function (id: string) {
      if (!validPairingId(id) || !map[id]) { return false; }
      if (map[id].state === 'waiting') { map[id].state = 'cancelled'; }
      return true;
    },
    size: function () { return Object.keys(map).length; }
  };
}
