/* ScreenShelf Device Probe 2 (IPTV questions P1-P10). Plain ES5.
 * Results are posted to probe2/server/media-server.mjs on the development PC (LAN, plain HTTP).
 * Commands from the PC are a fixed allowlist; nothing received is executed as code. */
(function () {
  'use strict';

  var PC = 'http://192.168.1.180:8099';
  var R = window.__probe = {
    meta: { t0: window.__T0, version: '0.2.0' },
    features: [], xhr: [], storage: [], crypto: [], images: [], avplay: [], avruns: [], manual: { events: [] }, log: [], done: {}
  };
  var logEl = document.getElementById('log');
  var phaseEl = document.getElementById('phase');
  var summaryEl = document.getElementById('summary');

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function log(msg) {
    R.log.push(((Date.now() - window.__T0) / 1000).toFixed(1) + 's ' + msg);
    if (R.log.length > 600) { R.log.shift(); }
    logEl.textContent = R.log.slice(-34).join('\n');
  }
  function phase(p) { phaseEl.textContent = p; log('== ' + p); }
  function rec(list, name, status, detail) {
    list.push({ name: name, status: status, detail: detail === undefined ? '' : String(detail) });
    log(status + ' ' + name + (detail !== undefined ? ' | ' + String(detail).substring(0, 90) : ''));
  }
  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function heapMB() { try { return Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) { return -1; } }
  function sysFreeMB() { try { return Math.round(tizen.systeminfo.getAvailableMemory() / 1048576); } catch (e) { return -1; } }
  function mem() { return 'heap ' + heapMB() + ' MB, sys free ' + sysFreeMB() + ' MB'; }
  function count(list) {
    var p = 0, f = 0;
    for (var i = 0; i < list.length; i++) { if (list[i].status === 'PASS') { p++; } else if (list[i].status === 'FAIL') { f++; } }
    return p + '/' + f;
  }
  function updateSummary() {
    summaryEl.textContent = 'pass/fail  features ' + count(R.features) + '  xhr ' + count(R.xhr) + '  storage ' + count(R.storage) +
      '  crypto ' + count(R.crypto) + '  images ' + count(R.images) + '  avplay ' + count(R.avplay);
  }
  function run(name, fn) {
    return function () {
      phase(name);
      var t = now();
      return Promise.resolve().then(fn).then(function () { R.done[name] = Math.round(now() - t) + ' ms'; updateSummary(); post(name); },
        function (e) { R.done[name] = 'crashed: ' + (e && e.message); log(name + ' crashed ' + (e && e.message)); post(name); });
    };
  }

  /* ---------------- reporting ---------------- */
  function post(tag) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', PC + '/report?tag=' + encodeURIComponent(tag), true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(JSON.stringify(R));
    } catch (e) { log('report failed ' + e.message); }
  }

  /* ---------------- features ---------------- */
  function featureTests() {
    var L = R.features;
    function has(name, v) { rec(L, name, v ? 'PASS' : 'FAIL', v ? '' : 'absent'); }
    R.meta.userAgent = navigator.userAgent;
    R.meta.memoryAtStart = mem();
    has('window.indexedDB', !!window.indexedDB);
    has('window.webkitIndexedDB', !!window.webkitIndexedDB);
    has('window.openDatabase (WebSQL)', typeof window.openDatabase === 'function');
    has('DecompressionStream', typeof window.DecompressionStream === 'function');
    has('TextDecoder', typeof window.TextDecoder === 'function');
    has('crypto.getRandomValues', !!(window.crypto && crypto.getRandomValues));
    has('crypto.subtle', !!(window.crypto && crypto.subtle));
    has('crypto.webkitSubtle', !!(window.crypto && crypto.webkitSubtle));
    has('tizen.filesystem', !!(window.tizen && tizen.filesystem));
    has('tizen.keymanager', !!(window.tizen && tizen.keymanager));
    has('XMLHttpRequest onprogress', 'onprogress' in new XMLHttpRequest());
    has('Uint8Array', typeof window.Uint8Array === 'function');
  }

  /* ---------------- P5: large XHR, incremental responseText, streaming parse ---------------- */
  function bigXhr(mb, gzip, readDuringProgress) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest(), t0 = now(), events = 0, growths = 0, lastLen = 0, parsedTo = 0, entries = 0, parseMs = 0, peakHeap = heapMB(), minFree = sysFreeMB();
      var name = 'XHR ' + mb + ' MB' + (gzip ? ' gzip' : '') + (readDuringProgress ? ' + incremental parse' : ' (read at end)');
      function parseNew(text) {
        var p0 = now(), end = text.lastIndexOf('\n');
        if (end <= parsedTo) { return; }
        var i = parsedTo;
        while (i < end) {
          var nl = text.indexOf('\n', i);
          if (nl < 0 || nl > end) { break; }
          if (text.charCodeAt(i) === 35 && text.substr(i, 8) === '#EXTINF:') { entries++; }
          i = nl + 1;
        }
        parsedTo = i;
        parseMs += now() - p0;
      }
      x.onprogress = function () {
        events++;
        if (!readDuringProgress) { return; }
        var txt = x.responseText;
        if (txt && txt.length > lastLen) { growths++; lastLen = txt.length; parseNew(txt); }
        var h = heapMB(); if (h > peakHeap) { peakHeap = h; }
        var f = sysFreeMB(); if (f >= 0 && f < minFree) { minFree = f; }
      };
      x.onload = function () {
        var tEnd = now(), txt = x.responseText || '', expect = +x.getResponseHeader('X-Uncompressed-Length');
        parseNew(txt);
        var h = heapMB(); if (h > peakHeap) { peakHeap = h; }
        var f = sysFreeMB(); if (f >= 0 && f < minFree) { minFree = f; }
        var ok = txt.length > 0 && (!expect || Math.abs(txt.length - expect) < expect * 0.01) && entries === +x.getResponseHeader('X-Entries');
        rec(R.xhr, name, ok ? 'PASS' : 'FAIL', 'len ' + txt.length + ' (expect ~' + expect + ' bytes), entries ' + entries + '/' + x.getResponseHeader('X-Entries') +
          ', ' + Math.round(tEnd - t0) + ' ms total, parse ' + Math.round(parseMs) + ' ms, progress events ' + events + ', text grew ' + growths +
          'x, peak heap ' + peakHeap + ' MB, min sys free ' + minFree + ' MB');
        txt = null;
        resolve();
      };
      x.onerror = function () { rec(R.xhr, name, 'FAIL', 'onerror after ' + Math.round(now() - t0) + ' ms'); resolve(); };
      x.ontimeout = function () { rec(R.xhr, name, 'FAIL', 'timeout'); resolve(); };
      x.open('GET', PC + '/text/big.txt?mb=' + mb + (gzip ? '&gzip=1' : '') + '&t=' + Date.now(), true);
      x.timeout = 180000;
      x.send();
    });
  }
  function xhrTests() {
    return bigXhr(10, false, true)
      .then(function () { return delay(2000); }).then(function () { return bigXhr(10, true, true); })
      .then(function () { return delay(2000); }).then(function () { return bigXhr(50, false, false); })
      .then(function () { return delay(4000); }).then(function () { return bigXhr(50, false, true); })
      .then(function () { R.meta.memoryAfterXhr = mem(); });
  }

  /* ---------------- P6: storage ---------------- */
  var CHUNK = (function () { var s = '0123456789abcdef'; while (s.length < 102400) { s += s; } return s.substring(0, 102400); })();
  var N_CHUNKS = 200; // 200 x 100 KB = about 20 MB of characters

  function idbTest() {
    var idb = window.indexedDB || window.webkitIndexedDB;
    if (!idb) { rec(R.storage, 'IndexedDB 20 MB', 'FAIL', 'absent'); return Promise.resolve(); }
    return new Promise(function (resolve) {
      var t0 = now(), req;
      function fail(msg) { rec(R.storage, 'IndexedDB 20 MB', 'FAIL', msg + ' after ' + Math.round(now() - t0) + ' ms'); resolve(); }
      try { req = idb.open('ssprobe2', 1); } catch (e) { fail('open threw ' + e.message); return; }
      req.onupgradeneeded = function () { try { req.result.createObjectStore('c'); } catch (e) { /* reported below */ } };
      req.onerror = function () { fail('open error ' + (req.error && req.error.name)); };
      req.onsuccess = function () {
        var db = req.result, tw = now(), tx;
        try { tx = db.transaction(['c'], 'readwrite'); } catch (e) { fail('tx threw ' + e.message); return; }
        var st = tx.objectStore('c');
        for (var i = 0; i < N_CHUNKS; i++) { st.put(CHUNK, 'k' + i); }
        tx.onerror = function () { fail('write error ' + (tx.error && tx.error.name)); };
        tx.onabort = function () { fail('write aborted ' + (tx.error && tx.error.name)); };
        tx.oncomplete = function () {
          var writeMs = now() - tw, tr = now(), total = 0, rtx = db.transaction(['c'], 'readonly'), rs = rtx.objectStore('c');
          for (var j = 0; j < N_CHUNKS; j++) { rs.get('k' + j).onsuccess = function (ev) { var v = ev.target.result; total += v ? v.length : 0; }; }
          rtx.oncomplete = function () {
            var readMs = now() - tr;
            rec(R.storage, 'IndexedDB 20 MB', total === N_CHUNKS * CHUNK.length ? 'PASS' : 'FAIL', 'write ' + Math.round(writeMs) + ' ms, read ' + Math.round(readMs) + ' ms, read back ' + total + ' chars, ' + mem());
            db.close();
            try { idb.deleteDatabase('ssprobe2'); } catch (e) { /* ignore */ }
            resolve();
          };
          rtx.onerror = function () { fail('read error'); };
        };
      };
    });
  }

  function webSqlTest() {
    if (typeof window.openDatabase !== 'function') { rec(R.storage, 'WebSQL 20 MB', 'FAIL', 'absent'); return Promise.resolve(); }
    return new Promise(function (resolve) {
      var t0 = now(), db;
      function fail(msg) { rec(R.storage, 'WebSQL 20 MB', 'FAIL', msg + ' after ' + Math.round(now() - t0) + ' ms'); resolve(); }
      try { db = openDatabase('ssprobe2', '1.0', 'probe2', 50 * 1024 * 1024); } catch (e) { fail('open threw ' + e.message); return; }
      var tw = now();
      db.transaction(function (tx) {
        tx.executeSql('DROP TABLE IF EXISTS c');
        tx.executeSql('CREATE TABLE c (k TEXT PRIMARY KEY, v TEXT)');
        for (var i = 0; i < N_CHUNKS; i++) { tx.executeSql('INSERT INTO c (k, v) VALUES (?, ?)', ['k' + i, CHUNK]); }
      }, function (e) { fail('write ' + (e && e.message)); }, function () {
        var writeMs = now() - tw, tr = now();
        db.transaction(function (tx) {
          tx.executeSql('SELECT SUM(LENGTH(v)) AS n, COUNT(*) AS c FROM c WHERE k LIKE ?', ['k%'], function (t, rs) {
            var row = rs.rows.item(0), readMs = now() - tr;
            rec(R.storage, 'WebSQL 20 MB', row.n === N_CHUNKS * CHUNK.length ? 'PASS' : 'FAIL', 'write ' + Math.round(writeMs) + ' ms, aggregate read ' + Math.round(readMs) + ' ms, rows ' + row.c + ', chars ' + row.n + ', ' + mem());
            t.executeSql('DROP TABLE c');
          });
        }, function (e) { fail('read ' + (e && e.message)); }, function () { resolve(); });
      });
    });
  }

  function fsTest() {
    if (!(window.tizen && tizen.filesystem)) { rec(R.storage, 'tizen.filesystem wgt-private 20 MB', 'FAIL', 'absent'); return Promise.resolve(); }
    return new Promise(function (resolve) {
      var t0 = now(), name = 'tizen.filesystem wgt-private 20 MB';
      function fail(msg) { rec(R.storage, name, 'FAIL', msg + ' after ' + Math.round(now() - t0) + ' ms'); resolve(); }
      try {
        tizen.filesystem.resolve('wgt-private', function (dir) {
          var file;
          try { file = dir.createFile('p2.txt'); } catch (e) {
            try { file = dir.resolve('p2.txt'); } catch (e2) { fail('createFile ' + e.message); return; }
          }
          var tw = now();
          file.openStream('w', function (ws) {
            try { for (var i = 0; i < N_CHUNKS; i++) { ws.write(CHUNK); } ws.close(); } catch (e) { fail('write ' + e.message); return; }
            var writeMs = now() - tw, tr = now();
            file.openStream('r', function (rs) {
              var total = 0, part;
              try {
                do { part = rs.read(1048576); total += part.length; } while (part.length > 0 && !rs.eof);
                rs.close();
              } catch (e) { fail('read ' + e.message); return; }
              rec(R.storage, name, total === N_CHUNKS * CHUNK.length ? 'PASS' : 'FAIL', 'write ' + Math.round(writeMs) + ' ms, read ' + Math.round(now() - tr) + ' ms, chars ' + total + ', ' + mem());
              try { dir.deleteFile(file.fullPath, function () { resolve(); }, function () { resolve(); }); } catch (e) { resolve(); }
            }, function (e) { fail('openStream r ' + (e && e.message)); }, 'UTF-8');
          }, function (e) { fail('openStream w ' + (e && e.message)); }, 'UTF-8');
        }, function (e) { fail('resolve ' + (e && e.name) + ' ' + (e && e.message)); }, 'rw');
      } catch (e) { fail('threw ' + e.name + ' ' + e.message); }
    });
  }

  function keymanagerTest() {
    var name = 'tizen.keymanager save/get/remove data';
    if (!(window.tizen && tizen.keymanager)) { rec(R.storage, name, 'FAIL', 'absent'); return Promise.resolve(); }
    return new Promise(function (resolve) {
      var alias = 'ssprobe2-test', secret = 'synthetic-test-value-123';
      function done(status, msg) { rec(R.storage, name, status, msg); try { tizen.keymanager.removeData({ name: alias }); } catch (e) { /* ignore */ } resolve(); }
      try { tizen.keymanager.removeData({ name: alias }); } catch (e) { /* not present */ }
      try {
        tizen.keymanager.saveData(alias, secret, null, function () {
          try {
            var back = tizen.keymanager.getData({ name: alias }, null);
            done(back === secret ? 'PASS' : 'FAIL', 'read back ' + (back === secret ? 'matches' : 'differs'));
          } catch (e) { done('FAIL', 'getData threw ' + e.name + ' ' + e.message); }
        }, function (e) { done('FAIL', 'saveData error ' + (e && e.name) + ' ' + (e && e.message)); });
      } catch (e) { done('FAIL', 'saveData threw ' + e.name + ' ' + e.message); }
    });
  }

  function storageTests() {
    return idbTest().then(webSqlTest).then(fsTest).then(keymanagerTest);
  }

  /* ---------------- P7: crypto (PBKDF2-SHA256) ---------------- */
  // Small ES5 SHA-256 / HMAC / PBKDF2 used only to time the JS fallback.
  var K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, withPad = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(withPad), w = new Array(64), i, j;
    m.set(bytes); m[l] = 0x80;
    var bits = l * 8; m[withPad - 4] = (bits >>> 24) & 255; m[withPad - 3] = (bits >>> 16) & 255; m[withPad - 2] = (bits >>> 8) & 255; m[withPad - 1] = bits & 255;
    for (i = 0; i < withPad; i += 64) {
      for (j = 0; j < 16; j++) { w[j] = (m[i + 4 * j] << 24) | (m[i + 4 * j + 1] << 16) | (m[i + 4 * j + 2] << 8) | m[i + 4 * j + 3]; }
      for (j = 16; j < 64; j++) {
        var a0 = w[j - 15], a1 = w[j - 2];
        var s0 = ((a0 >>> 7) | (a0 << 25)) ^ ((a0 >>> 18) | (a0 << 14)) ^ (a0 >>> 3);
        var s1 = ((a1 >>> 17) | (a1 << 15)) ^ ((a1 >>> 19) | (a1 << 13)) ^ (a1 >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (j = 0; j < 64; j++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[j] + w[j]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[4 * i] = h[i] >>> 24; out[4 * i + 1] = (h[i] >>> 16) & 255; out[4 * i + 2] = (h[i] >>> 8) & 255; out[4 * i + 3] = h[i] & 255; }
    return out;
  }
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
  function hmac(key, msg) {
    if (key.length > 64) { key = sha256(key); }
    var k = new Uint8Array(64), ipad = new Uint8Array(64), opad = new Uint8Array(64), i;
    k.set(key);
    for (i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
    return sha256(concat(opad, sha256(concat(ipad, msg))));
  }
  function pbkdf2(pw, salt, iter) {
    var u = hmac(pw, concat(salt, new Uint8Array([0, 0, 0, 1]))), t = new Uint8Array(u), i, j;
    for (i = 1; i < iter; i++) { u = hmac(pw, u); for (j = 0; j < 32; j++) { t[j] ^= u[j]; } }
    return t;
  }
  function ascii(s) { var o = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) { o[i] = s.charCodeAt(i) & 255; } return o; }
  function hex(b) { var s = ''; for (var i = 0; i < b.length; i++) { s += (b[i] < 16 ? '0' : '') + b[i].toString(16); } return s; }

  function cryptoTests() {
    var L = R.crypto;
    var vec = hex(pbkdf2(ascii('password'), ascii('salt'), 1));
    rec(L, 'JS PBKDF2-SHA256 test vector (c=1)', vec === '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b' ? 'PASS' : 'FAIL', vec);
    var t = now(); pbkdf2(ascii('1234'), ascii('0123456789abcdef'), 1000);
    rec(L, 'JS PBKDF2 1,000 iterations', 'PASS', Math.round(now() - t) + ' ms');
    t = now(); pbkdf2(ascii('1234'), ascii('0123456789abcdef'), 10000);
    rec(L, 'JS PBKDF2 10,000 iterations', 'PASS', Math.round(now() - t) + ' ms');
    var subtle = window.crypto && (crypto.subtle || crypto.webkitSubtle);
    if (!subtle) { rec(L, 'WebCrypto PBKDF2', 'FAIL', 'no subtle'); return Promise.resolve(); }
    return new Promise(function (resolve) {
      var t0 = now(), p;
      try {
        p = subtle.importKey('raw', ascii('password'), { name: 'PBKDF2' }, false, ['deriveBits']);
      } catch (e) { rec(L, 'WebCrypto PBKDF2', 'FAIL', 'importKey threw ' + e.message); resolve(); return; }
      if (!p || typeof p.then !== 'function') { rec(L, 'WebCrypto PBKDF2', 'FAIL', 'importKey not promise-based'); resolve(); return; }
      p.then(function (key) {
        return subtle.deriveBits({ name: 'PBKDF2', salt: ascii('salt'), iterations: 10000, hash: 'SHA-256' }, key, 256);
      }).then(function () {
        rec(L, 'WebCrypto PBKDF2 10,000 iterations', 'PASS', Math.round(now() - t0) + ' ms'); resolve();
      }, function (e) { rec(L, 'WebCrypto PBKDF2', 'FAIL', (e && e.name) + ' ' + (e && e.message)); resolve(); });
    });
  }

  /* ---------------- P8: remote images over HTTP ---------------- */
  function imageTests() {
    var host = document.getElementById('imgs'), total = 100, conc = 4, started = 0, ok = 0, bad = 0, t0 = now();
    return new Promise(function (resolve) {
      function next() {
        if (started >= total) { if (ok + bad === total) { finish(); } return; }
        var i = started++, img = new Image();
        img.onload = function () { ok++; next(); };
        img.onerror = function () { bad++; next(); };
        img.src = PC + '/img/logo.png?i=' + i + '&t=' + Date.now();
        host.appendChild(img);
      }
      function finish() {
        rec(R.images, '100 HTTP images, 4 concurrent', bad === 0 ? 'PASS' : 'FAIL', ok + ' ok, ' + bad + ' failed, ' + Math.round(now() - t0) + ' ms, ' + mem());
        while (host.firstChild) { host.removeChild(host.firstChild); }
        resolve();
      }
      for (var c = 0; c < conc; c++) { next(); }
    });
  }

  /* ---------------- P1-P4: AVPlay ---------------- */
  var M = PC + '/media/', LV = PC + '/live/';
  var STREAMS = [
    { name: 'VOD MP4 H.264/AAC over HTTP', url: M + 'h264_aac.mp4', seek: 30000, aspect: true },
    { name: 'VOD TS file H.264/AAC over HTTP', url: M + 'h264_aac.ts', seek: 30000 },
    { name: 'VOD TS file H.264/MP2 audio', url: M + 'h264_mp2.ts', seek: 30000 },
    { name: 'VOD MP4 H.264/AC3', url: M + 'h264_ac3.mp4', seek: 30000 },
    { name: 'VOD MP4 H.264/E-AC3', url: M + 'h264_eac3.mp4', seek: 30000 },
    { name: 'VOD TS H.264/AC3', url: M + 'h264_ac3.ts', seek: 30000 },
    { name: 'VOD MKV H.264/AAC', url: M + 'h264_aac.mkv', seek: 30000 },
    { name: 'VOD MP4 HEVC/AAC', url: M + 'hevc_aac.mp4', seek: 30000 },
    { name: 'VOD TS HEVC/AAC', url: M + 'hevc_aac.ts', seek: 30000 },
    { name: 'VOD MKV HEVC/AAC', url: M + 'hevc_aac.mkv', seek: 30000 },
    { name: 'VOD HLS over plain HTTP', url: M + 'hls/index.m3u8', seek: 30000 },
    { name: 'LIVE continuous MPEG-TS H.264/AAC over HTTP', url: LV + 'h264_aac.ts', live: true, preview: true },
    { name: 'LIVE continuous MPEG-TS H.264/MP2', url: LV + 'h264_mp2.ts', live: true },
    { name: 'LIVE continuous MPEG-TS H.264/AC3', url: LV + 'h264_ac3.ts', live: true },
    { name: 'LIVE continuous MPEG-TS HEVC/AAC', url: LV + 'hevc_aac.ts', live: true },
    { name: 'LIVE HLS over plain HTTP (rolling)', url: PC + '/livehls/index.m3u8', live: true },
    { name: 'ERROR: HTTP 404 on .ts', url: LV + 'does_not_exist.ts', expectError: true },
    { name: 'ERROR: connection refused', url: 'http://192.168.1.180:8097/x.ts', expectError: true }
  ];

  function avOne(s) {
    var av = webapis.avplay, out = { name: s.name, url: s.url, steps: {}, events: [], errors: [], tracks: null, firstTimeMs: null };
    function step(k, v) { out.steps[k] = v; log('  ' + k + ': ' + v); }
    function st() { try { return av.getState(); } catch (e) { return 'state-threw'; } }
    function cur() { try { return av.getCurrentTime(); } catch (e) { return -1; } }
    return new Promise(function (resolve) {
      var t0 = now(), finished = false, guard;
      function finish() {
        if (finished) { return; } finished = true; clearTimeout(guard);
        try { av.stop(); step('stop', 'PASS ' + st()); } catch (e) { step('stop', 'FAIL ' + e.name); }
        try { av.close(); step('close', 'PASS ' + st()); } catch (e) { step('close', 'FAIL ' + e.name); }
        out.totalMs = Math.round(now() - t0);
        resolve(out);
      }
      try { av.open(s.url); step('open', 'PASS'); } catch (e) { step('open', 'FAIL ' + e.name + ' ' + e.message); finish(); return; }
      try {
        av.setListener({
          onbufferingstart: function () { out.events.push('bufstart@' + Math.round(now() - t0)); },
          onbufferingcomplete: function () { out.events.push('bufdone@' + Math.round(now() - t0)); },
          onstreamcompleted: function () { out.events.push('completed'); },
          oncurrentplaytime: function (t) { if (out.firstTimeMs === null && t > 0) { out.firstTimeMs = Math.round(now() - t0); } },
          onevent: function (type, data) { out.events.push('event ' + type + ' ' + String(data).substring(0, 60)); },
          onerror: function (type) { out.errors.push('onerror ' + type + ' @' + Math.round(now() - t0)); log('  onerror ' + type); },
          onsubtitlechange: function () { /* not tested here */ }
        });
      } catch (e) { step('setListener', 'FAIL ' + e.message); }
      try { if (s.preview) { av.setDisplayRect(1300, 100, 560, 315); } else { av.setDisplayRect(960, 0, 960, 540); } } catch (e) { step('setDisplayRect', 'FAIL ' + e.message); }
      guard = setTimeout(function () { step('prepareAsync', 'FAIL watchdog 20 s'); finish(); }, 20000);
      try {
        av.prepareAsync(function () {
          if (finished) { return; }
          clearTimeout(guard);
          step('prepareAsync', 'PASS ' + Math.round(now() - t0) + ' ms');
          try { step('duration', av.getDuration() + ' ms'); } catch (e) { step('duration', 'FAIL ' + e.message); }
          try {
            var tr = av.getTotalTrackInfo(), list = [];
            for (var i = 0; i < tr.length; i++) { list.push({ type: tr[i].type, extra: String(tr[i].extra_info).substring(0, 200) }); }
            out.tracks = list;
          } catch (e) { step('tracks', 'FAIL ' + e.message); }
          try { var info = av.getCurrentStreamInfo(); out.streamInfo = []; for (var k = 0; k < info.length; k++) { out.streamInfo.push(info[k].type + ' ' + String(info[k].extra_info).substring(0, 200)); } } catch (e) { out.streamInfo = 'n/a ' + e.message; }
          var p0;
          try { av.play(); p0 = cur(); step('play', 'PASS'); } catch (e) { step('play', 'FAIL ' + e.message); finish(); return; }
          delay(7000).then(function () {
            var p = cur();
            step('advances', (p > p0 + 3000 ? 'PASS' : 'FAIL') + ' ' + p0 + ' -> ' + p + ' ms');
            if (s.aspect) {
              var modes = ['PLAYER_DISPLAY_MODE_LETTER_BOX', 'PLAYER_DISPLAY_MODE_FULL_SCREEN', 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO'];
              var chain = Promise.resolve();
              modes.forEach(function (m) {
                chain = chain.then(function () {
                  try { av.setDisplayMethod(m); step('setDisplayMethod ' + m, 'PASS'); } catch (e) { step('setDisplayMethod ' + m, 'FAIL ' + e.name + ' ' + e.message); }
                  return delay(2000);
                });
              });
              return chain;
            }
          }).then(function () {
            if (!s.seek) { return delay(3000); }
            return new Promise(function (res) {
              var ts = now();
              try { av.seekTo(s.seek, function () { step('seekTo', 'PASS ' + Math.round(now() - ts) + ' ms -> ' + cur()); res(); }, function (e) { step('seekTo', 'FAIL ' + (e && e.name)); res(); }); }
              catch (e) { step('seekTo', 'FAIL threw ' + e.message); res(); }
              setTimeout(res, 10000);
            }).then(function () { return delay(3000); });
          }).then(finish);
        }, function (e) {
          if (finished) { return; }
          clearTimeout(guard);
          step('prepareAsync', 'FAIL ' + (e && e.name) + ' after ' + Math.round(now() - t0) + ' ms');
          finish();
        });
      } catch (e) { step('prepareAsync', 'FAIL threw ' + e.message); finish(); }
    });
  }

  // Zap timing between two live TS channels: open -> first playback time > 0.
  function zapTest(urls, label, bufSec) {
    urls = urls || [LV + 'h264_aac.ts', LV + 'h264_mp2.ts', LV + 'h264_aac.ts', LV + 'h264_mp2.ts'];
    label = label || 'LIVE zap: open to first frame (4 zaps)';
    var av = webapis.avplay, times = [], i = 0, bufNote = '';
    function one(url) {
      return new Promise(function (resolve) {
        var t0 = now(), done = false;
        function end(v) { if (done) { return; } done = true; times.push(v); try { av.stop(); } catch (e) { /* ignore */ } try { av.close(); } catch (e2) { /* ignore */ } resolve(); }
        try {
          av.open(url);
          av.setDisplayRect(960, 0, 960, 540);
          av.setListener({ oncurrentplaytime: function (t) { if (t > 0) { end(Math.round(now() - t0)); } }, onerror: function (type) { end('error ' + type); } });
          if (bufSec) {
            try {
              av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', bufSec);
              av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', bufSec);
              bufNote = 'setBufferingParam ' + bufSec + ' s accepted';
            } catch (e) { bufNote = 'setBufferingParam threw ' + e.name + ' ' + e.message; }
          }
          av.prepareAsync(function () { try { av.play(); } catch (e) { end('play threw'); } }, function (e) { end('prepare fail ' + (e && e.name)); });
          setTimeout(function () { end('timeout 20 s'); }, 20000);
        } catch (e) { end('threw ' + e.message); }
      });
    }
    function next() {
      if (i >= urls.length) {
        rec(R.avplay, label, times.every(function (t) { return typeof t === 'number'; }) ? 'PASS' : 'FAIL', times.join(', ') + ' ms' + (bufNote ? ' | ' + bufNote : ''));
        return Promise.resolve();
      }
      return one(urls[i++]).then(function () { return delay(500); }).then(next);
    }
    return next();
  }

  function avTests() {
    if (!window.webapis || !webapis.avplay) { rec(R.avplay, 'webapis.avplay', 'FAIL', 'missing'); return Promise.resolve(); }
    var i = 0;
    function next() {
      if (i >= STREAMS.length) { return zapTest(); }
      var s = STREAMS[i++];
      phase('AVPlay ' + i + '/' + STREAMS.length + ': ' + s.name);
      return avOne(s).then(function (out) {
        R.avruns.push(out);
        var prep = out.steps.prepareAsync || '', adv = out.steps.advances || '';
        if (s.expectError) {
          var clean = out.errors.length > 0 || prep.indexOf('FAIL') === 0 && prep.indexOf('watchdog') < 0;
          rec(R.avplay, s.name, clean ? 'PASS' : 'FAIL', (clean ? 'clean error: ' : 'no clean error: ') + prep + ' ' + out.errors.join(' '));
        } else {
          rec(R.avplay, s.name, adv.indexOf('PASS') === 0 ? 'PASS' : 'FAIL', prep + ' | ' + adv + (out.firstTimeMs !== null ? ' | first frame ' + out.firstTimeMs + ' ms' : '') + ' | errors ' + out.errors.length);
        }
        updateSummary();
        post('avplay-progress');
        return delay(1500).then(next);
      });
    }
    return next();
  }

  /* ---------------- storage quota (5 MB steps, own transaction per step) ---------------- */
  var STEP = 50, MAX_STEPS = 16; // 50 x 100 KB = 5 MB per step, up to 80 MB
  function idbQuota() {
    var idb = window.indexedDB || window.webkitIndexedDB;
    return new Promise(function (resolve) {
      var req = idb.open('ssquota', 1), stored = 0, step = 0, t0 = now();
      req.onupgradeneeded = function () { req.result.createObjectStore('c'); };
      req.onerror = function () { rec(R.storage, 'IndexedDB quota', 'FAIL', 'open error'); resolve(); };
      req.onsuccess = function () {
        var db = req.result;
        function finish(reason) {
          var tr = now(), total = 0, rtx = db.transaction(['c'], 'readonly'), cur = rtx.objectStore('c').openCursor();
          cur.onsuccess = function (ev) { var c = ev.target.result; if (c) { total += c.value.length; c['continue'](); } };
          rtx.oncomplete = function () {
            rec(R.storage, 'IndexedDB quota', stored > 0 ? 'PASS' : 'FAIL', 'stored ' + (stored / 1048576).toFixed(0) + ' MB of chars before: ' + reason + '; cursor read ' + (total / 1048576).toFixed(0) + ' MB in ' + Math.round(now() - tr) + ' ms; write total ' + Math.round(now() - t0) + ' ms');
            db.close(); try { idb.deleteDatabase('ssquota'); } catch (e) { /* ignore */ } resolve();
          };
        }
        function next() {
          if (step >= MAX_STEPS) { finish('cap reached'); return; }
          var tx = db.transaction(['c'], 'readwrite'), st = tx.objectStore('c');
          for (var i = 0; i < STEP; i++) { st.put(CHUNK, 's' + step + '_' + i); }
          tx.oncomplete = function () { stored += STEP * CHUNK.length; step++; log('  idb ' + (stored / 1048576).toFixed(0) + ' MB'); next(); };
          tx.onabort = function () { finish('abort ' + (tx.error && tx.error.name)); };
        }
        next();
      };
    });
  }
  function sqlQuota() {
    return new Promise(function (resolve) {
      var db, stored = 0, step = 0;
      try { db = openDatabase('ssquota', '1.0', 'quota', 100 * 1024 * 1024); } catch (e) { rec(R.storage, 'WebSQL quota', 'FAIL', 'open threw ' + e.message); resolve(); return; }
      function finish(reason) {
        rec(R.storage, 'WebSQL quota', stored > 0 ? 'PASS' : 'FAIL', 'stored ' + (stored / 1048576).toFixed(0) + ' MB of chars before: ' + reason);
        db.transaction(function (tx) { tx.executeSql('DROP TABLE IF EXISTS q'); }, function () { resolve(); }, function () { resolve(); });
      }
      db.transaction(function (tx) { tx.executeSql('DROP TABLE IF EXISTS q'); tx.executeSql('CREATE TABLE q (k TEXT, v TEXT)'); }, function (e) { finish('create ' + e.message); }, next);
      function next() {
        if (step >= MAX_STEPS) { finish('cap reached'); return; }
        db.transaction(function (tx) { for (var i = 0; i < STEP; i++) { tx.executeSql('INSERT INTO q (k, v) VALUES (?, ?)', ['s' + step + '_' + i, CHUNK]); } },
          function (e) { finish('error ' + (e && e.message)); },
          function () { stored += STEP * CHUNK.length; step++; log('  sql ' + (stored / 1048576).toFixed(0) + ' MB'); next(); });
      }
    });
  }
  function quotaTests() { R.meta.memoryBeforeQuota = mem(); return idbQuota().then(sqlQuota); }
  function zap2Tests() {
    var L2 = PC + '/live2/';
    var u = [L2 + 'h264_aac.ts', L2 + 'h264_mp2.ts', L2 + 'h264_aac.ts', L2 + 'h264_mp2.ts'];
    return zapTest(u, 'LIVE zap, already-running streams, default buffer')
      .then(function () { return zapTest(u, 'LIVE zap, already-running streams, buffer 1 s', 1); })
      .then(function () { return zapTest(u, 'LIVE zap, already-running streams, buffer 2 s', 2); });
  }

  /* ---------------- P9/P10: manual keys and IME ---------------- */
  function manualSetup() {
    var K = R.manual, input = document.getElementById('ime'), stateEl = document.getElementById('manualstate');
    try { tizen.tvinputdevice.registerKey('ChannelUp'); tizen.tvinputdevice.registerKey('ChannelDown'); K.registered = 'ok'; } catch (e) { K.registered = 'FAIL ' + e.message; }
    function ev(type, extra) { var o = { type: type, t: Math.round(now()) }; for (var k in extra) { if (extra.hasOwnProperty(k)) { o[k] = extra[k]; } } K.events.push(o); if (K.events.length > 300) { K.events.shift(); } }
    document.addEventListener('keydown', function (e) {
      ev('keydown', { code: e.keyCode, target: e.target && e.target.id || e.target.tagName });
      if (e.keyCode === 427) { stateEl.textContent = 'CH+ received (427)'; }
      if (e.keyCode === 428) { stateEl.textContent = 'CH- received (428)'; }
      if (e.keyCode === 13 && document.activeElement !== input) { input.focus(); e.preventDefault(); }
      if (e.keyCode === 10009) { e.preventDefault(); if (document.activeElement === input) { input.blur(); } }
    });
    input.addEventListener('focus', function () { ev('focus', {}); });
    input.addEventListener('blur', function () { ev('blur', { value: input.value }); stateEl.textContent = 'text field value: "' + input.value + '"'; });
    input.addEventListener('input', function () { ev('input', { value: input.value }); });
    input.addEventListener('change', function () { ev('change', { value: input.value }); });
    var last = 0;
    setInterval(function () { if (K.events.length !== last) { last = K.events.length; post('manual'); } }, 3000);
    document.getElementById('manual').className = '';
  }

  /* ---------------- command polling ---------------- */
  var busy = false;
  function poll() {
    var x = new XMLHttpRequest();
    x.onload = function () {
      var cmd = String(x.responseText || '');
      if (cmd === 'avplay' && !busy) { busy = true; run('avplay', avTests)().then(function () { busy = false; phase('avplay done'); post('avplay'); }); }
      else if (cmd === 'quota' && !busy) { busy = true; run('quota', quotaTests)().then(function () { busy = false; phase('quota done'); post('quota'); }); }
      else if (cmd === 'zap2' && !busy) { busy = true; run('zap2', zap2Tests)().then(function () { busy = false; phase('zap2 done'); post('zap2'); }); }
      else if (cmd === 'report') { post('report'); }
      else if (cmd === 'exit') { post('exit'); setTimeout(function () { tizen.application.getCurrentApplication().exit(); }, 500); }
    };
    x.onloadend = function () { setTimeout(poll, 2000); };
    try { x.open('GET', PC + '/cmd', true); x.timeout = 4000; x.send(); } catch (e) { setTimeout(poll, 2000); }
  }

  window.addEventListener('load', function () {
    post('start');
    poll();
    manualSetup();
    Promise.resolve()
      .then(run('features', featureTests))
      .then(run('crypto', cryptoTests))
      .then(run('images', imageTests))
      .then(run('storage', storageTests))
      .then(run('xhr', xhrTests))
      .then(function () { phase('base tests done; waiting for PC (avplay)'); post('base'); });
  });
})();
