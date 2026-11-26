// Registers the playlist management screens (Stage 4B) with the router. Screens receive only
// what they need: the document, the PlaylistService, the translator and the clock.
import type { Router } from '../navigation/router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { Translate } from '../i18n/strings.ts';
import { createPlaylistsScreen } from './playlists-screen.ts';
import { createPlaylistForm } from './playlist-form-screen.ts';
import type { FormParams } from './playlist-form-screen.ts';
import { createPlaylistDetails } from './playlist-details-screen.ts';
import type { DetailsParams } from './playlist-details-screen.ts';
import { createImportDialog } from './import-dialog.ts';
import type { ImportDialogParams } from './import-dialog.ts';
import { createConfirmDialog } from './confirm-dialog.ts';
import type { ConfirmParams } from './confirm-dialog.ts';
import { createKeyboardOverlay } from './keyboard-overlay.ts';
import type { KeyboardParams } from './keyboard-overlay.ts';

export interface PlaylistScreenDeps {
  doc: Document;
  playlists: PlaylistService;
  t: Translate;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  openText?: (nav: Router, p: KeyboardParams) => void;
  live?: boolean;
  /** S2: subscription rows (expiry, status, checked, time basis) of a playlist. */
  subscription?: (playlistId: string) => Array<{ label: string; value: string }>;
  vod?: boolean;
}

export const PLAYLIST_SCREENS = ['playlists', 'playlist-form', 'playlist-details', 'import-dialog', 'confirm', 'keyboard'];

export function registerPlaylistScreens(router: Router, d: PlaylistScreenDeps): void {
  router.register('playlists', function (_p, nav) {
    return createPlaylistsScreen({ doc: d.doc, playlists: d.playlists, t: d.t, live: d.live, vod: d.vod }, nav);
  });
  router.register('playlist-form', function (p, nav) {
    return createPlaylistForm({ doc: d.doc, playlists: d.playlists, t: d.t, openText: d.openText }, p as unknown as FormParams, nav);
  });
  router.register('playlist-details', function (p, nav) {
    return createPlaylistDetails({ doc: d.doc, playlists: d.playlists, t: d.t, subscription: d.subscription }, p as unknown as DetailsParams, nav);
  });
  router.register('import-dialog', function (p, nav) {
    return createImportDialog(d, p as unknown as ImportDialogParams, nav);
  });
  router.register('confirm', function (p, nav) {
    return createConfirmDialog(d.doc, p as unknown as ConfirmParams, nav);
  });
  router.register('keyboard', function (p, nav) {
    return createKeyboardOverlay(d.doc, p as unknown as KeyboardParams, nav, d.t);
  });
}
