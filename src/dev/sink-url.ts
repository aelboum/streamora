// Validation of the dev log sink endpoint. Used by the build (scripts/build.mjs) and the
// dev sink itself. Only plain private-LAN IPv4 endpoints are accepted.

export type SinkUrlCheck = { ok: true; url: string; origin: string } | { ok: false; reason: string };

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) {
    return false;
  }
  for (let i = 1; i <= 4; i++) {
    if (+m[i] > 255) {
      return false;
    }
  }
  const a = +m[1];
  const b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function checkSinkUrl(raw: string): SinkUrlCheck {
  const m = /^http:\/\/([0-9.]+):(\d{2,5})(\/[A-Za-z0-9_\-\/]*)?$/.exec(raw || '');
  if (!m) {
    return { ok: false, reason: 'expected http://<private-ipv4>:<port>/<path>' };
  }
  if (!isPrivateIpv4(m[1])) {
    return { ok: false, reason: 'host must be a private LAN IPv4 address' };
  }
  const port = +m[2];
  if (port < 1024 || port > 65535) {
    return { ok: false, reason: 'port must be 1024-65535' };
  }
  const origin = 'http://' + m[1] + ':' + port;
  return { ok: true, url: origin + (m[3] || '/ingest'), origin: origin };
}
