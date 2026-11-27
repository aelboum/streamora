// Import progress overlay: starts PlaylistService.refresh, shows progress (throttled to 4 updates
// a second), lets the user cancel (button or Back), and shows the result or a plain-language error.
// No import logic here: the service does the work; this screen only presents it.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import { createFocusManager } from '../navigation/focus.ts';
import { createButtonList } from '../components/button-list.ts';
import type { ButtonList } from '../components/button-list.ts';
import type { PlaylistService, RefreshJob, RefreshResult } from '../services/playlist-service.ts';
import type { ImportProgress } from '../content/import-types.ts';
import type { Translate } from '../i18n/strings.ts';
import { clear, h } from '../utils/dom.ts';
import { httpStatusSuffix } from './format.ts';

export interface ImportDialogDeps {
  doc: Document;
  playlists: PlaylistService;
  t: Translate;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface ImportDialogParams {
  id: string;
  /** Called once with the final result (the details screen refreshes itself). */
  onFinished?: (r: RefreshResult) => void;
}

type Phase = 'running' | 'cancelling' | 'done';

const UPDATE_MS = 250;

export function createImportDialog(d: ImportDialogDeps, p: ImportDialogParams, nav: Router): Screen {
  const t = d.t;
  const def = d.playlists.get(p.id);
  const name = def ? def.name : '';
  let phase: Phase = 'running';
  let job: RefreshJob | null = null;
  let progress: ImportProgress | null = null;
  let startedAt = 0;
  let timer: unknown = null;
  let status: HTMLElement | null = null;
  let detail: HTMLElement | null = null;
  let buttonBox: HTMLElement | null = null;
  let buttons: ButtonList | null = null;
  let actions: Array<() => void> = [];
  let renders = 0;
  let alive = true;

  const focus = createFocusManager(function (_z, index, focused) { if (buttons) { buttons.setFocused(index, focused); } });
  focus.register({
    id: 'buttons', kind: 'row', size: function () { return buttons ? buttons.size() : 0; }, neighbours: {},
    onSelect: function (i) { if (actions[i]) { actions[i](); } }
  });

  function setButtons(labels: string[], run: Array<() => void>): void {
    if (!buttonBox) {
      return;
    }
    clear(buttonBox);
    buttons = createButtonList(d.doc, labels, true);
    actions = run;
    buttonBox.appendChild(buttons.element);
    focus.refresh('buttons');
    focus.focus('buttons', 0);
  }

  function seconds(): string {
    return String(Math.round((d.now() - startedAt) / 100) / 10);
  }

  function renderProgress(): void {
    timer = null;
    if (!alive || phase === 'done' || !status || !detail) {
      return;
    }
    renders++;
    const pr = progress;
    if (phase === 'cancelling') {
      status.textContent = t('import.cancelling');
    } else if (!pr) {
      status.textContent = t('import.connecting');
    } else if (pr.phase === 'store') {
      status.textContent = t('import.saving', { channels: pr.channels });
    } else {
      status.textContent = t('import.reading', { mb: (Math.round(pr.chars / 104857.6) / 10).toFixed(1), channels: pr.channels });
    }
    detail.textContent = t('import.elapsed', { s: seconds() });
    timer = d.setTimer(renderProgress, UPDATE_MS);
  }

  function cancel(): void {
    if (phase !== 'running' || !job) {
      return;
    }
    phase = 'cancelling';
    job.abort();
    if (status) { status.textContent = t('import.cancelling'); }
  }

  function start(): void {
    phase = 'running';
    progress = null;
    startedAt = d.now();
    job = d.playlists.refresh(p.id, function (pr) { progress = pr; });
    setButtons([t('import.cancel')], [cancel]);
    if (timer !== null) { d.clearTimer(timer); }
    renderProgress();
    job.result.then(finish);
  }

  function finish(r: RefreshResult): void {
    if (!alive) {
      return;
    }
    phase = 'done';
    if (timer !== null) {
      d.clearTimer(timer);
      timer = null;
    }
    if (!status || !detail) {
      return;
    }
    detail.className = 'ss-dialog__text';
    if (r.ok) {
      status.className = 'ss-dialog__status ss-tone--ok';
      status.textContent = r.unchanged
        ? t('import.unchanged', { channels: r.counts.live, s: Math.round(r.ms / 100) / 10 })
        : t('import.done', { channels: r.counts.live, categories: r.categories, s: Math.round(r.ms / 100) / 10 });
      detail.textContent = r.overBudget ? t('import.overBudget') : '';
      setButtons([t('common.close')], [function () { nav.closeOverlay(); }]);
    } else if (r.code === 'aborted') {
      status.className = 'ss-dialog__status';
      status.textContent = t('import.cancelled');
      detail.textContent = '';
      setButtons([t('common.close'), t('common.retry')], [function () { nav.closeOverlay(); }, start]);
    } else {
      status.className = 'ss-dialog__status ss-tone--error';
      status.textContent = t('import.failed') + ' ' + t('err.' + r.code) + httpStatusSuffix(r.code, r.message);
      // HTTP 884: the provider no longer serves M3U downloads (get.php); its Xtream login still works.
      detail.textContent = httpStatusSuffix(r.code, r.message) === ' (HTTP 884)' ? t('err.http884') + ' ' + t('import.keptOld') : t('import.keptOld');
      setButtons([t('common.close'), t('common.retry')], [function () { nav.closeOverlay(); }, start]);
    }
    if (p.onFinished) {
      p.onFinished(r);
    }
  }

  const screen: Screen & { renderCount(): number } = {
    mount: function (layer: HostLayer) {
      status = h(d.doc, 'div', { className: 'ss-dialog__status' });
      detail = h(d.doc, 'div', { className: 'ss-dialog__text ss-muted' });
      buttonBox = h(d.doc, 'div', { className: 'ss-dialog__buttons' });
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-dialog ss-dialog--import' }, [
        h(d.doc, 'div', { className: 'ss-dialog__title', text: t('import.title', { name: name }) }),
        status, detail, buttonBox
      ]));
      start();
    },
    onShow: function () { /* static */ },
    onHide: function () { /* static */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'left' || e.key === 'right') {
        focus.move(e.key);
      } else if (e.key === 'ok') {
        focus.select();
      }
      return true;
    },
    onBack: function () {
      // While running, Back cancels the import and keeps the dialog to show the outcome.
      if (phase === 'running') {
        cancel();
        return true;
      }
      return phase === 'cancelling';
    },
    destroy: function () {
      alive = false;
      if (phase === 'running' && job) {
        job.abort();
      }
      if (timer !== null) {
        d.clearTimer(timer);
        timer = null;
      }
    },
    renderCount: function () { return renders; }
  };
  return screen;
}
