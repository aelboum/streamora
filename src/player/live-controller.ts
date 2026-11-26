// LiveController (ARCHITECTURE.md rev 3 §5.3): channel selection and switching on top of a
// PlaybackEngine. No DOM. Rules:
//   - select(ch) shows the channel immediately (state.channel) and stops the old stream; the new
//     stream opens after the zap debounce (400 ms), so rapid presses open only the last channel;
//   - every load gets a generation number; callbacks of an older channel are ignored (cleanup on
//     channel changes);
//   - prepare watchdog (15 s): no picture by then = error 'timeout';
//   - prepare stall (Stage 5.1): when the engine reported buffering (stream data arrives) but has
//     not prepared prepareStallMs (3 s) later, the stream is closed and opened once more, inside
//     the same 15 s limit. Measured on the TV: AVPlay's prepareAsync sometimes never calls back
//     although data arrives and buffering completes, while a normal prepare follows the first
//     buffering report within 0.2–0.42 s (docs/STAGE-5.1-REPORT.md §3). Dead channels report no
//     buffering and are never reopened. One reopen per tune; 0 disables it;
//   - a dead channel (error before the first picture) shows the error; no automatic loop;
//   - a drop during playback is retried at the live edge up to 3 times (2/5/10 s), then error;
//   - pause/resume where the stream allows it;
//   - suspend/restore when the app is hidden/shown.
// Stream URLs come from `resolve` (PlaylistService.resolvePlayback) and are never logged.
import type { Channel, PlaybackSource } from '../models/content.ts';
import type { EngineEvent, PlaybackEngine } from './engine.ts';
import type { Logger } from '../utils/log.ts';

export type LivePhase = 'idle' | 'tuning' | 'loading' | 'buffering' | 'playing' | 'paused' | 'retrying' | 'error';

export type LiveErrorCode = 'unavailable' | 'no-source' | 'timeout' | 'connection' | 'format' | 'unsupported' | 'unknown';

export interface LiveState {
  phase: LivePhase;
  channel: Channel | null;
  bufferPercent: number;
  error: LiveErrorCode | null;
  /** Reconnect attempt (1–3) while retrying. */
  attempt: number;
  /** ms from the start of the load to the first picture (last successful tune). */
  startupMs: number;
  /**
   * The engine is prepared and playing was requested for this tune. AVPlay reports the first
   * position only ~0.5 s after that (TV diagnostics), while the picture may already show.
   */
  ready: boolean;
}

export interface LiveControllerOptions {
  engine: PlaybackEngine | null;
  resolve: (channel: Channel) => Promise<PlaybackSource | null>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  now: () => number;
  bufferSec: number;
  prepareTimeoutMs: number;
  zapDebounceMs: number;
  /**
   * A select() after at least this long without one tunes at once; quicker presses are debounced
   * (zapDebounceMs after the last one), so AVPlay never gets a burst of loads. 0 / absent = always
   * debounce (the Live TV preview).
   */
  zapQuietMs?: number;
  retryDelaysMs: number[];
  /** Reopen once when the engine has not prepared this long after its first buffering report. 0 = off. */
  prepareStallMs?: number;
  log: Logger;
  /** Called once per tune when the picture starts (recently-watched list). */
  onPlaying?: (channel: Channel) => void;
}

export interface LiveController {
  /** Debounced channel change (zapping). */
  select(channel: Channel): void;
  /** Immediate channel change (OK in a list). */
  selectNow(channel: Channel): void;
  retry(): void;
  togglePause(): void;
  stop(): void;
  suspend(): void;
  restore(): void;
  state(): LiveState;
  onChange(cb: (s: LiveState) => void): () => void;
  destroy(): void;
}

