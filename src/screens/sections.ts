// Top-level sections shared by the Home hub and the left rail (Stage 7B.1, Handover §5 rule 2:
// choosing a section resets the stack to Home + that section's root). Only destinations that exist
// in the app are reachable; a section is available when its screens are registered and the active
// playlist supports it (Movies/Series need an Xtream account).
import type { Router } from '../navigation/router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';

export type SectionId = 'home' | 'live' | 'favourites' | 'movies' | 'series' | 'search' | 'settings';

export function sectionAvailable(nav: Router, playlists: PlaylistService, id: SectionId): boolean {
  const active = playlists.activeId();
  const def = active ? playlists.get(active) : null;
  switch (id) {
    case 'home': return nav.isRegistered('home');
    case 'live':
    case 'favourites': return !!def && nav.isRegistered('live-tv');
    case 'movies':
    case 'series': return !!def && def.kind === 'xtream' && nav.isRegistered('vod-browse');
    case 'settings': return nav.isRegistered('settings') || nav.isRegistered('playlists');
    case 'search': return !!def && nav.isRegistered('search');
    default: return false;
  }
}

/** Opens a section from Home or the rail. Returns false when the section isn't available. */
export function openSection(nav: Router, playlists: PlaylistService, id: SectionId, fromHome: boolean): boolean {
  if (!sectionAvailable(nav, playlists, id)) {
    return false;
  }
  const pid = playlists.activeId();
  if (id === 'home') {
    return nav.resetTo('home');
  }
  if (!fromHome && nav.isRegistered('home')) {
    nav.resetTo('home');
  }
  if (id === 'live') { return nav.push('live-tv', { playlistId: pid }); }
  if (id === 'favourites') { return nav.push('live-tv', { playlistId: pid, start: 'fav' }); }
  if (id === 'movies') { return nav.push('vod-browse', { playlistId: pid, section: 'movie' }); }
  if (id === 'series') { return nav.push('vod-browse', { playlistId: pid, section: 'series' }); }
  if (id === 'search') { return nav.push('search'); }
  return nav.push(nav.isRegistered('settings') ? 'settings' : 'playlists');
}
