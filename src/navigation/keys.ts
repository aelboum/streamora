// Remote-control key mapping. Codes verified on the UE50MU6100 are marked [V]
// (PROBE-REPORT.md §6, PROBE2-REPORT.md §8). Every feature must work with arrows, OK and Back
// alone (decision D6); everything else is an accelerator.

export type RemoteKey =
  | 'up' | 'down' | 'left' | 'right' | 'ok' | 'back'
  | 'chUp' | 'chDown' | 'red' | 'green' | 'yellow' | 'blue'
  | 'play' | 'pause' | 'playPause' | 'stop' | 'rewind' | 'fastForward' | 'info' | 'guide' | 'digit'
  | 'prevChannel' | 'channelList';

export interface MappedKey {
  key: RemoteKey;
  /** 0–9 when key === 'digit'. */
  digit?: number;
}

const CODES: Record<number, RemoteKey> = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', // [V] physical
  10009: 'back',                                          // [V] XF86Back
  427: 'chUp', 428: 'chDown',                             // [V] probe 2, physical
  403: 'red', 404: 'green', 406: 'blue',                  // [V] physical
  405: 'yellow',                                          // registered, press untested
  415: 'play', 19: 'pause', 10252: 'playPause',           // play/playPause untested; pause injected only
  413: 'stop', 412: 'rewind', 417: 'fastForward',         // injected only (no media keys on the user's remote)
  457: 'info',                                            // [A]
  458: 'guide',                                           // [A] Stage 7B.2 (XF86ChannelGuide)
  10190: 'prevChannel',                                   // [A] Stage 10: PreviousChannel (TV getSupportedKeys)
  10073: 'channelList'                                    // [A] Stage 10: ChannelList (TV getSupportedKeys)
};

/** Browser development equivalents (never produced by the TV remote). */
const BROWSER_CODES: Record<number, RemoteKey> = {
  27: 'back',      // Escape
  8: 'back',       // Backspace
  33: 'chUp',      // PageUp
  34: 'chDown'     // PageDown
};

/** Tizen key names registered at start-up so their events reach the app. */
export const TIZEN_KEY_NAMES = [
  'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
  'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'Info', 'Guide',
  'PreviousChannel', 'ChannelList',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
];

export function mapKeyCode(code: number, allowBrowserKeys: boolean): MappedKey | null {
  if (code >= 48 && code <= 57) {
    return { key: 'digit', digit: code - 48 };
  }
  if (Object.prototype.hasOwnProperty.call(CODES, code)) {
    return { key: CODES[code] };
  }
  if (allowBrowserKeys && Object.prototype.hasOwnProperty.call(BROWSER_CODES, code)) {
    return { key: BROWSER_CODES[code] };
  }
  return null;
}

export function isArrow(key: RemoteKey): boolean {
  return key === 'up' || key === 'down' || key === 'left' || key === 'right';
}
