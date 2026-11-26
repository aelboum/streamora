// Track metadata merge and audio quality ranking (Stage 7E). Pure functions, no DOM, no I/O.
//
// mergeProbe: the engine's track list (what can be selected) + the container probe (what the file
// states). The probe is used for a kind (audio / subtitles) only when it lists exactly as many
// tracks of that kind as the engine, in the same order (verified on the TV, Stage 7E E1), and —
// for audio — every language the engine reports agrees with the probe's ("en" vs "eng").
// Stage 7F-D5: when the engine lists FEWER audio tracks than the file (it hides codecs it cannot
// decode, e.g. TrueHD), alignHidden places the engine's tracks in order onto the file's with strict
// language / codec / channel agreement and is used only when exactly one placement exists.
// Anything else keeps the engine's values: no metadata is attached to the wrong track.
//
// bestAudio: the best-quality track of one language. A track is "best" only when it is at least as
// good as every other track of that language on every stated measure — bitrate, channels and sample
// rate — and better on at least one. Missing values (0) make the comparison undecided, so no track
// is called best and nothing is switched. This never guesses from a single figure: more channels
// alone, or a different codec alone, never decides.
import type { MediaTrack } from './engine.ts';
import type { ProbeTrack } from './media-probe.ts';
import { cutMatches, noLanguage, normLang, normLangLoose } from '../i18n/languages.ts';

function sameLanguage(engineLang: string, probeLang: string): boolean {
  if (noLanguage(engineLang) || noLanguage(probeLang)) { return true; }
  const e = engineLang.toLowerCase().split('-')[0];
  const p = probeLang.toLowerCase().split('-')[0];
  if (e.length === 2 && p.length === 3 && p.substring(0, 2) === e) { return true; } // AVPlay truncation
  // Stage 7F-D5: the file states a 2-letter code, AVPlay cut the 3-letter one ("pl" ↔ "po" from "pol").
  if (e.length === 2 && cutMatches(e, p)) { return true; }
  return normLangLoose(e) === normLang(p) || normLang(e) === normLang(p);
}

/**
 * Stage 7F-D5, strict pair test for alignment: both languages missing, or both stated and equal
 * (AVPlay's two-letter cut "fr" ~ "fre"); a codec or channel count stated on both sides must agree.
 * Unlike sameLanguage, a missing language on one side only does NOT match.
 */
function strictPair(t: MediaTrack, q: ProbeTrack): boolean {
  const en = noLanguage(t.language);
  const pn = noLanguage(q.language);
  if (en !== pn) { return false; }
  if (!en && !sameLanguage(t.language, q.language)) { return false; }
  if (t.codec && q.codec && t.codec !== q.codec) { return false; }
  if ((t.channels || 0) > 0 && q.channels > 0 && t.channels !== q.channels) { return false; }
  return true;
}

/**
 * Stage 7F-D5: the engine lists fewer audio tracks than the file. Finds every way to place the
 * engine's tracks, IN ORDER, onto file tracks with strictPair. Only when there is exactly one such
 * placement is it returned (engine index → file index); any ambiguity (two same-language tracks the
 * engine could be either of, unknown languages, …) returns null and the engine's own values stay.
 * Track ids, selection and the engine's list are never changed: only labels gain metadata.
 */
export function alignHidden(e: MediaTrack[], p: ProbeTrack[]): number[] | null {
  const n = e.length;
  const m = p.length;
  if (!n || n >= m) { return null; }
  // ways[i][j]: number of placements of e[i..] onto p[j..], capped at 2 (only 0 / 1 / many matter).
  const ways: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[] = [];
    for (let j = 0; j <= m; j++) { row.push(i === n ? 1 : 0); }
    ways.push(row);
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let w = ways[i][j + 1];
      if (strictPair(e[i], p[j])) { w += ways[i + 1][j + 1]; }
      ways[i][j] = w > 2 ? 2 : w;
    }
  }
  if (ways[0][0] !== 1) { return null; }
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    // The unique placement: take p[j] for e[i] when that branch holds the one placement, else skip p[j].
    while (j < m && !(strictPair(e[i], p[j]) && ways[i + 1][j + 1] === 1)) { j++; }
    if (j >= m) { return null; }
    out.push(j);
    j++;
  }
  return out;
}

