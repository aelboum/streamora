// PlaybackEngine on Android (Stage 8): Media3 ExoPlayer in the native activity (PlayerBridge.java)
// draws on a surface behind the transparent WebView, the same layering as AVPlay on Tizen.
// Contract mirrors avplay-engine.ts: load() resolves once the source is prepared and playing,
// 'playing' fires on the first rendered frame, errors before that reject load(), later ones are
// events. Native events arrive through window.__elitePlayerEvent(json) as {sid, type, percent?,
// code?}; events of an older load (sid) are ignored. URLs are never logged (they hold credentials).
import type { AndroidPlayerBridge } from '../app/platform/platform.ts';
import type { PlaybackSource } from '../models/content.ts';
import type { EngineErrorCode, EngineEvent, EngineState, LoadOptions, MediaTrack, PlaybackEngine } from './engine.ts';

interface NativeEvent { sid: number; type: string; percent?: number; code?: string; text?: string }

export interface AndroidPlayerHost {
  ElitePlayer?: AndroidPlayerBridge;
  __elitePlayerEvent?: (json: string) => void;
}

function errorCode(c: string | undefined): EngineErrorCode {
  return c === 'connection' || c === 'format' || c === 'unsupported' ? c : 'unknown';
}

export function createAndroidEngine(host: AndroidPlayerHost): PlaybackEngine | null {
  const p = host.ElitePlayer;
  if (!p) {
    return null;
  }
  const player: AndroidPlayerBridge = p;
  const listeners: Array<(e: EngineEvent) => void> = [];
  let st: EngineState = 'idle';
  let session = 0;
  let pending: { sid: number; resolve: () => void; reject: (c: EngineErrorCode) => void } | null = null;
  let last: { src: PlaybackSource; opts: LoadOptions } | null = null;
  let suspended = false;
  let resumeAt = 0; // position to return to after Home (the decoder is released while hidden)
  let startMs = 0; // Stage 7B.2: resume position, applied once the source is prepared

  function emit(e: EngineEvent): void {
    const l = listeners.slice();
    for (let i = 0; i < l.length; i++) {
      try { l[i](e); } catch (x) { /* a failing listener never breaks playback */ }
    }
  }

  host.__elitePlayerEvent = function (json: string) {
    let e: NativeEvent;
    try { e = JSON.parse(json) as NativeEvent; } catch (x) { return; }
    if (e.sid !== session) {
      return;
    }
    if (e.type === 'prepared') {
      if (startMs > 0) { try { player.seekTo(startMs); } catch (x) { /* not open */ } startMs = 0; }
      if (pending) { const r = pending; pending = null; r.resolve(); }
    } else if (e.type === 'firstFrame') {
      st = 'playing';
      emit({ type: 'playing' });
    } else if (e.type === 'buffering') {
      emit({ type: 'buffering', percent: Math.max(0, Math.min(100, +(e.percent || 0))) });
    } else if (e.type === 'ended') {
      emit({ type: 'ended' });
    } else if (e.type === 'subtitle') {
      emit({ type: 'subtitle', text: typeof e.text === 'string' ? e.text : '' });
    } else if (e.type === 'tracks') {
      emit({ type: 'tracks' });
    } else if (e.type === 'error') {
      st = 'error';
      const code = errorCode(e.code);
      if (pending) { const r = pending; pending = null; r.reject(code); } else { emit({ type: 'error', code: code }); }
    }
  };

  function start(src: PlaybackSource, opts: LoadOptions): Promise<void> {
    const my = ++session;
    st = 'opening';
    if (pending) { const old = pending; pending = null; old.reject('unknown'); }
    return new Promise<void>(function (resolve, reject) {
      pending = { sid: my, resolve: resolve, reject: reject };
      try {
        player.load(String(my), src.url, src.type, !!src.live, src.userAgent || '', src.referrer || '', Math.round(opts.bufferSec * 1000));
      } catch (e) {
        pending = null;
        st = 'error';
        reject('unknown');
      }
    });
  }

  return {
    load: function (src, opts) {
      last = { src: src, opts: opts };
      startMs = opts.startMs && opts.startMs > 0 ? Math.floor(opts.startMs) : 0;
      return start(src, opts);
    },
    pause: function () { try { player.pause(); st = 'paused'; } catch (e) { /* not playing */ } },
    resume: function () { try { player.resume(); st = 'playing'; } catch (e) { /* not paused */ } },
    stop: function () {
      session++;
      if (pending) { const r = pending; pending = null; r.reject('unknown'); }
      try { player.stop(); } catch (e) { /* not open */ }
      st = 'idle';
      last = null;
    },
    state: function () { return st; },
    setRect: function (x, y, w, h) { try { player.setRect(x, y, w, h); } catch (e) { /* not open */ } },
    timing: function () {
      let pos = 0;
      let dur = 0;
      try { pos = +player.positionMs() || 0; dur = +player.durationMs() || 0; } catch (e) { /* not open */ }
      return { positionMs: pos, durationMs: dur };
    },
    seek: function (ms) { try { player.seekTo(Math.max(0, Math.floor(ms))); } catch (e) { /* not open */ } },
    tracks: function () {
      let raw: unknown;
      try { raw = JSON.parse(player.tracks()); } catch (e) { return []; }
      if (Object.prototype.toString.call(raw) !== '[object Array]') { return []; }
      const a = raw as Array<Record<string, unknown>>;
      const out: MediaTrack[] = [];
      for (let i = 0; i < a.length; i++) {
        const t = a[i];
        if (!t || (t.kind !== 'audio' && t.kind !== 'text') || typeof t.id !== 'number') { continue; }
        out.push({ kind: t.kind as 'audio' | 'text', id: t.id, language: String(t.language || '').slice(0, 12), label: String(t.label || '').slice(0, 40), selected: !!t.selected });
      }
      return out;
    },
    selectTrack: function (kind, id) { try { player.selectTrack(kind, id); } catch (e) { /* not open */ } },
    // App hidden: the decoder is released; on return the same source is reopened.
    suspend: function () {
      if (st === 'idle' || suspended) { return; }
      suspended = true;
      try { resumeAt = last && !last.src.live ? +player.positionMs() || 0 : 0; } catch (e) { resumeAt = 0; }
      session++;
      try { player.stop(); } catch (e) { /* not open */ }
    },
    restore: function () {
      if (!suspended) { return; }
      suspended = false;
      const at = resumeAt;
      resumeAt = 0;
      if (last) {
        start(last.src, last.opts).then(function () {
          if (at > 0) { try { player.seekTo(Math.floor(at)); } catch (e) { /* not open */ } }
        }, function (c: EngineErrorCode) { emit({ type: 'error', code: c }); });
      }
    },
    on: function (cb) {
      listeners.push(cb);
      return function () {
        const i = listeners.indexOf(cb);
        if (i >= 0) { listeners.splice(i, 1); }
      };
    },
    // CP1: one Media3 player in PlayerBridge.java; tracks via TrackSelectionOverride; cues forwarded;
    // the buffer size is passed to the bridge. Not verified on a device yet (CP2).
    capabilities: function () {
      return { multiDecoder: false, trackSwitching: true, embeddedSubtitles: true, bufferControl: true, maxTracks: 0 };
    },
    destroy: function () {
      session++;
      try { player.stop(); } catch (e) { /* not open */ }
      listeners.length = 0;
      st = 'idle';
    }
  };
}
