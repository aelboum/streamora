// Preferred audio and subtitle language (Stage 7B.2). KV "prefs.tracks": { audio, text }.
//   audio: ISO 639 code of the last audio language the user picked ('' = stream default)
//   text:  ISO 639 code of the last subtitle language picked; '' = subtitles off
// The player applies them when a title's tracks become known; Settings (part 3) can change them.
import type { KeyValueStore } from '../storage/kv-store.ts';
import type { MediaTrack } from '../player/engine.ts';
import { normLang, normLangLoose } from '../i18n/languages.ts';

export interface TrackPrefs { audio: string; text: string }

export interface TrackPrefStore {
  get(): TrackPrefs;
  set(p: Partial<TrackPrefs>): void;
}

const KEY = 'prefs.tracks';
const LANG_RE = /^[a-z-]{0,12}$/;

function isPrefs(x: unknown): x is TrackPrefs {
  const p = x as TrackPrefs;
  return !!p && typeof p === 'object' && typeof p.audio === 'string' && typeof p.text === 'string' && LANG_RE.test(p.audio) && LANG_RE.test(p.text);
}

export function createTrackPrefs(kv: KeyValueStore): TrackPrefStore {
  return {
    get: function () { return kv.get<TrackPrefs>(KEY, isPrefs, { audio: '', text: '' }); },
    set: function (p) {
      const cur = kv.get<TrackPrefs>(KEY, isPrefs, { audio: '', text: '' });
      const next: TrackPrefs = { audio: cur.audio, text: cur.text };
      if (typeof p.audio === 'string') { next.audio = normLang(p.audio); }
      if (typeof p.text === 'string') { next.text = normLang(p.text); }
      kv.set(KEY, next);
    }
  };
}

// Stage 7E: language codes and names live in i18n/languages.ts (ISO 639-1/639-2, UI-language names).
export { normLang, languageName } from '../i18n/languages.ts';

/** Language of a track for matching preferences (AVPlay's 2-letter values only when unambiguous). */
function trackLang(t: MediaTrack): string {
  return t.langExact === false ? normLangLoose(t.language) : normLang(t.language);
}

/**
 * Subtitle track for the saved subtitle language: a full (not forced) track of that language first,
 * a forced one otherwise. null = nothing to change (no preference, not present, or already on).
 */
export function preferredText(tracks: MediaTrack[], prefs: TrackPrefs): { kind: 'text'; id: number } | null {
  if (!prefs.text) { return null; }
  const want = normLang(prefs.text);
  let full = -1;
  let forced = -1;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.kind !== 'text' || trackLang(t) !== want) { continue; }
    if (t.selected) { return null; }
    if (t.forced) { if (forced < 0) { forced = t.id; } } else if (full < 0) { full = t.id; }
  }
  const id = full >= 0 ? full : forced;
  return id >= 0 ? { kind: 'text', id: id } : null;
}

/**
 * Tracks to switch to for the saved preferences (Stage 7B.2 behaviour, kept for callers and tests):
 * the first track of the preferred language that is not already selected. Subtitles stay off unless
 * a subtitle language was chosen before.
 */
export function preferredChoices(tracks: MediaTrack[], prefs: TrackPrefs): Array<{ kind: 'audio' | 'text'; id: number }> {
  const out: Array<{ kind: 'audio' | 'text'; id: number }> = [];
  const kinds: Array<'audio' | 'text'> = ['audio', 'text'];
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    const want = kind === 'audio' ? prefs.audio : prefs.text;
    if (!want) { continue; }
    const w = normLang(want);
    let already = false;
    let pick = -1;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t.kind !== kind || trackLang(t) !== w) { continue; }
      if (t.selected) { already = true; break; }
      if (pick < 0) { pick = t.id; }
    }
    if (!already && pick >= 0) { out.push({ kind: kind, id: pick }); }
  }
  return out;
}
