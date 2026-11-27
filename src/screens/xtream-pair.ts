// Xtream login with the phone (QR): what the phone sends and how the TV checks it.
// Payload (inside the end-to-end encrypted envelope, docs/AI-02-PHONE-PAIRING.md):
//     { v: 1, p: 'xtream', x: { s: server, u: username, w: password, n?: name } }
// The details are not stored here: after the check code matches and the user confirms, they fill
// in the Add/Edit Xtream form, where the normal validation and Save apply.
import type { Translate } from '../i18n/strings.ts';
import type { PairPurpose } from './ai-phone-pair-screen.ts';
import { maskUrl } from './format.ts';

export const XTREAM_PAIR_KIND = 'xtream';

export interface XtreamDetails { server: string; username: string; password: string; name: string }

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const SERVER_RE = /^https?:\/\/[^\s\/?#@]+(?::\d{1,5})?(?:\/[^\s?#]*)?$/i;

function str(v: unknown, max: number, trim: boolean): string | null {
  if (typeof v !== 'string') { return null; }
  const s = trim ? v.replace(/^\s+|\s+$/g, '') : v;
  if (s.length > max || CONTROL.test(s)) { return null; }
  return s;
}

/** Checks the decrypted payload; null when anything is missing or not acceptable. */
export function parseXtreamPayload(data: Record<string, unknown>): XtreamDetails | null {
  if (!data || data.p !== XTREAM_PAIR_KIND) { return null; }
  const x = data.x as Record<string, unknown>;
  if (!x || typeof x !== 'object') { return null; }
  const server = str(x.s, 256, true);
  const username = str(x.u, 256, true);
  const password = str(x.w, 256, false);
  const name = x.n === undefined || x.n === null ? '' : str(x.n, 64, true);
  if (!server || !SERVER_RE.test(server) || !username || !password || name === null) { return null; }
  return { server: server.replace(/\/+$/, ''), username: username, password: password, name: name };
}

/** Pairing purpose for the Xtream form: on confirm, hands the details to fill(). */
export function xtreamPurpose(t: Translate, fill: (v: XtreamDetails) => void): PairPurpose {
  return {
    kind: XTREAM_PAIR_KIND,
    title: t('pair.xt.title'),
    intro: t('pair.xt.intro'),
    confirmLabel: t('pair.xt.use'),
    savedText: null,
    failText: t('pair.xt.invalid'),
    accept: function (data) {
      if (data.p !== XTREAM_PAIR_KIND) { return { ok: false, note: t('pair.wrongKind') }; }
      const v = parseXtreamPayload(data);
      data.x = null;
      if (!v) { return { ok: false, note: t('pair.xt.invalid') }; }
      return {
        ok: true,
        summary: t('pair.xt.received', { server: maskUrl(v.server), ulen: v.username.length, plen: v.password.length }),
        commit: function () { fill(v); return Promise.resolve(); }
      };
    }
  };
}
