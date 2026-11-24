// Add M3U / add Xtream / edit playlist. Fields are rows; OK on a text row opens the on-screen
// keyboard, OK on the format row toggles it. Validation and storage are the PlaylistService's job:
// this screen only collects values and shows the service's error code as a message.
//
// Credentials are never read back: when editing, the username, password and M3U address show
// "Unchanged" and are only sent to the service if the user typed a replacement. Displayed URLs
// have their credential parts masked.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import { createFrame, createRowList, setMessage } from '../components/ui.ts';
import type { Frame, Row } from '../components/ui.ts';
import type { PlaylistChanges, PlaylistService, SaveDefResult } from '../services/playlist-service.ts';
import { MAX_PLAYLISTS } from '../services/playlist-service.ts';
import type { LiveFormat, PlaylistDef } from '../models/content.ts';
import type { KeyboardMode, KeyboardParams } from './keyboard-overlay.ts';
import type { Translate } from '../i18n/strings.ts';
import { maskUrl } from './format.ts';
import { h } from '../utils/dom.ts';

export type FormMode = 'add-m3u' | 'add-xtream' | 'edit';

export interface FormDeps {
  doc: Document;
  playlists: PlaylistService;
  t: Translate;
  /** Opens text entry: the system IME where preferred, else the app keyboard (Stage 5). */
  openText?: (nav: Router, p: KeyboardParams) => void;
}

export interface FormParams {
  mode: FormMode;
  id?: string;
}

type FieldId = 'name' | 'url' | 'server' | 'username' | 'password' | 'epg' | 'format';

interface Field {
  id: FieldId;
  label: string;
  kind: KeyboardMode | 'choice';
  max: number;
  /** For edit: credential fields start as "unchanged". */
  credential: boolean;
}

