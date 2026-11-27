// EXPERIMENTAL QR pairing UI test — TV screen (dev builds only; registered by dev-hooks.ts, which
// release builds replace with a no-op, so none of this is in a release bundle).
// Shows a QR code for the local test page with a random test pairing id, the id as text, a
// 5-minute countdown and the status polled from the local test server (scripts/qr-test-server.mjs).
// Buttons: Cancel (initial focus) · New code. Back = Cancel. On a simulated confirmation from the
// phone the screen says so; no key is transferred, received or stored.
// Isolation: this module receives only a document, an XHR factory, timers, a random source and
// the test server address. It has no access to the key store, AI settings or playlists.
import type { HostLayer, Router, Screen } from '../../navigation/router.ts';
import type { RemoteKeyEvent } from '../../navigation/key-router.ts';
import type { XhrLike } from '../../app/platform/platform.ts';
import { createFocusManager } from '../../navigation/focus.ts';
import { createButtonList } from '../../components/button-list.ts';
import { h } from '../../utils/dom.ts';
import { formatPairingId, newPairingId, PAIRING_TTL_MS, qrPayload } from './protocol.ts';
import { qrDataUri } from './qr-svg.ts';

export const QR_TEST_SCREEN = 'qr-pairing-test';

export interface QrTestDeps {
  doc: Document;
  serverUrl: string;
  xhrFactory: (() => XhrLike) | null;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  randomBytes: (n: number) => number[];
  pollMs?: number;
}

