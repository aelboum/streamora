// EliteStream – EXPERIMENTAL phone pairing test page. Fake keys only.
// The fake key is checked HERE and never sent: the request carries only { id, provider }.
// No storage of any kind is used (no localStorage, sessionStorage or cookies).
(function () {
  'use strict';
  var FAKE_KEY_RE = /^TEST-[A-Z]{2,20}-[0-9]{6}$/;
  var ID_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;
  var id = (location.hash || '').replace(/^#/, '');
  var pid = document.getElementById('pid');
  var key = document.getElementById('key');
  var toggle = document.getElementById('toggle');
  var go = document.getElementById('go');
  var result = document.getElementById('result');
  var provider = document.getElementById('provider');

  function show(text, ok) {
    result.textContent = text;
    result.className = 'result ' + (ok ? 'ok' : 'bad');
  }

  if (ID_RE.test(id)) {
    pid.textContent = id.substring(0, 5) + '-' + id.substring(5);
  } else {
    pid.textContent = 'missing';
    show('No valid pairing ID. Scan the QR code on the TV again.', false);
    go.disabled = true;
  }

  toggle.addEventListener('click', function () {
    var hidden = key.type === 'password';
    key.type = hidden ? 'text' : 'password';
    toggle.textContent = hidden ? 'Hide' : 'Show';
  });

  go.addEventListener('click', function () {
    var v = String(key.value || '').replace(/^\s+|\s+$/g, '');
    if (!v) { show('Enter the fake test key TEST-GEMINI-123456.', false); return; }
    if (/^AIza/.test(v) || /^sk-/.test(v) || v.length >= 30) {
      key.value = '';
      show('This looks like a REAL key. It was cleared and NOT sent. Use the fake test key only.', false);
      return;
    }
    if (!FAKE_KEY_RE.test(v)) { show('Not the test format. Use TEST-GEMINI-123456.', false); return; }
    if (!window.confirm('Send a TEST pairing confirmation to the TV? (The fake key itself is not sent.)')) { return; }
    go.disabled = true;
    show('Contacting the test server…', true);
    var x = new XMLHttpRequest();
    x.open('POST', '/api/phone/confirm', true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () {
      if (x.readyState !== 4) { return; }
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) { r = null; }
      var code = r && r.result;
      if (code === 'confirmed') {
        key.value = '';
        key.type = 'password';
        toggle.textContent = 'Show';
        show('Test pairing confirmed. Check the TV. (No key was transferred.)', true);
        return;
      }
      go.disabled = false;
      var msg = {
        invalid: 'Unknown pairing ID. Scan the QR code again.',
        expired: 'This pairing expired. Choose New code on the TV.',
        used: 'This pairing was already used.',
        cancelled: 'The pairing was cancelled on the TV.',
        'bad-provider': 'Provider not supported in this test.',
        locked: 'Too many failed attempts. Wait 5 minutes.',
        'bad-request': 'The test server refused the request.'
      }[code];
      show(msg || 'The test server is not reachable.', false);
    };
    x.send(JSON.stringify({ id: id, provider: provider.value }));
  });
})();
