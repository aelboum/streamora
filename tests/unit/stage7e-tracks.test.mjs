// Stage 7E: container probe (MP4 with moov at the end / at the start, Matroska), ISO 639 language
// names incl. AVPlay's 2-letter truncation, merging probe data into the engine's track list,
// best-quality audio ranking, automatic audio choice, track-sheet labels, and the VOD controller
// running the probe after the first picture. Fixtures: tests/fixtures/media/*, made with ffmpeg
// from synthetic sources (colour + sine tone), checked against ffprobe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeWith, cleanText, MAX_BLOCKS } from '../../src/player/media-probe.ts';
import { languageName, normLang, normLangLoose } from '../../src/i18n/languages.ts';
import { mergeProbe, bestAudio, bestAudioIds, autoAudio, audioLanguage } from '../../src/player/track-info.ts';
import { trackLabel, trackLabels } from '../../src/screens/track-sheet.ts';
import { preferredText } from '../../src/services/track-prefs.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createVodController } from '../../src/player/vod-controller.ts';
import { createFakeEngine } from '../fakes/fake-engine.mjs';
import { createLogger } from '../../src/utils/log.ts';

const media = (f) => readFileSync(new URL('../fixtures/media/' + f, import.meta.url));
function fileReader(buf, log) {
  return async (s, e) => {
    if (log) log.push([s, e]);
    return { data: buf.subarray(s, Math.min(e + 1, buf.length)).toString('latin1'), total: buf.length };
  };
}
const brief = (r) => r.tracks.filter((t) => t.kind !== 'video').map((t) => [t.kind, t.language, t.codec, t.channels, t.bitrate > 0 ? Math.round(t.bitrate / 1000) : 0, t.name, t.forced]);

test('Probe: MP4 with the track table at the end (mdat skipped by its size), 4 audio + 4 subtitle tracks', async () => {
  const reads = [];
  const r = await probeWith(fileReader(media('lang-end.mp4'), reads));
  assert.equal(r.container, 'mp4');
  assert.deepEqual(brief(r), [
    ['audio', 'eng', 'ac3', 6, 384, '', false],
    ['audio', 'eng', 'aac', 2, 128, '', false],
    ['audio', 'fre', 'aac', 2, 96, '', false],
    ['audio', 'dut', 'aac', 1, 65, '', false],
    ['text', 'eng', 'tx3g', 0, 0, 'English SDH', false],
    ['text', 'fre', 'tx3g', 0, 0, '', false],
    ['text', 'ara', 'tx3g', 0, 0, '', false],
    ['text', '', 'tx3g', 0, 0, '', false]
  ]);
  assert.equal(r.tracks[1].sampleRate, 48000);
  assert.ok(reads.length <= 3, 'only the blocks holding headers are read: ' + reads.length);
});

test('Probe: MP4 with the track table first, and Matroska with names, forced flag and undetermined language', async () => {
  const fast = await probeWith(fileReader(media('lang-fast.mp4')));
  assert.equal(fast.requests, 1);
  assert.equal(fast.tracks.filter((t) => t.kind === 'text').length, 4);
  const mkv = await probeWith(fileReader(media('lang.mkv')));
  assert.equal(mkv.container, 'mkv');
  assert.deepEqual(brief(mkv), [
    ['audio', 'eng', 'eac3', 6, 0, 'English 5.1', false],
    ['audio', 'fre', 'aac', 2, 0, '', false],
    ['audio', 'tur', 'ac3', 2, 0, '', false],
    ['text', 'eng', 'srt', 0, 0, '', false],
    ['text', 'dut', 'srt', 0, 0, '', false],
    ['text', 'fre', 'ass', 0, 0, 'Forced', true],
    ['text', 'ara', 'srt', 0, 0, '', false],
    ['text', '', 'srt', 0, 0, '', false]
  ], 'bitrates the file does not state stay unknown (0)');
});

