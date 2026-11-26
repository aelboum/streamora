// DEV BUILDS ONLY — Stage 7F TV run (approved D3, 2026-11-25). Not referenced by release builds.
//   E9  library sample: 60 movies spread over "All". For each: the raw get_vod_info KEY NAMES and
//       whether a TMDB id / subtitle / audio field is present (values are not logged, except track
//       metadata such as codec and language), then the container probe (byte ranges only, at most
//       24 × 64 KB). No playback, no full download. Stream URLs and credentials are never logged.
//   E10 lab codec file (LAN lab server): one audio track per codec; AVPlay's list, then each track
//       selected in turn: does playback keep advancing, does AVPlay report an error.
//   E11 Live TV preview fix: slot classes and the logo's computed visibility while live, after a
//       re-render, after a channel change; rapid moves.
//   E12 movie controls: hidden 3 s after the picture although the position ticks; keys show them;
//       seek cursor and pause keep them; title and time texts.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import type { PlaybackSource } from '../models/content.ts';
import { probeSource } from '../player/media-probe.ts';
import type { ProbeResult } from '../player/media-probe.ts';
import { mergeProbe, bestAudioIds } from '../player/track-info.ts';
import { trackLabels } from '../screens/track-sheet.ts';
import { createTranslator } from '../i18n/strings.ts';

const LAB = 'http://192.168.1.180:8096/lab/';
const KEY: Record<string, number> = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 10009, info: 457 };
const SAMPLE = 60;

function wait(ms: number): Promise<void> { return new Promise<void>(function (r) { setTimeout(r, ms); }); }
function until(fn: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  return new Promise<boolean>(function (resolve) {
    function poll(): void {
      if (fn()) { resolve(true); return; }
      if (Date.now() - t0 > ms) { resolve(false); return; }
      setTimeout(poll, 25);
    }
    poll();
  });
}

function probeLine(r: ProbeResult | null): { audio: string[]; text: string[]; video: string; requests: number } {
  const out = { audio: [] as string[], text: [] as string[], video: '', requests: r ? r.requests : 0 };
  if (!r) { return out; }
  for (let i = 0; i < r.tracks.length; i++) {
    const t = r.tracks[i];
    if (t.kind === 'video') { out.video = t.codec; continue; }
    if (t.kind === 'audio') { out.audio.push((t.language || '?') + '/' + (t.codec || '?') + '/' + t.channels + 'ch' + (t.bitrate ? '/' + Math.round(t.bitrate / 1000) + 'k' : '')); continue; }
    out.text.push((t.language || '?') + '/' + (t.codec || '?') + (t.forced ? '/F' : ''));
  }
  return out;
}

function keysOf(o: unknown): string[] {
  if (!o || typeof o !== 'object' || o instanceof Array) { return []; }
  const k: string[] = [];
  for (const n in (o as Record<string, unknown>)) { if (Object.prototype.hasOwnProperty.call(o, n)) { k.push(n); } }
  k.sort();
  return k;
}

function nonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) { return false; }
  if (typeof v === 'string') { return v.replace(/\s+/g, '') !== '' && v !== '0'; }
  if (typeof v === 'number') { return v > 0; }
  if (v instanceof Array) { return v.length > 0; }
  if (typeof v === 'object') { return keysOf(v).length > 0; }
  return !!v;
}

/** Summary of an ffprobe-style object the panel may send (info.audio / info.video): codec, channels, language only. */
function streamSummary(v: unknown): string {
  if (!v || typeof v !== 'object') { return nonEmpty(v) ? typeof v : ''; }
  const o = v as Record<string, unknown>;
  const tags = (o.tags && typeof o.tags === 'object') ? o.tags as Record<string, unknown> : {};
  const parts: string[] = [];
  if (typeof o.codec_name === 'string') { parts.push(o.codec_name.slice(0, 12)); }
  if (typeof o.channels === 'number') { parts.push(o.channels + 'ch'); }
  if (typeof tags.language === 'string') { parts.push(tags.language.slice(0, 8)); }
  return parts.join('/') || 'object';
}