/**
 * Stage 7F-E: AVPlay on this TV lists at most this many tracks of a file (video + audio + subtitles),
 * the first ones in file order (TV run 6: lab files with 40 subtitles → 30 listed, with 15 subtitles
 * + 10 audio + 15 subtitles → 21, and "Do Not Disturb" 1 + 6 + 33 → 25; cue text of every listed
 * track matched the file track at that position).
 */
export const AVPLAY_TRACK_LIMIT = 32;

/**
 * Stage 7F-E: the engine lists fewer subtitle tracks than the file. Used only when the file has more
 * tracks than AVPLAY_TRACK_LIMIT and the limit explains the engine's list EXACTLY: the file's first
 * AVPLAY_TRACK_LIMIT tracks hold as many subtitle tracks as the engine lists, and the engine's audio
 * plus subtitle count plus the video tracks in that window is the limit. Any other reason for hiding
 * (an unsupported codec, a different firmware) breaks that equality and nothing is attached. A
 * language the engine states must agree. Returns engine text index → file text index, or null.
 */
export function alignTrackLimit(eText: MediaTrack[], engineAudio: number, probe: ProbeTrack[]): number[] | null {
  const k = eText.length;
  if (!k || probe.length <= AVPLAY_TRACK_LIMIT) { return null; }
  let textIn = 0;
  let videoIn = 0;
  let textAll = 0;
  for (let i = 0; i < probe.length; i++) {
    if (probe[i].kind === 'text') { textAll++; if (i < AVPLAY_TRACK_LIMIT) { textIn++; } }
    if (probe[i].kind === 'video' && i < AVPLAY_TRACK_LIMIT) { videoIn++; }
  }
  if (k >= textAll || textIn !== k || videoIn + engineAudio + k !== AVPLAY_TRACK_LIMIT) { return null; }
  const out: number[] = [];
  let n = 0;
  for (let i = 0; i < AVPLAY_TRACK_LIMIT; i++) {
    if (probe[i].kind !== 'text') { continue; }
    const e = eText[n];
    if (!noLanguage(e.language) && (noLanguage(probe[i].language) || !sameLanguage(e.language, probe[i].language))) { return null; }
    out.push(n);
    n++;
  }
  return out;
}

export function mergeProbe(tracks: MediaTrack[], probe: ProbeTrack[] | null): MediaTrack[] {
  const out: MediaTrack[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const s = tracks[i];
    out.push({
      kind: s.kind, id: s.id, language: s.language, label: s.label, selected: s.selected, langExact: s.langExact,
      codec: s.codec, channels: s.channels, sampleRate: s.sampleRate, bitrate: s.bitrate, name: s.name, forced: s.forced, sdh: s.sdh
    });
  }
  if (!probe || !probe.length) { return out; }
  const kinds: Array<'audio' | 'text'> = ['audio', 'text'];
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    const e: MediaTrack[] = [];
    const p: ProbeTrack[] = [];
    for (let i = 0; i < out.length; i++) { if (out[i].kind === kind) { e.push(out[i]); } }
    for (let i = 0; i < probe.length; i++) { if (probe[i].kind === kind) { p.push(probe[i]); } }
    if (!e.length) { continue; }
    // pair[i] = index into p of the file track that engine track i is; null = attach nothing.
    let pair: number[] | null = null;
    if (e.length === p.length) {
      let ok = true;
      for (let i = 0; i < e.length && ok; i++) { if (!sameLanguage(e[i].language, p[i].language)) { ok = false; } }
      if (ok) {
        pair = [];
        for (let i = 0; i < e.length; i++) { pair.push(i); }
      }
    } else if (kind === 'audio' && e.length < p.length) {
      // Stage 7F-D5: the engine hides tracks it cannot decode (TrueHD on this TV, run 4).
      pair = alignHidden(e, p);
    } else if (kind === 'text' && e.length < p.length) {
      // Stage 7F-E: AVPlay's track limit cuts the subtitle list (TV run 6); its own list states nothing.
      let nAudio = 0;
      for (let i = 0; i < out.length; i++) { if (out[i].kind === 'audio') { nAudio++; } }
      pair = alignTrackLimit(e, nAudio, probe);
    }
    if (!pair) { continue; }
    for (let i = 0; i < e.length; i++) {
      const t = e[i];
      const q = p[pair[i]];
      if (q.language) { t.language = q.language; t.langExact = true; }
      if (q.codec) { t.codec = q.codec; }
      if (q.channels > 0) { t.channels = q.channels; }
      if (q.sampleRate > 0) { t.sampleRate = q.sampleRate; }
      if (q.bitrate > 0) { t.bitrate = q.bitrate; }
      if (q.name) { t.name = q.name; }
      if (q.forced) { t.forced = true; }
      if (kind === 'text' && q.hearingImpaired) { t.sdh = true; }
    }
  }
  return out;
}