test('Probe: not a media file, failed reads, a cut-off file and the request budget give null, never a throw', async () => {
  assert.equal(await probeWith(fileReader(Buffer.from('#EXTM3U\n#EXTINF:-1,x\nhttp://a/b.ts\n'))), null);
  assert.equal(await probeWith(async () => null), null);
  assert.equal(await probeWith(async () => { throw new Error('x'); }), null);
  const end = media('lang-end.mp4');
  assert.equal(await probeWith(fileReader(end.subarray(0, 120000))), null, 'track table missing (cut off) = no result');
  // A file of nested empty "free" boxes that never reaches moov: the reader stops at its budget.
  let n = 0;
  const r = await probeWith(async (s, e) => {
    n++;
    const b = Buffer.alloc(e - s + 1);
    for (let i = 0; i + 8 <= b.length; i += 8) { b.writeUInt32BE(8, i); b.write('free', i + 4, 'latin1'); }
    return { data: b.toString('latin1'), total: 1e12 };
  });
  assert.equal(r, null);
  assert.ok(n <= MAX_BLOCKS, 'requests ' + n);
  assert.equal(cleanText('FranÃ§ais\u0000junk'), 'Français');
});

test('Languages: ISO 639-1 / 639-2 T and B folded; names in the UI language; AVPlay 2-letter values only when unambiguous', () => {
  assert.deepEqual(['dut', 'nl', 'nld', 'fre', 'fra', 'fr', 'ger', 'en', 'pt-BR', 'xyz'].map(normLang), ['nld', 'nld', 'nld', 'fra', 'fra', 'fra', 'deu', 'eng', 'por', 'xyz']);
  assert.deepEqual(['eng', 'fre', 'ara', 'dut', 'tur', 'gre', 'cze', 'nob', 'rum', 'hrv'].map((c) => languageName(c)),
    ['English', 'French', 'Arabic', 'Dutch', 'Turkish', 'Greek', 'Czech', 'Norwegian Bokmål', 'Romanian', 'Croatian']);
  assert.deepEqual(['eng', 'fre', 'ara', 'dut'].map((c) => languageName(c, 'nl')), ['Engels', 'Frans', 'Arabisch', 'Nederlands']);
  assert.deepEqual([languageName('und'), languageName('un'), languageName(''), languageName('qqq')], ['', '', '', 'QQQ']);
  // AVPlay cuts "tur" to "tu", "dut" to "du", "swe" to "sw": these stay codes instead of a guessed name.
  assert.deepEqual(['en', 'de', 'nl', 'tu', 'du', 'sw', 'es', 'ru'].map((c) => languageName(c, 'en', false)), ['English', 'German', 'Dutch', 'TU', 'DU', 'SW', 'ES', 'RU']);
  assert.equal(languageName('sw'), 'Swahili', 'a real ISO 639-1 code from another engine is named');
  assert.deepEqual(['en', 'tu', 'sw'].map(normLangLoose), ['eng', 'tu', 'sw']);
});

const avplayLab = () => [
  { kind: 'audio', id: 1, language: 'en', label: '', selected: true, langExact: false, channels: 6, sampleRate: 48000, bitrate: 384000, codec: 'ac3' },
  { kind: 'audio', id: 2, language: 'en', label: '', selected: false, langExact: false, channels: 2, sampleRate: 48000, bitrate: 126278, codec: '' },
  { kind: 'audio', id: 3, language: 'fr', label: '', selected: false, langExact: false, channels: 2, sampleRate: 48000, bitrate: 0, codec: '' },
  { kind: 'audio', id: 4, language: 'du', label: '', selected: false, langExact: false, channels: 1, sampleRate: 48000, bitrate: 0, codec: '' },
  { kind: 'text', id: 5, language: '', label: '', selected: false },
  { kind: 'text', id: 6, language: '', label: '', selected: false },
  { kind: 'text', id: 7, language: '', label: '', selected: false },
  { kind: 'text', id: 8, language: '', label: '', selected: false }
];

