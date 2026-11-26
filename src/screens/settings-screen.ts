// Settings (Stage 7B.2 part 3). One column of rows under group headings; every row does something real:
//   Accounts      Accounts and playlists → the playlist screen (add, edit, refresh, remove)
//   Language      English / Nederlands (applies at once; the screens are rebuilt in the new language)
//   Playback      Audio language, Subtitles: OK steps through the choices (used by the movie player)
//   History       Clear Continue watching and watched marks · Clear recent searches (both confirm first)
//   About         version, platform, screen, storage; Diagnostics opens the diagnostics screen
//   Parental     set up a PIN · Lock adult content (turning it off needs the PIN) · Lock again now ·
//                change PIN · new recovery code · remove PIN (all through the PIN dialog)
// Remote: ▲▼ rows (◀ → rail), OK acts, Back leaves.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { ProgressStore } from '../services/progress.ts';
import type { TrackPrefStore } from '../services/track-prefs.ts';
import { languageName, uiLanguage } from '../i18n/languages.ts';
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { Translate } from '../i18n/strings.ts';
import type { ConfirmParams } from './confirm-dialog.ts';
import { createRail } from '../components/rail.ts';
import type { Parental } from '../services/parental.ts';
import type { PinDialogParams, PinMode } from './pin-dialog.ts';
import { clear, h } from '../utils/dom.ts';

export type UiLanguage = 'en' | 'nl';

export interface SettingsDeps {
  doc: Document;
  t: Translate;
  playlists: PlaylistService;
  progress: ProgressStore | null;
  trackPrefs: TrackPrefStore | null;
  kv: KeyValueStore;
  language: () => UiLanguage;
  /** Stores the choice and rebuilds the screens in the new language. */
  setLanguage: (l: UiLanguage) => void;
  about: () => Array<{ label: string; value: string }>;
  /** S3: "Play last channel on app startup" (off by default); absent where Live TV cannot play. */
  resumeLast?: { get(): boolean; set(on: boolean): void };
  /** S2: subscription rows of a playlist (information only). */
  subscription?: (playlistId: string) => Array<{ label: string; value: string }>;
  /** Stage 7B.2 part 4 (null: no PIN support on this device). */
  parental?: Parental | null;
}

/** Languages offered for audio and subtitles (ISO 639-2); '' = stream default / subtitles off. */
export const TRACK_LANGS = ['', 'eng', 'nld', 'fra', 'deu', 'spa', 'ita', 'por', 'tur', 'ara', 'pol'];

interface Row { id: string; label: string; value: string; act: (() => void) | null }

