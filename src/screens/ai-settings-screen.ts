// Settings → AI Intelligence (AI-02 multi-provider). Same layout and remote navigation as Settings:
// rows under group headings, ▲▼ moves between rows that do something, OK acts, Back leaves.
//   AI              master switch
//   Privacy         consent per data-processing party (asks first, Cancel focused)
//   Providers       per provider: status; own API key (Gemini; personal use only); test; planned
//                   providers listed as "Planned" (never selectable)
//   Models          per implemented provider: load / refresh the model list
//   Task routing    per task: primary (and fallback when automatic fallback is on); OK steps through
//                   only the provider/model pairs that support the task
//   Fallback        automatic fallback switch (fallback still needs its own consent and capability)
//   Usage & costs   today's figures, per-provider budgets
//   Cache           clear cache / statistics; notes
// No AI feature exists yet in AI-02: routes prepare later stages. Everything is off by default.
// Keys and session tokens never appear on screen or in logs.
import type { HostLayer, Router, Screen } from '../navigation/router.ts';
import type { RemoteKeyEvent } from '../navigation/key-router.ts';
import type { Translate } from '../i18n/strings.ts';
import type { ConfirmParams } from './confirm-dialog.ts';
import type { OpenText } from './live-screens.ts';
import type { AiEngine } from '../ai/ai-engine.ts';
import type { AiProviderStatus, AiStatus } from '../ai/ai-manager.ts';
import { TASKS } from '../ai/ai-manager.ts';
import type { AiRouteRef } from '../ai/ai-settings.ts';
import type { AiConnectionResult } from '../ai/types.ts';
import { clear, h } from '../utils/dom.ts';

export interface AiSettingsDeps {
  doc: Document;
  t: Translate;
  ai: AiEngine;
  openText: OpenText;
}

interface Row { id: string; label: string; value: string; act: (() => void) | null }

const REQUEST_STEPS = [50, 150, 500, 1500];
const TOKEN_STEPS = [100000, 300000, 1000000, 3000000];