export function createLiveController(o: LiveControllerOptions): LiveController {
  const listeners: Array<(s: LiveState) => void> = [];
  let s: LiveState = { phase: 'idle', channel: null, bufferPercent: 0, error: null, attempt: 0, startupMs: 0, ready: false };
  let lastSelectAt = -Infinity;
  let gen = 0;
  let zapTimer: unknown = null;
  let watchdog: unknown = null;
  let retryTimer: unknown = null;
  let stallTimer: unknown = null;
  /** The current load reported buffering (stream data arrives); dead channels never do. */
  let dataSeen = false;
  /** Arms the stall check of the current load on its first buffering report (null = none). */
  let armStall: (() => void) | null = null;
  let loadStarted = 0;
  let pictured = false;
  let suspended = false;
  let off: (() => void) | null = null;

  function emit(): void {
    const snap: LiveState = { phase: s.phase, channel: s.channel, bufferPercent: s.bufferPercent, error: s.error, attempt: s.attempt, startupMs: s.startupMs, ready: s.ready };
    const l = listeners.slice();
    for (let i = 0; i < l.length; i++) {
      try { l[i](snap); } catch (e) { /* listener failure never breaks playback */ }
    }
  }

  function set(p: Partial<LiveState>): void {
    for (const k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k)) {
        (s as unknown as Record<string, unknown>)[k] = (p as Record<string, unknown>)[k];
      }
    }
    emit();
  }

  function clear(t: unknown): null {
    if (t !== null) {
      o.clearTimer(t);
    }
    return null;
  }

  function clearAll(): void {
    zapTimer = clear(zapTimer);
    watchdog = clear(watchdog);
    retryTimer = clear(retryTimer);
    stallTimer = clear(stallTimer);
    armStall = null;
  }

  function fail(code: LiveErrorCode, my: number): void {
    if (my !== gen) {
      return;
    }
    clearAll();
    if (o.engine) {
      o.engine.stop();
    }
    if (pictured && s.attempt < o.retryDelaysMs.length && code !== 'no-source' && code !== 'unavailable') {
      // Drop during playback: reconnect at the live edge with back-off.
      const attempt = s.attempt + 1;
      const delay = o.retryDelaysMs[attempt - 1];
      o.log.warn('live: stream dropped; reconnecting', { channel: s.channel ? s.channel.id : '', attempt: attempt, delayMs: delay, code: code });
      set({ phase: 'retrying', attempt: attempt, error: code });
      const ch = s.channel;
      retryTimer = o.setTimer(function () {
        retryTimer = null;
        if (ch && my === gen) {
          start(ch, attempt, true);
        }
      }, delay);
      return;
    }
    o.log.warn('live: channel failed', { channel: s.channel ? s.channel.id : '', code: code });
    set({ phase: 'error', error: code });
  }

  function onEngine(e: EngineEvent): void {
    const my = gen;
    if (e.type === 'playing') {
      watchdog = clear(watchdog);
      const first = !pictured;
      pictured = true;
      set({ phase: 'playing', bufferPercent: 100, error: null, attempt: 0, startupMs: first ? o.now() - loadStarted : s.startupMs });
      if (first) {
        o.log.info('live: playing', { channel: s.channel ? s.channel.id : '', startupMs: s.startupMs });
      }
      if (first && s.channel && o.onPlaying) {
        o.onPlaying(s.channel);
      }
    } else if (e.type === 'buffering') {
      if (!dataSeen) {
        dataSeen = true;
        if (armStall) {
          armStall();
        }
      }
      if (s.phase === 'playing' || s.phase === 'buffering' || s.phase === 'loading') {
        const done = e.percent >= 100;
        set({ phase: done ? (pictured ? 'playing' : 'loading') : (pictured ? 'buffering' : 'loading'), bufferPercent: e.percent });
      }
    } else if (e.type === 'error') {
      fail(e.code, my);
    } else if (e.type === 'ended') {
      fail('connection', my); // a live stream that "ends" has dropped
    }
  }

  function start(channel: Channel, attempt: number, keepPictured: boolean): void {
    const my = ++gen;
    clearAll();
    const engine = o.engine;
    if (!engine) {
      set({ phase: 'error', channel: channel, error: 'unavailable', attempt: 0 });
      return;
    }
    if (!off) {
      off = engine.on(onEngine);
    }
    engine.stop();
    pictured = keepPictured && attempt > 0 ? pictured : false;
    dataSeen = false;
    loadStarted = o.now();
    set({ phase: attempt > 0 ? 'retrying' : 'loading', channel: channel, bufferPercent: 0, error: null, attempt: attempt, ready: false });
    watchdog = o.setTimer(function () {
      watchdog = null;
      fail('timeout', my);
    }, o.prepareTimeoutMs);
    let reopened = false;
    const eng: PlaybackEngine = engine;
    function open(src: PlaybackSource): void {
      let settled = false;
      const stallMs = o.prepareStallMs || 0;
      dataSeen = false;
      // Stall check, armed by the first buffering report of this load (stream data arrives).
      // Dead channels (404, refused) never report buffering and keep their own error.
      armStall = stallMs > 0 && !reopened ? function () {
        armStall = null;
        stallTimer = o.setTimer(function () {
          stallTimer = null;
          if (my !== gen || settled || pictured) {
            return;
          }
          reopened = true;
          o.log.warn('live: prepare stalled; reopening', { channel: s.channel ? s.channel.id : '', afterMs: o.now() - loadStarted });
          eng.stop();
          open(src);
        }, stallMs);
      } : null;
      eng.load(src, { bufferSec: o.bufferSec }).then(function () {
        settled = true;
        if (my === gen && s.phase !== 'playing') {
          set({ phase: pictured ? 'playing' : 'loading', ready: true });
        }
      }, function (code: unknown) {
        settled = true;
        fail(typeof code === 'string' ? code as LiveErrorCode : 'unknown', my);
      });
    }
    o.resolve(channel).then(function (src) {
      if (my !== gen) {
        return;
      }
      if (!src) {
        fail('no-source', my);
        return;
      }
      open(src);
    }, function () {
      fail('no-source', my);
    });
  }

  return {
    select: function (channel) {
      gen++; // anything still loading belongs to the old channel now
      clearAll();
      if (o.engine) {
        o.engine.stop();
      }
      pictured = false;
      const t = o.now();
      const quiet = !!o.zapQuietMs && t - lastSelectAt >= o.zapQuietMs;
      lastSelectAt = t;
      if (quiet) {
        start(channel, 0, false); // a single zap: no waiting
        return;
      }
      set({ phase: 'tuning', channel: channel, bufferPercent: 0, error: null, attempt: 0, ready: false });
      zapTimer = o.setTimer(function () {
        zapTimer = null;
        start(channel, 0, false);
      }, o.zapDebounceMs);
    },
    selectNow: function (channel) {
      start(channel, 0, false);
    },
    retry: function () {
      if (s.channel) {
        start(s.channel, 0, false);
      }
    },
    togglePause: function () {
      if (!o.engine) {
        return;
      }
      if (s.phase === 'playing' || s.phase === 'buffering') {
        o.engine.pause();
        set({ phase: 'paused' });
      } else if (s.phase === 'paused') {
        o.engine.resume();
        set({ phase: 'playing' });
      }
    },
    stop: function () {
      gen++;
      clearAll();
      if (o.engine) {
        o.engine.stop();
      }
      pictured = false;
      set({ phase: 'idle', channel: null, bufferPercent: 0, error: null, attempt: 0 });
    },
    suspend: function () {
      if (suspended || !o.engine || s.phase === 'idle') {
        return;
      }
      suspended = true;
      // Hidden: release the stream entirely; it is reopened at the live edge on restore.
      gen++;
      clearAll();
      o.engine.stop();
    },
    restore: function () {
      if (!suspended) {
        return;
      }
      suspended = false;
      if (s.channel) {
        start(s.channel, 0, false);
      }
    },
    state: function () { return s; },
    onChange: function (cb) {
      listeners.push(cb);
      return function () {
        const i = listeners.indexOf(cb);
        if (i >= 0) { listeners.splice(i, 1); }
      };
    },
    destroy: function () {
      gen++;
      clearAll();
      if (o.engine) {
        o.engine.stop();
      }
      if (off) { off(); off = null; }
      listeners.length = 0;
    }
  };
}
