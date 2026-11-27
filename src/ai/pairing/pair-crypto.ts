// AI-02: phone pairing — protocol and end-to-end encryption (TV side). docs/AI-02-PHONE-PAIRING.md.
//
// The TV creates a fresh X25519 key pair (TweetNaCl box) for every QR code. The QR code holds only
// the relay page address, with the TV PUBLIC key and the provider in the URL FRAGMENT (browsers
// never send a fragment to a server):
//     https://<pairing host>/#2.<TV public key>.<provider>
// Both sides derive the relay session id from the public key (sessionIdFor).
// The phone page encrypts {provider, key} to the TV public key with nacl.box (X25519 +
// XSalsa20-Poly1305, fresh phone key pair and nonce) and posts only the sealed envelope to the
// relay. The relay never sees the TV public key, so it can neither read nor forge an envelope.
// The TV decrypts locally, shows a 6-digit check code (both sides derive it from the two public
// keys) and stores the key only after the user confirms on the TV. The secret key is wiped after
// use and never leaves memory.
// TweetNaCl 1.0.3 (public domain; audited by Cure53 in 2017) is plain ES5 and needs only
// crypto.getRandomValues, which works on Tizen 3.0 and Android WebView without WebCrypto.subtle.
// @ts-ignore -- CommonJS module (`export =`); esbuild and Node provide it as the default import.
import naclLib from 'tweetnacl';

interface BoxKeyPair { publicKey: Uint8Array; secretKey: Uint8Array }
interface NaclLike {
  box: {
    keyPair(): BoxKeyPair;
    open(box: Uint8Array, nonce: Uint8Array, theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array | null;
    publicKeyLength: number;
    nonceLength: number;
  };
  hash(m: Uint8Array): Uint8Array;
  randomBytes(n: number): Uint8Array;
}
const nacl = naclLib as unknown as NaclLike;

export const PAIR_TTL_MS = 5 * 60000;
export const PAIR_PROVIDERS = ['gemini'];
/** Session ids: 16 bytes, base64url (22 characters); see sessionIdFor. */
export const SID_RE = /^[A-Za-z0-9_-]{22}$/;
/** Largest envelope accepted from the relay (characters of JSON). */
export const MAX_ENVELOPE_CHARS = 2048;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
  }
  if (bytes.length - i === 1) {
    const n = bytes[i] << 16;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
  } else if (bytes.length - i === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63);
  }
  return out;
}

/** Decodes base64url (no padding); null when the text is not valid. */
export function fromB64url(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) { return null; }
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/**
 * Session id derived from the TV public key: base64url of the first 16 bytes of
 * SHA-512("ES-PAIR-SID" || publicKey). The phone page derives the same id, so the QR code does not
 * need to carry it (smaller, easier-to-scan code). The relay sees only this id; SHA-512 is one-way,
 * so it cannot recover the public key from it. A fresh key pair per code gives a fresh id.
 */
export function sessionIdFor(publicKey: Uint8Array): string {
  const tag = 'ES-PAIR-SID';
  const m = new Uint8Array(tag.length + publicKey.length);
  for (let i = 0; i < tag.length; i++) { m[i] = tag.charCodeAt(i); }
  m.set(publicKey, tag.length);
  return b64url(nacl.hash(m).subarray(0, 16));
}

/** True when the platform offers a cryptographic random source (TweetNaCl needs it). */
export function pairingCryptoAvailable(): boolean {
  try { return nacl.randomBytes(1).length === 1; } catch (e) { return false; }
}

export interface PairSession {
  sid: string;
  provider: string;
  publicKey: Uint8Array;
  /** Wipes the secret key (call when the session ends in any way). */
  wipe(): void;
  /** Opens an envelope from the relay; the secret key stays inside this object. */
  open(env: unknown): PairOpenResult;
}

export type PairOpenResult =
  | { ok: true; key: string; code: string }
  | { ok: false; reason: 'bad-envelope' | 'decrypt-failed' | 'bad-payload' | 'wrong-provider' | 'wiped' };

