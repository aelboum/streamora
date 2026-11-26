// DEV BUILDS ONLY (called from device-selftest.ts, SUITE '7b2'). Stage 7B.2 checks on the real TV
// with INJECTED remote key events (not the physical remote), against the user's own Xtream
// playlist (the active one). Logs counts, languages and timings only: no titles, URLs or credentials.
//   1. movie: play the first title of "All movies" through the UI, then
//      - seek: ▶ (+10 s) and ◀ through the player screen, positions read back from AVPlay;
//      - tracks: AVPlay audio / subtitle tracks (count, languages), switch audio when there are 2+,
//        turn on the first subtitle track and count cues for 20 s, then turn subtitles off;
//      - resume: Back saves the position; the movie restarts from it and AVPlay reports it;
//      the progress entry written by the test is removed at the end (history unchanged);
//   2. TV guide: Live TV → Green → grid open time, rows, programme cells, key handling;
//   3. Settings and global Search screens open (render time, rows), Search over stored lists;
//   4. PIN: cost of one PBKDF2 check at 600,000 iterations (synthetic values), PIN dialog render.
// Never sets, changes or removes the user's PIN, language, track preferences or favourites.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import type { PlaylistService } from '../services/playlist-service.ts';
import type { VodService } from '../services/vod-service.ts';
import type { ProgressStore } from '../services/progress.ts';
import type { PlaybackEngine } from '../player/engine.ts';
import type { PlaybackSource } from '../models/content.ts';
import type { EpgService } from '../services/epg-service.ts';
import type { KeyValueStore } from '../storage/kv-store.ts';
import { createChannelIndex } from '../content/channel-index.ts';
import { PIN_ITERATIONS } from '../security/pin.ts';

const KEY = { up: 38, down: 40, left: 37, right: 39, ok: 13, back: 10009, green: 404 };

function wait(ms: number): Promise<void> {
  return new Promise<void>(function (resolve) { setTimeout(resolve, ms); });
}

function until(fn: () => boolean, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  return new Promise<number>(function (resolve) {
    function poll(): void {
      if (fn() || Date.now() - t0 > timeoutMs) { resolve(Date.now() - t0); return; }
      setTimeout(poll, 20);
    }
    poll();
  });
}

function lagProbe(): { stop(): number } {
  let maxLag = 0;
  let last = Date.now();
  const h = setInterval(function () {
    const now = Date.now();
    const lag = now - last - 50;
    last = now;
    if (lag > maxLag) { maxLag = lag; }
  }, 50);
  return { stop: function () { clearInterval(h); return maxLag; } };
}

