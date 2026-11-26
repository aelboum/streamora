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
import type { EngineErrorCode, EngineEvent, EngineState, LoadOptions, MediaTrack, PlaybackEngine } from './engine.ts';
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
  seekTo?(ms: number, ok?: () => void, err?: (e: unknown) => void): void;
  jumpForward?(ms: number, ok?: () => void, err?: (e: unknown) => void): void;
  jumpBackward?(ms: number, ok?: () => void, err?: (e: unknown) => void): void;
  setListener(l: Record<string, unknown>): void;
  setDisplayRect(x: number, y: number, w: number, h: number): void;
  setBufferingParam(a: string, b: string, v: number): void;
  setStreamingProperty?(name: string, value: string): void;
  getTotalTrackInfo?(): AvTrack[];
  getCurrentStreamInfo?(): AvTrack[];
  setSelectTrack?(type: string, index: number): void;
  setSilentSubtitle?(silent: boolean): void;
  suspend(): void;
  restore(): void;
}

interface AvTrack { type: string; index: number; extra_info?: string }

/** extra_info is a JSON string (audio: language, channels, fourCC; text: track_lang, subtitle_type). */
function parseExtra(x: unknown): Record<string, unknown> {
  if (typeof x !== 'string' || !x) { return {}; }
  try {
    const o = JSON.parse(x) as unknown;
    return o && typeof o === 'object' ? o as Record<string, unknown> : {};
  } catch (e) { return {}; }
}

function channelLabel(c: unknown): string {
  const n = +(c as number) || 0;
  return n >= 6 ? '5.1' : n === 2 ? 'Stereo' : n === 1 ? 'Mono' : '';
}

/** AVPlay track lists → MediaTrack (exported for tests). textId: the app's subtitle choice (−1 off). */
export function mapAvTracks(all: AvTrack[], current: AvTrack[], textId: number): MediaTrack[] {
  let audioSel = -1;
  for (let i = 0; i < current.length; i++) {
    if (current[i] && current[i].type === 'AUDIO') { audioSel = +current[i].index; }
  }
  const out: MediaTrack[] = [];
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (!t || (t.type !== 'AUDIO' && t.type !== 'TEXT')) { continue; }
    const ex = parseExtra(t.extra_info);
    const audio = t.type === 'AUDIO';
    const lang = String((audio ? ex.language : ex.track_lang) || '').replace(/[^A-Za-z-]/g, '').slice(0, 12);
    const parts: string[] = [];
    if (audio) {
      const ch = channelLabel(ex.channels);
      if (ch) { parts.push(ch); }
      if (ex.fourCC) { parts.push(String(ex.fourCC).replace(/[^A-Za-z0-9-]/g, '').slice(0, 12)); }
    }
    const tr: MediaTrack = { kind: audio ? 'audio' : 'text', id: +t.index, language: lang, label: parts.join(' · '), selected: audio ? +t.index === audioSel : +t.index === textId };
    // Stage 7E (TV): AVPlay cuts languages to two letters ("tu" = tur, "du" = dut); 'un' = und.
    if (lang.length === 2) { tr.langExact = false; }
    if (audio) {
      const n = function (v: unknown): number { const x = Math.floor(+(v as number)); return x > 0 && x < 1e9 ? x : 0; };
      tr.channels = n(ex.channels);
      tr.sampleRate = n(ex.sample_rate);
      tr.bitrate = n(ex.bit_rate);
      // AVPlay's "mpeg" covers AAC and MPEG audio alike, so only the unambiguous ones are named.
      const fc = String(ex.fourCC || '').toLowerCase();
      tr.codec = fc === 'ac3' || fc === 'eac3' || fc === 'dts' ? fc : '';
    }
    out.push(tr);
  }
  return out;
}

