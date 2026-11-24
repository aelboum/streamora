// DEV BUILDS ONLY (called from device-selftest.ts). Stage 5.1 measurements on the real TV with
// INJECTED remote key events (not the physical remote) and SYNTHETIC LAN streams from the dev sink
// (not a real provider).
//   r. Playback recovery: repeated channel failures followed by working channels, late errors of
//      an abandoned channel, and rapid zapping while a channel is still opening. Every attempt is
//      logged with its outcome; the AVPlay engine's debug traces (session numbers, AVPlay states,
//      error types; never URLs) go to the dev sink with it.
//   g. Gzip XMLTV guides: valid (.gz name, no name, Content-Encoding), corrupt and truncated, the
//      uncompressed regression; event-loop stalls and free memory during each refresh.
// Test playlists are added through PlaylistService and removed afterwards.
import type { Platform } from '../app/platform/platform.ts';
import type { Logger, LogEntry } from '../utils/log.ts';
import type { DevApp } from './device-selftest-stage4b.ts';
import type { Channel } from '../models/content.ts';

const KEY = { ok: 13, back: 10009, chUp: 427, chDown: 428 };

function wait(ms: number): Promise<void> {
  return new Promise<void>(function (resolve) { setTimeout(resolve, ms); });
}

function until(fn: () => boolean, timeoutMs: number, what: string): Promise<number> {
  const t0 = Date.now();
  return new Promise<number>(function (resolve, reject) {
    function poll(): void {
      if (fn()) { resolve(Date.now() - t0); return; }
      if (Date.now() - t0 > timeoutMs) { reject(new Error('timeout: ' + what)); return; }
      setTimeout(poll, 20);
    }
    poll();
  });
}

function step(log: Logger, name: string, p: Promise<unknown>): Promise<void> {
  const t0 = Date.now();
  return p.then(function (detail) {
    log.info('selftest PASS ' + name, { ms: Date.now() - t0, detail: detail });
  }, function (e) {
    log.warn('selftest FAIL ' + name, { ms: Date.now() - t0 }, e);
  });
}

type Outcome = { ok: boolean; ms: number; code: string };

