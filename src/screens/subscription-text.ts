// S2: subscription rows (Settings and playlist details). Expiry and account status are separate
// facts: the expiry line comes only from exp_date (date / no expiration / unknown); the status line
// appears only when the server reports a status other than Active. No credentials or addresses.
import type { Translate } from '../i18n/strings.ts';
import type { AccountInfo } from '../services/account-info.ts';
import { expiryView } from '../content/expiry.ts';
import { formatDate, formatDateTime } from './format.ts';

const DAY_MS = 86400000;

export function subscriptionLines(kind: 'm3u' | 'xtream', info: AccountInfo | null, deviceNow: number, t: Translate, detailed: boolean): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  let value: string;
  if (kind !== 'xtream') {
    value = t('sub.m3u');
  } else if (!info) {
    value = t('sub.notChecked');
  } else {
    const v = expiryView(info.expiry, info.clock, deviceNow);
    if (v.state === 'unknown') {
      value = t('sub.unknown');
    } else if (v.state === 'unlimited') {
      value = t('sub.none');
    } else if (v.state === 'expired') {
      value = t('sub.expired', { date: formatDate(v.at) });
    } else if (v.state === 'today') {
      value = t('sub.today', { date: formatDate(v.at) });
    } else {
      value = v.days === 1 ? t('sub.oneDay', { date: formatDate(v.at) }) : t('sub.days', { date: formatDate(v.at), n: v.days });
    }
  }
  out.push({ label: t('set.subscription'), value: value });
  if (kind === 'xtream' && info) {
    const st = info.status.toLowerCase();
    if (st && st !== 'active' && st !== 'unknown') {
      out.push({ label: t('set.accountStatus'), value: info.status });
    }
    if (detailed) {
      out.push({ label: t('sub.checked'), value: formatDateTime(info.checkedAt) });
      out.push({ label: t('sub.basis'), value: t('sub.basis.' + info.clock.reason, { n: Math.round(Math.abs(info.clock.offsetMs) / DAY_MS) }) });
    }
  }
  return out;
}
