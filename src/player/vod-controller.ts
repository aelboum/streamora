// VodController (Stage 6): movie and episode playback on the shared PlaybackEngine (AVPlay).
// ARCHITECTURE.md rev 3 §5.4 is the target; Stage 6 implements the basic part:
//   - open (AVPlay's default buffering, no live buffer), 15 s watchdog until the first picture;
//   - states loading → playing ⇄ buffering, paused, ended, error (no automatic retry; Retry reloads);
//   - every load has a generation; callbacks of an older load are ignored;
//   - Home key: AVPlay suspend/restore keeps the position (unverified on the TV [A]);
//   - position and duration for the progress bar (engine.timing()).
// Seeking, resume points and audio/subtitle tracks are Stage 7/8 (no progress system exists yet).
// Stream URLs come from `resolve` and are never logged.
import type { PlaybackSource, StreamRef } from '../models/content.ts';
import type { EngineEvent, PlaybackEngine } from './engine.ts';
import type { Logger } from '../utils/log.ts';

export type VodPhase = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';
export type VodErrorCode = 'unavailable' | 'no-source' | 'timeout' | 'connection' | 'format' | 'unsupported' | 'unknown';

export interface VodState {
  phase: VodPhase;
  error: VodErrorCode | null;
  bufferPercent: number;
  positionMs: number;
  durationMs: number;
  /** ms from the start of the load to the first picture. */
  startupMs: number;
}

export interface VodControllerOptions {
  engine: PlaybackEngine | null;
  resolve: (ref: StreamRef) => Promise<PlaybackSource | null>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  now: () => number;
  prepareTimeoutMs: number;
  log: Logger;
}

export interface VodController {
  play(ref: StreamRef): void;
  retry(): void;
  togglePause(): void;
  stop(): void;
  suspend(): void;
  restore(): void;
  /** Refreshes position and duration from the engine (the screen calls it about once a second). */
  tick(): void;
  state(): VodState;
  onChange(cb: (s: VodState) => void): () => void;
  destroy(): void;
}

export function createVodController(o: VodControllerOptions): VodController {
  const listeners: Array<(s: VodState) => void> = [];
  let s: VodState = { phase: 'idle', error: null, bufferPercent: 0, positionMs: 0, durationMs: 0, startupMs: 0 };
  let gen = 0;
  let watchdog: unknown = null;
  let started = 0;
  let pictured = false;
  let ref: StreamRef | null = null;
  let off: (() => void) | null = null;
  let suspended = false;

  function emit(): void {
    const snap: VodState = { phase: s.phase, error: s.error, bufferPercent: s.bufferPercent, positionMs: s.positionMs, durationMs: s.durationMs, startupMs: s.startupMs };
    const l = listeners.slice();
    for (let i = 0; i < l.length; i++) {
      try { l[i](snap); } catch (e) { /* a listener failure never breaks playback */ }
    }
  }
  function set(p: Partial<VodState>): void {
    for (const k in p) {
      if (Object.prototype.hasOwnProperty.call(p, k)) {
        (s as unknown as Record<string, unknown>)[k] = (p as Record<string, unknown>)[k];
      }
    }
    emit();
  }
  function clearWatchdog(): void {
    if (watchdog !== null) {
      o.clearTimer(watchdog);
      watchdog = null;
    }
  }
  function fail(code: VodErrorCode, my: number): void {
    if (my !== gen) {
      return;
    }
    clearWatchdog();
    if (o.engine) {
      o.engine.stop();
    }
    o.log.warn('vod: playback failed', { code: code, afterMs: o.now() - started });
    set({ phase: 'error', error: code });
  }

  function onEngine(e: EngineEvent): void {
    const my = gen;
    if (e.type === 'playing') {
      clearWatchdog();
      const first = !pictured;
      pictured = true;
      set({ phase: s.phase === 'paused' ? 'paused' : 'playing', error: null, bufferPercent: 100, startupMs: first ? o.now() - started : s.startupMs });
      if (first) {
        o.log.info('vod: playing', { startupMs: s.startupMs });
      }
    } else if (e.type === 'buffering') {
      if (s.phase === 'loading' || s.phase === 'playing' || s.phase === 'buffering') {
        set({ phase: e.percent >= 100 ? (pictured ? 'playing' : 'loading') : (pictured ? 'buffering' : 'loading'), bufferPercent: e.percent });
      }
    } else if (e.type === 'error') {
      fail(e.code, my);
    } else if (e.type === 'ended') {
      if (my === gen) {
        clearWatchdog();
        set({ phase: 'ended' });
      }
    }
  }

  function start(r: StreamRef): void {
    const my = ++gen;
    clearWatchdog();
    ref = r;
    const engine = o.engine;
    if (!engine) {
      set({ phase: 'error', error: 'unavailable' });
      return;
    }
    if (!off) {
      off = engine.on(onEngine);
    }
    engine.stop();
    pictured = false;
    started = o.now();
    set({ phase: 'loading', error: null, bufferPercent: 0, positionMs: 0, durationMs: 0 });
    watchdog = o.setTimer(function () {
      watchdog = null;
      fail('timeout', my);
    }, o.prepareTimeoutMs);
    o.resolve(r).then(function (src) {
      if (my !== gen) {
        return;
      }
      if (!src) {
        fail('no-source', my);
        return;
      }
      engine.load(src, { bufferSec: 0 }).then(function () { /* picture reported by the 'playing' event */ }, function (code: unknown) {
        fail(typeof code === 'string' ? code as VodErrorCode : 'unknown', my);
      });
    }, function () {
      fail('no-source', my);
    });
  }

  return {
    play: function (r) { start(r); },
    retry: function () { if (ref) { start(ref); } },
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
      clearWatchdog();
      if (o.engine) {
        o.engine.stop();
      }
      pictured = false;
      set({ phase: 'idle', error: null, bufferPercent: 0 });
    },
    suspend: function () {
      if (suspended || !o.engine || s.phase === 'idle' || s.phase === 'error') {
        return;
      }
      suspended = true;
      o.engine.suspend();
    },
    restore: function () {
      if (!suspended || !o.engine) {
        return;
      }
      suspended = false;
      o.engine.restore();
    },
    tick: function () {
      const e = o.engine;
      if (!e || !e.timing || (s.phase !== 'playing' && s.phase !== 'paused' && s.phase !== 'buffering')) {
        return;
      }
      const t = e.timing();
      if (t.positionMs !== s.positionMs || t.durationMs !== s.durationMs) {
        set({ positionMs: t.positionMs, durationMs: t.durationMs });
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
      clearWatchdog();
      if (o.engine) {
        o.engine.stop();
      }
      if (off) { off(); off = null; }
      listeners.length = 0;
    }
  };
}