export function runStage7B2SelfTest(platform: Platform, log: Logger, app: DevApp | undefined): Promise<void> {
  const L = log.child('selftest7b2');
  const ctx = app ? app.ctx as unknown as { playlists: PlaylistService | null; vod: VodService | null; progress: ProgressStore; engine: PlaybackEngine | null; kv: KeyValueStore; epg: EpgService | null } : null;
  if (!app || !ctx || !ctx.playlists || !ctx.vod || !ctx.engine) {
    L.warn('stage 7B.2 self-test skipped (no app context)');
    return Promise.resolve();
  }
  const svc = ctx.playlists;
  const vod = ctx.vod;
  const engine = ctx.engine;
  const progress = ctx.progress;
  const kv = ctx.kv;
  const epg = ctx.epg;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  const root = app.root;
  const pid = svc.activeId() || '';
  if (!pid || !vod.supported(pid)) {
    L.warn('stage 7B.2 self-test skipped (active playlist is not Xtream)');
    return Promise.resolve();
  }
  // Raw snapshot of this account's viewing history, put back unchanged after the test.
  const progressName = 'progress.' + pid;
  const progressBefore = kv.get<unknown>(progressName, function (x): x is unknown { return x !== undefined; }, null);

  function press(code: number, times?: number): void {
    for (let i = 0; i < (times || 1); i++) {
      const ev = { keyCode: code, preventDefault: function () { /* */ } };
      kr.keyDown(ev);
      kr.keyUp(ev);
    }
  }
  function find(msg: string, since: number): LogEntry | null {
    const es = log.entries();
    for (let i = es.length - 1; i >= 0; i--) { if (es[i].t >= since && es[i].msg === msg) { return es[i]; } }
    return null;
  }
  function top(): string { return router.stack().slice(-1)[0]; }
  function layer(): HTMLElement {
    const kids = root.childNodes;
    return kids[kids.length - 1] as HTMLElement;
  }
  function count(sel: string): number {
    const l = layer();
    return l && l.querySelectorAll ? l.querySelectorAll(sel).length : -1;
  }
  function pos(): number { return engine.timing ? engine.timing().positionMs : -1; }
  function waitPlaying(since: number): Promise<{ ok: boolean; startupMs?: number; code?: string }> {
    return until(function () { return find('vod: playing', since) !== null || find('vod: playback failed', since) !== null; }, 40000).then(function () {
      const ok = find('vod: playing', since);
      const bad = find('vod: playback failed', since);
      return ok ? { ok: true, startupMs: (ok.data as { startupMs: number }).startupMs } : { ok: false, code: bad ? (bad.data as { code: string }).code : 'no-outcome' };
    });
  }

  function movie(): Promise<unknown> {
    const out: Record<string, unknown> = {};
    const since = Date.now();
    router.resetTo('home');
    router.push('vod-browse', { playlistId: pid, section: 'movie' });
    return until(function () { return find('vod browse ready', since) !== null; }, 120000).then(function () {
      return wait(1500);
    }).then(function () {
      if (top() !== 'vod-browse') { throw new Error('browse not shown: ' + top()); }
      press(KEY.right);
      press(KEY.left);
      press(KEY.ok);
      return until(function () { return top() === 'vod-details'; }, 5000);
    }).then(function () {
      return wait(1500);
    }).then(function () {
      out.detailsButtons = count('.ss-details__actions .ss-button');
      const tp = Date.now();
      press(KEY.ok);
      return waitPlaying(tp);
    }).then(function (r) {
      out.playback = r;
      if (!r.ok) { throw new Error('playback ' + r.code); }
      return wait(6000);
    }).then(function () {
      const p0 = pos();
      out.durationMs = engine.timing ? engine.timing().durationMs : -1;
      press(KEY.right);
      return wait(8000).then(function () {
        const p1 = pos();
        out.seekForward = { beforeMs: p0, afterMs: p1, gainedMs: p1 - p0 };
        press(KEY.left, 2);
        return wait(3000);
      }).then(function () {
        out.seekBackAfterMs = pos();
        out.uiPhase = (layer().querySelector('.ss-vbar__state') || { textContent: '' }).textContent || 'playing';
        // The engine directly (bypassing the screen and controller): +60 s.
        const d0 = pos();
        if (engine.seek) { engine.seek(d0 + 60000); }
        return wait(8000).then(function () { out.directSeek = { fromMs: d0, toMs: d0 + 60000, nowMs: pos() }; });
      });
    }).then(function () {
      const tr = engine.tracks ? engine.tracks() : [];
      const audio = tr.filter(function (t) { return t.kind === 'audio'; });
      const text = tr.filter(function (t) { return t.kind === 'text'; });
      out.tracks = {
        audio: audio.length, text: text.length,
        audioLangs: audio.map(function (t) { return t.language || '?'; }).join(','),
        textLangs: text.map(function (t) { return t.language || '?'; }).join(','),
        audioSelected: audio.filter(function (t) { return t.selected; }).length
      };
      let chain: Promise<void> = Promise.resolve();
      const sel = engine.selectTrack;
      if (audio.length >= 2 && sel) {
        const target = audio[1].selected ? audio[0] : audio[1];
        chain = chain.then(function () {
          const p0 = pos();
          sel('audio', target.id);
          return wait(3000).then(function () {
            const now = engine.tracks ? engine.tracks() : [];
            const s = now.filter(function (t) { return t.kind === 'audio' && t.selected; });
            out.audioSwitch = { to: target.language || '?', selectedNow: s.length ? s[0].language || '?' : 'none', advancedMs: pos() - p0 };
          });
        });
      }
      if (text.length && sel) {
        chain = chain.then(function () {
          let cues = 0;
          let maxLen = 0;
          const off = engine.on(function (e) { if (e.type === 'subtitle' && e.text) { cues++; if (e.text.length > maxLen) { maxLen = e.text.length; } } });
          sel('text', text[0].id);
          return wait(20000).then(function () {
            off();
            out.subtitles = { track: text[0].language || '?', cuesIn20s: cues, longestCueChars: maxLen };
            sel('text', -1);
          });
        });
      }
      return chain;
    }).then(function () {
      press(KEY.down);
      press(KEY.right, 2);
      press(KEY.ok);
      return wait(500).then(function () {
        out.sheetRows = count('.ss-tracks__row');
        out.sheetOpen = count('.ss-tracks.is-hidden') === 0;
        press(KEY.back);
        return wait(300);
      });
    }).then(function () {
      out.sheetClosed = count('.ss-tracks.is-hidden') === 1 && top() === 'vod-player';
      const saveAt = pos();
      out.positionAtBackMs = saveAt;
      press(KEY.back);
      return wait(1500).then(function () {
        const e = progress.list(pid)[0] || null;
        out.progressSaved = e ? { posMs: e.pos, durMs: e.dur, close: Math.abs(e.pos - saveAt) < 15000 } : null;
        out.detailsButtonsAfter = count('.ss-details__actions .ss-button');
      });
    }).then(function () {
      const saved = progress.list(pid)[0];
      const tp = Date.now();
      press(KEY.ok);
      return waitPlaying(tp).then(function (r) {
        out.resumePlayback = r;
        out.resumeToast = count('.ss-toast.is-hidden') === 0;
        return wait(5000);
      }).then(function () {
        const p = pos();
        out.resume = { savedMs: saved ? saved.pos : -1, reportedMs: p, ok: !!saved && p >= saved.pos - 5000 };
        press(KEY.back);
        return wait(1500);
      });
    }).then(function () {
      out.afterBack = top();
      return out;
    });
  }


  // AVPlay seek in isolation: local test files from the PC (probe2 media server, byte ranges supported).
  function seekLab(): Promise<unknown> {
    const out: Record<string, unknown> = {};
    const files = ['h264_aac.mp4', 'h264_aac.mkv', 'h264_aac.ts'];
    let chain: Promise<void> = Promise.resolve();
    router.resetTo('home');
    files.forEach(function (f) {
      chain = chain.then(function () {
        let playing = false;
        const off = engine.on(function (e) { if (e.type === 'playing') { playing = true; } });
        const type = f.slice(-3) === 'mp4' ? 'mp4' : f.slice(-3) === 'mkv' ? 'mkv' : 'ts';
        const ld = engine.load({ url: 'http://192.168.1.180:8099/media/' + f, type: type as 'mp4', live: false }, { bufferSec: 0 });
        return ld.then(function () {
          return until(function () { return playing; }, 15000);
        }).then(function () {
          return wait(3000);
        }).then(function () {
          const p0 = pos();
          if (engine.seek) { engine.seek(30000); }
          return wait(6000).then(function () {
            out[f] = 'from ' + p0 + ' to 30000 now ' + pos();
          });
        }, function (code) { out[f] = 'load failed ' + String(code); }).then(function () { off(); engine.stop(); return wait(800); });
      });
    });
    return chain.then(function () { return out; });
  }


  // Does the provider's movie server answer byte-range requests (what AVPlay needs to seek)?
  // Only status codes, header presence and timings are logged; the URL holds the credentials.
  function rangeProbe(): Promise<unknown> {
    return vod.load(pid, 'movie').then(function (l) {
      if (l.status !== 'ok') { return { movies: l.status }; }
      const view = l.view;
      return view.ensure([0]).then(function () {
        const it = view.item(0);
        if (!it) { return { item: 'none' }; }
        return vod.resolve(pid, vod.movieRef(pid, it)).then(function (src) {
          if (!src) { return { source: 'none' }; }
          const url = src.url;
          function one(range: string): Promise<string> {
            return new Promise<string>(function (resolve) {
              const x = new XMLHttpRequest();
              const t0 = Date.now();
              let done = false;
              function finish(r: string): void { if (!done) { done = true; try { x.abort(); } catch (e) { /* */ } resolve(r); } }
              x.onreadystatechange = function () {
                if (x.readyState >= 2) {
                  const ru = (x as unknown as { responseURL?: string }).responseURL;
                  finish('status=' + x.status + ' ms=' + (Date.now() - t0) + ' acceptRanges=' + (x.getResponseHeader('Accept-Ranges') || '-') +
                    ' contentRange=' + (x.getResponseHeader('Content-Range') ? 'yes' : 'no') + ' length=' + (x.getResponseHeader('Content-Length') || '-') +
                    ' type=' + (x.getResponseHeader('Content-Type') || '-') + ' redirected=' + (ru === undefined ? 'unknown' : String(ru !== url)));
                }
              };
              x.onerror = function () { finish('network error ms=' + (Date.now() - t0)); };
              setTimeout(function () { finish('timeout 15s'); }, 15000);
              x.open('GET', url, true);
              if (range) { x.setRequestHeader('Range', range); }
              x.send();
            });
          }
          const out: Record<string, unknown> = { container: src.type };
          return one('').then(function (r) { out.plain = r; return one('bytes=0-1'); }).then(function (r) {
            out.rangeStart = r;
            return one('bytes=500000000-500000001');
          }).then(function (r) { out.rangeMiddle = r; return out; });
        });
      });
    });
  }


  // Provider movie opened at 10:00: the seek happens before play (READY state).
  function startAt(): Promise<unknown> {
    return vod.load(pid, 'movie').then(function (l): Promise<unknown> {
      if (l.status !== 'ok') { return Promise.resolve({ movies: l.status }); }
      const view = l.view;
      return view.ensure([0]).then(function (): Promise<PlaybackSource | null> {
        const it = view.item(0);
        if (!it) { return Promise.resolve(null); }
        return vod.resolve(pid, vod.movieRef(pid, it));
      }).then(function (src): unknown {
        if (!src) { return { source: 'none' }; }
        router.resetTo('home');
        let playing = false;
        const off = engine.on(function (e) { if (e.type === 'playing') { playing = true; } });
        const t0 = Date.now();
        // Final URL after the redirect (read from a 2-byte range request; never logged).
        return new Promise<string>(function (resolve) {
          const x = new XMLHttpRequest();
          let done = false;
          function fin(u: string): void { if (!done) { done = true; try { x.abort(); } catch (e) { /* */ } resolve(u); } }
          x.onreadystatechange = function () { if (x.readyState >= 2) { fin((x as unknown as { responseURL?: string }).responseURL || src.url); } };
          x.onerror = function () { fin(src.url); };
          setTimeout(function () { fin(src.url); }, 10000);
          x.open('GET', src.url, true);
          x.setRequestHeader('Range', 'bytes=0-1');
          x.send();
        }).then(function (finalUrl) {
          const direct: PlaybackSource = { url: finalUrl, type: src.type, live: false, userAgent: src.userAgent, referrer: src.referrer };
          L.info('start-at source', { redirected: finalUrl !== src.url });
          return engine.load(direct, { bufferSec: 0, startMs: 600000 });
        }).then(function () {
          return until(function () { return playing; }, 20000);
        }).then(function () {
          const first = Date.now() - t0;
          return wait(4000).then(function () {
            const r = { firstPictureMs: first, positionMs: pos(), atTarget: pos() >= 595000 };
            off();
            engine.stop();
            return r;
          });
        }, function (code) { off(); engine.stop(); return { load: String(code) }; });
      });
    });
  }

  function guide(): Promise<unknown> {
    const out: Record<string, unknown> = {};
    const since = Date.now();
    router.resetTo('home');
    router.push('live-tv', { playlistId: pid });
    return until(function () { return find('live tv ready', since) !== null; }, 60000).then(function () {
      return wait(2000);
    }).then(function () {
      const t0 = Date.now();
      press(KEY.green);
      out.openMs = Date.now() - t0;
      out.screen = top();
      return wait(4000);
    }).then(function () {
      out.rows = count('.ss-guide__row');
      out.cells = count('.ss-guide__cell');
      out.emptyRows = count('.ss-guide__cell--empty');
      const empties = layer().querySelectorAll('.ss-guide__cell--empty');
      let loadingCells = 0;
      for (let i = 0; i < empties.length; i++) { if (/Loading|laden/.test(empties[i].textContent || '')) { loadingCells++; } }
      out.emptyStillLoading = loadingCells;
      const ep = epg;
      if (ep) {
        const st = ep.status();
        out.epgStatus = st.state + ' shortEpg=' + st.shortEpg + ' channels=' + st.channels + ' programmes=' + st.programmes + ' samePlaylist=' + (st.playlistId === pid);
      }
    }).then(function () {
      // Which channels of "All channels" have guide data at all (stored XMLTV), and what the
      // provider's short EPG returns for the first three.
      const ep = epg;
      if (!ep) { return; }
      return svc.loadLive(pid).then(function (l) {
        if (l.status !== 'ok') { return; }
        const idx = createChannelIndex(l.catalogue);
        const all = idx.all();
        const n = all.length;
        let keyed = 0;
        let mapped = 0;
        const now0 = Date.now();
        for (let i = 0; i < all.length; i++) {
          const c = idx.channels[all[i]];
          if (c.epgKey) { keyed++; }
          if (ep.programmes(c, now0 - 3 * 3600000, now0 + 3 * 3600000, 1).length) { mapped++; }
        }
        out.allChannels = all.length + ' withEpgKey=' + keyed + ' withGuideData=' + mapped;
        const now = Date.now();
        let withData = 0;
        let first = -1;
        for (let i = 0; i < n; i++) {
          if (ep.programmes(idx.channels[all[i]], now - 3 * 3600000, now + 3 * 3600000, 5).length) { withData++; if (first < 0) { first = i; } }
        }
        out.xmltvAll = withData + '/' + n + ' firstWithDataAt=' + first;
        const shorts: Array<Promise<string>> = [];
        for (let i = 0; i < 3 && i < all.length; i++) {
          shorts.push(ep.shortEpg(idx.channels[all[i]]).then(function (x) { return x === null ? 'null' : String(x.length); }, function () { return 'error'; }));
        }
        return Promise.all(shorts).then(function (r) {
          out.shortEpgFirst3 = r.join(',');
          if (first < 0) { return; }
          // Open the grid at the first channel with data and count real programme cells.
          router.push('tv-guide', { playlistId: pid, index: idx, list: all, pos: first });
          return wait(1500).then(function () {
            out.atDataChannel = { cells: count('.ss-guide__cell'), empty: count('.ss-guide__cell--empty'), focused: count('.ss-guide__cell.is-focused'), infoTitleChars: ((layer().querySelector('.ss-guide__ititle') || { textContent: '' }).textContent || '').length };
            press(KEY.right, 2);
            out.atDataChannel2 = { focused: count('.ss-guide__cell.is-focused'), firstMark: (layer().querySelector('.ss-guide__mark') || { textContent: '' }).textContent };
            router.pop();
            return wait(300);
          });
        });
      });
      const probe = lagProbe();
      const t1 = Date.now();
      press(KEY.right, 5);
      press(KEY.down, 10);
      press(KEY.left, 5);
      out.keyMsPerPress = Math.round((Date.now() - t1) / 20 * 100) / 100;
      return wait(2000).then(function () { out.maxStallMs = probe.stop(); });
    }).then(function () {
      out.cellsAfterMoves = count('.ss-guide__cell');
      press(KEY.back);
      return wait(500).then(function () { out.afterBack = top(); return out; });
    });
  }

  function screens(): Promise<unknown> {
    const out: Record<string, unknown> = {};
    router.resetTo('home');
    let t0 = Date.now();
    router.push('settings');
    out.settingsMs = Date.now() - t0;
    out.settingsRows = count('.ss-set__row');
    router.resetTo('home');
    t0 = Date.now();
    router.push('search');
    out.searchScreenMs = Date.now() - t0;
    const tl = Date.now();
    return svc.loadLive(pid).then(function (l) {
      if (l.status !== 'ok') { out.live = l.status; return; }
      const idx = createChannelIndex(l.catalogue);
      out.liveLoadMs = Date.now() - tl;
      const q = idx.channels.length ? idx.channels[0].name.substring(0, 3) : 'a';
      const ts = Date.now();
      out.liveHits = idx.search(q, 200).length;
      out.liveSearchMs = Date.now() - ts;
      return vod.load(pid, 'movie').then(function (m) {
        if (m.status !== 'ok') { out.movies = m.status; return; }
        const tv = Date.now();
        return m.view.search(q, 40).result.then(function (p2) {
          return m.view.ensure(p2).then(function () { out.movieHits = p2.length; out.movieSearchMs = Date.now() - tv; });
        });
      });
    }).then(function () { router.resetTo('home'); return out; });
  }

  function pinCost(): Promise<unknown> {
    const out: Record<string, unknown> = {};
    const c = platform.crypto;
    if (!c) { return Promise.resolve({ crypto: 'none' }); }
    const pw = new Uint8Array([49, 50, 51, 52, 53, 54]); // synthetic, never a real PIN
    const salt = c.randomBytes(16);
    const t0 = Date.now();
    return c.pbkdf2Sha256(pw, salt, PIN_ITERATIONS, 256).then(function () {
      out.pbkdf2Ms = Date.now() - t0;
      out.iterations = PIN_ITERATIONS;
      if (router.isRegistered('pin-dialog')) {
        const tr = Date.now();
        router.openOverlay('pin-dialog', { mode: 'verify' });
        out.dialogMs = Date.now() - tr;
        out.cells = count('.ss-pin__cell');
        out.padKeys = count('.ss-pin__key');
        router.closeOverlay();
      }
      return out;
    });
  }

  function step(name: string, p: () => Promise<unknown>): Promise<void> {
    const t0 = Date.now();
    return p().then(function (detail) {
      // Nested values flattened to JSON text: the logger cuts objects deeper than two levels.
      const flat: Record<string, unknown> = {};
      const dd = detail as Record<string, unknown> | null;
      if (dd && typeof dd === 'object') {
        for (const k in dd) {
          if (Object.prototype.hasOwnProperty.call(dd, k)) { flat[k] = dd[k] !== null && typeof dd[k] === 'object' ? JSON.stringify(dd[k]) : dd[k]; }
        }
      }
      L.info('selftest PASS ' + name, { ms: Date.now() - t0, detail: flat });
    }, function (e) {
      router.resetTo('home');
      L.warn('selftest FAIL ' + name, { ms: Date.now() - t0 }, e);
    });
  }

  const QUICK = false; // true: seek investigation only (range probe + start-at)
  if (QUICK) {
    return step('provider range probe', rangeProbe)
      .then(function () { return step('provider start-at 10:00', startAt); })
      .then(function () { router.resetTo('home'); L.info('stage 7B.2 self-test done', { quick: true }); });
  }
  return step('provider range probe', rangeProbe)
    .then(function () { return step('AVPlay seek lab (local files)', seekLab); })
    .then(function () { return step('movie: seek, tracks, subtitles, resume', movie); })
    .then(function () {
      // Leave the user's viewing history exactly as it was.
      if (progressBefore === null) { kv.remove(progressName); } else { kv.set(progressName, progressBefore); }
      L.info('selftest progress restored', { entries: progress.list(pid).length });
    })
    .then(function () { return step('TV guide grid', guide); })
    .then(function () { return step('Settings and Search screens', screens); })
    .then(function () { return step('PIN check cost and dialog', pinCost); })
    .then(function () { router.resetTo('home'); L.info('stage 7B.2 self-test done', { memory: platform.memory() }); });
}