/** A seek without any answer for this long (and not at its target) means the title cannot seek. */
export const SEEK_STUCK_MS = 10000;

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
  let textId = -1; // subtitles start off; the player screen may pick a track
  let tracksLogged = -1;
  let seekBroken = false; // this title cannot be seeked (see seek())
  let seekBusy = false; // a seekTo is running (AVPlay drops overlapping ones)
  let seekQueued = -1; // latest target asked for while busy
  let seekGen = 0; // invalidates the callbacks of a seek that was cancelled (stop / new load)
  let lastTracks: MediaTrack[] = [];
  let cueTimer: ReturnType<typeof setTimeout> | null = null;

  function currentMs(): number {
    try { return player.getCurrentTime ? +player.getCurrentTime() || 0 : 0; } catch (e) { return 0; }
  }

  function startSeek(to: number): void {
    const my = session;
    const g = ++seekGen;
    const ts = Date.now();
    const from = currentMs();
    let answered = false;
    seekBusy = true;
    function next(): void {
      if (g !== seekGen) { return; }
      seekBusy = false;
      if (my !== session || seekBroken) { seekQueued = -1; return; }
      if (seekQueued >= 0) { const n = seekQueued; seekQueued = -1; startSeek(n); }
    }
    function broken(reason: string, data: Record<string, unknown>): void {
      if (g !== seekGen || my !== session) { return; }
      seekBroken = true;
      seekQueued = -1;
      seekBusy = false;
      if (log) { data.sid = my; data.toMs = to; data.fromMs = from; log.warn('avplay: ' + reason, data); }
      emit({ type: 'seek-failed' });
    }
    try {
      (player.seekTo as (ms: number, ok: () => void, err: (e: unknown) => void) => void).call(player, to, function () {
        if (answered) { return; }
        answered = true;
        if (log) { log.info('avplay: seek done', { sid: my, toMs: to, ms: Date.now() - ts }); }
        next();
      }, function (e: unknown) {
        if (answered) { return; }
        answered = true;
        broken('seek failed', { name: String(e && (e as { name?: string }).name) });
      });
    } catch (e) {
      answered = true;
      broken('seek threw', { error: String(e).slice(0, 160) });
      return;
    }
    setTimeout(function () {
      if (answered || g !== seekGen || my !== session) { return; }
      const now = currentMs();
      if (Math.abs(now - to) < 5000) {
        // Reached without a callback: fine, carry on with any queued target.
        answered = true;
        if (log) { log.info('avplay: seek reached without callback', { sid: my, toMs: to, nowMs: now }); }
        next();
        return;
      }
      answered = true;
      broken('seek no answer', { nowMs: now, waitedMs: Date.now() - ts });
    }, SEEK_STUCK_MS);
  }

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
    if (cueTimer !== null) { clearTimeout(cueTimer); cueTimer = null; }
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
      seekBroken = false;
      seekBusy = false;
      seekQueued = -1;
      seekGen++;
      lastTracks = [];
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
            // Embedded subtitles: AVPlay hands over the cue text and its duration; the app draws it.
            onsubtitlechange: function (duration: unknown, text: unknown) {
              if (log && my === session) { log.info('avplay: subtitle cue', { sid: my, on: textId >= 0, chars: String(text || '').length, durationMs: +(duration as number) || 0 }); }
              if (my !== session || textId < 0) { return; }
              if (cueTimer !== null) { clearTimeout(cueTimer); cueTimer = null; }
              emit({ type: 'subtitle', text: String(text || '') });
              const ms = +(duration as number) || 0;
              if (ms > 0) {
                cueTimer = setTimeout(function () { cueTimer = null; if (my === session) { emit({ type: 'subtitle', text: '' }); } }, Math.min(ms, 15000));
              }
            }
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
          const startPlay = function (): void {
            if (my !== session || settled) {
              return;
            }
            try {
              player.play();
            } catch (e) {
              fail('unknown');
              return;
            }
            settled = true;
            textId = -1;
            if (typeof player.setSilentSubtitle === 'function') {
              try { player.setSilentSubtitle(true); } catch (e) { /* no subtitle support */ }
            }
            resolve();
            if (!src.live) { emit({ type: 'tracks' }); } // track choice is a VOD feature (Stage 7B.2)
          };
          player.prepareAsync(function () {
            trace('prepared', { sid: my, current: session, settled: settled });
            if (my !== session || settled) {
              return;
            }
            prepared = true;
            const start = opts.startMs && opts.startMs > 0 && typeof player.seekTo === 'function' ? Math.floor(opts.startMs) : 0;
            if (start <= 0) {
              startPlay();
              return;
            }
            // Stage 7B.2: seek in the READY state, before play.
            let went = false;
            const t1 = Date.now();
            const go = function (how: string): void {
              if (went || my !== session) { return; }
              went = true;
              if (log) { log.info('avplay: start-at ' + how, { sid: my, toMs: start, ms: Date.now() - t1 }); }
              if (how !== 'done') { seekBroken = true; }
              startPlay();
              // From the start instead: the controller and the player screen say so.
              if (how !== 'done') { emit({ type: 'seek-failed' }); }
            };
            try {
              (player.seekTo as (ms: number, ok: () => void, err: () => void) => void).call(player, start, function () { go('done'); }, function () { go('failed'); });
            } catch (e) { go('threw'); }
            // TV test (Stage 7B.2): on the user's provider seekTo never answers; give up after 5 s.
            setTimeout(function () { go('timeout'); }, 5000);
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
      seekGen++;
      seekBusy = false;
      seekQueued = -1;
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
    seek: function (ms) {
      // AVPlay seekTo is asynchronous; the next timing() call reports the new position.
      // TV findings (Stage 7B.2 / 7D):
      //   - a seek normally answers in 0.1–3.1 s;
      //   - AVPlay silently DROPS a seekTo issued while another seek is still running, so seeks
      //     are serialised here: one in flight, the latest further target queued;
      //   - an MKV without Cues (seek index) never answers at all and the position stays put.
      // A title is marked not seekable only when a seek gets no answer for SEEK_STUCK_MS and the
      // position did not reach the target; an error callback or a throw also marks it.
      if (typeof player.seekTo !== 'function' || seekBroken) {
        emit({ type: 'seek-failed' });
        return;
      }
      const to = Math.max(0, Math.floor(ms));
      if (seekBusy) {
        seekQueued = to;
        return;
      }
      startSeek(to);
    },
    tracks: function () {
      if (typeof player.getTotalTrackInfo !== 'function') { return []; }
      try {
        const all = player.getTotalTrackInfo() || [];
        const cur = typeof player.getCurrentStreamInfo === 'function' ? player.getCurrentStreamInfo() || [] : [];
        if (log && tracksLogged !== session) {
          // Once per title: the raw track descriptions (codec/language metadata, no URLs) to check the mapping.
          tracksLogged = session;
          const raw: string[] = [];
          for (let i = 0; i < all.length && i < 12; i++) { raw.push(String(all[i].type) + '#' + all[i].index + ' ' + String(all[i].extra_info || '').slice(0, 160)); }
          log.info('avplay: tracks', { sid: session, raw: raw.join(' | ') });
        }
        const mapped = mapAvTracks(all, cur, textId);
        if (mapped.length) { lastTracks = mapped; }
        return mapped.length ? mapped : lastTracks;
      } catch (e) {
        // AVPlay can refuse track queries while a seek runs: keep offering the list seen before.
        return lastTracks;
      }
    },
    selectTrack: function (kind, id) {
      try {
        if (kind === 'audio') {
          if (player.setSelectTrack) { player.setSelectTrack('AUDIO', id); }
        } else if (id < 0) {
          textId = -1;
          if (player.setSilentSubtitle) { player.setSilentSubtitle(true); }
          if (cueTimer !== null) { clearTimeout(cueTimer); cueTimer = null; }
          emit({ type: 'subtitle', text: '' });
        } else {
          if (player.setSelectTrack) { player.setSelectTrack('TEXT', id); }
          if (player.setSilentSubtitle) { player.setSilentSubtitle(false); }
          textId = id;
        }
        trace('track', { sid: session, kind: kind, id: id });
      } catch (e) {
        trace('track failed', { sid: session, kind: kind, name: String(e && (e as { name?: string }).name) });
      }
      emit({ type: 'tracks' });
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
    // CP1: one AVPlay player per app [T]; tracks listed and switched (first 32 only, Stage 7F-E) [T];
    // subtitle cues from the stream [T]; setBufferingParam [T].
    capabilities: function () {
      return { multiDecoder: false, trackSwitching: true, embeddedSubtitles: true, bufferControl: true, maxTracks: 32 };
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
