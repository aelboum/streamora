// Audio & subtitles side sheet in the VOD player (Stage 7B.2; design P3 "Player · Audio & subtitles").
// Right-hand panel over the video: "Audio" rows, then "Subtitles" with "Off" first. ▲▼ move over the
// rows, OK picks (the chosen row gets a ✓), Back closes. Rows come from the engine's track list, so a
// title with one audio track and no subtitles shows that honestly instead of fake options.
import type { MediaTrack } from '../player/engine.ts';
import type { Translate } from '../i18n/strings.ts';
import { languageName, uiLanguage } from '../i18n/languages.ts';
import { bestAudioIds } from '../player/track-info.ts';
import { createIcon } from '../components/brand.ts';
import { clear, h } from '../utils/dom.ts';

export interface TrackRow { kind: 'audio' | 'text'; id: number; language: string }

export interface TrackSheet {
  element: HTMLElement;
  isOpen(): boolean;
  open(tracks: MediaTrack[]): void;
  /** Re-reads the list while open (selection changed); keeps the focused row. */
  update(tracks: MediaTrack[]): void;
  close(): void;
  /** Returns the picked row on OK, 'close' on Back, null for other keys (consumed while open). */
  key(k: string): TrackRow | 'close' | null;
}

const CODEC: Record<string, string> = {
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', mp3: 'MP3', mp2: 'MP2',
  opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', pcm: 'PCM', alac: 'ALAC'
};
const IMAGE_SUBS: Record<string, boolean> = { pgs: true, vobsub: true, dvbsub: true };
/** Stage 7F-E: subtitle formats named in the row (only when the file states the codec). */
const SUB_FORMAT: Record<string, string> = {
  srt: 'SRT', ass: 'ASS', webvtt: 'WebVTT', ttml: 'TTML', tx3g: 'MP4 Timed Text', pgs: 'PGS', vobsub: 'VobSub', dvbsub: 'DVB'
};

function channelText(t: Translate, n: number): string {
  return n === 1 ? t('vod.mono') : n === 2 ? t('vod.stereo') : n === 6 ? '5.1' : n === 8 ? '7.1' : n > 0 ? t('vod.channels', { n: n }) : '';
}

/**
 * Row text: language name in the UI language (or "Unknown language" when neither the file nor the
 * player states one; "Unknown language 1", "… 2" when several tracks of the list have none — Stage 7F),
 * then what is known about the track: channels, codec, bitrate, "Best quality", forced,
 * the track's own name. `dup` numbers rows whose text would otherwise be identical.
 */
export function trackLabel(t: Translate, tr: MediaTrack, _n: number, opts?: { best?: boolean; dup?: number; unknownN?: number }): string {
  const ui = uiLanguage(t);
  const lang = languageName(tr.language, ui, tr.langExact);
  // `_n` (position in the list) is kept for callers; a missing language is never guessed.
  let main = lang || (opts && opts.unknownN ? t('vod.unknownLangN', { n: opts.unknownN }) : t('vod.unknownLang'));
  if (opts && opts.dup) { main += ' (' + opts.dup + ')'; }
  const parts: string[] = [];
  if (tr.kind === 'audio') {
    const ch = channelText(t, tr.channels || 0);
    if (ch) { parts.push(ch); }
    if (tr.codec && CODEC[tr.codec]) { parts.push(CODEC[tr.codec]); }
    if (tr.bitrate && tr.bitrate >= 8000) { parts.push(t('vod.kbps', { n: Math.round(tr.bitrate / 1000) })); }
  } else {
    // Stage 7F-E: flags only as the file states them (FlagForced, FlagHearingImpaired, a CEA-608 track).
    if (tr.forced) { parts.push(t('vod.forced')); }
    if (tr.sdh) { parts.push(t('vod.sdh')); }
    if (tr.codec === 'cea608') { parts.push(t('vod.cc')); }
    if (tr.codec && IMAGE_SUBS[tr.codec]) { parts.push(t('vod.imageSubs')); }
    const f = tr.codec && SUB_FORMAT[tr.codec] ? SUB_FORMAT[tr.codec] : '';
    if (f && (tr.name || '').toLowerCase().indexOf(f.toLowerCase()) < 0) { parts.push(f); }
  }
  const nm = tr.name || '';
  if (nm && nm.toLowerCase() !== lang.toLowerCase() && nm.toLowerCase() !== languageName(tr.language, 'en', tr.langExact).toLowerCase() &&
    nm.toLowerCase() !== (tr.language || '').toLowerCase() &&
    !(tr.forced && /^forced$/i.test(nm)) && !(tr.sdh && /^sdh$/i.test(nm))) {
    parts.push(nm);
  }
  if (tr.kind === 'audio' && opts && opts.best) { parts.push(t('vod.best')); }
  if (!parts.length && tr.label && tr.channels === undefined) { parts.push(tr.label); }
  return parts.length ? main + ' · ' + parts.join(' · ') : main;
}

