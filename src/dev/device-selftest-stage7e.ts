// DEV BUILDS ONLY — temporary Stage 7E experiments (removed after the TV run).
//   E1 lab tracks: AVPlay's raw track info vs the container probe on synthetic multi-language files;
//   E2 provider tracks: the same on real provider movies (metadata only; URLs never logged);
//   E3 preview frames: a hidden HTML5 <video> seeks and is drawn to a canvas while AVPlay plays —
//      does it work, how fast, does AVPlay keep playing (lab file with colour-coded 10 s segments,
//      then a provider movie);
//   E4 live mini window: AVPlay in a 556×313 rectangle while Live TV is shown;
//   E5 Live TV key fuzz on the real playlist: random remote keys, uncaught errors, memory.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import type { PlaybackSource } from '../models/content.ts';
import { probeSource } from '../player/media-probe.ts';
import type { ProbeResult } from '../player/media-probe.ts';

const LAB = 'http://192.168.1.180:8096/lab/';
const KEY: Record<string, number> = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 10009, chUp: 427, chDown: 428, info: 457 };

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

function summary(r: ProbeResult | null): string {
  if (!r) { return 'none'; }
  const parts: string[] = [];
  for (let i = 0; i < r.tracks.length; i++) {
    const t = r.tracks[i];
    if (t.kind === 'video') { parts.push('v:' + t.codec); continue; }
    parts.push(t.kind[0] + ':' + (t.language || '?') + '/' + (t.codec || '?') + (t.kind === 'audio' ? '/' + t.channels + 'ch/' + Math.round(t.bitrate / 1000) + 'k' : '') + (t.forced ? '/F' : '') + (t.name ? '/"' + t.name.slice(0, 20) + '"' : ''));
  }
  return r.container + ' req=' + r.requests + ' ' + parts.join(' ');
}

