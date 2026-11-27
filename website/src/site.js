// EliteStream website: the only JavaScript. Mobile menu, FAQ topics and answers, and old
// prototype links (#/features) to the real page URLs. No storage, cookies or tracking.
(function () {
  'use strict';
  var PAGES = ['features', 'platforms', 'ai', 'screenshots', 'downloads', 'support', 'about'];

  // Prototype hash routes → real pages (only known page names; anything else is ignored).
  var m = /^#\/([a-z]*)$/.exec(location.hash || '');
  if (m) {
    var target = m[1] === '' ? '/' : PAGES.indexOf(m[1]) >= 0 ? '/' + m[1] + '/' : null;
    if (target && target !== location.pathname) { location.replace(target); return; }
  }

  function ready(fn) {
    if (document.readyState !== 'loading') { fn(); } else { document.addEventListener('DOMContentLoaded', fn); }
  }

  ready(function () {
    // Mobile menu (below 1000 px): ≡ opens, ✕ closes, as in the design.
    var btn = document.querySelector('.es-menu-btn');
    var menu = document.getElementById('es-mobile');
    if (btn && menu) {
      btn.addEventListener('click', function () {
        var open = menu.hidden;
        menu.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? '✕' : '≡';
      });
    }

    // FAQ: one topic at a time; one open answer per topic (the first when a topic is chosen).
    var topics = document.querySelectorAll('.faq-nav button');
    function setOpen(group, index) {
      var qs = group.querySelectorAll('.faq-q');
      for (var j = 0; j < qs.length; j++) {
        var b = qs[j].querySelector('button');
        var a = qs[j].querySelector('p');
        var on = j === index;
        b.setAttribute('aria-expanded', on ? 'true' : 'false');
        b.lastElementChild.textContent = on ? '−' : '+';
        a.hidden = !on;
      }
    }
    for (var i = 0; i < topics.length; i++) {
      topics[i].addEventListener('click', function () {
        var g = this.getAttribute('data-group');
        for (var k = 0; k < topics.length; k++) {
          var sel = topics[k] === this;
          topics[k].setAttribute('aria-pressed', sel ? 'true' : 'false');
          var grp = document.getElementById('faq-g' + topics[k].getAttribute('data-group'));
          if (grp) { grp.hidden = !sel; }
        }
        var group = document.getElementById('faq-g' + g);
        if (group) { setOpen(group, 0); }
      });
    }
    var groups = document.querySelectorAll('.faq-group');
    for (var n = 0; n < groups.length; n++) {
      (function (group) {
        var qs = group.querySelectorAll('.faq-q button');
        for (var q = 0; q < qs.length; q++) {
          (function (idx) {
            qs[idx].addEventListener('click', function () {
              setOpen(group, this.getAttribute('aria-expanded') === 'true' ? -1 : idx);
            });
          })(q);
        }
      })(groups[n]);
    }
  });
})();