export function createPlaylistForm(d: FormDeps, p: FormParams, nav: Router): Screen {
  const t = d.t;
  const existing: PlaylistDef | null = p.mode === 'edit' && p.id ? d.playlists.get(p.id) : null;
  const kind = p.mode === 'add-xtream' || (existing && existing.kind === 'xtream') ? 'xtream' : 'm3u';
  const editing = p.mode === 'edit';
  const fields: Field[] = [{ id: 'name', label: t('form.name'), kind: 'text', max: 64, credential: false }];
  if (kind === 'm3u') {
    fields.push({ id: 'url', label: t('form.url'), kind: 'url', max: 2048, credential: true });
  } else {
    fields.push({ id: 'server', label: t('form.server'), kind: 'url', max: 256, credential: false });
    fields.push({ id: 'username', label: t('form.username'), kind: 'text', max: 256, credential: true });
    fields.push({ id: 'password', label: t('form.password'), kind: 'secret', max: 256, credential: true });
  }
  fields.push({ id: 'epg', label: t('form.epg'), kind: 'url', max: 2048, credential: false });
  fields.push({ id: 'format', label: t('form.format'), kind: 'choice', max: 0, credential: false });

  const values: Record<string, string> = { name: '', url: '', server: '', username: '', password: '', epg: '' };
  const touched: Record<string, boolean> = {};
  let format: LiveFormat = 'ts';
  if (existing) {
    values.name = existing.name;
    values.server = existing.server;
    values.epg = existing.epgUrl || '';
    format = existing.liveFormat;
  }
  let saving = false;
  let frame: Frame | null = null;
  const list = createRowList(d.doc, 'ss-rows--form');
  const buttons = createButtonList(d.doc, [t('common.save'), t('common.cancel')], true);

  function display(f: Field): Row {
    if (f.kind === 'choice') {
      return { primary: f.label, secondary: format === 'ts' ? t('form.format.ts') : t('form.format.m3u8') };
    }
    const v = values[f.id];
    if (editing && f.credential && !touched[f.id]) {
      return { primary: f.label, secondary: t('form.unchanged') };
    }
    if (!v) {
      return { primary: f.label, secondary: t('form.empty') };
    }
    if (f.kind === 'secret') {
      let dots = '';
      for (let i = 0; i < v.length && i < 32; i++) { dots += '•'; }
      return { primary: f.label, secondary: dots };
    }
    return { primary: f.label, secondary: f.kind === 'url' ? maskUrl(v) : v };
  }

  function render(): void {
    const rows: Row[] = [];
    for (let i = 0; i < fields.length; i++) {
      rows.push(display(fields[i]));
    }
    list.setRows(rows);
  }

  function edit(i: number): void {
    const f = fields[i];
    if (f.kind === 'choice') {
      format = format === 'ts' ? 'm3u8' : 'ts';
      render();
      return;
    }
    const kp: KeyboardParams = {
      title: f.label,
      // A credential is never pre-filled when editing: the user types a full replacement.
      value: editing && f.credential && !touched[f.id] ? '' : values[f.id],
      mode: f.kind,
      maxLength: f.max,
      onDone: function (v) {
        values[f.id] = v;
        touched[f.id] = true;
        render();
        focus.focus('fields', i);
      }
    };
    if (d.openText) {
      d.openText(nav, kp);
    } else {
      nav.openOverlay('keyboard', kp as unknown as Record<string, unknown>);
    }
  }

  function errorText(r: SaveDefResult): string {
    if (r.ok) {
      return '';
    }
    return t('form.err.' + r.code, { max: MAX_PLAYLISTS });
  }

  function save(): void {
    if (saving || !frame) {
      return;
    }
    saving = true;
    setMessage(frame.message, t('form.saving'));
    let pending: Promise<SaveDefResult>;
    if (!editing) {
      pending = d.playlists.add(kind === 'm3u'
        ? { name: values.name, kind: 'm3u', url: values.url, epgUrl: values.epg, liveFormat: format }
        : { name: values.name, kind: 'xtream', server: values.server, username: values.username, password: values.password, epgUrl: values.epg, liveFormat: format });
    } else {
      const ch: PlaylistChanges = { name: values.name, epgUrl: values.epg ? values.epg : null, liveFormat: format };
      if (kind === 'm3u' && touched.url) { ch.url = values.url; }
      if (kind === 'xtream') {
        if (existing && values.server !== existing.server) { ch.server = values.server; }
        if (touched.username) { ch.username = values.username; }
        if (touched.password) { ch.password = values.password; }
      }
      pending = d.playlists.update(p.id || '', ch);
    }
    pending.then(function (r) {
      saving = false;
      if (!frame) {
        return;
      }
      if (!r.ok) {
        setMessage(frame.message, errorText(r), 'error');
        return;
      }
      // Forget typed credentials as soon as they are stored.
      values.password = '';
      values.username = '';
      values.url = '';
      if (editing) {
        nav.pop();
      } else {
        nav.replace('playlist-details', { id: r.playlist.id, autoRefresh: true });
      }
    });
  }

  const focus = createFocusManager(function (zone, index, focused) {
    if (zone === 'fields') { list.setFocused(index, focused); } else { buttons.setFocused(index, focused); }
  });
  focus.register({ id: 'fields', kind: 'column', size: function () { return list.size(); }, neighbours: { down: 'buttons' }, onSelect: edit });
  focus.register({
    id: 'buttons', kind: 'row', size: function () { return buttons.size(); }, neighbours: { up: 'fields' },
    onSelect: function (i) { if (i === 0) { save(); } else { nav.pop(); } }
  });

  return {
    mount: function (layer: HostLayer) {
      const title = editing ? t('form.edit') : kind === 'm3u' ? t('form.addM3u') : t('form.addXtream');
      frame = createFrame(d.doc, t('app.title'), title);
      frame.body.appendChild(h(d.doc, 'div', { className: 'ss-panel ss-panel--wide' }, [list.element, buttons.element]));
      (layer.element as HTMLElement).appendChild(frame.root);
      render();
      focus.focus('fields', 0);
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
    onBack: function () { return false; }, // router pops = cancel
    destroy: function () {
      values.password = '';
      values.username = '';
      values.url = '';
      frame = null;
    }
  };
}