/** aligned: the test streams start at a TS packet boundary (PAT) instead of mid-packet (fixture ?align=1). */
export function runStage51SelfTest(platform: Platform, log: Logger, sinkUrl: string, app: DevApp | undefined, reps: number, aligned: boolean,
  withGuides: boolean): Promise<void> {
  const L = log.child('selftest51');
  if (!app || !app.ctx.playlists || !app.ctx.epg) {
    L.warn('stage 5.1 self-test skipped (no app context)');
    return Promise.resolve();
  }
  const svc = app.ctx.playlists;
  const epg = app.ctx.epg;
  const router = app.started.router;
  const kr = app.started.keyRouter;
  const origin = sinkUrl.replace(/\/ingest$/, '');

  function press(code: number): void {
    const ev = { keyCode: code, preventDefault: function () { /* */ } };
    kr.keyDown(ev);
    kr.keyUp(ev);
  }
  function find(msg: string, since: number): LogEntry | null {
    const es = log.entries();
    for (let i = 0; i < es.length; i++) { if (es[i].t >= since && es[i].msg === msg) { return es[i]; } }
    return null;
  }
  /** First 'live: playing' or 'live: channel failed' at or after `since`. */
  function outcome(since: number, timeoutMs: number): Promise<Outcome> {
    return until(function () { return find('live: playing', since) !== null || find('live: channel failed', since) !== null; }, timeoutMs, 'outcome')
      .then(function (): Outcome {
        const p = find('live: playing', since);
        const f = find('live: channel failed', since);
        if (p && (!f || p.t <= f.t)) {
          return { ok: true, ms: p.t - since, code: '' };
        }
        const fe = f as LogEntry;
        return { ok: false, ms: fe.t - since, code: String((fe.data as { code?: string }).code) };
      }, function (): Outcome { return { ok: false, ms: timeoutMs, code: 'no-outcome' }; });
  }
  function addAndImport(url: string, name: string): Promise<string> {
    return svc.add({ name: name, kind: 'm3u', url: url }).then(function (a) {
      if (!a.ok) { throw new Error('add failed: ' + a.code); }
      svc.markCleartextNoticeSeen(a.playlist.id);
      return svc.refresh(a.playlist.id).result.then(function (r) {
        if (!r.ok) { throw new Error('import failed: ' + r.code); }
        return a.playlist.id;
      });
    });
  }
  function openLive(id: string): Promise<void> {
    const since = Date.now();
    router.resetTo('playlists');
    router.push('live-tv', { playlistId: id });
    return until(function () { return find('live tv ready', since) !== null; }, 60000, 'live tv ready').then(function () {
      return until(function () { return !epg.status().refreshing && epg.status().state !== 'loading'; }, 60000, 'guide');
    }).then(function () { return undefined; });
  }

  type Attempt = { scenario: string; n: number; ok: boolean; ms: number; code: string };
  const attempts: Attempt[] = [];
  function record(scenario: string, n: number, r: Outcome): void {
    const a: Attempt = { scenario: scenario, n: n, ok: r.ok, ms: r.ms, code: r.code };
    attempts.push(a);
    L.info('recovery attempt', a);
  }
  function zap(code: number, timeoutMs: number): Promise<Outcome> {
    // 5 ms gap: log timestamps have 1 ms resolution, so the previous outcome is never matched again.
    return wait(5).then(function () {
      const since = Date.now();
      press(code);
      return outcome(since, timeoutMs);
    });
  }

  // Channel order in /fixture/live.m3u: 1 good (H.264/AAC), 2 good (H.264/MP2), 3 HTTP 404,
  // 4 connection refused. In the player CH+ moves 1→2→3→4→1 and CH− the other way (debounced).
  function recovery(): Promise<unknown> {
    let id = '';
    const half = Math.max(2, Math.floor(reps / 2));
    return addAndImport(origin + '/fixture/live.m3u' + (aligned ? '?align=1' : ''), 'selftest live').then(function (pid) {
      id = pid;
      return openLive(id);
    }).then(function () {
      log.setLevel('debug');
      const since = Date.now();
      press(KEY.ok); // channel 1
      return outcome(since, 30000);
    }).then(function (r) {
      record('start ch1', 0, r);
      return zap(KEY.chUp, 30000); // channel 2
    }).then(function (r) {
      record('start ch2', 0, r);
      let chain: Promise<unknown> = Promise.resolve();
      // S1: two failed channels, then a working one (the Stage 5 failure). Starts and ends on ch2.
      for (let i = 1; i <= reps; i++) {
        const n = i;
        chain = chain.then(function () { return zap(KEY.chUp, 40000); })
          .then(function (r) { record('S1 fail 404', n, r); return zap(KEY.chUp, 40000); })
          .then(function (r) { record('S1 fail refused', n, r); return zap(KEY.chUp, 30000); })
          .then(function (r) { record('S1 recover ch1', n, r); return zap(KEY.chUp, 30000); })
          .then(function (r) { record('S1 then ch2', n, r); });
      }
      // S2: one failed channel, then a working one. ch2 → 3 (fails) → ch2.
      for (let j = 1; j <= half; j++) {
        const n = j;
        chain = chain.then(function () { return zap(KEY.chUp, 40000); })
          .then(function (r) { record('S2 fail 404', n, r); return zap(KEY.chDown, 30000); })
          .then(function (r) { record('S2 recover ch2', n, r); });
      }
      // S3: late error of an abandoned channel. ch2 → 3 (404; its error arrives ≈ 11 s after the
      // open), leave after 3 s with CH− to ch2, then check ch2 is still fine 10 s later.
      for (let k = 1; k <= half; k++) {
        const n = k;
        chain = chain.then(function () {
          press(KEY.chUp);
          return wait(3000);
        }).then(function () { return zap(KEY.chDown, 30000); })
          .then(function (r) { record('S3 leave 404 early, ch2', n, r); return wait(10000); })
          .then(function () {
            const since = Date.now() - 10000;
            const f = find('live: channel failed', since);
            const d = find('live: stream dropped; reconnecting', since);
            record('S3 ch2 unaffected 10 s later', n, { ok: !f && !d, ms: 10000, code: f ? 'failed' : (d ? 'dropped' : '') });
          });
      }
      // S4: rapid zapping while channels open. ch2: CH+ ×3 150 ms apart (debounced to ch1);
      // then CH+ to ch2 and CH− back to ch1 1.5 s later while ch2 is still opening.
      for (let m = 1; m <= half; m++) {
        const n = m;
        chain = chain.then(function () {
          const since = Date.now();
          press(KEY.chUp);
          return wait(150).then(function () { press(KEY.chUp); return wait(150); })
            .then(function () { press(KEY.chUp); return outcome(since, 30000); });
        }).then(function (r) {
          record('S4 rapid x3 to ch1', n, r);
          press(KEY.chUp);
          return wait(1500).then(function () { return zap(KEY.chDown, 30000); });
        }).then(function (r) {
          record('S4 leave ch2 mid-open, ch1', n, r);
          return zap(KEY.chUp, 30000);
        }).then(function (r) { record('S4 then ch2', n, r); });
      }
      return chain;
    }).then(function () {
      log.setLevel('info');
      const summary: Record<string, { ok: number; failed: number; codes: string[]; ms: number[] }> = {};
      for (let i = 0; i < attempts.length; i++) {
        const a = attempts[i];
        if (!summary[a.scenario]) { summary[a.scenario] = { ok: 0, failed: 0, codes: [], ms: [] }; }
        if (a.ok) { summary[a.scenario].ok++; } else { summary[a.scenario].failed++; summary[a.scenario].codes.push(a.code); }
        summary[a.scenario].ms.push(a.ms);
      }
      press(KEY.back);
      return wait(1500).then(function () {
        const out = { summary: summary, afterBack: router.stack().slice(-1)[0], freeMB: platform.memory().availableMB };
        router.resetTo('playlists');
        return svc.remove(id).then(function () { return out; });
      });
    }, function (e) {
      log.setLevel('info');
      router.resetTo('playlists');
      return (id ? svc.remove(id) : Promise.resolve()).then(function () { throw e; });
    });
  }

  // ------------------------------------------------------------ gzip XMLTV guides
  // One playlist of 2,000 channels; its guide is first the valid gzip file (via the M3U url-tvg),
  // then each variant through the playlist's EPG address. Failing variants must keep the guide.
  type Probe = { stop(): { maxLagMs: number; over100: number; minFreeMB: number } };
  function lagProbe(): Probe {
    let maxLag = 0;
    let over = 0;
    let n = 0;
    let last = Date.now();
    let minFree = platform.memory().availableMB;
    const h = setInterval(function () {
      const now = Date.now();
      const lag = now - last - 50;
      last = now;
      if (lag > maxLag) { maxLag = lag; }
      if (lag > 100) { over++; }
      if (++n % 10 === 0) {
        const m = platform.memory().availableMB;
        if (m >= 0 && m < minFree) { minFree = m; }
      }
    }, 50);
    return { stop: function () { clearInterval(h); return { maxLagMs: maxLag, over100: over, minFreeMB: minFree }; } };
  }
  function gzipGuides(): Promise<unknown> {
    const N = 2000;
    const out: Record<string, unknown> = {};
    let id = '';
    let channels: Channel[] = [];
    function measure(label: string, epgPath: string | null): Promise<void> {
      const set = epgPath === null ? Promise.resolve() : svc.update(id, { epgUrl: origin + epgPath }).then(function (r) {
        if (!r.ok) { throw new Error('update failed: ' + r.code); }
      });
      return set.then(function () {
        const before = epg.status().programmes;
        const free0 = platform.memory().availableMB;
        const probe = lagProbe();
        const t0 = Date.now();
        return epg.refresh(id, channels).result.then(function (r) {
          const p = probe.stop();
          const st = epg.status();
          out[label] = {
            ok: r.ok, code: r.code || '', ms: Date.now() - t0, programmes: r.programmes, before: before,
            after: st.programmes, state: st.state, maxStallMs: p.maxLagMs, stallsOver100ms: p.over100, freeBeforeMB: free0, minFreeMB: p.minFreeMB
          };
          L.info('gzip guide', { variant: label, result: out[label] });
        });
      });
    }
    return addAndImport(origin + '/fixture/channels.m3u?n=' + N + '&guide=' + encodeURIComponent('/fixture/guide.xml.gz?n=' + N), 'selftest gz')
      .then(function (pid) {
        id = pid;
        return svc.loadLive(id);
      }).then(function (l) {
        channels = l.status === 'ok' ? l.catalogue.channels : [];
        out.channels = channels.length;
        return epg.load(id);
      })
      .then(function () { return measure('gzip via url-tvg (.gz name, application/gzip)', null); })
      .then(function () { return measure('gzip without .gz name (octet-stream; restart as binary)', '/fixture/guide-gz?n=' + N); })
      .then(function () { return measure('gzip with Content-Encoding (browser decodes)', '/fixture/guide-ce.xml.gz?n=' + N); })
      .then(function () { return measure('corrupt gzip (must fail, keep guide)', '/fixture/guide-corrupt.xml.gz?n=' + N); })
      .then(function () { return measure('truncated gzip (must fail, keep guide)', '/fixture/guide-trunc.xml.gz?n=' + N); })
      .then(function () { return measure('uncompressed XMLTV (regression)', '/fixture/guide.xml?n=' + N); })
      .then(function () { return svc.remove(id); })
      .then(function () { return out; }, function (e) {
        return (id ? svc.remove(id) : Promise.resolve()).then(function () { throw e; });
      });
  }

  function cleanup(): Promise<number> {
    const old = svc.list().filter(function (d) { return d.name.indexOf('selftest ') === 0; });
    let chain: Promise<void> = Promise.resolve();
    for (let i = 0; i < old.length; i++) {
      const pid = old[i].id;
      chain = chain.then(function () { return svc.remove(pid); });
    }
    return chain.then(function () { return old.length; });
  }

  return cleanup().then(function (n) { if (n) { L.info('removed leftover self-test playlists', { count: n }); } })
    .then(function () { return step(L, 'playback recovery (synthetic LAN streams' + (aligned ? ', packet-aligned' : ', joined mid-packet') + ', real AVPlay)', recovery()); })
    .then(function () { return withGuides ? step(L, 'gzip XMLTV guides (2,000 channels, 52,000 programmes)', gzipGuides()) : undefined; })
    .then(function () { L.info('stage 5.1 self-test done', { memory: platform.memory() }); });
}