function n(v: number): string {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function nextOf(steps: number[], cur: number): number {
  for (let i = 0; i < steps.length; i++) { if (steps[i] > cur) { return steps[i]; } }
  return steps[0];
}

export function createAiSettingsScreen(d: AiSettingsDeps, nav: Router): Screen {
  const t = d.t;
  const ai = d.ai;
  const list = h(d.doc, 'div', { className: 'ss-set__list' });
  const note = h(d.doc, 'div', { className: 'ss-message ss-ai__note' });
  let rows: Row[] = [];
  let groups: Array<{ title: string; from: number }> = [];
  let focus = -1;
  let top = 0;
  const VISIBLE = 10;
  let status: AiStatus | null = null;
  const testing: Record<string, boolean> = {};
  const lastTest: Record<string, AiConnectionResult> = {};
  let alive = true;

  function setNote(text: string, kind?: 'error'): void {
    note.textContent = text;
    note.className = 'ss-message ss-ai__note' + (kind === 'error' ? ' ss-tone--error' : '');
  }

  function refresh(): void {
    ai.manager.status().then(function (s) {
      if (!alive) { return; }
      status = s;
      build();
      paint();
    }, function () { /* keep the previous state */ });
  }

  /** safeFirst: Cancel gets the initial focus (consent and removals), so OK alone never grants or deletes. */
  function confirm(title: string, text: string, label: string, run: () => void, safeFirst?: boolean): void {
    const act = { label: label, run: run };
    const cancel = { label: t('common.cancel') };
    const cp: ConfirmParams = { title: title, paragraphs: [text], buttons: safeFirst ? [cancel, act] : [act, cancel] };
    nav.openOverlay('confirm', cp as unknown as Record<string, unknown>);
  }

  function errorText(code: string | null): string {
    const key = 'ai.err.' + (code || 'unknown');
    const s = t(key);
    return s === key ? t('ai.err.unknown') : s;
  }

  function providerName(id: string): string {
    const desc = ai.registry.descriptor(id);
    return desc ? desc.name : id;
  }

  function refText(ref: AiRouteRef | null): string {
    if (!ref) { return t('ai.route.none'); }
    return providerName(ref.provider) + ' · ' + (ref.model || t('ai.modelAuto'));
  }

  function groupName(g: string): string {
    const key = 'ai.group.' + g;
    const s = t(key);
    return s === key ? g : s;
  }

  function configured(id: string): boolean {
    const a = ai.registry.adapter(id);
    return !!a && (!a.configured || a.configured());
  }

  function providerState(p: AiProviderStatus): string {
    const desc = p.descriptor;
    if (desc.status === 'planned') { return t('ai.prov.planned'); }
    if (!configured(desc.id)) { return t('ai.prov.notConfigured'); }
    if (testing[desc.id]) { return t('ai.testing'); }
    const lt = lastTest[desc.id];
    if (lt && !lt.ok) { return errorText(lt.code); }
    if (!p.hasCredential) { return desc.auth === 'user-session' ? t('ai.prov.notSignedIn') : t('ai.keyNotSet'); }
    if (lt && lt.ok) { return t('ai.testOk', { model: lt.model, ms: n(lt.latencyMs) }); }
    return p.verifiedAt ? t('ai.prov.verified') : t('ai.prov.notVerified');
  }

  function enterKey(provider: string): void {
    const a = ai.registry.adapter(provider);
    d.openText(nav, {
      title: t('ai.keyTitle', { provider: providerName(provider) }), value: '', mode: 'secret', maxLength: 200,
      onDone: function (v: string) {
        if (!v || !a) { return; }
        ai.settings.setCredential(provider, 'api-key', v, a.validKey || function () { return false; }).then(function () {
          ai.settings.clearVerified(provider);
          delete lastTest[provider];
          setNote(t('ai.keySaved'));
          refresh();
        }, function (e: unknown) {
          const m = e instanceof Error ? e.message : '';
          setNote(m === 'invalid-key-format' ? t('ai.keyInvalidFormat') : t('ai.keyNotSaved'), 'error');
        });
      }
    });
  }

  function runTest(provider: string): void {
    if (testing[provider]) { return; }
    testing[provider] = true;
    setNote(t('ai.testing'));
    build(); paint();
    ai.manager.testConnection(provider).then(function (r) {
      testing[provider] = false;
      lastTest[provider] = r;
      if (!alive) { return; }
      setNote(r.ok ? t('ai.testOkNote', { models: n(r.models) }) : errorText(r.code), r.ok ? undefined : 'error');
      refresh();
    });
  }

  function loadModels(provider: string): void {
    setNote(t('ai.modelsLoading'));
    ai.manager.refreshModels(provider).then(function (r) {
      if (!alive) { return; }
      setNote(r.ok ? t('ai.modelsLoaded', { n: n(r.models.length), provider: providerName(provider) }) : errorText(r.code), r.ok ? undefined : 'error');
      refresh();
    });
  }

  function stepRoute(task: typeof TASKS[number]['task'], slot: 'primary' | 'fallback'): void {
    const opts: Array<AiRouteRef | null> = [null];
    const all = ai.manager.routeOptions(task);
    const route = ai.settings.route(task);
    for (let i = 0; i < all.length; i++) {
      const o = all[i];
      if (slot === 'fallback' && route.primary && o.provider === route.primary.provider && o.model === route.primary.model) { continue; }
      opts.push(o);
    }
    const cur = route[slot];
    let at = 0;
    for (let i = 1; i < opts.length; i++) {
      const o = opts[i] as AiRouteRef;
      if (cur && o.provider === cur.provider && o.model === cur.model) { at = i; }
    }
    const next = opts[(at + 1) % opts.length];
    ai.settings.setRoute(task, slot, next, function (p) { return !!ai.registry.adapter(p); });
    if (opts.length === 1) { setNote(t('ai.route.noOptions')); }
    refresh();
  }

  function build(): void {
    // Keep the focus on the same row (by id) when rows appear or disappear above it.
    const keepId = focus >= 0 && focus < rows.length ? rows[focus].id : '';
    rows = [];
    groups = [];
    const s = ai.settings.get();
    const st = status;
    function group(title: string): void { groups.push({ title: title, from: rows.length }); }

    group(t('ai.sec.master'));
    rows.push({ id: 'ai-enabled', label: t('ai.enable'), value: s.enabled ? t('set.on') : t('set.off'), act: function () { ai.settings.setEnabled(!ai.settings.get().enabled); refresh(); } });

    // Privacy and consent: one row per data-processing party of implemented providers and their models.
    group(t('ai.sec.privacy'));
    const parties: string[] = [];
    const descs = ai.registry.descriptors();
    for (let i = 0; i < descs.length; i++) {
      if (descs[i].status !== 'implemented') { continue; }
      if (parties.indexOf(descs[i].dataGroup) < 0) { parties.push(descs[i].dataGroup); }
      const ms = ai.registry.models(descs[i].id) || [];
      for (let j = 0; j < ms.length; j++) { if (parties.indexOf(ms[j].dataGroup) < 0) { parties.push(ms[j].dataGroup); } }
    }
    for (let i = 0; i < parties.length; i++) {
      const g = parties[i];
      const on = ai.settings.hasConsent(g);
      rows.push({
        id: 'ai-consent-' + g, label: t('ai.consentFor', { party: groupName(g) }), value: on ? t('set.on') : t('set.off'),
        act: function () {
          if (ai.settings.hasConsent(g)) { ai.settings.setConsent(g, false); refresh(); return; }
          confirm(t('ai.consentTitle', { party: groupName(g) }), t('ai.consentText', { party: groupName(g) }), t('ai.consentAllow'), function () { ai.settings.setConsent(g, true); refresh(); }, true);
        }
      });
    }

    // Dev builds only: the experimental QR pairing UI test (never registered in release builds).
    if (nav.isRegistered('qr-pairing-test')) {
      rows.push({ id: 'ai-qr-test', label: 'Phone pairing test (experimental, fake keys only)', value: '', act: function () { nav.push('qr-pairing-test'); } });
    }
    group(t('ai.sec.providers'));
    const provs = st ? st.providers : [];
    for (let i = 0; i < provs.length; i++) {
      const p = provs[i];
      const desc = p.descriptor;
      if (desc.status === 'planned') {
        rows.push({ id: 'ai-prov-' + desc.id, label: desc.name, value: t('ai.prov.planned'), act: null });
        continue;
      }
      rows.push({ id: 'ai-prov-' + desc.id, label: desc.name + (desc.distributionSafe ? '' : ' ' + t('ai.prov.ownKeyTag')), value: providerState(p), act: null });
      if (desc.auth === 'api-key') {
        rows.push({ id: 'ai-key-' + desc.id, label: t('ai.keyRow', { provider: desc.name }), value: p.hasCredential ? (st && st.keyStore === 'session' ? t('ai.keySetSession') : t('ai.keySet')) : t('ai.keyNotSet'),
          act: st && st.keyStore !== 'none' ? (function (id) { return function () { enterKey(id); }; })(desc.id) : null });
        // Phone pairing (QR, end-to-end encrypted): only when a relay is configured.
        if (ai.pairing && st && st.keyStore !== 'none' && nav.isRegistered('ai-phone-pair')) {
          rows.push({ id: 'ai-pair-' + desc.id, label: t('pair.row', { provider: desc.name }), value: '', act: (function (id) {
            return function () {
              nav.push('ai-phone-pair', { provider: id, onSaved: function () { ai.settings.clearVerified(id); delete lastTest[id]; setNote(t('ai.keySaved')); } });
            };
          })(desc.id) });
        }
        if (p.hasCredential) {
          rows.push({
            id: 'ai-key-remove-' + desc.id, label: t('ai.keyRemove', { provider: desc.name }), value: '',
            act: (function (id, name) {
              return function () {
                confirm(t('ai.keyRemoveTitle', { provider: name }), t('ai.keyRemoveText'), t('ai.remove'), function () {
                  ai.settings.removeCredential(id, 'api-key').then(function () { ai.settings.clearVerified(id); delete lastTest[id]; refresh(); });
                }, true);
              };
            })(desc.id, desc.name)
          });
        }
      } else if (desc.auth === 'user-session') {
        rows.push({ id: 'ai-signin-' + desc.id, label: t('ai.signIn'), value: p.hasCredential ? t('ai.prov.signedIn') : t('ai.prov.signInLater'), act: null });
      }
      if (configured(desc.id)) {
        rows.push({ id: 'ai-test-' + desc.id, label: t('ai.test', { provider: desc.name }), value: '', act: (function (id) { return function () { runTest(id); }; })(desc.id) });
      }
    }

    group(t('ai.sec.models'));
    for (let i = 0; i < provs.length; i++) {
      const desc = provs[i].descriptor;
      if (desc.status !== 'implemented') { continue; }
      const cnt = provs[i].models;
      const ok = configured(desc.id);
      rows.push({ id: 'ai-models-' + desc.id, label: t('ai.modelsOf', { provider: desc.name }), value: !ok ? t('ai.prov.notConfigured') : cnt === null ? t('ai.modelsNotLoaded') : t('ai.modelsCount', { n: n(cnt) }),
        act: ok ? (function (id) { return function () { loadModels(id); }; })(desc.id) : null });
    }

    group(t('ai.sec.routing'));
    for (let i = 0; i < TASKS.length; i++) {
      const spec = TASKS[i];
      const r = ai.settings.route(spec.task);
      const label = t(spec.labelKey) + (spec.implemented ? '' : ' ' + t('ai.task.later', { stage: spec.stage }));
      rows.push({ id: 'ai-route-' + spec.task, label: label, value: refText(r.primary), act: (function (task) { return function () { stepRoute(task, 'primary'); }; })(spec.task) });
      if (s.fallbackEnabled) {
        rows.push({ id: 'ai-fallback-' + spec.task, label: t('ai.route.fallbackFor', { task: t(spec.labelKey) }), value: refText(r.fallback),
          act: (function (task) { return function () { stepRoute(task, 'fallback'); }; })(spec.task) });
      }
    }

    group(t('ai.sec.fallback'));
    rows.push({ id: 'ai-fallback', label: t('ai.fallback'), value: s.fallbackEnabled ? t('set.on') : t('set.off'), act: function () { ai.settings.setFallbackEnabled(!ai.settings.get().fallbackEnabled); refresh(); } });

    group(t('ai.sec.usage'));
    const u = ai.usage.stats();
    rows.push({ id: 'ai-requests', label: t('ai.requestsToday'), value: n(u.requests), act: null });
    rows.push({ id: 'ai-tokens', label: t('ai.tokensToday'), value: t('ai.tokensValue', { input: n(u.inputTokens), output: n(u.outputTokens) }), act: null });
    rows.push({ id: 'ai-errors', label: t('ai.errorsToday'), value: t('ai.errorsValue', { errors: n(u.errors), quota: n(u.quotaErrors), fallbacks: n(u.fallbacks) }), act: null });
    for (const pid in u.providers) {
      if (!Object.prototype.hasOwnProperty.call(u.providers, pid)) { continue; }
      const pu = u.providers[pid];
      rows.push({ id: 'ai-usage-' + pid, label: providerName(pid), value: t('ai.providerUsage', { requests: n(pu.requests), tokens: n(pu.inputTokens + pu.outputTokens) }) + (pu.pausedForMs > 0 ? ' · ' + t('ai.pausedFor', { s: n(Math.ceil(pu.pausedForMs / 1000)) }) : ''), act: null });
    }
    rows.push({ id: 'ai-budget-requests', label: t('ai.budgetRequests'), value: n(s.budget.dailyRequestsPerProvider),
      act: function () { ai.settings.setBudget({ dailyRequestsPerProvider: nextOf(REQUEST_STEPS, ai.settings.get().budget.dailyRequestsPerProvider) }); refresh(); } });
    rows.push({ id: 'ai-budget-tokens', label: t('ai.budgetTokens'), value: n(s.budget.dailyTokensPerProvider),
      act: function () { ai.settings.setBudget({ dailyTokensPerProvider: nextOf(TOKEN_STEPS, ai.settings.get().budget.dailyTokensPerProvider) }); refresh(); } });
    rows.push({ id: 'ai-costs-note', label: t('ai.costsNote'), value: '', act: null });

    group(t('ai.sec.cache'));
    const c = ai.cache.stats();
    rows.push({ id: 'ai-cache', label: t('ai.cacheStats'), value: t('ai.cacheValue', { entries: n(c.entries), hits: n(u.cacheHits), misses: n(u.cacheMisses) }), act: null });
    rows.push({
      id: 'ai-clear-cache', label: t('ai.clearCache'), value: '',
      act: function () { confirm(t('ai.clearCache'), t('ai.clearCacheText'), t('set.clear'), function () { ai.cache.clear().then(function () { refresh(); }); }); }
    });
    rows.push({
      id: 'ai-clear-usage', label: t('ai.clearUsage'), value: '',
      act: function () { confirm(t('ai.clearUsage'), t('ai.clearUsageText'), t('set.clear'), function () { ai.usage.clear(); refresh(); }); }
    });
    rows.push({ id: 'ai-note-key', label: t('ai.noteKey'), value: '', act: null });
    rows.push({ id: 'ai-note-terms', label: t('ai.noteTerms'), value: '', act: null });

    if (keepId) {
      for (let i = 0; i < rows.length; i++) { if (rows[i].id === keepId && rows[i].act) { focus = i; break; } }
    }
    if (focus < 0 || focus >= rows.length || !rows[focus].act) {
      let first = -1;
      for (let i = 0; i < rows.length; i++) { if (rows[i].act && (focus < 0 || i >= focus)) { first = i; break; } }
      if (first < 0) { for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].act) { first = i; break; } } }
      focus = first;
    }
  }

  function step(dir: number): void {
    let i = focus + dir;
    while (i >= 0 && i < rows.length && !rows[i].act) { i += dir; }
    if (i >= 0 && i < rows.length) { focus = i; }
  }

  function paint(): void {
    clear(list);
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
      list.appendChild(h(d.doc, 'div', { className: 'ss-set__row' + (ln.row === focus ? ' is-focused' : '') + (r.act ? '' : ' is-info'), attrs: { 'data-row': r.id } }, [
        h(d.doc, 'div', { className: 'ss-set__label', text: r.label }),
        h(d.doc, 'div', { className: 'ss-set__value', text: r.value })
      ]));
    }
  }

  return {
    mount: function (layer: HostLayer) {
      (layer.element as HTMLElement).appendChild(h(d.doc, 'div', { className: 'ss-live ss-set ss-ai' }, [
        h(d.doc, 'div', { className: 'ss-live__header' }, [h(d.doc, 'div', { className: 'ss-live__title', text: t('ai.title') })]),
        list, note
      ]));
      setNote(t('ai.intro'));
      build();
      paint();
      refresh();
    },
    onShow: function () { refresh(); },
    onHide: function () { /* nothing running */ },
    onKey: function (e: RemoteKeyEvent) {
      if (e.key === 'up' || e.key === 'down') { step(e.key === 'up' ? -1 : 1); }
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
    onBack: function () { return false; },
    destroy: function () { alive = false; }
  };
}
