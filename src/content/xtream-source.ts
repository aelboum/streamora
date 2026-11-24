// Xtream Codes import: authenticate -> live categories -> live streams (streamed) -> compact
// live catalogue. ContentProvider layer: no storage, no DOM. Maps provider types
// (api/xtream/xtream-types.ts) to the normalised model; the provider shapes stop here.
import type { XtreamClient } from '../api/xtream/xtream-client.ts';
import type { XtreamErrorCode } from '../api/xtream/xtream-client.ts';
import { checkUrl } from '../api/url.ts';
import type { ImportCounts, ImportErrorCode, LiveFormat } from '../models/content.ts';
import { createLiveBuilder, looksAdult } from './catalogue-codec.ts';
import type { ImportHandle, ImportProgress, ImportResult, SourceImport } from './import-types.ts';

export interface XtreamImportOptions {
  client: XtreamClient;
  liveFormat: LiveFormat;
  now: () => number;
  onProgress?: (p: ImportProgress) => void;
}

function code(c: XtreamErrorCode): ImportErrorCode {
  return c === 'invalid-response' ? 'invalid-response' : c;
}

function fail(c: ImportErrorCode, message: string): ImportResult {
  return { ok: false, code: c, message: message };
}

export function importXtream(o: XtreamImportOptions): ImportHandle {
  let current: { abort(): void } | null = null;
  let aborted = false;
  const builder = createLiveBuilder();
  const counts: ImportCounts = { live: 0, movie: 0, series: 0, invalid: 0, duplicate: 0 };
  const warnings: string[] = [];
  let account: SourceImport['account'];

  const result = Promise.resolve().then(function (): Promise<ImportResult> | ImportResult {
    if (aborted) {
      return fail('aborted', 'aborted');
    }
    const auth = o.client.authenticate();
    current = auth;
    return auth.result.then(function (a): Promise<ImportResult> | ImportResult {
      if (!a.ok) {
        return fail(code(a.code), a.message);
      }
      const u = a.data.user;
      account = { expiresAt: u.expiresAt, maxConnections: u.maxConnections, trial: u.trial, status: u.status };
      const st = u.status.toLowerCase();
      if (st === 'expired' || (u.expiresAt !== null && u.expiresAt < o.now())) {
        return fail('expired', 'subscription expired');
      }
      if (st !== 'active' && st !== 'unknown') {
        return fail('auth', 'account status: ' + u.status);
      }
      if (u.allowedFormats.length > 0 && u.allowedFormats.indexOf(o.liveFormat) < 0) {
        warnings.push('provider does not list the ' + o.liveFormat + ' format');
      }
      if (aborted) {
        return fail('aborted', 'aborted');
      }
      const cats = o.client.liveCategories();
      current = cats;
      return cats.result.then(function (c): Promise<ImportResult> | ImportResult {
        if (!c.ok) {
          return fail(code(c.code), c.message);
        }
        for (let i = 0; i < c.data.length; i++) {
          builder.addCategory(c.data[i].id, c.data[i].name, looksAdult(c.data[i].name));
        }
        if (aborted) {
          return fail('aborted', 'aborted');
        }
        let lastProgress = 0;
        const streams = o.client.liveStreams(function (s) {
          let logo = '';
          if (s.icon) {
            const l = checkUrl(s.icon, { kind: 'userSource' });
            logo = l.ok ? l.href : '';
          }
          const added = builder.addChannel({
            providerId: s.streamId,
            num: s.num,
            name: s.name,
            categoryId: s.categoryId,
            logo: logo,
            epgKey: s.epgChannelId,
            // The stream URL is rebuilt at play time from the configured server, the secret and the format.
            ref: { kind: 'xtream', type: 'live', id: s.streamId },
            adult: s.adult,
            radio: false,
            catchupDays: s.archiveDays,
            userAgent: '',
            referrer: ''
          });
          if (added) {
            counts.live++;
          } else {
            counts.duplicate++;
          }
          if (o.onProgress && counts.live - lastProgress >= 2000) {
            lastProgress = counts.live;
            o.onProgress({ chars: 0, channels: counts.live });
          }
        });
        current = streams;
        return streams.result.then(function (r): ImportResult {
          if (!r.ok) {
            return fail(code(r.code), r.message);
          }
          counts.invalid += r.data.invalid;
          if (counts.invalid > 0) {
            warnings.push(counts.invalid + ' invalid stream entries skipped');
          }
          if (counts.live === 0) {
            return fail('empty', 'the account has no live channels');
          }
          const built = builder.finish();
          return {
            ok: true,
            data: { payload: built.payload, counts: counts, categories: built.categories, epg: [{ kind: 'xtream' }], warnings: warnings, account: account }
          };
        });
      });
    });
  });

  return {
    result: result,
    abort: function () {
      aborted = true;
      if (current) {
        current.abort();
      }
    }
  };
}