/** Row texts for one kind, numbering rows that would read the same. */
export function trackLabels(t: Translate, list: MediaTrack[], best: number[]): string[] {
  const ui = uiLanguage(t);
  // Tracks without a language are numbered among themselves when there are several.
  const unknown: number[] = [];
  let unknownCount = 0;
  for (let i = 0; i < list.length; i++) {
    if (!languageName(list[i].language, ui, list[i].langExact)) { unknownCount++; unknown.push(unknownCount); } else { unknown.push(0); }
  }
  if (unknownCount < 2) { for (let i = 0; i < unknown.length; i++) { unknown[i] = 0; } }
  const plain: string[] = [];
  const count: Record<string, number> = {};
  for (let i = 0; i < list.length; i++) {
    const b = best.indexOf(list[i].id) >= 0;
    plain.push(trackLabel(t, list[i], i + 1, { best: b, unknownN: unknown[i] }));
    count[plain[i]] = (count[plain[i]] || 0) + 1;
  }
  const seen: Record<string, number> = {};
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (count[plain[i]] > 1) {
      seen[plain[i]] = (seen[plain[i]] || 0) + 1;
      out.push(trackLabel(t, list[i], i + 1, { best: best.indexOf(list[i].id) >= 0, dup: seen[plain[i]], unknownN: unknown[i] }));
    } else {
      out.push(plain[i]);
    }
  }
  return out;
}

export function createTrackSheet(doc: Document, t: Translate): TrackSheet {
  const list = h(doc, 'div', { className: 'ss-tracks__list' });
  const root = h(doc, 'div', { className: 'ss-tracks is-hidden' }, [
    h(doc, 'div', { className: 'ss-tracks__title', text: t('vod.tracks') }),
    list
  ]);
  let rows: TrackRow[] = [];
  let els: HTMLElement[] = [];
  let focus = 0;
  let open = false;

  function build(tracks: MediaTrack[]): void {
    clear(list);
    rows = [];
    els = [];
    const audio: MediaTrack[] = [];
    const text: MediaTrack[] = [];
    for (let i = 0; i < tracks.length; i++) { (tracks[i].kind === 'audio' ? audio : text).push(tracks[i]); }
    if (!audio.length && !text.length) {
      list.appendChild(h(doc, 'div', { className: 'ss-tracks__empty', text: t('vod.noTracks') }));
      return;
    }
    function row(r: TrackRow, label: string, selected: boolean): void {
      const el = h(doc, 'div', { className: 'ss-tracks__row' + (selected ? ' is-selected' : '') }, [
        h(doc, 'div', { className: 'ss-tracks__name', text: label }),
        selected ? createIcon(doc, 'check', '#4FA8FF', 'ss-tracks__check') : h(doc, 'div', { className: 'ss-tracks__check' })
      ]);
      rows.push(r);
      els.push(el);
      list.appendChild(el);
    }
    if (audio.length) {
      list.appendChild(h(doc, 'div', { className: 'ss-tracks__head', text: t('vod.audio') }));
      const al = trackLabels(t, audio, bestAudioIds(audio));
      for (let i = 0; i < audio.length; i++) {
        row({ kind: 'audio', id: audio[i].id, language: audio[i].language }, al[i], audio[i].selected);
      }
    }
    list.appendChild(h(doc, 'div', { className: 'ss-tracks__head', text: t('vod.subs') }));
    let anyOn = false;
    for (let i = 0; i < text.length; i++) { if (text[i].selected) { anyOn = true; } }
    row({ kind: 'text', id: -1, language: '' }, t('vod.subsOff'), !anyOn);
    const tl = trackLabels(t, text, []);
    for (let i = 0; i < text.length; i++) {
      row({ kind: 'text', id: text[i].id, language: text[i].language }, tl[i], text[i].selected);
    }
  }

  function paint(): void {
    for (let i = 0; i < els.length; i++) {
      els[i].className = els[i].className.replace(/ ?is-focused/g, '') + (i === focus ? ' is-focused' : '');
    }
  }

  return {
    element: root,
    isOpen: function () { return open; },
    open: function (tracks) {
      build(tracks);
      focus = 0;
      for (let i = 0; i < els.length; i++) { if (/is-selected/.test(els[i].className)) { focus = i; break; } }
      open = true;
      root.className = 'ss-tracks';
      paint();
    },
    update: function (tracks) {
      if (!open) { return; }
      const f = focus;
      build(tracks);
      focus = Math.max(0, Math.min(els.length - 1, f));
      paint();
    },
    close: function () {
      open = false;
      root.className = 'ss-tracks is-hidden';
    },
    key: function (k) {
      if (k === 'back') { return 'close'; }
      if (k === 'up' || k === 'down') {
        if (els.length) {
          focus = Math.max(0, Math.min(els.length - 1, focus + (k === 'up' ? -1 : 1)));
          paint();
        }
        return null;
      }
      if (k === 'ok') { return rows[focus] || null; }
      return null;
    }
  };
}
