// Playback engine interface (ARCHITECTURE.md rev 3 §5.1, the live-TV subset used in Stage 5).
// Implementations: avplay-engine.ts (Samsung AVPlay, TV) and the test double in tests/fakes.
// The engine never logs URLs: a PlaybackSource can contain credentials.
import type { PlaybackSource } from '../models/content.ts';

export type EngineState = 'idle' | 'opening' | 'playing' | 'paused' | 'error';

export type EngineErrorCode = 'connection' | 'format' | 'unsupported' | 'unknown';

export type EngineEvent =
  /** 0 when buffering starts, 100 when it completes. */
  | { type: 'buffering'; percent: number }
  /** First advance of the playback position after load (picture on screen). */
  | { type: 'playing' }
  | { type: 'error'; code: EngineErrorCode }
  | { type: 'ended' };

export interface LoadOptions {
  /** AVPlay setBufferingParam for PLAY and RESUME (rev 3 §5.2: 2 s for live). 0 = AVPlay default (VOD, Stage 6). */
  bufferSec: number;
}

export interface PlaybackEngine {
  /** Opens and prepares the source, then starts playback. Rejects with an EngineErrorCode string. */
  load(src: PlaybackSource, opts: LoadOptions): Promise<void>;
  pause(): void;
  resume(): void;
  /** Stops and closes; never throws. Safe to call in any state. */
  stop(): void;
  state(): EngineState;
  /** Video rectangle in the 1920×1080 UI coordinate space. */
  setRect(x: number, y: number, w: number, h: number): void;
  /** App hidden (Home key): release the decoder; restore() when visible again. */
  suspend(): void;
  restore(): void;
  on(cb: (e: EngineEvent) => void): () => void;
  /** Stage 6 (VOD): playback position and duration in ms (0 when unknown). Optional for test doubles. */
  timing?(): { positionMs: number; durationMs: number };
  destroy(): void;
}
