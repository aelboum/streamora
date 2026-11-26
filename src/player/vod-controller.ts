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
import type { EngineEvent, MediaTrack, PlaybackEngine } from './engine.ts';
import type { Logger } from '../utils/log.ts';
import type { ProbeTrack } from './media-probe.ts';
import { mergeProbe } from './track-info.ts';

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
  /** Stage 7B.2: subtitle cue on screen ('' = none). */
  subtitle: string;
  /** Stage 7B.2: increases whenever the engine's track list changes. */
  tracksRev: number;
  /** Stage 7B.2: false once a seek or start position failed for this title (AVPlay on some providers). */
  seekable: boolean;
  /** Stage 7B.2: the start position (resume) could not be applied; playback began at 0. */
  startFailed: boolean;
}

export interface VodControllerOptions {
  engine: PlaybackEngine | null;
  resolve: (ref: StreamRef) => Promise<PlaybackSource | null>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  now: () => number;
  prepareTimeoutMs: number;
  log: Logger;
  /**
   * Stage 7E: reads the track table from the file (media-probe.ts) once the picture is shown, for
   * real languages, codecs, channels and bitrates. Optional (tests, platforms without it).
   */
  probe?: (src: PlaybackSource) => Promise<{ tracks: ProbeTrack[]; requests: number } | null>;
}

export interface VodController {
  /** startMs > 0: resume there once the first picture is shown (Stage 7B.2). */
  play(ref: StreamRef, startMs?: number): void;
  /** Absolute seek (clamped to [0, duration − 1 s]); the position is shown at once. */
  seekTo(ms: number): void;
  retry(): void;
  togglePause(): void;
  stop(): void;
  suspend(): void;
  restore(): void;
  /** Refreshes position and duration from the engine (the screen calls it about once a second). */
  tick(): void;
  /** Stage 7B.2: audio and subtitle tracks of the current title ([] when unknown). */
  tracks(): MediaTrack[];
  /** Stage 7E: true once the file's track table was read (or cannot be): languages / quality are final. */
  tracksFinal(): boolean;
  selectTrack(kind: 'audio' | 'text', id: number): void;
  state(): VodState;
  onChange(cb: (s: VodState) => void): () => void;
  destroy(): void;
}

/** Quiet time after the last ◀▶ press before the engine seeks (Stage 7D TV finding). */
export const SEEK_SETTLE_MS = 400;