/** a is at least as good as b on every measure and better on one; false when a measure is unknown. */
function dominates(a: MediaTrack, b: MediaTrack): boolean {
  const ab = a.bitrate || 0;
  const bb = b.bitrate || 0;
  const ac = a.channels || 0;
  const bc = b.channels || 0;
  const ar = a.sampleRate || 0;
  const br = b.sampleRate || 0;
  if (!ab || !bb || !ac || !bc || !ar || !br) { return false; }
  return ab >= bb && ac >= bc && ar >= br && (ab > bb || ac > bc || ar > br);
}

/** Language group key of an audio track ('' = no / unknown language). */
export function audioLanguage(t: MediaTrack): string {
  if (noLanguage(t.language)) { return ''; }
  return t.langExact === false ? normLangLoose(t.language) : normLang(t.language);
}

/**
 * The best-quality audio track among those of `language` (see the header), or −1 when there is
 * only one such track or no single track is best on the stated figures.
 */
export function bestAudio(tracks: MediaTrack[], language: string): number {
  const c: MediaTrack[] = [];
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].kind === 'audio' && audioLanguage(tracks[i]) === language) { c.push(tracks[i]); }
  }
  if (c.length < 2) { return -1; }
  for (let i = 0; i < c.length; i++) {
    let all = true;
    for (let j = 0; j < c.length && all; j++) { if (j !== i && !dominates(c[i], c[j])) { all = false; } }
    if (all) { return c[i].id; }
  }
  return -1;
}

/** Ids of the tracks shown as "Best quality" (one per language at most). */
export function bestAudioIds(tracks: MediaTrack[]): number[] {
  const seen: Record<string, boolean> = {};
  const out: number[] = [];
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].kind !== 'audio') { continue; }
    const l = audioLanguage(tracks[i]);
    if (Object.prototype.hasOwnProperty.call(seen, l)) { continue; }
    seen[l] = true;
    const b = bestAudio(tracks, l);
    if (b >= 0) { out.push(b); }
  }
  return out;
}

/**
 * Automatic audio choice when a title starts: the language is the one the user picked before (when
 * the title has it), otherwise the language of the track the stream starts with. Within that
 * language the best-quality track is chosen. −1 = keep the current track. Never changes language
 * on quality grounds.
 */
export function autoAudio(tracks: MediaTrack[], preferred: string): number {
  let cur: MediaTrack | null = null;
  let hasPref = false;
  const pref = preferred ? normLang(preferred) : '';
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.kind !== 'audio') { continue; }
    if (t.selected) { cur = t; }
    if (pref && audioLanguage(t) === pref) { hasPref = true; }
  }
  const lang = hasPref ? pref : cur ? audioLanguage(cur) : '';
  if (!lang && !cur) { return -1; }
  const best = bestAudio(tracks, lang);
  if (best >= 0) { return cur && cur.id === best ? -1 : best; }
  // No single best: switch only to reach the preferred language (its first track).
  if (hasPref && (!cur || audioLanguage(cur) !== pref)) {
    for (let i = 0; i < tracks.length; i++) { if (tracks[i].kind === 'audio' && audioLanguage(tracks[i]) === pref) { return tracks[i].id; } }
  }
  return -1;
}
