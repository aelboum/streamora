// Samsung AVPlay engine (ARCHITECTURE.md rev 3 §5.2). The only module that calls webapis.avplay
// (enforced by scripts/lib/compat-rules.mjs PLATFORM_ALLOWED).
//
// Call order verified on the TV in probes 1 and 2:
//   open → setListener → setDisplayRect → setBufferingParam (PLAY + RESUME, seconds) →
//   prepareAsync(success → play, error) ; teardown = try stop, try close (stop may throw).
// Facts used: onerror arrives in place of prepare errors for connection failures (≈ 10 s);
// prepareAsync's error callback may never fire, so the live controller adds a watchdog.
// setStreamingProperty('USER_AGENT', …) is attempted when a channel asks for a user agent; its
// effect on this TV is unverified [A].
// AVPlay renders on the video plane behind the web page: an <object type="application/avplayer">
// marks the hole; the player screen keeps its own layer transparent.
import type { PlaybackSource } from '../models/content.ts';
import type { EngineErrorCode, EngineEvent, EngineState, LoadOptions, PlaybackEngine } from './engine.ts';
import type { Logger } from '../utils/log.ts';

interface AvPlay {
  open(url: string): void;
  close(): void;
  prepareAsync(ok: () => void, err: (e: unknown) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  getState(): string;
  getCurrentTime?(): number;
  getDuration?(): number;
  setListener(l: Record<string, unknown>): void;
  setDisplayRect(x: number, y: number, w: number, h: number): void;
  setBufferingParam(a: string, b: string, v: number): void;
  setStreamingProperty?(name: string, value: string): void;
  suspend(): void;
  restore(): void;
}

export interface AvplayHost {
  webapis?: { avplay?: unknown };
  document: Document;
}

function errorCode(type: unknown): EngineErrorCode {
  const t = String(type || '');
  if (/CONNECTION|NETWORK|TIMEOUT/i.test(t)) {
    return 'connection';
  }
  if (/UNSUPPORTED|CODEC|FORMAT|DRM/i.test(t)) {
    return 'format';
  }
  return 'unknown';
}

/**
 * Returns null when AVPlay is not present (browser, emulator without AVPlay).
 * `log` receives debug-level lifecycle traces (session numbers, AVPlay states, error type names,
 * elapsed times; never URLs) used to diagnose channel-switching problems on the TV (Stage 5.1).
 */
export function createAvplayEngine(host: AvplayHost, log?: Logger): PlaybackEngine | null {
  const apis = host.webapis;
  const av = apis && apis.avplay ? apis.avplay as unknown as AvPlay : null;
  if (!av || typeof av.open !== 'function') {
    return null;
  }
  const player: AvPlay = av;
  const doc = host.document;
  const listeners: Array<(e: EngineEvent) => void> = [];
  let st: EngineState = 'idle';
  let session = 0;
  let rect = { x: 0, y: 0, w: 1920, h: 1080 };
  let obj: HTMLElement | null = null;
  let t0 = 0;

  function avState(): string {
    try { return String(player.getState()); } catch (e) { return 'throws'; }
  }

  function trace(msg: string, data: Record<string, unknown>): void {
    if (log) {
      data.ms = Date.now() - t0;
      log.debug('avplay: ' + msg, data);
    }
  }

  function element(): HTMLElement {
    if (!obj) {
      obj = doc.createElement('object');
      obj.setAttribute('type', 'application/avplayer');
      obj.className = 'ss-video';
      if (doc.body.firstChild) {
        doc.body.insertBefore(obj, doc.body.firstChild);
      } else {
        doc.body.appendChild(obj);
      }
    }
    return obj;
  }

  function place(): void {
    const el = element();
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
  }

  function emit(e: EngineEvent): void {
    const l = listeners.slice();
    for (let i = 0; i < l.length; i++) {
      try { l[i](e); } catch (x) { /* a failing listener never breaks playback */ }
    }
  }

  function teardown(): void {
    const before = log ? avState() : '';
    let stopThrew = false;
    let closeThrew = false;
    try { player.stop(); } catch (e) { stopThrew = true; }
    try { player.close(); } catch (e) { closeThrew = true; }
    if (log && before !== 'NONE') {
      trace('teardown', { sid: session, before: before, stopThrew: stopThrew, closeThrew: closeThrew, after: avState() });
    }
    if (obj) {
      obj.style.width = '0px';
      obj.style.height = '0px';
    }
  }

  return {
    load: function (src: PlaybackSource, opts: LoadOptions) {
      teardown();
      const my = ++session;
      st = 'opening';
      t0 = Date.now();
      trace('open', { sid: my, state: log ? avState() : '' });
      return new Promise<void>(function (resolve, reject) {
        let prepared = false;
        let settled = false;
        let advanced = false;
        function fail(code: EngineErrorCode): void {
          if (my !== session) {
            return;
          }
          st = 'error';
          if (!settled) {
            settled = true;
            reject(code);
          } else {
            emit({ type: 'error', code: code });
          }
        }
        try {
          player.open(src.url);
          player.setListener({
            onbufferingstart: function () {
              trace('buffering start', { sid: my, current: session });
              if (my === session) { emit({ type: 'buffering', percent: 0 }); }
            },
            onbufferingprogress: function (p: number) {
              if (my === session) { emit({ type: 'buffering', percent: Math.max(0, Math.min(100, +p || 0)) }); }
            },
            onbufferingcomplete: function () {
              trace('buffering complete', { sid: my, current: session });
              if (my === session) { emit({ type: 'buffering', percent: 100 }); }
            },
            oncurrentplaytime: function (t: number) {
              if (my === session && !advanced && +t > 0) {
                advanced = true;
                trace('first frame', { sid: my });
                st = 'playing';
                emit({ type: 'playing' });
              }
            },
            onstreamcompleted: function () { if (my === session) { emit({ type: 'ended' }); } },
            onerror: function (type: unknown) {
              trace('onerror', { sid: my, current: session, type: String(type) });
              fail(errorCode(type));
            },
            onevent: function (type: unknown) { trace('onevent', { sid: my, current: session, type: String(type) }); },
            onsubtitlechange: function () { /* Stage 8 */ }
          });
          place();
          player.setDisplayRect(rect.x, rect.y, rect.w, rect.h);
          if (opts.bufferSec > 0) {
            // Live: the measured 2 s buffer. VOD passes 0 and keeps AVPlay's default buffering (Stage 6).
            try {
              player.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', opts.bufferSec);
              player.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', opts.bufferSec);
            } catch (e) { /* accepted on the TV [M]; ignore elsewhere */ }
          }
          if (src.userAgent && typeof player.setStreamingProperty === 'function') {
            try { player.setStreamingProperty('USER_AGENT', src.userAgent); } catch (e) { /* unverified [A] */ }
          }
          player.prepareAsync(function () {
            trace('prepared', { sid: my, current: session, settled: settled });
            if (my !== session || settled) {
              return;
            }
            prepared = true;
            try {
              player.play();
            } catch (e) {
              fail('unknown');
              return;
            }
            settled = true;
            resolve();
          }, function (e: unknown) {
            trace('prepare error', { sid: my, current: session, prepared: prepared, name: String(e && (e as { name?: string }).name) });
            if (!prepared) { fail(errorCode(e && (e as { name?: string }).name)); }
          });
        } catch (e) {
          trace('load threw', { sid: my, name: String(e && (e as { name?: string }).name) });
          fail(errorCode(e && (e as { name?: string }).name));
        }
      });
    },
    pause: function () {
      try { player.pause(); st = 'paused'; } catch (e) { /* not playing */ }
    },
    resume: function () {
      try { player.play(); st = 'playing'; } catch (e) { /* not paused */ }
    },
    stop: function () {
      session++;
      teardown();
      st = 'idle';
    },
    state: function () { return st; },
    setRect: function (x, y, w, h) {
      rect = { x: x, y: y, w: w, h: h };
      if (st !== 'idle') {
        place();
        try { player.setDisplayRect(x, y, w, h); } catch (e) { /* not open */ }
      }
    },
    timing: function () {
      let pos = 0;
      let dur = 0;
      try { pos = player.getCurrentTime ? +player.getCurrentTime() || 0 : 0; } catch (e) { /* not open */ }
      try { dur = player.getDuration ? +player.getDuration() || 0 : 0; } catch (e) { /* not open */ }
      return { positionMs: pos, durationMs: dur };
    },
    suspend: function () { try { player.suspend(); } catch (e) { /* not open */ } },
    restore: function () { try { player.restore(); } catch (e) { /* not open */ } },
    on: function (cb) {
      listeners.push(cb);
      return function () {
        const i = listeners.indexOf(cb);
        if (i >= 0) { listeners.splice(i, 1); }
      };
    },
    destroy: function () {
      session++;
      teardown();
      listeners.length = 0;
      if (obj && obj.parentNode) {
        obj.parentNode.removeChild(obj);
      }
      obj = null;
      st = 'idle';
    }
  };
}