export function createQrTestScreen(d: QrTestDeps, nav: Router): Screen {
  let id = '';
  let started = 0;
  let state: 'waiting' | 'confirmed' | 'expired' | 'cancelled' | 'unreachable' = 'waiting';
  let pollTimer: unknown = null;
  let tickTimer: unknown = null;
  let alive = true;
  // Inline styles: this dev-only screen adds nothing to the production style sheets.
  const img = h(d.doc, 'img', { className: 'ss-qrtest__qr', attrs: { alt: '' } }) as HTMLImageElement;
  img.style.width = '440px';
  img.style.height = '440px';
  img.style.display = 'block';
  img.style.margin = '8px auto 16px auto';
  const idLine = h(d.doc, 'div', { className: 'ss-qrtest__id' });
  idLine.style.fontSize = '44px';
  idLine.style.textAlign = 'center';
  idLine.style.letterSpacing = '0.08em';
  const timeLine = h(d.doc, 'div', { className: 'ss-qrtest__time' });
  timeLine.style.fontSize = '28px';
  timeLine.style.textAlign = 'center';
  const status = h(d.doc, 'div', { className: 'ss-message ss-qrtest__status' });
  const buttons = createButtonList(d.doc, ['Cancel', 'New code'], true);
  const focus = createFocusManager(function (_z, index, focused) { buttons.setFocused(index, focused); });
  focus.register({ id: 'buttons', kind: 'row', size: function () { return buttons.size(); }, neighbours: {}, onSelect: function (i) { if (i === 0) { cancel(); } else { fresh(); } } });

  function stopTimers(): void {
    if (pollTimer !== null) { d.clearTimer(pollTimer); pollTimer = null; }
    if (tickTimer !== null) { d.clearTimer(tickTimer); tickTimer = null; }
  }

  function send(method: 'GET' | 'POST', path: string, done: (ok: boolean, json: { state?: string } | null) => void): void {
    if (!d.xhrFactory) { done(false, null); return; }
    let x: XhrLike;
    let finished = false;
    function end(ok: boolean, json: { state?: string } | null): void { if (!finished) { finished = true; done(ok, json); } }
    try {
      x = d.xhrFactory();
      x.open(method, d.serverUrl + path, true);
      x.onreadystatechange = function () {
        if (x.readyState !== 4) { return; }
        if (x.status < 200 || x.status >= 300) { end(false, null); return; }
        let j: { state?: string } | null = null;
        try { j = JSON.parse(x.responseText || 'null'); } catch (e) { j = null; }
        end(true, j);
      };
      x.onerror = function () { end(false, null); };
      x.send(null);
      d.setTimer(function () { if (!finished) { try { x.abort(); } catch (e) { /* closed */ } end(false, null); } }, 5000);
    } catch (e) {
      end(false, null);
    }
  }

  function render(): void {
    const left = Math.max(0, PAIRING_TTL_MS - (d.now() - started));
    const mm = Math.floor(left / 60000);
    const ss = Math.floor((left % 60000) / 1000);
    timeLine.textContent = state === 'waiting' || state === 'unreachable' ? 'Expires in ' + mm + ':' + (ss < 10 ? '0' : '') + ss : '';
    status.className = 'ss-message ss-qrtest__status' + (state === 'confirmed' ? ' ss-tone--ok' : state === 'waiting' ? '' : ' ss-tone--error');
    status.textContent =
      state === 'waiting' ? 'Waiting for the phone… Scan the code, enter the FAKE test key and press Test pairing.' :
      state === 'confirmed' ? 'Test pairing confirmed from the phone (Gemini). No key was transferred or stored.' :
      state === 'expired' ? 'This code expired. Choose New code.' :
      state === 'cancelled' ? 'Cancelled.' :
      'The local test server is not reachable. Still trying…';
  }

  function poll(): void {
    pollTimer = null;
    if (!alive || state === 'confirmed' || state === 'expired' || state === 'cancelled') { return; }
    const forId = id;
    send('GET', '/api/tv/' + forId, function (ok, json) {
      if (!alive || forId !== id) { return; }
      if (!ok || !json) { state = 'unreachable'; }
      else if (json.state === 'confirmed' || json.state === 'expired' || json.state === 'cancelled' || json.state === 'waiting') { state = json.state; }
      render();
      if (state === 'waiting' || state === 'unreachable') { pollTimer = d.setTimer(poll, d.pollMs || 2000); }
    });
  }

  function tick(): void {
    tickTimer = null;
    if (!alive) { return; }
    if ((state === 'waiting' || state === 'unreachable') && d.now() - started >= PAIRING_TTL_MS) {
      state = 'expired';
      if (pollTimer !== null) { d.clearTimer(pollTimer); pollTimer = null; }
    }
    render();
    if (state === 'waiting' || state === 'unreachable') { tickTimer = d.setTimer(tick, 1000); }
  }

  function fresh(): void {
    stopTimers();
    if (id && (state === 'waiting' || state === 'unreachable')) { send('POST', '/api/tv/' + id + '/cancel', function () { /* best effort */ }); }
    id = newPairingId(d.randomBytes);
    started = d.now();
    state = 'waiting';
    img.setAttribute('src', qrDataUri(qrPayload(d.serverUrl, id)));
    idLine.textContent = 'Pairing ID: ' + formatPairingId(id);
    render();
    poll();
    tickTimer = d.setTimer(tick, 1000);
    focus.focus('buttons', 0);
  }

  /** Ends the pairing at the test server (best effort) and stops polling. */
  function endPairing(): void {
    if (id && (state === 'waiting' || state === 'unreachable')) { send('POST', '/api/tv/' + id + '/cancel', function () { /* best effort */ }); }
    state = 'cancelled';
    stopTimers();
  }

  function cancel(): void {
    endPairing();
    nav.pop();
  }

  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-set ss-qrtest' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [h(d.doc, 'div', { className: 'ss-live__title', text: 'Phone pairing test (experimental)' })]),
        h(d.doc, 'div', { className: 'ss-message ss-tone--error', text: 'EXPERIMENTAL TEST ONLY – NEVER ENTER A REAL API KEY. Nothing is stored on this TV.' }),
        h(d.doc, 'div', { className: 'ss-qrtest__box' }, [img, idLine, timeLine]),
        status, buttons.element
      ]));
      fresh();
    },
    onShow: function () { /* static */ },
    onHide: function () { /* keeps running while an overlay is open */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right') { focus.move(e.key); }
      else if (e.key === 'ok') { focus.select(); }
      return true;
    },
    onBack: function () { endPairing(); return false; }, // the router closes the screen
    destroy: function () { alive = false; stopTimers(); }
  };
}
