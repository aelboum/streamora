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
  | { type: 'ended' }
  /** Stage 7B.2: subtitle cue to draw ('' clears). The app renders subtitles on both platforms. */
  | { type: 'subtitle'; text: string }
  /** Stage 7B.2: the list of audio / subtitle tracks became known or changed. */
  | { type: 'tracks' }
  /** Stage 7B.2: a seek (or a start position) could not be applied; the title plays on where it is. */
  | { type: 'seek-failed' };

/** Stage 7B.2: an audio or subtitle track of the open source. */
export interface MediaTrack {
  kind: 'audio' | 'text';
  /** Engine-specific index; stable while the source is open. */
  id: number;
  /** ISO 639 code as reported by the stream ('' when unknown). */
  language: string;
  /** Extra description from the stream (codec, channels, "SDH" …), may be ''. */
  label: string;
  selected: boolean;
  /** Stage 7E: false when `language` may be cut short (AVPlay reports two letters: "tu" for tur). */
  langExact?: boolean;
  /** Stage 7E: codec (aac, ac3, eac3, dts, mp3, srt, ass, tx3g, pgs, …), '' / absent when unknown. */
  codec?: string;
  /** Stage 7E: audio channels, sample rate (Hz) and average bitrate (bit/s); 0 / absent = unknown. */
  channels?: number;
  sampleRate?: number;
  bitrate?: number;
  /** Stage 7E: track name stated by the file ("English SDH", "Commentary"). */
  name?: string;
  /** Stage 7E: forced subtitles (only signs / foreign-language parts). */
  forced?: boolean;
  /** Stage 7F-E: subtitles for the deaf and hard of hearing, only when the file flags it explicitly. */
  sdh?: boolean;
}

export interface LoadOptions {
  /** AVPlay setBufferingParam for PLAY and RESUME (rev 3 §5.2: 2 s for live). 0 = AVPlay default (VOD, Stage 6). */
  bufferSec: number;
  /** Stage 7B.2: start at this position (ms); AVPlay seeks after prepare, before play. */
  startMs?: number;
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
  /** Stage 7B.2 (VOD): jump to an absolute position in ms. Optional for test doubles. */
  seek?(positionMs: number): void;
  /** Stage 7B.2: audio and subtitle tracks of the open source ([] when unknown). */
  tracks?(): MediaTrack[];
  /** Stage 7B.2: select a track; for 'text', id −1 turns subtitles off. */
  selectTrack?(kind: 'audio' | 'text', id: number): void;
  destroy(): void;
}