export function runStage7ESelfTest(platform: Platform, log: Logger, app?: DevApp): Promise<void> {
  const L = log.child('selftest7e');
  if (!app) { L.warn('7e skipped (no app)'); return Promise.resolve(); }
  const ctx = app.ctx;
  const engine = ctx.engine;
  const vod = ctx.vod;
  const svc = ctx.playlists;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  if (!engine || !vod || !svc) { L.warn('7e skipped (no engine/vod)'); return Promise.resolve(); }
  const eng = engine;
  const vodS = vod;
  const svcS = svc;
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
  function pos(): number { return eng.timing ? eng.timing().positionMs : -1; }
  function errors(since: number): LogEntry[] {
    return log.entries().filter(function (e) { return e.t >= since && e.level === 'error'; });
  }
  function play(src: PlaybackSource, bufferSec: number): Promise<{ ok: boolean; ms: number }> {
    playingSeen = false;
    errorSeen = '';
    const t0 = Date.now();
    eng.load(src, { bufferSec: bufferSec }).then(function () { /* */ }, function (c) { errorSeen = String(c); });
    return until(function () { return playingSeen || !!errorSeen; }, 20000).then(function () {
      return { ok: playingSeen, ms: Date.now() - t0 };
    });
  }
  function trackLine(): string {
    const ts = eng.tracks ? eng.tracks() : [];
    const out: string[] = [];
    for (let i = 0; i < ts.length; i++) { out.push(ts[i].kind[0] + '#' + ts[i].id + ':' + (ts[i].language || '?') + (ts[i].selected ? '*' : '')); }
    return out.join(' ');
  }

  // ---------------------------------------------------------------- E1
  function e1(): Promise<void> {
    const files = ['lang-long.mp4', 'lang-long.mkv'];
    let chain: Promise<void> = Promise.resolve();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      chain = chain.then(function () {
        const src: PlaybackSource = { url: LAB + f, type: (f.split('.').pop() || 'other') as PlaybackSource['type'], live: false };
        const tp = Date.now();
        return probeSource(xf, src, 8000).then(function (pr) {
          const probeMs = Date.now() - tp;
          return play(src, 0).then(function (r) {
            return wait(1500).then(function () {
              const before = trackLine();
              const ts = eng.tracks ? eng.tracks() : [];
              const sw: string[] = [];
              let c2: Promise<void> = Promise.resolve();
              for (let k = 0; k < ts.length; k++) {
                const t = ts[k];
                if (t.kind !== 'audio') { continue; }
                c2 = c2.then(function () {
                  if (eng.selectTrack) { eng.selectTrack('audio', t.id); }
                  return wait(1200).then(function () {
                    const now = eng.tracks ? eng.tracks() : [];
                    let sel = -1;
                    for (let q = 0; q < now.length; q++) { if (now[q].kind === 'audio' && now[q].selected) { sel = now[q].id; } }
                    sw.push(t.id + '->' + sel);
                  });
                });
              }
              return c2.then(function () {
                L.info('7e E1 lab tracks', { file: f, playing: r.ok, startMs: r.ms, probeMs: probeMs, probe: summary(pr), avplay: before, audioSwitch: sw.join(' ') });
                eng.stop();
              });
            });
          });
        });
      });
    }
    return chain;
  }

  // ---------------------------------------------------------------- E2
  function e2(): Promise<void> {
    return vodS.load(pid, 'movie').then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { L.warn('7e E2 no movies', { status: l.status }); return undefined; }
      const view = l.view;
      const want = [0, 3, 1500, 7000, 15000, 30000, 52000, 75000, 96000, 107000];
      const at: number[] = [];
      for (let i = 0; i < want.length; i++) { if (want[i] < view.total) { at.push(want[i]); } }
      return view.ensure(at).then(function () {
        let chain: Promise<void> = Promise.resolve();
        for (let i = 0; i < at.length; i++) {
          const p = at[i];
          chain = chain.then(function (): Promise<void> | undefined {
            const it = view.item(p);
            if (!it) { return undefined; }
            return vodS.resolve(pid, vodS.movieRef(pid, it)).then(function (src): Promise<void> | undefined {
              if (!src) { L.info('7e E2 provider', { pos: p, src: 'none' }); return undefined; }
              const tp = Date.now();
              return probeSource(xf, src, 8000).then(function (pr) {
                const probeMs = Date.now() - tp;
                return play(src, 0).then(function (r) {
                  return wait(2500).then(function () {
                    L.info('7e E2 provider', { pos: p, ext: src.type, playing: r.ok, startMs: r.ms, err: errorSeen, probeMs: probeMs, probe: summary(pr), avplay: trackLine() });
                    eng.stop();
                  });
                });
              });
            });
          });
        }
        return chain;
      });
    });
  }

  // ---------------------------------------------------------------- E3
  function previewRun(label: string, src: PlaybackSource, times: number[], expectColour: boolean): Promise<void> {
    const doc = root.ownerDocument as Document;
    return play(src, 0).then(function (r): Promise<void> | undefined {
      if (!r.ok) { L.warn('7e E3 main did not play', { label: label, err: errorSeen }); return undefined; }
      return wait(3000).then(function () {
        const v = doc.createElement('video') as HTMLVideoElement;
        const cv = doc.createElement('canvas') as HTMLCanvasElement;
        cv.width = 320;
        cv.height = 180;
        v.muted = true;
        v.setAttribute('muted', '');
        v.preload = 'auto';
        if (expectColour) { v.crossOrigin = 'anonymous'; }
        v.style.position = 'absolute';
        v.style.left = '-2000px';
        v.style.top = '0';
        v.style.width = '320px';
        v.style.height = '180px';
        const evs: string[] = [];
        const t0 = Date.now();
        const names = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'seeking', 'seeked', 'error', 'stalled', 'suspend', 'abort', 'emptied'];
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          v.addEventListener(n, function () { if (evs.length < 60) { evs.push(n + '@' + (Date.now() - t0)); } });
        }
        let meta = false;
        v.addEventListener('loadedmetadata', function () { meta = true; });
        root.appendChild(v);
        const pos0 = pos();
        v.src = src.url;
        try { v.load(); } catch (e) { evs.push('load-throw'); }
        return until(function () { return meta || !!v.error; }, 15000).then(function () {
          const metaMs = Date.now() - t0;
          const frames: string[] = [];
          let chain: Promise<void> = Promise.resolve();
          for (let i = 0; i < times.length; i++) {
            const want = times[i];
            chain = chain.then(function (): Promise<void> | undefined {
              if (!meta) { return undefined; }
              const at = want < 1 ? want * (v.duration || 0) : want;
              let seeked = false;
              const onS = function (): void { seeked = true; };
              v.addEventListener('seeked', onS);
              const ts = Date.now();
              try { v.currentTime = at; } catch (e) { frames.push('seek-throw'); return undefined; }
              return until(function () { return seeked || !!v.error; }, 10000).then(function (ok) {
                v.removeEventListener('seeked', onS);
                const ms = Date.now() - ts;
                let px = '';
                try {
                  const g = cv.getContext('2d');
                  if (g) {
                    g.drawImage(v, 0, 0, 320, 180);
                    try {
                      const d = g.getImageData(160, 90, 1, 1).data;
                      px = d[0] + ',' + d[1] + ',' + d[2];
                    } catch (e) { px = 'read:' + String((e as { name?: string }).name); }
                  }
                } catch (e) { px = 'draw:' + String((e as { name?: string }).name); }
                frames.push(Math.round(at) + 's ' + (ok ? 'seeked' : 'TIMEOUT') + ' ' + ms + 'ms px=' + px + ' main=' + pos());
              });
            });
          }
          return chain.then(function () {
            const pos1 = pos();
            const wall = Date.now() - t0;
            const vErr = v.error ? String(v.error.code) : '';
            const dur = Math.round(v.duration || 0);
            v.removeAttribute('src');
            try { v.load(); } catch (e) { /* */ }
            if (v.parentNode) { v.parentNode.removeChild(v); }
            return wait(4000).then(function () {
              L.info('7e E3 preview', {
                label: label, metaMs: metaMs, meta: meta, duration: dur, videoError: vErr, frames: frames.join(' | '),
                mainAdvancedMs: pos1 - pos0, wallMs: wall, mainAfterCleanupMs: pos() - pos1, mainError: errorSeen, events: evs.join(' ').slice(0, 600), memMB: mem()
              });
              eng.stop();
            });
          });
        });
      });
    });
  }
  function e3(): Promise<void> {
    return previewRun('lab', { url: LAB + 'thumb.mp4', type: 'mp4', live: false }, [5, 25, 45, 15, 55, 35], true).then(function () {
      return vodS.load(pid, 'movie');
    }).then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      const view = l.view;
      return view.ensure([3, 1500]).then(function (): Promise<void> | undefined {
        const it = view.item(3) || view.item(1500);
        if (!it) { return undefined; }
        return vodS.resolve(pid, vodS.movieRef(pid, it)).then(function (src): Promise<void> | undefined {
          if (!src) { return undefined; }
          return previewRun('provider-' + src.type, src, [0.1, 0.3, 0.5, 0.2], false);
        });
      });
    });
  }

  // ---------------------------------------------------------------- E4
  function e4(): Promise<void> {
    const since = Date.now();
    router.resetTo('home');
    router.push('live-tv', { playlistId: pid });
    return until(function () { return log.entries().some(function (e) { return e.t >= since && e.msg === 'live tv ready'; }); }, 60000).then(function () {
      return svcS.loadLive(pid);
    }).then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      const chans = l.catalogue.channels;
      const pick = [0, 1, 2, 5, 9];
      const out: string[] = [];
      let chain: Promise<void> = Promise.resolve();
      for (let i = 0; i < pick.length && pick[i] < chans.length; i++) {
        const ch = chans[pick[i]];
        chain = chain.then(function () {
          return svcS.resolvePlayback(pid, ch).then(function (src): Promise<void> | undefined {
            if (!src) { out.push('none'); return undefined; }
            eng.setRect(1180, 200, 556, 313);
            return play(src, 2).then(function (r) {
              return wait(3000).then(function () { out.push((r.ok ? 'ok' : 'fail:' + errorSeen) + ' ' + r.ms + 'ms'); });
            });
          });
        });
      }
      return chain.then(function () {
        // Rapid zapping: five loads 300 ms apart, then the last one should play.
        const t0 = Date.now();
        let c2: Promise<void> = Promise.resolve();
        for (let i = 0; i < 5 && i < chans.length; i++) {
          const ch = chans[i];
          c2 = c2.then(function () {
            return svcS.resolvePlayback(pid, ch).then(function (src) {
              if (src) { playingSeen = false; errorSeen = ''; eng.load(src, { bufferSec: 2 }).then(function () { /* */ }, function () { /* */ }); }
              return wait(300);
            });
          });
        }
        return c2.then(function () {
          return until(function () { return playingSeen; }, 15000);
        }).then(function (ok) {
          L.info('7e E4 live mini', { tunes: out.join(' | '), rapidZapLastPlays: ok, rapidMs: Date.now() - t0, err: errorSeen, memMB: mem() });
          eng.stop();
          eng.setRect(0, 0, 1920, 1080);
        });
      });
    });
  }

  // ---------------------------------------------------------------- E5
  function e5(): Promise<void> {
    const since = Date.now();
    router.resetTo('home');
    router.push('live-tv', { playlistId: pid });
    return until(function () { return log.entries().some(function (e) { return e.t >= since && e.msg === 'live tv ready'; }); }, 60000).then(function () {
      return wait(4000);
    }).then(function () {
      const names = ['left', 'right', 'up', 'down', 'right', 'left', 'right', 'down', 'up', 'back', 'chDown', 'ok'];
      let x = 12345;
      function rnd(): number { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }
      const hist: string[] = [];
      const memLog: string[] = [];
      let step = 0;
      let stopped = '';
      function one(): Promise<void> {
        if (step >= 400 || stopped) { return Promise.resolve(); }
        step++;
        let k = names[Math.floor(rnd() * names.length)];
        const top = router.stack().slice(-1)[0];
        if (top === 'home') {
          router.push('live-tv', { playlistId: pid });
          hist.push('(reopen)');
          return wait(2500).then(one);
        }
        // Player or guide on top: leave with Back. On Live TV, Back mostly becomes Left so the run stays there.
        if (top !== 'live-tv') { k = 'back'; } else if (k === 'back' && rnd() < 0.7) { k = 'left'; }
        hist.push(top.replace('live-tv', 'L').replace('player', 'P').replace('tv-guide', 'G') + ':' + k);
        if (hist.length > 30) { hist.shift(); }
        try {
          const ev = { keyCode: KEY[k], preventDefault: function () { /* */ } };
          kr.keyDown(ev);
          kr.keyUp(ev);
        } catch (e) { stopped = 'throw ' + String((e as { message?: string }).message).slice(0, 200); }
        const errs = errors(since);
        if (errs.length) {
          stopped = errs[0].msg + ' ' + JSON.stringify(errs[0].data || {}).slice(0, 300) + ' ' + JSON.stringify((errs[0] as unknown as { error?: unknown }).error || '').slice(0, 600);
        }
        if (step % 50 === 0) { memLog.push(step + ':' + mem()); }
        return wait(rnd() < 0.25 ? 900 : 140).then(one);
      }
      return one().then(function () {
        L.info('7e E5 live fuzz', { steps: step, stopped: stopped, lastKeys: hist.join(' '), mem: memLog.join(' '), top: router.stack().join('>') });
        router.resetTo('home');
      });
    });
  }

  function e6(): Promise<void> {
    // Guide download alone (no Live TV screen): characters received vs free memory; abort below 160 MB.
    const epg = ctx.epg;
    if (!epg) { return Promise.resolve(); }
    return svcS.loadLive(pid).then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { return undefined; }
      let chars = 0;
      let progs = 0;
      const samples: string[] = [];
      const t0 = Date.now();
      const job = epg.refresh(pid, l.catalogue.channels, function (c, p) { chars = c; progs = p; });
      let low = false;
      const iv = setInterval(function () {
        const m = mem();
        samples.push(Math.round((Date.now() - t0) / 1000) + 's:' + Math.round(chars / 1048576) + 'Mc/' + progs + 'p/' + m + 'MB');
        L.info('7e E6 sample', { s: Math.round((Date.now() - t0) / 1000), mchars: Math.round(chars / 104857.6) / 10, programmes: progs, memMB: m });
        if (m > 0 && m < 160 && !low) { low = true; job.abort(); }
      }, 1000);
      return job.result.then(function (r) {
        clearInterval(iv);
        return wait(5000).then(function () {
          L.info('7e E6 guide download', { aborted: low, ok: r.ok, code: r.code || '', programmes: r.programmes, channels: r.channels, ms: r.ms, lastMChars: Math.round(chars / 104857.6) / 10, memAfter5sMB: mem(), samples: samples.join(' ').slice(0, 1500) });
        });
      });
    });
  }
  // ---------------------------------------------------------------- E7 / E8 (run 3)
  function key(k: string): void {
    const ev = { keyCode: KEY[k], preventDefault: function () { /* */ } };
    kr.keyDown(ev);
    kr.keyUp(ev);
  }
  function keys(list: string[], gapMs: number): Promise<void> {
    let c: Promise<void> = Promise.resolve();
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      c = c.then(function () { key(k); return wait(gapMs); });
    }
    return c;
  }
  function texts(cls: string): string[] {
    const els = (root as HTMLElement).getElementsByClassName(cls);
    const out: string[] = [];
    for (let i = 0; i < els.length; i++) { out.push((els[i] as HTMLElement).textContent || ''); }
    return out;
  }
  function count(msg: string, comp: string, since: number): number {
    return log.entries().filter(function (e) { return e.t >= since && e.msg === msg && (e as unknown as { component?: string }).component === comp; }).length;
  }

  // E7: the movie that carries 18 subtitle tracks (position 52000 of "All", run 1): its name, and
  // the real Audio & subtitles panel of the VOD player (DOM labels) once the file probe finished.
  function e7(): Promise<void> {
    return vodS.load(pid, 'movie').then(function (l): Promise<void> | undefined {
      if (l.status !== 'ok') { L.warn('7e E7 no movies'); return undefined; }
      const view = l.view;
      return view.ensure([52000]).then(function (): Promise<void> | undefined {
        const it = view.item(52000);
        if (!it) { L.warn('7e E7 no item'); return undefined; }
        const since = Date.now();
        playingSeen = false;
        router.resetTo('home');
        router.push('vod-player', { playlistId: pid, ref: vodS.movieRef(pid, it), title: it.name, startMs: 0 });
        return until(function () { return playingSeen; }, 30000).then(function () {
          return wait(15000); // probe measured 5.4 s for this file
        }).then(function () {
          return keys(['info', 'down', 'right', 'right', 'ok'], 400);
        }).then(function () {
          const names = texts('ss-tracks__name');
          L.info('7e E7 subtitle panel', { title: it.name, category: it.categoryId, rows: names.length, labels: names.join(' | ').slice(0, 1500), errors: errors(since).length, memMB: mem() });
          return keys(['back', 'back'], 600);
        }).then(function () {
          eng.stop();
          router.resetTo('home');
        });
      });
    });
  }

  // E8: the mini preview on the real Live TV screen (single AVPlay in the 556×313 slot).
  function e8(): Promise<void> {
    const since = Date.now();
    router.resetTo('home');
    router.push('live-tv', { playlistId: pid });
    let slotRect = '';
    return until(function () { return log.entries().some(function (e) { return e.t >= since && e.msg === 'live tv ready'; }); }, 60000).then(function () {
      return wait(6000);
    }).then(function () {
      const s = (root as HTMLElement).getElementsByClassName('ss-preview')[0] as HTMLElement | undefined;
      if (s) {
        let x = 0; let y = 0; let n: HTMLElement | null = s;
        while (n) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent as HTMLElement | null; }
        slotRect = x + ',' + y + ' ' + s.offsetWidth + 'x' + s.offsetHeight + ' ' + s.className;
      }
      const first = count('live: playing', 'preview', since);
      L.info('7e E8 first preview', { playing: first, slot: slotRect, htmlTransparent: /ss-playing/.test(document.body.className), memMB: mem() });
      // Rapid ↓ ×10 (150 ms apart): only the channel the focus rests on may open.
      const t1 = Date.now();
      return keys(['down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down'], 150).then(function () {
        return wait(6000);
      }).then(function () {
        L.info('7e E8 rapid', { playingAfter: count('live: playing', 'preview', t1), failed: count('live: channel failed', 'preview', t1), engine: eng.state(), memMB: mem() });
        // OK: full-screen player takes the decoder; Back: the preview returns.
        const t2 = Date.now();
        key('ok');
        return wait(8000).then(function () {
          const top = router.stack().slice(-1)[0];
          const pl = count('live: playing', 'player', t2);
          key('back');
          return wait(6000).then(function () {
            L.info('7e E8 handover', { playerTop: top, playerPlaying: pl, backTop: router.stack().slice(-1)[0], previewPlayingAgain: count('live: playing', 'preview', t2), memMB: mem() });
          });
        });
      }).then(function () {
        // 30 tunes, focus resting 2.5 s on each: memory over time.
        const t3 = Date.now();
        const memLog: string[] = [];
        let n = 0;
        function one(): Promise<void> {
          if (n >= 30) { return Promise.resolve(); }
          n++;
          key('down');
          return wait(2500).then(function () { if (n % 5 === 0) { memLog.push(n + ':' + mem()); } return one(); });
        }
        return one().then(function () {
          L.info('7e E8 tunes', { tunes: n, playing: count('live: playing', 'preview', t3), failed: count('live: channel failed', 'preview', t3), mem: memLog.join(' '), errors: errors(since).length });
          // Leave Live TV: decoder released, page opaque again.
          return keys(['back', 'back'], 800);
        }).then(function () {
          return wait(1500);
        }).then(function () {
          L.info('7e E8 leave', { top: router.stack().slice(-1)[0], engine: eng.state(), htmlTransparent: /ss-playing/.test(document.body.className), memMB: mem() });
        });
      });
    });
  }

  L.info('7e start', { memMB: mem() });
  let beats = 0;
  const hb = setInterval(function () {
    beats++;
    const es = ctx.epg ? ctx.epg.status() : null;
    L.info('7e beat', { n: beats, memMB: mem(), top: router.stack().slice(-1)[0], epg: es ? es.state + (es.refreshing ? '/refreshing' : '') : '-' });
    if (beats > 200) { clearInterval(hb); }
  }, 3000);
  // Run 2: E1–E3 done in run 1 (E3 froze the app afterwards); only the Live TV experiments.
  const RUN_LAB = false;
  // Run 3 (mini preview built): E7 subtitle panel of the 18-track movie, E8 Live TV preview.
  const RUN3 = true;
  return (RUN_LAB ? e1().then(e2).then(e3) : Promise.resolve()).then(function () { return RUN3 ? e7().then(e8) : e6().then(e5).then(e4); }).then(function () {
    L.info('7e done', { memMB: mem() });
  }, function (e) {
    L.warn('7e failed', undefined, e);
  });
}