export function runStage7FSelfTest(platform: Platform, log: Logger, app?: DevApp): Promise<void> {
  const L = log.child('selftest7f');
  if (!app) { L.warn('7f skipped (no app)'); return Promise.resolve(); }
  const ctx = app.ctx;
  const engine = ctx.engine;
  const vod = ctx.vod;
  const svc = ctx.playlists;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  if (!engine || !vod || !svc) { L.warn('7f skipped (no engine/vod)'); return Promise.resolve(); }
  const eng = engine;
  const vodS = vod;
  const pid = svc.activeId() || '';
  const xf = platform.xhrFactory;
  const root = app.root;
  let playingSeen = false;
  let errorSeen = '';
  eng.on(function (e) {
    if (e.type === 'playing') { playingSeen = true; }
    if (e.type === 'error') { errorSeen = e.code; }
  });
  function mem(): number { return platform.memory().availableMB; }
  function errors(since: number): LogEntry[] {
    return log.entries().filter(function (e) { return e.t >= since && e.level === 'error'; });
  }
  function key(k: string): void {
    const ev = { keyCode: KEY[k], preventDefault: function () { /* */ } };
    kr.keyDown(ev);
    kr.keyUp(ev);
  }
  function first(cls: string): HTMLElement | null {
    const els = (root as HTMLElement).getElementsByClassName(cls);
    return els.length ? els[0] as HTMLElement : null;
  }
  function count(msg: string, comp: string, since: number): number {
    return log.entries().filter(function (e) { return e.t >= since && e.msg === msg && (e as unknown as { component?: string }).component === comp; }).length;
  }

  /** Raw get_vod_info, built from the resolved movie URL (credentials stay in memory, never logged). */
  function rawInfo(src: PlaybackSource): Promise<Record<string, unknown> | null> {
    const m = /^(https?:\/\/[^/]+)\/movie\/([^/]+)\/([^/]+)\/([^/.]+)\.[A-Za-z0-9]+$/.exec(src.url);
    if (!m) { return Promise.resolve(null); }
    const url = m[1] + '/player_api.php?username=' + m[2] + '&password=' + m[3] + '&action=get_vod_info&vod_id=' + m[4];
    return new Promise(function (resolve) {
      const x = xf();
      let done = false;
      function fin(v: Record<string, unknown> | null): void { if (!done) { done = true; resolve(v); } }
      x.timeout = 10000;
      x.onload = function () {
        if (x.status !== 200 || x.responseText.length > 2000000) { fin(null); return; }
        try { const v = JSON.parse(x.responseText); fin(v && typeof v === 'object' ? v as Record<string, unknown> : null); } catch (e) { fin(null); }
      };
      x.onerror = function () { fin(null); };
      x.ontimeout = function () { fin(null); };
      x.open('GET', url, true);
      x.send(null);
    });
  }

  // ---------------------------------------------------------------- E9
  function e9(): Promise<void> {
    return vodS.load(pid, 'movie').then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { L.warn('7f E9 no movies', { status: l.status }); return undefined; }
      const view = l.view;
      const at: number[] = [];
      for (let i = 0; i < SAMPLE; i++) { at.push(Math.floor((i + 0.5) * view.total / SAMPLE)); }
      return view.ensure(at).then(function () {
        let chain: Promise<void> = Promise.resolve();
        const keyCount: Record<string, number> = {};
        const tot = { movies: 0, info: 0, tmdb: 0, subsField: 0, audioField: 0, probed: 0, withText: 0, multiAudio: 0 };
        for (let i = 0; i < at.length; i++) {
          const p = at[i];
          chain = chain.then(function (): Promise<void> | undefined {
            const it = view.item(p);
            if (!it) { return undefined; }
            tot.movies++;
            return vodS.resolve(pid, vodS.movieRef(pid, it)).then(function (src): Promise<void> | undefined {
              if (!src) { L.info('7f E9 movie', { n: tot.movies, pos: p, src: 'none' }); return undefined; }
              const t0 = Date.now();
              return rawInfo(src).then(function (raw) {
                const info = raw && raw.info && typeof raw.info === 'object' ? raw.info as Record<string, unknown> : null;
                const md = raw && raw.movie_data && typeof raw.movie_data === 'object' ? raw.movie_data as Record<string, unknown> : null;
                const ik = keysOf(info);
                for (let k = 0; k < ik.length; k++) { keyCount[ik[k]] = (keyCount[ik[k]] || 0) + 1; }
                const tmdb = !!info && (nonEmpty(info.tmdb_id) || nonEmpty(info.tmdb));
                const subs = !!info && nonEmpty(info.subtitles);
                const audio = !!info && nonEmpty(info.audio);
                if (info) { tot.info++; }
                if (tmdb) { tot.tmdb++; }
                if (subs) { tot.subsField++; }
                if (audio) { tot.audioField++; }
                const infoMs = Date.now() - t0;
                const tp = Date.now();
                return probeSource(xf, src, 8000).then(function (pr) {
                  const s = probeLine(pr);
                  if (pr) { tot.probed++; }
                  if (s.text.length) { tot.withText++; }
                  if (s.audio.length > 1) { tot.multiAudio++; }
                  L.info('7f E9 movie', {
                    n: tot.movies, pos: p, title: it.name.slice(0, 60), year: it.year || 0, ext: src.type,
                    infoMs: infoMs, infoKeys: ik.length, movieDataKeys: keysOf(md).length,
                    tmdb: tmdb, tmdbNumeric: !!info && /^\d+$/.test(String(info.tmdb_id || info.tmdb || '')),
                    subsField: subs ? (info && info.subtitles instanceof Array ? 'array:' + (info.subtitles as unknown[]).length : typeof (info && info.subtitles)) : '',
                    audioField: info ? streamSummary(info.audio) : '', videoField: info ? streamSummary(info.video) : '',
                    probeMs: Date.now() - tp, container: pr ? pr.container : 'none', requests: s.requests,
                    video: s.video, audio: s.audio.join(' '), text: s.text.join(' '), memMB: mem()
                  });
                });
              });
            });
          });
        }
        return chain.then(function () {
          const kk = keysOf(keyCount);
          const keys: string[] = [];
          for (let i = 0; i < kk.length; i++) { keys.push(kk[i] + ':' + keyCount[kk[i]]); }
          L.info('7f E9 summary', { totals: tot, infoKeys: keys.join(' ').slice(0, 1800) });
        });
      });
    });
  }

  // ---------------------------------------------------------------- E10
  function e10(): Promise<void> {
    const src: PlaybackSource = { url: LAB + 'codecs.mkv', type: 'mkv', live: false } as PlaybackSource;
    const since = Date.now();
    playingSeen = false;
    errorSeen = '';
    eng.load(src, { bufferSec: 0 }).then(function () { /* */ }, function (c) { errorSeen = String(c); });
    return until(function () { return playingSeen || !!errorSeen; }, 20000).then(function (): Promise<void> {
      const tl = eng.tracks ? eng.tracks() : [];
      const list: string[] = [];
      for (let i = 0; i < tl.length; i++) { list.push(tl[i].kind[0] + '#' + tl[i].id + ':' + (tl[i].language || '?') + '/' + (tl[i].codec || '?') + '/' + (tl[i].channels || 0) + 'ch' + (tl[i].selected ? '*' : '')); }
      L.info('7f E10 lab tracks', { playing: playingSeen, err: errorSeen, avplay: list.join(' ') });
      return probeSource(xf, src, 8000).then(function (pr) {
        L.info('7f E10 lab probe', { probe: probeLine(pr).audio.join(' ') });
        const audio = tl.filter(function (t) { return t.kind === 'audio'; });
        let c: Promise<void> = Promise.resolve();
        for (let i = 0; i < audio.length; i++) {
          const a = audio[i];
          c = c.then(function () {
            errorSeen = '';
            const p0 = eng.timing ? eng.timing().positionMs : -1;
            if (eng.selectTrack) { eng.selectTrack('audio', a.id); }
            return wait(2500).then(function () {
              const p1 = eng.timing ? eng.timing().positionMs : -1;
              const now = eng.tracks ? eng.tracks() : [];
              let sel = '';
              for (let j = 0; j < now.length; j++) { if (now[j].kind === 'audio' && now[j].selected) { sel = String(now[j].id); } }
              L.info('7f E10 select', { track: a.id, codec: a.codec || '?', lang: a.language, selectedNow: sel, advancedMs: p1 - p0, state: eng.state(), err: errorSeen, errors: errors(since).length });
            });
          });
        }
        return c.then(function () { eng.stop(); });
      });
    });
  }

  // ---------------------------------------------------------------- E11
  function e11(): Promise<void> {
    const since = Date.now();
    router.resetTo('home');
    router.push('live-tv', { playlistId: pid });
    function slotState(): string {
      const s = first('ss-preview');
      const lg = first('ss-preview__logo');
      const vis = lg ? window.getComputedStyle(lg).visibility : '-';
      return (s ? s.className : 'no-slot') + ' | logo:' + vis + ' inline:' + (lg ? lg.style.visibility || '' : '-');
    }
    return until(function () { return log.entries().some(function (e) { return e.t >= since && e.msg === 'live tv ready'; }); }, 60000).then(function () {
      return until(function () { return count('live: playing', 'preview', since) > 0; }, 15000);
    }).then(function (ok) {
      return wait(500).then(function () {
        L.info('7f E11 live', { playing: ok, slot: slotState(), memMB: mem() });
        key('right');
        return wait(300);
      });
    }).then(function () {
      key('left');
      return wait(600);
    }).then(function () {
      L.info('7f E11 after re-render', { slot: slotState() });
      const t1 = Date.now();
      key('down');
      return wait(300).then(function () {
        L.info('7f E11 next channel (300 ms)', { slot: slotState() });
        return until(function () { return count('live: playing', 'preview', t1) > 0 || count('live: channel failed', 'preview', t1) > 0; }, 15000);
      }).then(function () {
        return wait(400).then(function () {
          L.info('7f E11 next channel settled', { playing: count('live: playing', 'preview', t1), failed: count('live: channel failed', 'preview', t1), slot: slotState(), memMB: mem() });
        });
      });
    }).then(function () {
      const t2 = Date.now();
      let c: Promise<void> = Promise.resolve();
      for (let i = 0; i < 10; i++) { c = c.then(function () { key('down'); return wait(150); }); }
      return c.then(function () { return wait(6000); }).then(function () {
        L.info('7f E11 rapid', { playingAfter: count('live: playing', 'preview', t2), failed: count('live: channel failed', 'preview', t2), slot: slotState(), errors: errors(since).length, memMB: mem() });
        key('back');
        return wait(500);
      }).then(function () {
        key('back');
        return wait(1500);
      }).then(function () {
        L.info('7f E11 leave', { top: router.stack().slice(-1)[0], engine: eng.state(), memMB: mem() });
      });
    });
  }

  // ---------------------------------------------------------------- E12
  function e12(): Promise<void> {
    return vodS.load(pid, 'movie').then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      const view = l.view;
      // Position 7000 of "All": an MP4 that played and seeks (Stage 7E run 1).
      return view.ensure([7000]).then(function (): Promise<void> | undefined {
        const it = view.item(7000);
        if (!it) { return undefined; }
        const since = Date.now();
        playingSeen = false;
        router.resetTo('home');
        router.push('vod-player', { playlistId: pid, ref: vodS.movieRef(pid, it), title: it.name, startMs: 0 });
        function bar(): string {
          const b = first('ss-vbar');
          return b ? (b.className.indexOf('is-hidden') >= 0 ? 'hidden' : 'shown') : 'none';
        }
        const seq: string[] = [];
        function at(label: string): void { seq.push(label + '=' + bar()); }
        return until(function () { return playingSeen; }, 30000).then(function (ok): Promise<void> {
          const tp = Date.now();
          seq.push('playing=' + ok);
          return wait(1500).then(function () { at('1.5s'); return wait(2100); }).then(function () {
            at('3.6s');
            L.info('7f E12 picture', { afterMs: Date.now() - tp, title: (first('ss-vbar__title') || { textContent: '' }).textContent, time: (first('ss-vbar__time--left') || { textContent: '' }).textContent, clock: !!first('ss-vbar__clock') });
            key('right'); // seek cursor
            return wait(200);
          }).then(function () { at('cursor'); return wait(3600); }).then(function () {
            at('cursor+3.6s');
            key('back'); // cancel
            return wait(3600);
          }).then(function () {
            at('cancel+3.6s');
            key('ok'); // pause
            return wait(3600);
          }).then(function () {
            at('paused+3.6s');
            key('ok'); // resume
            return wait(3600);
          }).then(function () {
            at('resumed+3.6s');
            L.info('7f E12 controls', { sequence: seq.join(' '), errors: errors(since).length, memMB: mem() });
            key('back');
            return wait(1000);
          }).then(function () {
            eng.stop();
            router.resetTo('home');
          });
        });
      });
    });
  }

  // ---------------------------------------------------------------- E13 (D5 run)
  // a) lab file (7 audio, AVPlay hides TrueHD): the same merge + label functions the panel uses;
  //    every listed track selected in turn.
  function e13lab(): Promise<void> {
    const src: PlaybackSource = { url: LAB + 'codecs.mkv', type: 'mkv', live: false } as PlaybackSource;
    const tr = createTranslator('en');
    playingSeen = false;
    errorSeen = '';
    eng.load(src, { bufferSec: 0 }).then(function () { /* */ }, function (c) { errorSeen = String(c); });
    return until(function () { return playingSeen || !!errorSeen; }, 20000).then(function () {
      return probeSource(xf, src, 8000);
    }).then(function (pr): Promise<void> {
      const raw = eng.tracks ? eng.tracks() : [];
      const merged = mergeProbe(raw, pr ? pr.tracks : null);
      const audio = merged.filter(function (x) { return x.kind === 'audio'; });
      const rawAudio = raw.filter(function (x) { return x.kind === 'audio'; });
      L.info('7f E13 lab labels', {
        fileAudio: pr ? pr.tracks.filter(function (x) { return x.kind === 'audio'; }).length : 0, playerAudio: rawAudio.length,
        before: trackLabels(tr, rawAudio, []).join(' | '), after: trackLabels(tr, audio, bestAudioIds(audio)).join(' | '),
        ids: audio.map(function (x) { return x.id; }).join(',')
      });
      let c: Promise<void> = Promise.resolve();
      for (let i = 0; i < audio.length; i++) {
        const a = audio[i];
        c = c.then(function () {
          const p0 = eng.timing ? eng.timing().positionMs : -1;
          if (eng.selectTrack) { eng.selectTrack('audio', a.id); }
          return wait(2000).then(function () {
            const now = eng.tracks ? eng.tracks() : [];
            let sel = -1;
            for (let j = 0; j < now.length; j++) { if (now[j].kind === 'audio' && now[j].selected) { sel = now[j].id; } }
            L.info('7f E13 lab select', { id: a.id, label: trackLabels(tr, [a], [])[0], selectedNow: sel, advancedMs: (eng.timing ? eng.timing().positionMs : -1) - p0, state: eng.state(), err: errorSeen });
          });
        });
      }
      return c.then(function () { eng.stop(); });
    });
  }

  // b) provider movies in the real VOD player: the Audio & subtitles panel rows (DOM), then the
  //    second audio row chosen in the panel: the engine's selected track and the position afterwards.
  function e13movie(pos: number, expect: string): Promise<void> {
    return vodS.load(pid, 'movie').then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      const view = l.view;
      return view.ensure([pos]).then(function (): Promise<void> | undefined {
        const it = view.item(pos);
        if (!it || it.name.indexOf(expect) < 0) { L.warn('7f E13 movie not at position', { pos: pos, found: it ? it.name.slice(0, 60) : '' }); return undefined; }
        const since = Date.now();
        playingSeen = false;
        router.resetTo('home');
        router.push('vod-player', { playlistId: pid, ref: vodS.movieRef(pid, it), title: it.name, startMs: 0 });
        function rows(): string[] {
          const els = (root as HTMLElement).getElementsByClassName('ss-tracks__name');
          const out: string[] = [];
          for (let i = 0; i < els.length; i++) { out.push((els[i] as HTMLElement).textContent || ''); }
          return out;
        }
        function selAudio(): number {
          const now = eng.tracks ? eng.tracks() : [];
          for (let j = 0; j < now.length; j++) { if (now[j].kind === 'audio' && now[j].selected) { return now[j].id; } }
          return -1;
        }
        return until(function () { return playingSeen; }, 30000).then(function (ok) {
          return wait(12000).then(function () { return ok; });
        }).then(function (ok) {
          let c: Promise<void> = Promise.resolve();
          const ks = ['info', 'down', 'right', 'right', 'ok'];
          for (let i = 0; i < ks.length; i++) { const k = ks[i]; c = c.then(function () { key(k); return wait(400); }); }
          return c.then(function () {
            const r = rows();
            const s0 = selAudio();
            const p0 = eng.timing ? eng.timing().positionMs : -1;
            // Another audio row: the panel opens on the selected one; from the last audio row go up.
            const aud = (eng.tracks ? eng.tracks() : []).filter(function (x) { return x.kind === 'audio'; });
            key(aud.length > 1 && aud[aud.length - 1].id === s0 ? 'up' : 'down');
            return wait(300).then(function () { key('ok'); return wait(3000); }).then(function () {
              L.info('7f E13 movie', {
                title: it.name.slice(0, 60), playing: ok, panelRows: r.length, panel: r.join(' | ').slice(0, 1600),
                selectedBefore: s0, selectedAfter: selAudio(), advancedMs: (eng.timing ? eng.timing().positionMs : -1) - p0,
                state: eng.state(), errors: errors(since).length, memMB: mem()
              });
              return keys2(['back', 'back'], 600);
            });
          }).then(function () { eng.stop(); router.resetTo('home'); });
        });
      });
    });
  }
  function keys2(list: string[], gap: number): Promise<void> {
    let c: Promise<void> = Promise.resolve();
    for (let i = 0; i < list.length; i++) { const k = list[i]; c = c.then(function () { key(k); return wait(gap); }); }
    return c;
  }
  // ---------------------------------------------------------------- E14 (Stage 7F-E subtitles)
  // Cue texts arrive through the engine's 'subtitle' event (AVPlay onsubtitlechange).
  let cues: string[] = [];
  eng.on(function (e) { if (e.type === 'subtitle' && e.text) { cues.push(e.text); } });
  /** Script classes and distinct accented Latin letters of cue text (the text itself is not logged). */
  function scriptInfo(list: string[]): string {
    const s = list.join(' ');
    const R: Array<[string, RegExp]> = [['latin', /[A-Za-z]/g], ['arabic', /[؀-ۿ]/g], ['greek', /[Ͱ-Ͽ]/g], ['hebrew', /[֐-׿]/g],
      ['cyrillic', /[Ѐ-ӿ]/g], ['thai', /[฀-๿]/g], ['hangul', /[가-힯]/g], ['kana', /[぀-ヿ]/g], ['cjk', /[一-鿿]/g]];
    const parts: string[] = [];
    for (let i = 0; i < R.length; i++) { const m = s.match(R[i][1]); if (m && m.length) { parts.push(R[i][0] + ':' + m.length); } }
    const acc: Record<string, boolean> = {};
    const am = s.match(/[À-ɏ]/g) || [];
    let accs = '';
    for (let i = 0; i < am.length && accs.length < 16; i++) { if (!acc[am[i]]) { acc[am[i]] = true; accs += am[i]; } }
    return parts.join(',') + (accs ? ' acc:' + accs : '');
  }
  function textIds(): number[] {
    const now = eng.tracks ? eng.tracks() : [];
    const out: number[] = [];
    for (let j = 0; j < now.length; j++) { if (now[j].kind === 'text') { out.push(now[j].id); } }
    return out;
  }
  /** Selects each listed subtitle track and records the cues it renders (lab marker "Sxx" or script). */
  function cueSweep(ids: number[], waitMs: number, lab: boolean): Promise<string[]> {
    const res: string[] = [];
    let c: Promise<void> = Promise.resolve();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      c = c.then(function () {
        if (eng.selectTrack) { eng.selectTrack('text', id); }
        // Run 1 showed AVPlay keeps delivering the previous track's cues for a few seconds after a
        // switch: let the switch settle, then record only cues that arrive afterwards.
        return wait(lab ? 4500 : 6000).then(function () {
          cues = [];
          return until(function () { return lab ? cues.length >= 2 : cues.length >= 3; }, waitMs);
        }).then(function () {
          if (lab) {
            const ms: string[] = [];
            for (let k = 0; k < cues.length; k++) { const m = /S(\d\d)/.exec(cues[k]); const v = m ? m[1] : '?'; if (ms.indexOf(v) < 0) { ms.push(v); } }
            res.push(id + ':' + (ms.join('/') || '-'));
          } else {
            res.push(id + ':' + cues.length + 'cues ' + (scriptInfo(cues) || '-'));
          }
        });
      });
    }
    return c.then(function () { if (eng.selectTrack) { eng.selectTrack('text', -1); } return res; });
  }
  function e14lab(file: string): Promise<void> {
    const src: PlaybackSource = { url: LAB + file, type: 'mkv', live: false } as PlaybackSource;
    const tr = createTranslator('en');
    playingSeen = false;
    errorSeen = '';
    eng.load(src, { bufferSec: 0 }).then(function () { /* */ }, function (c) { errorSeen = String(c); });
    return until(function () { return playingSeen || !!errorSeen; }, 20000).then(function () {
      return probeSource(xf, src, 8000);
    }).then(function (pr): Promise<void> {
      const raw = eng.tracks ? eng.tracks() : [];
      const merged = mergeProbe(raw, pr ? pr.tracks : null);
      const rawText = raw.filter(function (x) { return x.kind === 'text'; });
      const text = merged.filter(function (x) { return x.kind === 'text'; });
      const ids = textIds();
      return cueSweep(ids, 3500, true).then(function (map) {
        L.info('7f E14 lab', {
          file: file, fileText: pr ? pr.tracks.filter(function (x) { return x.kind === 'text'; }).length : 0, playerText: rawText.length,
          playerAudio: raw.filter(function (x) { return x.kind === 'audio'; }).length, rawLang: rawText.map(function (x) { return x.language || '-'; }).join(','),
          map: map.join(' '), labels: trackLabels(tr, text, []).join(' | ').slice(0, 2400), state: eng.state(), err: errorSeen, memMB: mem()
        });
        eng.stop();
      });
    });
  }
  /** A provider movie through the engine (no UI): every listed subtitle selected, cue scripts recorded. */
  function e14movie(pos: number, expect: string, startMs: number, waitMs: number): Promise<void> {
    const tr = createTranslator('en');
    return vodS.load(pid, 'movie').then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      const view = l.view;
      return view.ensure([pos]).then(function (): Promise<void> | undefined {
        const it = view.item(pos);
        if (!it || it.name.indexOf(expect) < 0) { L.warn('7f E14 movie not at position', { pos: pos, found: it ? it.name.slice(0, 60) : '' }); return undefined; }
        return vodS.resolve(pid, vodS.movieRef(pid, it)).then(function (s0): Promise<void> | undefined {
          if (!s0) { L.warn('7f E14 movie unresolved', { pos: pos }); return undefined; }
          const src: PlaybackSource = s0;
          playingSeen = false;
          errorSeen = '';
          eng.load(src, { bufferSec: 0, startMs: startMs }).then(function () { /* */ }, function (c) { errorSeen = String(c); });
          return until(function () { return playingSeen || !!errorSeen; }, 30000).then(function () {
            return probeSource(xf, src, 8000);
          }).then(function (pr) {
            const raw = eng.tracks ? eng.tracks() : [];
            const merged = mergeProbe(raw, pr ? pr.tracks : null);
            const text = merged.filter(function (x) { return x.kind === 'text'; });
            return cueSweep(textIds(), waitMs, false).then(function (map) {
              L.info('7f E14 movie', {
                title: it.name.slice(0, 60), fileText: pr ? probeLine(pr).text.join(' ') : '', playerText: raw.filter(function (x) { return x.kind === 'text'; }).length,
                map: map.join(' | ').slice(0, 3000), labels: trackLabels(tr, text, []).join(' | ').slice(0, 2400),
                state: eng.state(), err: errorSeen, memMB: mem()
              });
              eng.stop();
            });
          });
        });
      });
    });
  }
  /**
   * Verification in the real VOD player: the panel's rows (DOM), then subtitle row `row` (1-based)
   * chosen with keys: the engine's selected subtitle id and the script of the cues drawn afterwards.
   */
  function e14panel(pos: number, expect: string, startMs: number, row: number): Promise<void> {
    return vodS.load(pid, 'movie').then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      const view = l.view;
      return view.ensure([pos]).then(function (): Promise<void> | undefined {
        const it = view.item(pos);
        if (!it || it.name.indexOf(expect) < 0) { L.warn('7f E14 panel not at position', { pos: pos, found: it ? it.name.slice(0, 60) : '' }); return undefined; }
        const since = Date.now();
        playingSeen = false;
        router.resetTo('home');
        router.push('vod-player', { playlistId: pid, ref: vodS.movieRef(pid, it), title: it.name, startMs: startMs });
        function rows(): string[] {
          const els = (root as HTMLElement).getElementsByClassName('ss-tracks__name');
          const out: string[] = [];
          for (let i = 0; i < els.length; i++) { out.push((els[i] as HTMLElement).textContent || ''); }
          return out;
        }
        function selText(): number {
          const now = eng.tracks ? eng.tracks() : [];
          for (let j = 0; j < now.length; j++) { if (now[j].kind === 'text' && now[j].selected) { return now[j].id; } }
          return -1;
        }
        return until(function () { return playingSeen; }, 30000).then(function (ok) {
          return wait(12000).then(function () { return ok; });
        }).then(function (ok) {
          return keys2(['info', 'down', 'right', 'right', 'ok'], 400).then(function () {
            const r = rows();
            const aud = (eng.tracks ? eng.tracks() : []).filter(function (x) { return x.kind === 'audio'; });
            let s = 0;
            for (let j = 0; j < aud.length; j++) { if (aud[j].selected) { s = j; } }
            let drawnMax = 0;
            let drawnSamples = 0;
            const downs: string[] = [];
            for (let j = 0; j < aud.length - 1 - s + 1 + row; j++) { downs.push('down'); }
            return keys2(downs, 250).then(function () { key('ok'); return wait(6000); }).then(function () {
              cues = [];
              return until(function () {
                // What the app actually drew on screen (the overlay lines), not only what AVPlay handed over.
                const ls = (root as HTMLElement).getElementsByClassName('ss-subs__line');
                let n = 0;
                for (let q = 0; q < ls.length; q++) { n += ((ls[q] as HTMLElement).textContent || '').length; }
                if (n > drawnMax) { drawnMax = n; }
                if (n > 0) { drawnSamples++; }
                return cues.length >= 3 && drawnSamples > 0;
              }, 25000);
            }).then(function () {
              const subRows = r.slice(aud.length + 1);
              L.info('7f E14 panel', {
                title: it.name.slice(0, 60), playing: ok, subRows: subRows.length, panel: subRows.join(' | ').slice(0, 2400),
                chosenRow: row, chosenLabel: subRows[row - 1] || '', selectedText: selText(), cues: cues.length, script: scriptInfo(cues),
                drawnMaxChars: drawnMax, drawnSamples: drawnSamples,
                state: eng.state(), errors: errors(since).length, memMB: mem()
              });
              return keys2(['back', 'back'], 600);
            });
          }).then(function () { eng.stop(); router.resetTo('home'); });
        });
      });
    });
  }
  const RUN_E: string = 'verify';
  const RUN_D5 = false;

  L.info('7f start', { memMB: mem() });
  let beats = 0;
  const hb = setInterval(function () {
    beats++;
    L.info('7f beat', { n: beats, memMB: mem(), top: router.stack().slice(-1)[0] });
    if (beats > 400) { clearInterval(hb); }
  }, 5000);
  const run: Promise<void> = RUN_E === 'verify'
    ? e14lab('subs40.mkv').then(function () { return e14lab('subsorder.mkv'); }).then(function () { return e14lab('subsformats.mkv'); })
      .then(function () { return e14panel(51568, 'Do Not Disturb', 600000, 2); })
      .then(function () { return e14panel(51568, 'Do Not Disturb', 900000, 10); })
      .then(function () { return e14panel(51568, 'Do Not Disturb', 1200000, 16); })
      .then(function () { return e14panel(51568, 'Do Not Disturb', 1500000, 25); })
      .then(function () { return e14panel(53377, 'Hitman', 600000, 1); })
      .then(function () { return e14panel(11761, 'Les Malvenus', 600000, 1); })
      .then(function () { return e14panel(47949, 'Zohan', 600000, 3); })
    : RUN_E === 'discover'
    ? e14lab('subs40.mkv').then(function () { return e14lab('subsorder.mkv'); }).then(function () { return e14lab('subsformats.mkv'); })
      .then(function () { return e14movie(51568, 'Do Not Disturb', 600000, 15000); })
      .then(function () { return e14movie(53377, 'Hitman', 600000, 15000); })
      .then(function () { return e14movie(47949, 'Zohan', 600000, 20000); })
    : RUN_D5
    ? e13lab().then(function () { return e13movie(47949, 'Zohan'); }).then(function () { return e13movie(96803, 'Green Mile'); })
      .then(function () { return e13movie(51568, 'Do Not Disturb'); }).then(function () { return e13movie(11761, 'Les Malvenus'); })
    : e9().then(e10).then(e11).then(e12);
  return run.then(function () {
    clearInterval(hb);
    L.info('7f done', { memMB: mem() });
  }, function (e) {
    clearInterval(hb);
    L.warn('7f failed', undefined, e);
  });
}
