// Registers the Stage 6 screens: movie/series browse, details and the VOD player.
// The player uses the shared playback engine (the same AVPlay instance as Live TV).
import type { Router } from '../navigation/router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { VodService } from '../services/vod-service.ts';
import type { Lifecycle } from '../app/lifecycle.ts';
import type { PlaybackEngine } from '../player/engine.ts';
import { createVodController } from '../player/vod-controller.ts';
import type { Translate } from '../i18n/strings.ts';
import type { Logger } from '../utils/log.ts';
import type { OpenText } from './live-screens.ts';
import { createVodBrowseScreen } from './vod-browse-screen.ts';
import type { VodBrowseParams, VodDetailsParams } from './vod-browse-screen.ts';
import { createVodDetailsScreen } from './vod-details-screen.ts';
import type { VodPlayerParams } from './vod-details-screen.ts';
import { createVodPlayerScreen } from './vod-player-screen.ts';

export interface VodScreenDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  vod: VodService;
  lifecycle: Lifecycle;
  engine: PlaybackEngine | null;
  openText: OpenText;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  log: Logger;
  prepareTimeoutMs: number;
}

export function registerVodScreens(router: Router, d: VodScreenDeps): void {
  router.register('vod-browse', function (p, nav) {
    return createVodBrowseScreen({
      doc: d.doc, t: d.t, playlists: d.playlists, vod: d.vod, now: d.now, setTimer: d.setTimer, clearTimer: d.clearTimer,
      openText: d.openText, log: d.log.child('vod')
    }, p as unknown as VodBrowseParams, nav);
  });
  router.register('vod-details', function (p, nav) {
    return createVodDetailsScreen({ doc: d.doc, t: d.t, vod: d.vod }, p as unknown as VodDetailsParams, nav);
  });
  router.register('vod-player', function (p, nav) {
    return createVodPlayerScreen({
      doc: d.doc, t: d.t, lifecycle: d.lifecycle, setTimer: d.setTimer, clearTimer: d.clearTimer,
      createController: function (playlistId) {
        return createVodController({
          engine: d.engine,
          resolve: function (ref) { return d.vod.resolve(playlistId, ref); },
          setTimer: d.setTimer, clearTimer: d.clearTimer, now: d.now, prepareTimeoutMs: d.prepareTimeoutMs, log: d.log.child('player')
        });
      }
    }, p as unknown as VodPlayerParams, nav);
  });
}
