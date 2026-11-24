// Playlist details: facts from the definition and the stored catalogue metadata, and the actions
// Update now / Edit / Use this playlist / Remove. "Update now" shows the HTTP warning first for an
// http:// playlist that hasn't been acknowledged, then the import dialog. Credentials are never shown.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { createFrame, createInfoList } from '../components/ui.ts';
import type { Frame, Tone } from '../components/ui.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { CatalogueMeta, PlaylistDef } from '../models/content.ts';
import type { Translate } from '../i18n/strings.ts';
import type { ConfirmParams } from './confirm-dialog.ts';
import type { ImportDialogParams } from './import-dialog.ts';
import { formatCount, formatDate, formatDateTime } from './format.ts';
import { h } from '../utils/dom.ts';

export interface DetailsDeps {
  doc: Document;
  playlists: PlaylistService;
  t: Translate;
}

export interface DetailsParams {
  id: string;
  /** Start an import right away (after adding a playlist). */
  autoRefresh?: boolean;
}

export function createPlaylistDetails(d: DetailsDeps, p: DetailsParams, nav: Router): Screen {
  const t = d.t;
  const info = createInfoList(d.doc);
  const buttons = createButtonList(d.doc, [t('details.refresh'), t('details.edit'), t('details.activate'), t('details.remove')], true);
  let frame: Frame | null = null;
  let meta: CatalogueMeta | null = null;
  let alive = true;
  let auto = !!p.autoRefresh;

  function render(): void {
    const def: PlaylistDef | null = d.playlists.get(p.id);
    if (!def) {
      info.setLines([]);
      return;
    }
    const st = def.lastStatus;
    const lines: Array<{ label: string; value: string; tone?: Tone }> = [
      { label: t('details.type'), value: t('kind.' + def.kind) },
      { label: t('details.server'), value: def.server },
      { label: t('details.format'), value: def.liveFormat === 'ts' ? t('form.format.ts') : t('form.format.m3u8') },
      {
        label: t('details.status'),
        value: !st ? t('playlists.neverLoaded') : st.ok ? t('details.ok') : t('err.' + (st.code || 'network')),
        tone: st && !st.ok ? 'error' : st ? 'ok' : 'normal'
      },
      { label: t('details.updated'), value: def.lastLoadedAt ? formatDateTime(def.lastLoadedAt) : t('details.never') }
    ];
    if (meta) {
      lines.push({ label: t('details.channels'), value: formatCount(meta.counts.live) });
      lines.push({ label: t('details.categories'), value: formatCount(meta.categories) });
      if (meta.counts.movie + meta.counts.series > 0) {
        lines.push({ label: t('details.other'), value: formatCount(meta.counts.movie + meta.counts.series) });
      }
      if (meta.counts.invalid + meta.counts.duplicate > 0) {
        lines.push({ label: t('details.skipped'), value: formatCount(meta.counts.invalid + meta.counts.duplicate) });
      }
    }
    if (st && st.expiresAt) {
      lines.push({ label: t('details.expires'), value: formatDate(st.expiresAt) });
    }
    if (st && st.maxConnections) {
      lines.push({ label: t('details.connections'), value: String(st.maxConnections) });
    }
    lines.push({ label: t('details.isActive'), value: d.playlists.activeId() === def.id ? t('playlists.active') : '—' });
    info.setLines(lines);
  }

  function loadMeta(): void {
    d.playlists.meta(p.id).then(function (m) {
      if (alive) {
        meta = m;
        render();
      }
    });
  }

  function openImport(): void {
    const ip: ImportDialogParams = { id: p.id, onFinished: function () { loadMeta(); render(); } };
    nav.openOverlay('import-dialog', ip as unknown as Record<string, unknown>);
  }

  function refresh(): void {
    if (!d.playlists.needsCleartextNotice(p.id)) {
      openImport();
      return;
    }
    const cp: ConfirmParams = {
      title: t('http.title'),
      paragraphs: [t('http.body'), t('http.body2')],
      variant: 'ss-dialog--warning',
      buttons: [
        { label: t('common.cancel') },
        { label: t('common.continue'), run: function () { d.playlists.markCleartextNoticeSeen(p.id); openImport(); } }
      ]
    };
    nav.openOverlay('confirm', cp as unknown as Record<string, unknown>);
  }

  function remove(): void {
    const def = d.playlists.get(p.id);
    const cp: ConfirmParams = {
      title: t('remove.title', { name: def ? def.name : '' }),
      paragraphs: [t('remove.body')],
      buttons: [
        { label: t('common.cancel') },
        { label: t('remove.confirm'), run: function () { d.playlists.remove(p.id).then(function () { if (alive) { nav.pop(); } }); } }
      ]
    };
    nav.openOverlay('confirm', cp as unknown as Record<string, unknown>);
  }

  const focus = createFocusManager(function (_z, index, focused) { buttons.setFocused(index, focused); });
  focus.register({
    id: 'actions', kind: 'row', size: function () { return buttons.size(); }, neighbours: {},
    onSelect: function (i) {
      if (i === 0) { refresh(); }
      if (i === 1) { nav.push('playlist-form', { mode: 'edit', id: p.id }); }
      if (i === 2) { d.playlists.setActive(p.id); render(); }
      if (i === 3) { remove(); }
    }
  });

  return {
    mount: function (layer: HostLayer) {
      const def = d.playlists.get(p.id);
      frame = createFrame(d.doc, t('app.title'), def ? def.name : '');
      frame.body.appendChild(h(d.doc, 'div', { className: 'ss-panel ss-panel--wide' }, [info.element, buttons.element]));
      (layer.element as HTMLElement).appendChild(frame.root);
      render();
      loadMeta();
      focus.focus('actions', 0);
    },
    onShow: function () {
      render();
      if (auto) {
        auto = false;
        refresh();
      }
    },
    onHide: function () { /* nothing running */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right' || e.key === 'up' || e.key === 'down') {
        return focus.move(e.key);
      }
      if (e.key === 'ok') {
        return focus.select();
      }
      return false;
    },
    onBack: function () { return false; },
    destroy: function () { alive = false; frame = null; }
  };
}