test('Merge: probe languages/codecs/bitrates attach to the engine tracks in order; a count or language mismatch keeps the engine values', async () => {
  const probe = (await probeWith(fileReader(media('lang-end.mp4')))).tracks;
  const m = mergeProbe(avplayLab(), probe);
  assert.deepEqual(m.map((t) => [t.id, t.language, t.langExact, t.codec || '', t.bitrate || 0]), [
    [1, 'eng', true, 'ac3', 384000], [2, 'eng', true, 'aac', 127990], [3, 'fre', true, 'aac', 96284], [4, 'dut', true, 'aac', 64777],
    [5, 'eng', true, 'tx3g', 0], [6, 'fre', true, 'tx3g', 0], [7, 'ara', true, 'tx3g', 0], [8, '', undefined, 'tx3g', 0]
  ]);
  assert.equal(m[4].name, 'English SDH');
  assert.equal(avplayLab()[0].language, 'en', 'inputs are not modified');
  // AVPlay lists 3 subtitle tracks, the file 4: subtitles keep the engine's (empty) values, audio still merges.
  const fewer = mergeProbe(avplayLab().slice(0, 7), probe);
  assert.deepEqual(fewer.filter((t) => t.kind === 'text').map((t) => t.language), ['', '', '']);
  assert.equal(fewer[2].language, 'fre');
  // Audio language disagreement (engine "fr" where the file says "eng"): audio is left alone.
  const odd = avplayLab();
  odd[0].language = 'fr';
  assert.equal(mergeProbe(odd, probe)[0].language, 'fr');
  assert.deepEqual(mergeProbe(avplayLab(), null).map((t) => t.language), avplayLab().map((t) => t.language));
});

test('Best quality: only a track at least as good on bitrate, channels and sample rate (and better on one) wins; unknown figures decide nothing', () => {
  const a = (id, lang, br, ch, sr, sel) => ({ kind: 'audio', id, language: lang, label: '', selected: !!sel, channels: ch, sampleRate: sr, bitrate: br });
  assert.equal(bestAudio([a(1, 'eng', 384000, 6, 48000), a(2, 'eng', 128000, 2, 48000)], 'eng'), 1);
  assert.equal(bestAudio([a(1, 'eng', 128000, 6, 48000), a(2, 'eng', 192000, 2, 48000)], 'eng'), -1, 'more channels alone does not decide');
  assert.equal(bestAudio([a(1, 'eng', 0, 6, 48000), a(2, 'eng', 128000, 2, 48000)], 'eng'), -1, 'unknown bitrate: undecided');
  assert.equal(bestAudio([a(1, 'eng', 128000, 2, 48000), a(2, 'eng', 128000, 2, 48000)], 'eng'), -1, 'equal: no best');
  assert.equal(bestAudio([a(1, 'eng', 128000, 2, 48000)], 'eng'), -1, 'a single track is not labelled');
  assert.equal(bestAudio([a(1, 'fra', 384000, 6, 48000), a(2, 'eng', 128000, 2, 48000), a(3, 'eng', 96000, 2, 44100)], 'eng'), 2, 'within the language only');
  assert.deepEqual(bestAudioIds([a(1, 'eng', 128000, 2, 48000), a(2, 'eng', 384000, 6, 48000), a(3, 'fra', 96000, 2, 48000), a(4, 'fra', 64000, 1, 48000)]), [2, 3]);
  assert.equal(audioLanguage({ kind: 'audio', id: 1, language: 'tu', langExact: false, label: '', selected: false }), 'tu');
});