export function createVodController(o: VodControllerOptions): VodController {
  const listeners: Array<(s: VodState) => void> = [];
  let s: VodState = { phase: 'idle', error: null, bufferPercent: 0, positionMs: 0, durationMs: 0, startupMs: 0, subtitle: '', tracksRev: 0, seekable: true, startFailed: false };
  let gen = 0;
  let watchdog: unknown = null;
  let started = 0;
  let pictured = false;
  let ref: StreamRef | null = null;
  let off: (() => void) | null = null;
  let suspended = false;
  let startAt = 0;
  // Stage 7E: the opened source (for the probe) and the probed track table of the current title.
  let opened: PlaybackSource | null = null;
  let probed: ProbeTrack[] | null = null;
  let probeDone = false;
  // Seeks from the remote are coalesced: the target shown at once, one engine seek after the keys settle.
  let seekTimer: unknown = null;
  let pendingSeek = -1;
  let pendingSince = 0;
  function clearSeek(): void {
    if (seekTimer !== null) { o.clearTimer(seekTimer); seekTimer = null; }
    pendingSeek = -1;
  }

  function emit(): void {
    const snap: VodState = { phase: s.phase, error: s.error, bufferPercent: s.bufferPercent, positionMs: s.positionMs, durationMs: s.durationMs, startupMs: s.startupMs, subtitle: s.subtitle, tracksRev: s.tracksRev, seekable: s.seekable, startFailed: s.startFailed };
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
        // The start position went to the engine with the load (AVPlay seeks before play).
        if (startAt > 0 && !s.startFailed) { set({ positionMs: startAt }); }
        startAt = 0;
        runProbe(my);
      }
    } else if (e.type === 'buffering') {
      if (s.phase === 'loading' || s.phase === 'playing' || s.phase === 'buffering') {
        set({ phase: e.percent >= 100 ? (pictured ? 'playing' : 'loading') : (pictured ? 'buffering' : 'loading'), bufferPercent: e.percent });
      }
    } else if (e.type === 'error') {
      fail(e.code, my);
    } else if (e.type === 'subtitle') {
      if (e.text !== s.subtitle) { set({ subtitle: e.text }); }
    } else if (e.type === 'seek-failed') {
      if (my === gen) {
        clearSeek();
        const t = o.engine && o.engine.timing ? o.engine.timing() : null;
        set({ seekable: false, startFailed: s.startFailed || startAt > 0, positionMs: t ? t.positionMs : s.positionMs });
      }
    } else if (e.type === 'tracks') {
      set({ tracksRev: s.tracksRev + 1 });
    } else if (e.type === 'ended') {
      if (my === gen) {
        clearWatchdog();
        set({ phase: 'ended' });
      }
    }
  }

  function runProbe(my: number): void {
    const src = opened;
    if (!o.probe || !src) { probeDone = true; set({ tracksRev: s.tracksRev + 1 }); return; }
    const t0 = o.now();
    o.probe(src).then(function (r) {
      if (my !== gen) { return; }
      probeDone = true;
      if (!r) { o.log.info('vod: track table not readable', { ms: o.now() - t0 }); set({ tracksRev: s.tracksRev + 1 }); return; }
      probed = r.tracks;
      let a = 0;
      let x = 0;
      for (let i = 0; i < r.tracks.length; i++) { if (r.tracks[i].kind === 'audio') { a++; } else if (r.tracks[i].kind === 'text') { x++; } }
      o.log.info('vod: track table read', { audio: a, text: x, requests: r.requests, ms: o.now() - t0 });
      set({ tracksRev: s.tracksRev + 1 });
    }, function () {
      // The engine's own track list stays in use.
      if (my === gen) { probeDone = true; set({ tracksRev: s.tracksRev + 1 }); }
    });
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
    clearSeek();
    pictured = false;
    opened = null;
    probed = null;
    probeDone = false;
    started = o.now();
    set({ phase: 'loading', error: null, bufferPercent: 0, positionMs: 0, durationMs: 0, subtitle: '', seekable: true, startFailed: false });
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
      opened = src;
      engine.load(src, { bufferSec: 0, startMs: startAt > 0 ? startAt : undefined }).then(function () { /* picture reported by the 'playing' event */ }, function (code: unknown) {
        fail(typeof code === 'string' ? code as VodErrorCode : 'unknown', my);
      });
    }, function () {
      fail('no-source', my);
    });
  }

  return {
    tracks: function () {
      const e = o.engine;
      if (!e || !e.tracks || s.phase === 'idle' || s.phase === 'loading' || s.phase === 'error') { return []; }
      return mergeProbe(e.tracks(), probed);
    },
    tracksFinal: function () { return probeDone; },
    selectTrack: function (kind, id) {
      const e = o.engine;
      if (e && e.selectTrack) { e.selectTrack(kind, id); }
    },
    play: function (r, startMs) { startAt = startMs && startMs > 0 ? startMs : 0; start(r); },
    seekTo: function (ms) {
      const e = o.engine;
      if (!e || !e.seek || !s.seekable || (s.phase !== 'playing' && s.phase !== 'paused' && s.phase !== 'buffering')) {
        return;
      }
      const max = s.durationMs > 1000 ? s.durationMs - 1000 : ms;
      const to = Math.max(0, Math.min(max, ms));
      // The bar follows every key press at once; the engine gets one seek to where the presses
      // stopped. Holding ◀▶ repeats a key every ~0.1 s, and AVPlay drops a seek issued while
      // another is still running (TV, Stage 7D) — which used to look like "not seekable".
      pendingSeek = to;
      pendingSince = o.now();
      set({ positionMs: to });
      if (seekTimer !== null) { o.clearTimer(seekTimer); }
      const my = gen;
      seekTimer = o.setTimer(function () {
        seekTimer = null;
        if (my === gen && o.engine && o.engine.seek && s.seekable && pendingSeek >= 0) { o.engine.seek(pendingSeek); }
      }, SEEK_SETTLE_MS);
    },
    retry: function () { if (ref) { startAt = s.positionMs > 0 ? s.positionMs : 0; start(ref); } },
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
      clearSeek();
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
      // While a seek is on its way, keep showing its target (until the engine gets there, at most 15 s).
      if (pendingSeek >= 0) {
        if (seekTimer === null && (Math.abs(t.positionMs - pendingSeek) < 3000 || o.now() - pendingSince > 15000)) {
          pendingSeek = -1;
        } else {
          if (t.durationMs !== s.durationMs) { set({ durationMs: t.durationMs }); }
          return;
        }
      }
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
      clearSeek();
      if (o.engine) {
        o.engine.stop();
      }
      if (off) { off(); off = null; }
      listeners.length = 0;
    }
  };
}
