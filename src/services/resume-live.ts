// S3: "Play last channel on app startup" (off by default). One cautious attempt per app session:
//   1. only when the option is on, the playlist list is verified (DI-1 whenChecked: never while
//      protected), an active playlist has its login, a player exists, memory is above the floor,
//      no import runs, the user is still on Home with no dialog open;
//   2. the channel is the last one that actually showed a picture (lists.recent(pid)[0], written by
//      the player's onPlaying), it must still exist, and an adult channel is never auto-played
//      while parental control is locked (no PIN prompt at start-up either);
//   3. restart-loop guard: KV startup.resume-guard {at}; no new attempt within RESUME_LOOP_MS of the
//      previous one (a crash during playback restarts the app quickly);
//   4. a "Resuming …" overlay for RESUME_DELAY_MS: any key cancels; then Live TV opens through the
//      normal path with { resume: { channelId } } (its category, so CH± stays in it).
// Playback failures are handled by the normal player (bounded retries, then an error); there is
// no second automatic attempt. Nothing here writes playlist data.
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { PlaylistService } from './playlist-service.ts';
import type { UserLists } from './user-lists.ts';
import type { Parental } from './parental.ts';
import type { Logger } from '../utils/log.ts';
import { createChannelIndex } from '../content/channel-index.ts';
import { isLocked } from '../screens/parental-gate.ts';

// KV names are lowercase (kv-store NAME_RE).
export const RESUME_PREF_KEY = 'startup.resume-last-channel';
export const RESUME_GUARD_KEY = 'startup.resume-guard';
export const RESUME_DELAY_MS = 3000;
export const RESUME_LOOP_MS = 90000;

export type ResumeOutcome =
  | 'started' | 'off' | 'done' | 'storage' | 'no-playlist' | 'no-credentials' | 'no-player' | 'memory'
  | 'importing' | 'no-channel' | 'loop-guard' | 'load-failed' | 'missing-channel' | 'parental' | 'busy-ui'
  | 'cancelled' | 'moved' | 'error';

export interface ResumeUi {
  /** Top screen of the stack (null when empty). */
  top(): string | null;
  overlay(): string | null;
  /** Shows the cancellable "Resuming …" overlay; `cancel` runs on any key. */
  openToast(title: string, body: string, cancel: () => void): void;
  closeToast(): void;
  /** Opens Live TV the normal way, asking it to tune `channelId` in its category. */
  openLive(playlistId: string, channelId: string): void;
}

export interface ResumeDeps {
  kv: KeyValueStore;
  playlists: PlaylistService;
  lists: UserLists;
  parental: Parental | null;
  /** True when free memory is measured below the work floor (memory-policy.ts low()). */
  memoryLow: () => boolean;
  /** A playback engine and the Live TV screens exist. */
  hasPlayer: boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  log: Logger;
  /** Overlay title ("Resuming <channel>…") and body ("Press any key to cancel."). */
  text: (channelName: string) => { title: string; body: string };
  ui: ResumeUi;
  /** The screen the app starts on (normally 'home'). */
  rootScreen: string;
}

export interface ResumeLive {
  enabled(): boolean;
  setEnabled(on: boolean): boolean;
  /** The single start-up attempt (later calls resolve 'done'). */
  run(): Promise<ResumeOutcome>;
}

function isBool(x: unknown): x is boolean { return typeof x === 'boolean'; }
function isGuard(x: unknown): x is { at: number } {
  const g = x as { at: number };
  return !!g && typeof g === 'object' && typeof g.at === 'number' && isFinite(g.at);
}

export function createResumeLive(d: ResumeDeps): ResumeLive {
  let attempted = false;

  function enabled(): boolean { return d.kv.get<boolean>(RESUME_PREF_KEY, isBool, false); }

  function uiFree(): boolean { return d.ui.top() === d.rootScreen && d.ui.overlay() === null; }

  function finish(o: ResumeOutcome): ResumeOutcome {
    d.log.info('resume last channel', { outcome: o });
    return o;
  }

  function attempt(): Promise<ResumeOutcome> {
    const pl = d.playlists;
    return pl.whenChecked().then(function (st): ResumeOutcome | Promise<ResumeOutcome> {
      if (st.status !== 'ok') { return 'storage'; }
      const pid = pl.activeId();
      const def = pid ? pl.get(pid) : null;
      if (!pid || !def) { return 'no-playlist'; }
      if (!d.hasPlayer) { return 'no-player'; }
      if (d.memoryLow()) { return 'memory'; }
      if (pl.importing()) { return 'importing'; }
      const channelId = d.lists.recent(pid)[0];
      if (!channelId) { return 'no-channel'; }
      const now = d.now();
      const last = d.kv.get<{ at: number } | null>(RESUME_GUARD_KEY, function (x): x is { at: number } | null { return isGuard(x); }, null);
      // Within the loop window (also a clock that went back a little) → skip; far in the "future"
      // (the clock went back a lot) → not a usable reference, allow.
      if (last && last.at - now <= RESUME_LOOP_MS && now - last.at < RESUME_LOOP_MS) { return 'loop-guard'; }
      return pl.hasCredentials(pid).then(function (has): ResumeOutcome | Promise<ResumeOutcome> {
        if (!has) { return 'no-credentials'; }
        return pl.loadLive(pid).then(function (l): ResumeOutcome | Promise<ResumeOutcome> {
          if (l.status !== 'ok') { return 'load-failed'; }
          const idx = createChannelIndex(l.catalogue);
          const ci = idx.indexOfId(channelId);
          if (ci < 0) { return 'missing-channel'; }
          const ch = idx.channels[ci];
          if (isLocked(d.parental, !!ch.adult)) { return 'parental'; }
          if (d.memoryLow()) { return 'memory'; }
          if (pl.storageState().status !== 'ok') { return 'storage'; }
          if (!uiFree()) { return 'busy-ui'; }
          d.kv.set(RESUME_GUARD_KEY, { at: d.now() });
          return new Promise<ResumeOutcome>(function (resolve) {
            let settled = false;
            const timer = d.setTimer(function () {
              if (settled) { return; }
              settled = true;
              d.ui.closeToast();
              if (!uiFree() || pl.storageState().status !== 'ok' || d.memoryLow()) { resolve('moved'); return; }
              d.ui.openLive(pid, channelId);
              resolve('started');
            }, RESUME_DELAY_MS);
            const msg = d.text(ch.name);
            d.ui.openToast(msg.title, msg.body, function () {
              if (settled) { return; }
              settled = true;
              d.clearTimer(timer);
              d.ui.closeToast();
              resolve('cancelled');
            });
          });
        });
      });
    });
  }

  return {
    enabled: enabled,
    setEnabled: function (on) { return d.kv.set(RESUME_PREF_KEY, !!on); },
    run: function () {
      if (attempted) { return Promise.resolve<ResumeOutcome>('done'); }
      attempted = true; // once per app session, whatever happens below
      if (!enabled()) { return Promise.resolve(finish('off')); }
      return attempt().then(finish, function () { return finish('error'); });
    }
  };
}
