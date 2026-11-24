// Synthetic IPTV endpoints for on-TV measurements (dev-sink only; never part of the app).
// Synthetic credentials only. Serves:
//   /get.php?username=…&password=…&n=50000      Xtream-style M3U (n channels, 120 groups)
//   /player_api.php?username=…&password=…[&action=get_live_categories|get_live_streams]
//   /fixture/redirect?to=same|cross              302 to /fixture/landing on this or the second port
//   /fixture/landing                             small JSON body
export const TV_USER = 'tvtest_user';
export const TV_PASS = 'tvtest_pass_0';

const GROUPS = 120;

function query(url) {
  const out = {};
  const q = url.indexOf('?');
  if (q < 0) return out;
  for (const p of url.substring(q + 1).split('&')) {
    const eq = p.indexOf('=');
    if (eq > 0) out[decodeURIComponent(p.substring(0, eq))] = decodeURIComponent(p.substring(eq + 1));
  }
  return out;
}

function count(q) {
  const n = Number(q.n || 50000);
  return Number.isFinite(n) && n > 0 && n <= 300000 ? Math.floor(n) : 50000;
}

/** Writes a large body in pieces so the TV's XHR sees progress events. */
function stream(res, contentType, total, piece) {
  res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  let i = 0;
  function more() {
    let ok = true;
    while (ok && i < total) {
      ok = res.write(piece(i));
      i++;
    }
    if (i >= total) res.end(piece(-1));
    else res.once('drain', more);
  }
  more();
}

export function handleFixture(req, res, origin, otherOrigin) {
  const url = req.url || '';
  const path = url.split('?')[0];
  const q = query(url);
  const authed = q.username === TV_USER && q.password === TV_PASS;
  if (path === '/get.php') {
    if (!authed) { res.writeHead(403, { 'Access-Control-Allow-Origin': '*' }); res.end(); return true; }
    const n = count(q);
    stream(res, 'audio/x-mpegurl; charset=utf-8', n + 1, (i) => {
      if (i === 0) return '#EXTM3U url-tvg="' + origin + '/xmltv.php?username=' + TV_USER + '&password=' + TV_PASS + '"\n';
      if (i < 0) return '';
      const k = i - 1;
      return '#EXTINF:-1 tvg-id="ch' + k + '.example" tvg-name="Channel ' + k + '" tvg-logo="' + origin + '/logos/' + (k % 500) + '.png" group-title="Group ' + (k % GROUPS) + '",Channel ' + k + '\n' +
        origin + '/' + TV_USER + '/' + TV_PASS + '/' + (100000 + k) + '\n';
    });
    return true;
  }
  if (path === '/player_api.php') {
    const head = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (!authed) { res.writeHead(200, head); res.end('{"user_info":{"auth":0}}'); return true; }
    if (!q.action) {
      res.writeHead(200, head);
      res.end(JSON.stringify({ user_info: { username: TV_USER, password: TV_PASS, auth: 1, status: 'Active', exp_date: '1893456000', is_trial: '0', active_cons: '0', max_connections: '1', allowed_output_formats: ['ts', 'm3u8'] }, server_info: { timezone: 'UTC', timestamp_now: Math.floor(Date.now() / 1000) } }));
      return true;
    }
    if (q.action === 'get_live_categories') {
      const cats = [];
      for (let g = 0; g < GROUPS; g++) cats.push({ category_id: String(g + 1), category_name: 'Group ' + g, parent_id: 0 });
      res.writeHead(200, head);
      res.end(JSON.stringify(cats));
      return true;
    }
    if (q.action === 'get_live_streams') {
      const n = count({ n: q.n || 50000 });
      stream(res, 'application/json', n + 1, (i) => {
        if (i < 0) return ']';
        if (i === n) return '';
        return (i === 0 ? '[' : ',') + JSON.stringify({ num: i + 1, name: 'Channel ' + i, stream_type: 'live', stream_id: 100000 + i, stream_icon: origin + '/logos/' + (i % 500) + '.png', epg_channel_id: 'ch' + i + '.example', added: '1700000000', is_adult: '0', category_id: String((i % GROUPS) + 1), custom_sid: '', tv_archive: 0, direct_source: '', tv_archive_duration: 0 });
      });
      return true;
    }
    res.writeHead(200, head);
    res.end('[]');
    return true;
  }
  if (path === '/fixture/redirect') {
    const target = (q.to === 'cross' ? otherOrigin : origin) + '/fixture/landing';
    res.writeHead(302, { Location: target, 'Access-Control-Allow-Origin': '*' });
    res.end();
    return true;
  }
  if (path === '/fixture/landing') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end('{"landed":true}');
    return true;
  }
  return false;
}
