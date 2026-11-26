// Stage 10: Live TV controls without DOM — channel-number entry and previous-channel history.
// Kept apart from the player screen so the rules can be tested on their own.
//
// Number entry: digits (the remote's 123 pad sends key codes 48–57, verified on the TV with the
// physical remote, Stage 10) build a channel number of at most MAX_DIGITS digits. It is tuned
// `timeoutMs` after the last digit, at once on OK, or as soon as MAX_DIGITS digits were typed.
// Back cancels. Leading zeros are ignored ("007" = 7); "0" alone is no channel.
//
// History: only channels whose picture started (the controller's onPlaying) are remembered, so a
// failed tune never becomes "previous". One playlist at a time: another playlist starts empty.

export const MAX_DIGITS = 6;

export interface NumberEntryOptions {
  timeoutMs: number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  /** The typed text changed ('' = entry closed). */
  onChange: (text: string) => void;
  /** Called with the channel number to tune (≥ 1), or 0 when the text is no valid number. */
  onCommit: (num: number) => void;
}

export interface NumberEntry {
  /** True while digits are being typed. */
  active(): boolean;
  text(): string;
  digit(d: number): void;
  /** OK: tune now. False when no entry was active. */
  confirm(): boolean;
  /** Back: close without tuning. False when no entry was active. */
  cancel(): boolean;
  destroy(): void;
}

/** "007" → 7; '' / "0" / non-digits → 0 (no channel). */
export function parseChannelNumber(text: string): number {
  if (!/^\d{1,6}$/.test(text)) { return 0; }
  const n = parseInt(text, 10);
  return n > 0 ? n : 0;
}

export function createNumberEntry(o: NumberEntryOptions): NumberEntry {
  let buf = '';
  let timer: unknown = null;
  function stop(): void {
    if (timer !== null) { o.clearTimer(timer); timer = null; }
  }
  function commit(): void {
    stop();
    const n = parseChannelNumber(buf);
    buf = '';
    o.onChange('');
    o.onCommit(n);
  }
  return {
    active: function () { return buf.length > 0; },
    text: function () { return buf; },
    digit: function (d) {
      if (!(d >= 0 && d <= 9) || Math.floor(d) !== d) { return; }
      buf += String(d);
      o.onChange(buf);
      stop();
      if (buf.length >= MAX_DIGITS) { commit(); return; }
      timer = o.setTimer(function () { timer = null; commit(); }, o.timeoutMs);
    },
    confirm: function () {
      if (!buf) { return false; }
      commit();
      return true;
    },
    cancel: function () {
      if (!buf) { return false; }
      stop();
      buf = '';
      o.onChange('');
      return true;
    },
    destroy: function () { stop(); buf = ''; }
  };
}

export interface ZapHistory {
  /** A channel's picture started on `playlistId`. */
  tuned(playlistId: string, channelId: string): void;
  /** The channel before the current one, or '' (none, or another playlist). */
  previous(playlistId: string): string;
  current(playlistId: string): string;
  clear(): void;
}

/** In memory only (one session); shared by every player screen so it survives leaving the player. */
export function createZapHistory(): ZapHistory {
  let pid = '';
  let cur = '';
  let prev = '';
  return {
    tuned: function (playlistId, channelId) {
      if (!channelId) { return; }
      if (playlistId !== pid) { pid = playlistId; cur = ''; prev = ''; }
      if (channelId === cur) { return; } // a reconnect or retry of the same channel changes nothing
      prev = cur;
      cur = channelId;
    },
    previous: function (playlistId) { return playlistId === pid ? prev : ''; },
    current: function (playlistId) { return playlistId === pid ? cur : ''; },
    clear: function () { pid = ''; cur = ''; prev = ''; }
  };
}

/**
 * Position of a channel number in `list` (indexes into `channels`): the first match in list
 * order, so duplicates resolve the same way every time; −1 when not present. `memo` caches the
 * number table of one list (built on the first lookup, O(n) once, no channel copies).
 */
export function findByNumber(channels: Array<{ num: number }>, list: number[], num: number, memo: { list: number[] | null; map: Record<string, number> | null }): number {
  if (num <= 0) { return -1; }
  if (memo.list !== list || !memo.map) {
    const map: Record<string, number> = {};
    for (let i = 0; i < list.length; i++) {
      const k = 'n' + channels[list[i]].num;
      if (!Object.prototype.hasOwnProperty.call(map, k)) { map[k] = i; }
    }
    memo.list = list;
    memo.map = map;
  }
  const v = memo.map['n' + num];
  return typeof v === 'number' ? v : -1;
}

/** Position of a channel id in `list`; −1 when not present. */
export function findById(channels: Array<{ id: string }>, list: number[], id: string): number {
  for (let i = 0; i < list.length; i++) { if (channels[list[i]].id === id) { return i; } }
  return -1;
}