test('Automatic audio: best of the preferred language, else of the starting language; never a language change for quality', () => {
  const a = (id, lang, br, ch, sel) => ({ kind: 'audio', id, language: lang, label: '', selected: !!sel, channels: ch, sampleRate: 48000, bitrate: br });
  const list = [a(1, 'eng', 128000, 2, true), a(2, 'eng', 384000, 6), a(3, 'fra', 96000, 2), a(4, 'fra', 448000, 6)];
  assert.equal(autoAudio(list, ''), 2, 'no preference: best English (the starting language)');
  assert.equal(autoAudio(list, 'fre'), 4, 'French chosen before: best French, not the better-sounding English');
  assert.equal(autoAudio(list, 'deu'), 2, 'preferred language absent: stay with English');
  assert.equal(autoAudio([a(1, 'eng', 384000, 6, true), a(2, 'eng', 128000, 2)], ''), -1, 'already on the best');
  assert.equal(autoAudio([a(1, 'eng', 0, 2, true), a(2, 'fra', 0, 2)], 'fra'), 2, 'quality unknown: only the language switch');
  assert.equal(autoAudio([a(1, 'eng', 0, 2, true), a(2, 'eng', 0, 6)], ''), -1, 'quality unknown: nothing switched');
});

test('Labels: language names, channels, codec, bitrate, best quality, forced, names; numbered duplicates; honest fallbacks', () => {
  const t = createTranslator('en');
  const nl = createTranslator('nl');
  const au = { kind: 'audio', id: 1, language: 'eng', label: '', selected: true, channels: 6, sampleRate: 48000, bitrate: 384000, codec: 'ac3' };
  assert.equal(trackLabel(t, au, 1, { best: true }), 'English · 5.1 · Dolby Digital · 384 kb/s · Best quality');
  assert.equal(trackLabel(nl, au, 1, { best: true }), 'Engels · 5.1 · Dolby Digital · 384 kb/s · Beste kwaliteit');
  assert.equal(trackLabel(t, { kind: 'audio', id: 2, language: 'un', label: '', selected: false, langExact: false, channels: 2, bitrate: 0 }, 2), 'Unknown language · Stereo', 'Stage 7F: no language = Unknown language');
  assert.equal(trackLabel(t, { kind: 'audio', id: 2, language: 'tu', label: '', selected: false, langExact: false, channels: 2 }, 1), 'TU · Stereo', 'a cut-off code is shown as it is');
  assert.equal(trackLabel(t, { kind: 'text', id: 3, language: '', label: '', selected: false }, 4), 'Unknown language');
  assert.equal(trackLabel(t, { kind: 'text', id: 3, language: 'fre', label: '', selected: false, forced: true, name: 'Forced', codec: 'ass' }, 1), 'French · Forced · ASS', 'Stage 7F-E: the stated format is named');
  assert.equal(trackLabel(t, { kind: 'text', id: 3, language: 'eng', label: '', selected: false, name: 'English SDH' }, 1), 'English · English SDH');
  assert.equal(trackLabel(t, { kind: 'text', id: 3, language: 'eng', label: '', selected: false, name: 'English' }, 1), 'English', 'a name repeating the language is not shown twice');
  assert.equal(trackLabel(t, { kind: 'text', id: 3, language: 'eng', label: '', selected: false, codec: 'pgs' }, 1), 'English · Image · PGS');
  const subs = [
    { kind: 'text', id: 3, language: 'eng', label: '', selected: false },
    { kind: 'text', id: 4, language: 'eng', label: '', selected: false },
    { kind: 'text', id: 5, language: 'dut', label: '', selected: false }
  ];
  assert.deepEqual(trackLabels(t, subs, []), ['English (1)', 'English (2)', 'Dutch']);
});

test('Subtitle preference: a full track of the saved language before a forced one; nothing when absent, off or already on', () => {
  const s = (id, lang, forced, sel) => ({ kind: 'text', id, language: lang, label: '', selected: !!sel, forced: !!forced });
  assert.deepEqual(preferredText([s(3, 'fre', true), s(4, 'fre'), s(5, 'eng')], { audio: '', text: 'fra' }), { kind: 'text', id: 4 });
  assert.deepEqual(preferredText([s(3, 'fre', true)], { audio: '', text: 'fra' }), { kind: 'text', id: 3 });
  assert.equal(preferredText([s(5, 'eng')], { audio: '', text: 'fra' }), null);
  assert.equal(preferredText([s(5, 'eng')], { audio: '', text: '' }), null);
  assert.equal(preferredText([s(4, 'fre', false, true)], { audio: '', text: 'fra' }), null);
});