export function createSettingsScreen(d: SettingsDeps, nav: Router): Screen {
  const t = d.t;
  const rail = createRail(d.doc, t, 'settings', nav, d.playlists);
  const list = h(d.doc, 'div', { className: 'ss-set__list' });
  let rows: Row[] = [];
  let groups: Array<{ title: string; from: number }> = [];
  let focus = 0;
  let inRail = false;
  let railIdx = rail.currentIndex();
  let top = 0;
  const VISIBLE = 11; // lines (rows and headings) that fit under the header

  function next(cur: string): string {
    const i = TRACK_LANGS.indexOf(cur);
    return TRACK_LANGS[(i + 1) % TRACK_LANGS.length];
  }

  function confirm(title: string, text: string, label: string, run: () => void): void {
    const cp: ConfirmParams = { title: title, paragraphs: [text], buttons: [{ label: label, run: run }, { label: t('common.cancel') }] };
    nav.openOverlay('confirm', cp as unknown as Record<string, unknown>);
  }

  function build(): void {
    rows = [];
    groups = [];
    const pid = d.playlists.activeId();
    const def = pid ? d.playlists.get(pid) : null;
    function group(title: string): void { groups.push({ title: title, from: rows.length }); }
    group(t('set.accounts'));
    rows.push({ id: 'accounts', label: t('set.accountsRow'), value: d.playlists.storageState().status === 'protected' ? t('set.storageProtected') : def ? def.name + ' · ' + t('set.accountCount', { n: d.playlists.list().length }) : t('home.noAccount'), act: function () { nav.push('playlists'); } });
    if (pid && def && d.subscription) {
      const sub = d.subscription(pid);
      for (let i = 0; i < sub.length; i++) { rows.push({ id: i === 0 ? 'subscription' : 'subscription-' + i, label: sub[i].label, value: sub[i].value, act: null }); }
    }
    group(t('set.language'));
    const langs: UiLanguage[] = ['en', 'nl'];
    for (let i = 0; i < langs.length; i++) {
      const l = langs[i];
      rows.push({ id: 'lang-' + l, label: l === 'en' ? 'English' : 'Nederlands', value: d.language() === l ? '✓' : '', act: function () { d.setLanguage(l); } });
    }
    const prefs = d.trackPrefs;
    if (prefs) {
      group(t('set.playback'));
      const p = prefs.get();
      rows.push({ id: 'audio', label: t('set.audioLang'), value: p.audio ? languageName(p.audio, uiLanguage(t)) : t('set.streamDefault'), act: function () { prefs.set({ audio: next(prefs.get().audio) }); } });
      rows.push({ id: 'subs', label: t('set.subLang'), value: p.text ? languageName(p.text, uiLanguage(t)) : t('vod.subsOff'), act: function () { prefs.set({ text: next(prefs.get().text) }); } });
    }
    const resume = d.resumeLast;
    if (resume) {
      if (!prefs) { group(t('set.playback')); }
      rows.push({ id: 'resume-last', label: t('set.resumeLast'), value: resume.get() ? t('set.on') : t('set.off'), act: function () { resume.set(!resume.get()); build(); paint(); } });
    }
    group(t('set.parental'));
    const par = d.parental;
    function pinFlow(mode: PinMode, after?: () => void): () => void {
      return function () {
        const pp: PinDialogParams = { mode: mode, onDone: function () { if (after) { after(); } build(); paint(); } };
        nav.openOverlay('pin-dialog', pp as unknown as Record<string, unknown>);
      };
    }
    if (!par || !par.available()) {
      rows.push({ id: 'pin-none', label: t('set.pinUnavailable'), value: '', act: null });
    } else if (!par.hasPin()) {
      rows.push({ id: 'pin-set', label: t('set.pinSet'), value: t('set.off'), act: pinFlow('set', function () { par.setLockAdult(true); par.relock(); }) });
    } else {
      const on = par.lockAdult();
      rows.push({
        id: 'lock-adult', label: t('set.lockAdult'), value: on ? t('set.on') : t('set.off'),
        act: on ? pinFlow('verify', function () { par.setLockAdult(false); }) : function () { par.setLockAdult(true); par.relock(); }
      });
      if (on && !par.locked()) {
        rows.push({ id: 'pin-relock', label: t('set.relock'), value: t('set.unlockedNow'), act: function () { par.relock(); } });
      }
      rows.push({ id: 'pin-change', label: t('set.pinChange'), value: '', act: pinFlow('change') });
      rows.push({ id: 'pin-recovery', label: t('set.pinRecovery'), value: '', act: pinFlow('recovery') });
      rows.push({ id: 'pin-remove', label: t('set.pinRemove'), value: '', act: pinFlow('remove') });
    }
    group(t('set.history'));
    const progress = d.progress;
    const n = progress && pid ? progress.list(pid).length : 0;
    rows.push({
      id: 'clear-progress', label: t('set.clearProgress'), value: pid ? t('set.titles', { n: n }) : '',
      act: progress && pid ? function () {
        confirm(t('set.clearProgressTitle'), t('set.clearProgressText'), t('set.clear'), function () { progress.clear(pid); build(); paint(); });
      } : null
    });
    rows.push({
      id: 'clear-searches', label: t('set.clearSearches'), value: '',
      act: function () { confirm(t('set.clearSearchesTitle'), t('set.clearSearchesText'), t('set.clear'), function () { d.kv.remove('search.recent'); }); }
    });
    group(t('set.about'));
    // S1: one focusable row opens the About screen (version shown as its value); the details moved there.
    const info = d.about();
    rows.push({
      id: 'about', label: t('set.aboutRow'), value: info.length ? info[0].value : '',
      act: nav.isRegistered('about') ? function () { nav.push('about'); } : null
    });
    if (nav.isRegistered('diagnostics')) {
      rows.push({ id: 'diagnostics', label: t('set.diagnostics'), value: '', act: function () { nav.push('diagnostics'); } });
    }
    if (focus >= rows.length) { focus = rows.length - 1; }
  }

  /** Focusable = rows with an action; info rows are skipped by ▲▼. */
  function step(dir: number): void {
    let i = focus + dir;
    while (i >= 0 && i < rows.length && !rows[i].act) { i += dir; }
    if (i >= 0 && i < rows.length) { focus = i; }
  }

  function paint(): void {
    rail.setFocused(railIdx, inRail);
    rail.setOpen(inRail);
    clear(list);
    // Keep the focused row in view (whole rows, headings count as rows of their own).
    const lines: Array<{ head?: string; row?: number }> = [];
    let g = 0;
    for (let i = 0; i < rows.length; i++) {
      while (g < groups.length && groups[g].from === i) { lines.push({ head: groups[g].title }); g++; }
      lines.push({ row: i });
    }
    let at = 0;
    for (let i = 0; i < lines.length; i++) { if (lines[i].row === focus) { at = i; } }
    if (at < top) { top = Math.max(0, at - 1); }
    if (at >= top + VISIBLE) { top = at - VISIBLE + 1; }
    for (let i = top; i < lines.length && i < top + VISIBLE + 1; i++) {
      const ln = lines[i];
      if (ln.head !== undefined) {
        list.appendChild(h(d.doc, 'div', { className: 'ss-set__head', text: ln.head }));
        continue;
      }
      const r = rows[ln.row as number];
      const f = !inRail && ln.row === focus;
      list.appendChild(h(d.doc, 'div', { className: 'ss-set__row' + (f ? ' is-focused' : '') + (r.act ? '' : ' is-info'), attrs: { 'data-row': r.id } }, [
        h(d.doc, 'div', { className: 'ss-set__label', text: r.label }),
        h(d.doc, 'div', { className: 'ss-set__value', text: r.value })
      ]));
    }
  }

  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(rail.element);
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-set' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [h(d.doc, 'div', { className: 'ss-live__title', text: t('nav.settings') })]),
        list
      ]));
      build();
      focus = 0;
      paint();
    },
    onShow: function () { build(); paint(); },
    onHide: function () { /* nothing running */ },
    onKey: function (e: RemoteKeyEvent) {
      if (inRail) {
        if (e.key === 'up' || e.key === 'down') { railIdx = Math.max(0, Math.min(rail.size() - 1, railIdx + (e.key === 'up' ? -1 : 1))); }
        else if (e.key === 'right') { inRail = false; }
        else if (e.key === 'ok') { if (!rail.select(railIdx)) { inRail = false; } else { return true; } }
        else { return false; }
        paint();
        return true;
      }
      if (e.key === 'up' || e.key === 'down') { step(e.key === 'up' ? -1 : 1); }
      else if (e.key === 'left') { inRail = true; railIdx = rail.currentIndex(); }
      else if (e.key === 'ok') {
        const r = rows[focus];
        if (r && r.act) {
          r.act();
          if (!nav.overlay()) { build(); }
        }
      } else { return false; }
      paint();
      return true;
    },
    onBack: function () {
      if (inRail) { inRail = false; paint(); return true; }
      return false;
    },
    destroy: function () { /* nothing */ }
  };
}