/** Starts a pairing session: fresh key pair and session id. */
export function createPairSession(provider: string): PairSession {
  const kp = nacl.box.keyPair();
  const sid = sessionIdFor(kp.publicKey);
  let sk: Uint8Array | null = kp.secretKey;
  return {
    sid: sid,
    provider: provider,
    publicKey: kp.publicKey,
    wipe: function () {
      if (sk) { for (let i = 0; i < sk.length; i++) { sk[i] = 0; } }
      sk = null;
    },
    open: function (env: unknown) {
      if (!sk) { return { ok: false, reason: 'wiped' }; }
      return openEnvelope(env, kp.publicKey, sk, provider);
    }
  };
}

/** The QR payload: pairing page address with everything in the fragment. */
export function pairUrl(base: string, s: { sid: string; publicKey: Uint8Array; provider: string }): string {
  return base.replace(/\/+$/, '') + '/#2.' + b64url(s.publicKey) + '.' + s.provider;
}

/** 6-digit check code from both public keys ("123 456"); the phone page computes the same. */
export function checkCode(tvPublicKey: Uint8Array, phonePublicKey: Uint8Array): string {
  const m = new Uint8Array(tvPublicKey.length + phonePublicKey.length + 9);
  const tag = 'ES-PAIR-1';
  for (let i = 0; i < tag.length; i++) { m[i] = tag.charCodeAt(i); }
  m.set(tvPublicKey, 9);
  m.set(phonePublicKey, 9 + tvPublicKey.length);
  const hsh = nacl.hash(m);
  const n = ((hsh[0] << 24) >>> 0) + (hsh[1] << 16) + (hsh[2] << 8) + hsh[3];
  let s = String(n % 1000000);
  while (s.length < 6) { s = '0' + s; }
  return s.substring(0, 3) + ' ' + s.substring(3);
}

function utf8Decode(b: Uint8Array): string | null {
  let bin = '';
  for (let i = 0; i < b.length; i++) { bin += String.fromCharCode(b[i]); }
  try { return decodeURIComponent(escape(bin)); } catch (e) { return null; }
}

/**
 * Envelope (from the relay): { v: 1, epk, n, c } — phone public key, nonce, box, all base64url.
 * Plaintext: JSON { v: 1, p: provider, k: key }.
 */
export function openEnvelope(env: unknown, tvPublicKey: Uint8Array, tvSecretKey: Uint8Array, provider: string): PairOpenResult {
  const e = env as Record<string, unknown>;
  if (!e || typeof e !== 'object' || e.v !== 1 || typeof e.epk !== 'string' || typeof e.n !== 'string' || typeof e.c !== 'string') {
    return { ok: false, reason: 'bad-envelope' };
  }
  const epk = fromB64url(e.epk);
  const nonce = fromB64url(e.n);
  const box = fromB64url(e.c);
  if (!epk || epk.length !== nacl.box.publicKeyLength || !nonce || nonce.length !== nacl.box.nonceLength || !box || box.length < 17 || box.length > 1200) {
    return { ok: false, reason: 'bad-envelope' };
  }
  const plain = nacl.box.open(box, nonce, epk, tvSecretKey);
  if (!plain) { return { ok: false, reason: 'decrypt-failed' }; }
  const text = utf8Decode(plain);
  for (let i = 0; i < plain.length; i++) { plain[i] = 0; }
  let o: Record<string, unknown> | null = null;
  try { o = text ? JSON.parse(text) : null; } catch (x) { o = null; }
  if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.p !== 'string' || typeof o.k !== 'string' || !o.k) {
    return { ok: false, reason: 'bad-payload' };
  }
  if (o.p !== provider) { return { ok: false, reason: 'wrong-provider' }; }
  return { ok: true, key: o.k.replace(/^\s+|\s+$/g, ''), code: checkCode(tvPublicKey, epk) };
}