test('VOD controller: the probe runs once after the first picture, its data appears in tracks(), stale results of an older title are ignored', async () => {
  const fe = createFakeEngine();
  const probeCalls = [];
  const release = [];
  const ctl = createVodController({
    engine: fe.engine,
    resolve: async (ref) => ({ url: 'http://s.example/' + ref.id + '.mp4', type: 'mp4', live: false }),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), now: () => Date.now(), prepareTimeoutMs: 15000,
    log: createLogger(200),
    probe: (src) => { probeCalls.push(src.url); return new Promise((r) => release.push(r)); }
  });
  const probe = await probeWith(fileReader(media('lang-end.mp4')));
  ctl.play({ kind: 'movie', id: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  fe.prepared();
  assert.equal(probeCalls.length, 0, 'not before the picture');
  assert.equal(ctl.tracksFinal(), false);
  fe.picture();
  fe.setTracks(avplayLab());
  assert.deepEqual(probeCalls, ['http://s.example/a.mp4']);
  assert.equal(ctl.tracks()[0].language, 'en', 'engine values until the probe answers');
  const rev = ctl.state().tracksRev;
  release.shift()(probe);
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(ctl.tracksFinal(), true);
  assert.ok(ctl.state().tracksRev > rev, 'the screen is told');
  assert.deepEqual(ctl.tracks().slice(0, 5).map((t) => t.language), ['eng', 'eng', 'fre', 'dut', 'eng']);
  // Next title: the first title's late answer must not apply.
  ctl.play({ kind: 'movie', id: 'b' });
  await new Promise((r) => setTimeout(r, 5));
  fe.prepared();
  fe.picture();
  fe.setTracks(avplayLab());
  assert.equal(ctl.tracksFinal(), false);
  release.shift()(null);
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(ctl.tracksFinal(), true, 'an unreadable file still ends the wait');
  assert.equal(ctl.tracks()[0].language, 'en');
  ctl.destroy();
});

test('Stage 7F labels: "Unknown language" for one track without a language, numbered when several; never guessed', () => {
  const t = createTranslator('en');
  const nl = createTranslator('nl');
  const one = [
    { kind: 'text', id: 2, language: 'eng', label: '', selected: false },
    { kind: 'text', id: 3, language: '', label: '', selected: false }
  ];
  assert.deepEqual(trackLabels(t, one, []), ['English', 'Unknown language']);
  const many = [
    { kind: 'text', id: 2, language: '', label: '', selected: false },
    { kind: 'text', id: 3, language: 'dut', label: '', selected: false },
    { kind: 'text', id: 4, language: 'und', label: '', selected: false },
    { kind: 'text', id: 5, language: '', label: '', selected: false }
  ];
  assert.deepEqual(trackLabels(t, many, []), ['Unknown language 1', 'Dutch', 'Unknown language 2', 'Unknown language 3'], 'und and empty are not languages');
  assert.deepEqual(trackLabels(nl, many, []), ['Onbekende taal 1', 'Nederlands', 'Onbekende taal 2', 'Onbekende taal 3']);
  const audio = [
    { kind: 'audio', id: 1, language: 'un', label: '', selected: true, langExact: false, channels: 2, codec: 'aac' },
    { kind: 'audio', id: 2, language: '', label: '', selected: false, channels: 6, codec: 'ac3' }
  ];
  assert.deepEqual(trackLabels(t, audio, []), ['Unknown language 1 · Stereo · AAC', 'Unknown language 2 · 5.1 · Dolby Digital']);
  const twoAudio = [
    { kind: 'audio', id: 1, language: 'tur', label: '', selected: true, channels: 2, codec: 'aac' },
    { kind: 'audio', id: 2, language: 'por', label: '', selected: false, channels: 2, codec: 'aac' }
  ];
  assert.deepEqual(trackLabels(t, twoAudio, []), ['Turkish · Stereo · AAC', 'Portuguese · Stereo · AAC'], 'multiple audio languages listed with format');
});
