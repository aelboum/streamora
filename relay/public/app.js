// EliteStream phone pairing page (docs/AI-02-PHONE-PAIRING.md).
// Reads the TV public key and the kind from the URL fragment (never sent to a server), encrypts the
// details ({p, k: API key} or {p: 'xtream', x: {s, u, w, n}}) to the TV public key with nacl.box
// (fresh phone key pair and nonce) and posts only the sealed envelope. No storage, cookies,
// analytics or third-party code.
(function () {
  'use strict';
  var nacl = window.nacl;
  // Kinds in the QR link: an AI provider API key, or an Xtream login for the playlist form.
  var PROVIDERS = { gemini: 'Google Gemini API key', xtream: 'Xtream login' };
  var CONFIRM = { gemini: 'Save key', xtream: 'Use these details' };
  var XT_MAX = { s: 256, u: 256, w: 256, n: 64 };
  var SERVER_RE = /^https?:\/\/[^\s\/?#@]+(?::\d{1,5})?(?:\/[^\s?#]*)?$/i;
  // Same rule as the TV (gemini-provider.ts): standard "AIza…" keys and AI Studio auth keys "AQ.…".
  var KEY_RE = /^(?:AQ\.[A-Za-z0-9_\-.]{17,197}|[A-Za-z0-9_\-]{20,200})$/;
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var $ = function (id) { return document.getElementById(id); };

  function b64url(bytes) {
    var out = '', i = 0, n;
    for (; i + 2 < bytes.length; i += 3) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (bytes.length - i === 1) { n = bytes[i] << 16; out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]; }
    else if (bytes.length - i === 2) { n = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]; }
    return out;
  }
  function fromB64url(s) {
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 6) | B64.indexOf(s[i]); bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
      acc &= (1 << bits) - 1;
    }
    return out;
  }
  /** Same derivation as the TV (src/ai/pairing/pair-crypto.ts checkCode). */
  function checkCode(tvPk, phonePk) {
    var m = new Uint8Array(9 + tvPk.length + phonePk.length), tag = 'ES-PAIR-1';
    for (var i = 0; i < tag.length; i++) { m[i] = tag.charCodeAt(i); }
    m.set(tvPk, 9); m.set(phonePk, 9 + tvPk.length);
    var h = nacl.hash(m);
    var s = String((((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3]) % 1000000);
    while (s.length < 6) { s = '0' + s; }
    return s.substring(0, 3) + ' ' + s.substring(3);
  }
  function wipe(a) { if (a) { for (var i = 0; i < a.length; i++) { a[i] = 0; } } }

  /** Same derivation as the TV (pair-crypto.ts sessionIdFor). */
  function sessionIdFor(pk) {
    var tag = 'ES-PAIR-SID', m2 = new Uint8Array(tag.length + pk.length);
    for (var i = 0; i < tag.length; i++) { m2[i] = tag.charCodeAt(i); }
    m2.set(pk, tag.length);
    return b64url(nacl.hash(m2).subarray(0, 16));
  }

  // Current format "#2.<TV public key>.<provider>" (session id derived from the key);
  // "#v1.<session id>.<TV public key>.<provider>" is still accepted.
  var hash = location.hash || '';
  var m = /^#2\.([A-Za-z0-9_-]{43})\.([a-z]{2,20})$/.exec(hash);
  var m1 = m ? null : /^#v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.([a-z]{2,20})$/.exec(hash);
  // Remove the fragment from the address bar and history entry.
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  var provider = m ? m[2] : m1 ? m1[3] : '';
  if ((!m && !m1) || !PROVIDERS[provider] || !nacl || !nacl.box) { $('bad').hidden = false; return; }

  var tvPk = fromB64url(m ? m[1] : m1[2]);
  var sid = m ? sessionIdFor(tvPk) : m1[1];
  var kp = nacl.box.keyPair();
  var sent = false;
  var xtream = provider === 'xtream';
  $('provider').textContent = PROVIDERS[provider];
  $('code').textContent = checkCode(tvPk, kp.publicKey);
  $('keyBox').hidden = xtream;
  $('xtBox').hidden = !xtream;
  $('confirm').textContent = CONFIRM[provider];
  $('form').hidden = false;

  /**
   * Many providers hand out one link such as http://host:port/get.php?username=U&password=P&type=m3u_plus
   * (or player_api.php). Pasted into the server field, it is split into server, username and password.
   */
  function splitXtreamLink() {
    var v = ($('xtServer').value || '').replace(/^\s+|\s+$/g, '');
    var mm = /^(https?:\/\/[^\s\/?#]+)(\/[^\s?#]*)?\?(.*)$/i.exec(v);
    if (!mm) { return; }
    var q = {}, parts = mm[3].split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      try { q[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); } catch (e) { /* skip */ }
    }
    if (!q.username || !q.password) { return; }
    var path = (mm[2] || '').replace(/\/(?:get|player_api|xmltv)\.php$/i, '');
    $('xtServer').value = mm[1] + path;
    $('xtUser').value = q.username;
    $('xtPass').value = q.password;
    say('The link was split into server, username and password.');
  }
  $('xtServer').onchange = splitXtreamLink;
  $('xtServer').onblur = splitXtreamLink;
  $('xtShow').onclick = function () {
    var k = $('xtPass');
    k.type = k.type === 'password' ? 'text' : 'password';
    this.textContent = k.type === 'password' ? 'Show' : 'Hide';
  };

  /** Xtream details from the form, or a message saying what is missing (never showing values). */
  function xtreamPayload() {
    splitXtreamLink();
    var s = ($('xtServer').value || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    var u = ($('xtUser').value || '').replace(/^\s+|\s+$/g, '');
    var w = $('xtPass').value || '';
    var n = ($('xtName').value || '').replace(/^\s+|\s+$/g, '');
    if (!s) { return { error: 'Enter the server address.' }; }
    if (!/^https?:\/\//i.test(s)) { s = 'http://' + s; }
    if (!SERVER_RE.test(s)) { return { error: 'The server address does not look right. Example: http://example.com:8080' }; }
    if (!u) { return { error: 'Enter the username.' }; }
    if (!w) { return { error: 'Enter the password.' }; }
    var x = { s: s, u: u, w: w, n: n };
    for (var f in XT_MAX) {
      if (x[f].length > XT_MAX[f]) { return { error: 'One of the fields is too long.' }; }
      if (/[\u0000-\u001f\u007f]/.test(x[f])) { return { error: 'One of the fields contains a line break or another control character.' }; }
    }
    return { x: x };
  }

  function say(text, bad) { $('msg').textContent = text; $('msg').className = bad ? 'err' : ''; }

  $('show').onclick = function () {
    var k = $('key');
    k.type = k.type === 'password' ? 'text' : 'password';
    this.textContent = k.type === 'password' ? 'Show' : 'Hide';
  };
  $('paste').onclick = function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) { say('Paste is not available here. Long-press the field and choose Paste.', true); return; }
    navigator.clipboard.readText().then(function (t) { $('key').value = cleanKey(t); say(''); }, function () {
      say('Paste was not allowed. Long-press the field and choose Paste.', true);
    });
  };

  /** Removes what copying often adds: spaces, line breaks, invisible characters, wrapping quotes. */
  function cleanKey(v) {
    return String(v || '').replace(/[\s ​-‍⁠﻿]+/g, '').replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  }
  /** Why a value is not accepted, without ever showing the value itself. */
  function keyProblem(k) {
    if (!k) { return 'Paste your API key first.'; }
    if (k.length < 20) { return 'That is too short for an API key (' + k.length + ' characters). Copy the whole key.'; }
    if (k.length > 200) { return 'That is too long for an API key (' + k.length + ' characters). Copy only the key.'; }
    var hit = /^AQ\./.test(k) ? /[^A-Za-z0-9_\-.]/.exec(k.substring(3)) : /[^A-Za-z0-9_\-]/.exec(k);
    if (!hit) { return 'That does not look like an API key. A Gemini key starts with AIza or AQ.'; }
    var bad = hit[0];
    var kind = bad === '.' ? 'a dot (.)' : bad === ':' ? 'a colon (:)' : bad === '/' ? 'a slash (/)' : /[a-zA-Z0-9]/.test(bad.normalize ? bad.normalize('NFKD') : bad) ? 'a special letter' : 'the character "' + bad + '"';
    return 'That does not look like an API key: it has ' + k.length + ' characters and contains ' + kind +
      ' at position ' + (k.indexOf(bad, /^AQ\./.test(k) ? 3 : 0) + 1) + '. A Gemini key starts with AIza (39 letters, digits, - or _) or AQ. (letters, digits, -, _ or dots).';
  }

  function finish(text) {
    $('form').hidden = true;
    $('done').hidden = false;
    $('doneMsg').textContent = text;
  }

  function watch(until) {
    if (Date.now() > until) { return; }
    fetch('/v1/s/' + sid + '/status', { cache: 'no-store', credentials: 'omit' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.state === 'delivered') { finish('The TV received it. Check that the TV shows code ' + $('code').textContent + ', then choose "' + CONFIRM[provider] + '" on the TV.'); return; }
      if (j && (j.state === 'cancelled' || j.state === 'expired')) { finish('The TV closed this pairing. Nothing was used.'); return; }
      setTimeout(function () { watch(until); }, 2000);
    }, function () { setTimeout(function () { watch(until); }, 3000); });
  }

  $('send').onclick = function () {
    if (sent) { return; }
    var payload;
    if (xtream) {
      var xp = xtreamPayload();
      if (xp.error) { say(xp.error, true); return; }
      payload = { v: 1, p: provider, x: xp.x };
    } else {
      var key = cleanKey($('key').value);
      if (!KEY_RE.test(key)) { say(keyProblem(key), true); return; }
      payload = { v: 1, p: provider, k: key };
      key = '';
    }
    var msg = new TextEncoder().encode(JSON.stringify(payload));
    payload = null;
    // The relay accepts sealed messages up to about 1,200 bytes.
    if (msg.length > 1100) { wipe(msg); say('The details are too long to send.', true); return; }
    var nonce = nacl.randomBytes(24);
    var box = nacl.box(msg, nonce, tvPk, kp.secretKey);
    wipe(msg);
    wipe(kp.secretKey);
    $('key').value = '';
    $('xtPass').value = '';
    $('xtUser').value = '';
    sent = true;
    $('send').disabled = true;
    say('Sending…');
    fetch('/v1/s/' + sid, {
      method: 'POST', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, epk: b64url(kp.publicKey), n: b64url(nonce), c: b64url(box) })
    }).then(function (r) {
      if (r.ok) { say('Sent. Waiting for the TV…'); watch(Date.now() + 5 * 60000); return; }
      return r.json().then(function (j) {
        var e = j && j.error;
        finish(e === 'expired' ? 'This QR code has expired. Show a new code on the TV.' :
          e === 'cancelled' ? 'The TV closed this pairing.' :
          e === 'ready' || e === 'delivered' ? 'Something was already sent for this code. Show a new code on the TV.' :
          'It could not be sent (' + (e || r.status) + '). Show a new code on the TV and try again.');
      });
    }).catch(function () { finish('No connection. Show a new code on the TV and try again.'); });
  };
})();
