// Registers the Stage 5 screens: Live TV, the player and the system-keyboard text entry, and
// provides the text-entry choice (Samsung IME preferred, app keyboard as fallback).
import type { Router } from '../navigation/router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { EpgService } from '../services/epg-service.ts';
import type { UserLists } from '../services/user-lists.ts';
import type { Lifecycle } from '../app/lifecycle.ts';
import type { PlaybackEngine } from '../player/engine.ts';
import { createLiveController } from '../player/live-controller.ts';
import type { Translate } from '../i18n/strings.ts';
import type { Logger } from '../utils/log.ts';
import type { KeyboardParams } from './keyboard-overlay.ts';
import { createLiveTvScreen } from './live-tv-screen.ts';
import { createLivePreview } from './live-preview.ts';
import type { LiveTvParams, PlayerParams } from './live-tv-screen.ts';
import { createTvGuideScreen } from './tv-guide-screen.ts';
import { createPlayerScreen } from './player-screen.ts';
import { createZapHistory } from './live-controls.ts';
import { createTextEntryOverlay } from './text-entry-overlay.ts';
import type { TextInputState } from './text-entry-overlay.ts';

import type { CategoryPrefsStore } from '../content/category-prefs.ts';

export interface LiveScreenDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  epg: EpgService;
  lists: UserLists;
  lifecycle: Lifecycle;
  engine: PlaybackEngine | null;
  textInput: TextInputState;
  /** True when the system IME should be used (TV, keyboard setting 'auto'). */
  preferIme: boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  log: Logger;
  player: { bufferSec: number; prepareTimeoutMs: number; prepareStallMs: number; zapDebounceMs: number; retryDelaysMs: number[]; numberEntryMs?: number; zapQuietMs?: number };
  parental?: Parental | null;
  /** Stage 7E: miniature live preview in Live TV (needs an engine); tune delay after the focus rests. */
  preview?: { debounceMs: number } | null;
  /** Stage 14: category order / hidden categories, and the memory floor for the manager. */
  catPrefs?: CategoryPrefsStore | null;
  memoryMB?: () => number;
  minFreeMB?: number;
}

import type { Parental } from '../services/parental.ts';

export type OpenText = (nav: Router, p: KeyboardParams) => void;

export function textOpener(preferIme: boolean): OpenText {
  return function (nav, p) {
    nav.openOverlay(preferIme ? 'text-entry' : 'keyboard', p as unknown as Record<string, unknown>);
  };
}

export function registerLiveScreens(router: Router, d: LiveScreenDeps): void {
  const openText = textOpener(d.preferIme);
  router.register('live-tv', function (p, nav) {
    const lp = p as unknown as LiveTvParams;
    const engine = d.engine;
    const pv = d.preview;
    return createLiveTvScreen({
      doc: d.doc, t: d.t, playlists: d.playlists, epg: d.epg, lists: d.lists, now: d.now,
      setTimer: d.setTimer, clearTimer: d.clearTimer, openText: openText, log: d.log.child('live'), parental: d.parental,
      catPrefs: d.catPrefs, memoryMB: d.memoryMB, minFreeMB: d.minFreeMB,
      preview: engine && pv ? function () {
        return createLivePreview({
          doc: d.doc, t: d.t, engine: engine, lifecycle: d.lifecycle,
          createController: function () {
            // Same rules as the full-screen player, but no reconnect loop while browsing.
            return createLiveController({
              engine: engine,
              resolve: function (ch) { return d.playlists.resolvePlayback(lp.playlistId, ch); },
              setTimer: d.setTimer, clearTimer: d.clearTimer, now: d.now,
              bufferSec: d.player.bufferSec, prepareTimeoutMs: d.player.prepareTimeoutMs, prepareStallMs: d.player.prepareStallMs,
              zapDebounceMs: pv.debounceMs, retryDelaysMs: [], log: d.log.child('preview')
            });
          }
        });
      } : null
    }, lp, nav);
  });
  // Stage 10: channels whose picture started, kept across player screens for previous-channel.
  const zapHistory = createZapHistory();
  router.register('player', function (p, nav) {
    return createPlayerScreen({
      doc: d.doc, t: d.t, epg: d.epg, lifecycle: d.lifecycle, setTimer: d.setTimer, clearTimer: d.clearTimer,
      history: zapHistory, numberEntryMs: d.player.numberEntryMs,
      createController: function (playlistId) {
        return createLiveController({
          engine: d.engine,
          resolve: function (ch) { return d.playlists.resolvePlayback(playlistId, ch); },
          setTimer: d.setTimer, clearTimer: d.clearTimer, now: d.now,
          bufferSec: d.player.bufferSec, prepareTimeoutMs: d.player.prepareTimeoutMs, prepareStallMs: d.player.prepareStallMs, zapDebounceMs: d.player.zapDebounceMs,
          zapQuietMs: d.player.zapQuietMs, retryDelaysMs: d.player.retryDelaysMs, log: d.log.child('player'),
          onPlaying: function (ch) { d.lists.markWatched(playlistId, ch.id); zapHistory.tuned(playlistId, ch.id); }
        });
      }
    }, p as unknown as PlayerParams, nav);
  });
  router.register('tv-guide', function (p, nav) {
    return createTvGuideScreen({ doc: d.doc, t: d.t, epg: d.epg, now: d.now, setTimer: d.setTimer, clearTimer: d.clearTimer }, p as unknown as PlayerParams, nav);
  });
  router.register('text-entry', function (p, nav) {
    return createTextEntryOverlay({ doc: d.doc, t: d.t, textInput: d.textInput, setTimer: d.setTimer }, p as unknown as KeyboardParams, nav);
  });
}
