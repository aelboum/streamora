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
import type { ProgressStore } from '../services/progress.ts';
import type { TrackPrefStore } from '../services/track-prefs.ts';
import type { Parental } from '../services/parental.ts';
import type { MyList } from '../services/my-list.ts';
import type { PlaybackSource } from '../models/content.ts';
import type { ProbeResult } from '../player/media-probe.ts';

export interface VodScreenDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  vod: VodService;
  progress?: ProgressStore | null;
  trackPrefs?: TrackPrefStore | null;
  parental?: Parental | null;
  /** Stage 11: My List. */
  myList?: MyList | null;
  /** Stage 11: free memory and the floor for sorting (see vod-browse-screen.ts). */
  memoryMB?: () => number;
  minFreeMB?: number;
  /** Stage 14: category order / hidden categories. */
  catPrefs?: CategoryPrefsStore | null;
  lifecycle: Lifecycle;
  engine: PlaybackEngine | null;
  openText: OpenText;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  log: Logger;
  prepareTimeoutMs: number;
  /** Stage 7E: reads a movie's track table (media-probe.ts); absent = engine track info only. */
  probe?: (src: PlaybackSource) => Promise<ProbeResult | null>;
}

import type { CategoryPrefsStore } from '../content/category-prefs.ts';

export function registerVodScreens(router: Router, d: VodScreenDeps): void {
  router.register('vod-browse', function (p, nav) {
    return createVodBrowseScreen({
      doc: d.doc, t: d.t, playlists: d.playlists, vod: d.vod, now: d.now, setTimer: d.setTimer, clearTimer: d.clearTimer,
      openText: d.openText, log: d.log.child('vod'), parental: d.parental, myList: d.myList, memoryMB: d.memoryMB, minFreeMB: d.minFreeMB, catPrefs: d.catPrefs
    }, p as unknown as VodBrowseParams, nav);
  });
  router.register('vod-details', function (p, nav) {
    return createVodDetailsScreen({ doc: d.doc, t: d.t, vod: d.vod, progress: d.progress, parental: d.parental, myList: d.myList }, p as unknown as VodDetailsParams, nav);
  });
  router.register('vod-player', function (p, nav) {
    return createVodPlayerScreen({
      doc: d.doc, t: d.t, lifecycle: d.lifecycle, setTimer: d.setTimer, clearTimer: d.clearTimer, progress: d.progress, trackPrefs: d.trackPrefs,
      createController: function (playlistId) {
        // Playback has priority: a running movie/series list update is stopped (previous list kept).
        d.vod.abortRefresh();
        return createVodController({
          engine: d.engine,
          resolve: function (ref) { return d.vod.resolve(playlistId, ref); },
          setTimer: d.setTimer, clearTimer: d.clearTimer, now: d.now, prepareTimeoutMs: d.prepareTimeoutMs, log: d.log.child('player'), probe: d.probe
        });
      }
    }, p as unknown as VodPlayerParams, nav);
  });
}
