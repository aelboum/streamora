// Playlist overview (Settings → Accounts, All accounts). Top row: Live TV / Movies / Series when
// active, Diagnostics (adding an account is on the home screen). Below: one row per
// playlist with its type, server host and last status. OK on a playlist opens its details.
// Back at the root opens the exit dialog (router root-back handler).
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { createFrame, createRowList } from '../components/ui.ts';
import type { Frame, Row } from '../components/ui.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { PlaylistDef } from '../models/content.ts';
import type { Translate } from '../i18n/strings.ts';
import { formatDateTime } from './format.ts';
import { h } from '../utils/dom.ts';

export interface PlaylistsDeps {
  doc: Document;
  playlists: PlaylistService;
  t: Translate;
  /** Live TV screens are registered (Stage 5). */
  live?: boolean;
  /** Movie and series screens are registered (Stage 6); shown for an active Xtream playlist. */
  vod?: boolean;
}

export function playlistRow(def: PlaylistDef, activeId: string | null, t: Translate): Row {
  const host = def.server.replace(/^https?:\/\//, '');
  let status: string;
  let tone: Row['tone'] = 'normal';
  if (def.lastStatus && !def.lastStatus.ok) {
    status = t('playlists.failed', { reason: t('err.' + (def.lastStatus.code || 'network')) });
    tone = 'error';
  } else if (def.lastLoadedAt) {
    status = t('playlists.loadedAt', { when: formatDateTime(def.lastLoadedAt) });
  } else {
    status = t('playlists.neverLoaded');
  }
  const r: Row = { primary: def.name, secondary: t('kind.' + def.kind) + ' · ' + host + ' · ' + status, tone: tone };
  if (def.id === activeId) {
    r.badge = t('playlists.active');
  }
  return r;
}

export function createPlaylistsScreen(d: PlaylistsDeps, nav: Router): Screen {
  const t = d.t;
  let actionIds: string[] = [];
  let actions = createButtonList(d.doc, [], true);
  const actionBox = h(d.doc, 'div', { className: 'ss-actions' });
  const list = createRowList(d.doc);
  let defs: PlaylistDef[] = [];
  let frame: Frame | null = null;
  let empty: HTMLElement | null = null;

  const focus = createFocusManager(function (zone, index, focused) {
    if (zone === 'actions') { actions.setFocused(index, focused); } else { list.setFocused(index, focused); }
  });
  focus.register({
    id: 'actions', kind: 'row', size: function () { return actions.size(); }, neighbours: { down: 'list' },
    onSelect: function (i) {
      const a = actionIds[i];
      if (a === 'live') { const id = d.playlists.activeId(); if (id) { nav.push('live-tv', { playlistId: id }); } }
      if (a === 'movies' || a === 'series') {
        const vid = d.playlists.activeId();
        if (vid) { nav.push('vod-browse', { playlistId: vid, section: a === 'movies' ? 'movie' : 'series' }); }
      }
      if (a === 'm3u') { nav.push('playlist-form', { mode: 'add-m3u' }); }
      if (a === 'xtream') { nav.push('playlist-form', { mode: 'add-xtream' }); }
      if (a === 'diag') { nav.push('diagnostics'); }
    }
  });
  focus.register({
    id: 'list', kind: 'column', size: function () { return list.size(); }, neighbours: { up: 'actions' }, fallback: 'actions',
    onSelect: function (i) { if (defs[i]) { nav.push('playlist-details', { id: defs[i].id }); } }
  });

  function renderActions(active: string | null): void {
    const activeDef = active ? d.playlists.get(active) : null;
    const vod = !!(d.vod && activeDef && activeDef.kind === 'xtream');
    // Adding an account is on the home screen ("Add account"); this list only manages them.
    const ids = (active && d.live ? ['live'] : []).concat(vod ? ['movies', 'series'] : []).concat(['diag']);
    if (ids.join() === actionIds.join()) {
      return;
    }
    const labels: Record<string, string> = { live: t('playlists.liveTv'), movies: t('playlists.movies'), series: t('playlists.series'), m3u: t('playlists.addM3u'), xtream: t('playlists.addXtream'), diag: t('playlists.diagnostics') };
    actionIds = ids;
    const cur = focus.current();
    while (actionBox.firstChild) { actionBox.removeChild(actionBox.firstChild); }
    actions = createButtonList(d.doc, ids.map(function (x) { return labels[x]; }), true);
    actionBox.appendChild(actions.element);
    if (cur && cur.zone === 'actions') {
      focus.refresh('actions');
      actions.setFocused(Math.min(cur.index, ids.length - 1), true);
    }
  }

  function render(): void {
    defs = d.playlists.list();
    const active = d.playlists.activeId();
    renderActions(active);
    const rows: Row[] = [];
    for (let i = 0; i < defs.length; i++) {
      rows.push(playlistRow(defs[i], active, t));
    }
    list.setRows(rows);
    if (empty) {
      // DI-1: an unreadable list is never presented as "no playlists yet".
      empty.textContent = defs.length ? '' : d.playlists.storageState().status === 'protected' ? t('playlists.protected') : t('playlists.empty');
    }
    focus.refresh('list');
    const cur = focus.current();
    if (cur && cur.zone === 'list') {
      list.setFocused(cur.index, true);
    }
  }

  return {
    mount: function (layer: HostLayer) {
      frame = createFrame(d.doc, t('app.title'), t('playlists.title'));
      empty = h(d.doc, 'div', { className: 'ss-empty' });
      renderActions(d.playlists.activeId());
      frame.body.appendChild(actionBox);
      frame.body.appendChild(empty);
      frame.body.appendChild(list.element);
      (layer.element as HTMLElement).appendChild(frame.root);
      render();
      if (defs.length) { focus.focus('list', 0); } else { focus.focus('actions', 0); }
    },
    onShow: function () { render(); },
    onHide: function () { /* nothing running */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'up' || e.key === 'down' || e.key === 'left' || e.key === 'right') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      return false;
    },
    onBack: function () { return false; },
    destroy: function () { frame = null; empty = null; }
  };
}
