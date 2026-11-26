// Stage 7F-E: subtitle metadata when the player (AVPlay) lists fewer subtitle tracks than the file.
// AVPlay states nothing about its subtitle tracks (no language, no codec). On the TV (run 6) it lists
// at most 32 tracks of a file — the first ones in file order — which is the only proven reason for a
// shorter subtitle list. File metadata is attached only when that limit explains the list exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeProbe, alignTrackLimit, AVPLAY_TRACK_LIMIT } from '../../src/player/track-info.ts';
import { probeWith } from '../../src/player/media-probe.ts';
import { trackLabels, trackLabel } from '../../src/screens/track-sheet.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createVodController } from '../../src/player/vod-controller.ts';
import { createFakeEngine } from '../fakes/fake-engine.mjs';
import { createLogger } from '../../src/utils/log.ts';

const t = createTranslator('en');
const pf = (kind, language, codec, extra) => Object.assign({ kind, language, name: '', codec, channels: kind === 'audio' ? 2 : 0, sampleRate: 0, bitrate: 0, isDefault: false, forced: false, hearingImpaired: false, enabled: true }, extra || {});
const V = () => pf('video', '', 'h264');
// AVPlay-style tracks (mapAvTracks): subtitles carry no language and no codec.
const avA = (id, language) => ({ kind: 'audio', id, language, label: 'Stereo', selected: id === 1, langExact: false, codec: '', channels: 2 });
const avT = (id, language = '') => ({ kind: 'text', id, language, label: '', selected: false });
const textOf = (list) => list.filter((x) => x.kind === 'text');
const subLabels = (list) => trackLabels(t, textOf(list), []);

// "NF - Do Not Disturb (2023)" as probed on the TV (Stage 7F run 4): 1 video, 6 audio, 33 SRT subtitles.
const DND_TEXT = ['en', 'ar', 'hr', 'cs', 'da', 'nl', 'fi', 'fr', 'de', 'el', 'he', 'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nb', 'pl', 'pt', 'pt', 'ro', 'ru', 'es', 'es',
  'sv', 'th', 'tr', 'tr', 'uk', 'vi', 'zh', 'zh'];
const DND_FILE = () => [V()].concat(['en', 'de', 'pl', 'pt', 'es', 'tr'].map((l) => pf('audio', l, 'aac')))
  .concat(DND_TEXT.map((l, i) => pf('text', l, 'srt', { forced: i === 28 })));
// AVPlay on the TV (run 6): audio ids 1–6, subtitle ids 7–31 (25 tracks).
const DND_AV = () => [avA(1, 'en'), avA(2, 'de'), avA(3, 'po'), avA(4, 'po'), avA(5, 'es'), avA(6, 'tu')]
  .concat(Array.from({ length: 25 }, (_, i) => avT(7 + i)));

test('7F-E 1: unambiguous match — the 25 tracks AVPlay lists are the first 25 file subtitles (TV-verified by cue script)', () => {
  const m = mergeProbe(DND_AV(), DND_FILE());
  assert.deepEqual(textOf(m).map((x) => x.language), DND_TEXT.slice(0, 25));
  const l = subLabels(m);
  assert.equal(l[0], 'English · SRT');
  assert.equal(l[1], 'Arabic · SRT');
  assert.equal(l[9], 'Greek · SRT');
  assert.equal(l[14], 'Japanese · SRT');
  assert.equal(l[24], 'Spanish (2) · SRT');
  assert.equal(l.filter((x) => /Unknown language/.test(x)).length, 0);
});

test('7F-E 1b: TV lab files — 40 subtitles → 30 listed; subtitles around 10 audio tracks → 21 listed, in file order', () => {
  const langs = ['eng', 'ara', 'hrv', 'ces', 'dan', 'nld', 'fin', 'fre', 'ger', 'gre', 'heb', 'hun', 'ind', 'ita', 'jpn', 'kor', 'msa', 'nob', 'pol', 'por',
    'por', 'rum', 'rus', 'spa', 'spa', 'swe', 'tha', 'tur', 'tur', 'ukr', 'vie', 'chi', 'chi', 'eng', 'fre', 'ger', 'ita', 'spa', 'nld', 'pol'];
  const name = (i) => 'S' + String(i + 1).padStart(2, '0');
  const s = (i) => pf('text', langs[i], 'srt', { name: name(i) });
  const a40 = [V(), pf('audio', 'eng', 'aac')].concat(langs.map((_, i) => s(i)));
  const e40 = [avA(1, 'en')].concat(Array.from({ length: 30 }, (_, i) => avT(2 + i)));
  assert.deepEqual(textOf(mergeProbe(e40, a40)).map((x) => x.name), Array.from({ length: 30 }, (_, i) => name(i)));
  const order = [V()].concat(langs.slice(0, 15).map((_, i) => s(i)), langs.slice(0, 10).map((l) => pf('audio', l, 'aac')), langs.slice(15, 30).map((_, i) => s(15 + i)));
  const eo = Array.from({ length: 10 }, (_, i) => avA(1 + i, '')).concat(Array.from({ length: 21 }, (_, i) => avT(11 + i)));
  assert.deepEqual(textOf(mergeProbe(eo, order)).map((x) => x.name), Array.from({ length: 21 }, (_, i) => name(i)));
  assert.equal(AVPLAY_TRACK_LIMIT, 32);
});

test('7F-E 2: ambiguous or unexplained lists are rejected — the player labels stay', () => {
  // The limit does not explain the list: one audio track fewer than the window holds (a hidden codec too).
  const av = DND_AV().filter((x) => x.id !== 6);
  assert.equal(alignTrackLimit(textOf(av), 5, DND_FILE()), null);
  assert.ok(subLabels(mergeProbe(av, DND_FILE())).every((x) => /^Unknown language \d+$/.test(x)));
  // A file within the limit with fewer listed subtitles: the reason is unknown (8 of 10 listed).
  const small = [V(), pf('audio', 'eng', 'aac')].concat(DND_TEXT.slice(0, 10).map((l) => pf('text', l, 'srt')));
  const es = [avA(1, 'en')].concat(Array.from({ length: 8 }, (_, i) => avT(2 + i)));
  assert.deepEqual(textOf(mergeProbe(es, small)).map((x) => x.language), Array(8).fill(''));
  // Listed count not equal to the subtitles inside the window.
  assert.equal(alignTrackLimit(Array.from({ length: 24 }, (_, i) => avT(7 + i)), 6, DND_FILE()), null);
});

test('7F-E 3: missing file metadata — a subtitle without a stated language stays "Unknown language", only its format is added', () => {
  const file = DND_FILE();
  file[7 + 2].language = ''; // third subtitle: no language in the file
  const l = subLabels(mergeProbe(DND_AV(), file));
  assert.equal(l[2], 'Unknown language · SRT');
  assert.equal(l[3], 'Czech · SRT');
});

test('7F-E 4: player metadata — a language the player states must agree, otherwise nothing is attached', () => {
  const ok = DND_AV();
  ok[6].language = 'en';
  assert.equal(textOf(mergeProbe(ok, DND_FILE()))[1].language, 'ar');
  const bad = DND_AV();
  bad[7].language = 'fr'; // the file has Arabic there
  assert.deepEqual(textOf(mergeProbe(bad, DND_FILE())).map((x) => x.language).slice(0, 3), ['', 'fr', '']);
});

test('7F-E 5: duplicate languages are numbered, and told apart by the file\'s names when it states them', () => {
  const file = DND_FILE();
  file[7 + 20].name = 'Brazilian';
  const l = subLabels(mergeProbe(DND_AV(), file));
  assert.equal(l[19], 'Portuguese · SRT');
  assert.equal(l[20], 'Portuguese · SRT · Brazilian');
  assert.equal(l[23], 'Spanish (1) · SRT');
  assert.equal(l[24], 'Spanish (2) · SRT');
});

test('7F-E 6: different subtitle formats (equal-count path; TV lab file: SRT, ASS and WebVTT all rendered)', () => {
  const file = [pf('text', 'eng', 'srt'), pf('text', 'eng', 'ass'), pf('text', 'fre', 'webvtt'), pf('text', 'eng', 'pgs'), pf('text', 'spa', 'tx3g'), pf('text', 'eng', 'cea608')];
  const m = mergeProbe([1, 2, 3, 4, 5, 6].map((i) => avT(i)), file);
  assert.deepEqual(subLabels(m), ['English · SRT', 'English · ASS', 'French · WebVTT', 'English · Image · PGS', 'Spanish · MP4 Timed Text', 'English · CC']);
});

test('7F-E 7: different order — a stated player language that disagrees with the file order rejects the list', () => {
  const file = [pf('text', 'eng', 'srt'), pf('text', 'fre', 'srt')];
  assert.deepEqual(textOf(mergeProbe([avT(1, 'fr'), avT(2, 'en')], file)).map((x) => x.language), ['fr', 'en']);
  const av = DND_AV();
  av[6].language = 'ar';
  av[7].language = 'en';
  assert.equal(alignTrackLimit(textOf(av), 6, DND_FILE()), null);
});

test('7F-E 8 + 12: hidden file tracks are never added; ids and the list length stay the player\'s', () => {
  const av = DND_AV();
  const m = mergeProbe(av, DND_FILE());
  assert.equal(m.length, av.length);
  assert.equal(textOf(m).length, 25, 'the 8 file subtitles beyond the limit are not offered');
  assert.deepEqual(m.map((x) => x.id), av.map((x) => x.id));
  assert.ok(!textOf(m).some((x) => ['sv', 'th', 'uk', 'vi', 'zh'].indexOf(x.language) >= 0));
  assert.ok(!m.some((x) => x.kind === 'video'));
  assert.equal(av[6].language, '', 'inputs are not modified');
});

test('7F-E 9: fallback — no probe, an empty probe or a probe without subtitles keep the player labels', () => {
  for (const p of [null, [], [V()]]) {
    assert.ok(subLabels(mergeProbe(DND_AV(), p)).every((x) => /^Unknown language \d+$/.test(x)));
  }
});

test('7F-E 10: Forced / SDH / CC only from explicit flags; names are shown as names, never turned into flags', async () => {
  const buf = readFileSync(new URL('../fixtures/media/subs-flags.mkv', import.meta.url));
  const r = await probeWith(async (s, e) => ({ data: buf.subarray(s, Math.min(e + 1, buf.length)).toString('latin1'), total: buf.length }));
  const subs = r.tracks.filter((x) => x.kind === 'text');
  assert.deepEqual(subs.map((x) => [x.language, x.codec, x.name, x.forced, x.hearingImpaired]), [
    ['eng', 'srt', '', false, true], ['eng', 'srt', 'SDH', false, false], ['fre', 'webvtt', '', true, false], ['ger', 'ass', 'German Forced', false, false]
  ]);
  const m = mergeProbe([1, 2, 3, 4].map((i) => avT(i)), r.tracks);
  assert.deepEqual([m[0].sdh, !!m[1].sdh, !!m[3].forced], [true, false, false]);
  assert.deepEqual(subLabels(m), ['English · SDH · SRT', 'English · SRT · SDH', 'French · Forced · WebVTT', 'German · ASS · German Forced']);
  assert.equal(trackLabel(t, { kind: 'text', id: 1, language: 'eng', label: '', selected: false, codec: 'srt' }, 1), 'English · SRT', 'no flag, no indicator');
});

test('7F-E 11: subtitle selection is unchanged — ids, order, selected flags and the engine call stay the player\'s', async () => {
  const fe = createFakeEngine();
  let release = null;
  const ctl = createVodController({
    engine: fe.engine,
    resolve: async (ref) => ({ url: 'http://s.example/' + ref.id + '.mkv', type: 'mkv', live: false }),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), now: () => Date.now(), prepareTimeoutMs: 15000,
    log: createLogger(200),
    probe: () => new Promise((res) => { release = res; })
  });
  ctl.play({ kind: 'movie', id: 'dnd' });
  await new Promise((r) => setTimeout(r, 5));
  fe.prepared();
  fe.picture();
  fe.setTracks(DND_AV());
  const before = ctl.tracks().map((x) => [x.kind, x.id, x.selected]);
  assert.ok(release, 'probe started after the picture');
  release({ container: 'mkv', requests: 3, tracks: DND_FILE() });
  await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(ctl.tracks().map((x) => [x.kind, x.id, x.selected]), before);
  assert.equal(textOf(ctl.tracks())[9].language, 'el');
  ctl.selectTrack('text', 16);
  assert.deepEqual(fe.calls.filter((c) => c.op === 'track').slice(-1)[0], { op: 'track', kind: 'text', id: 16 }, 'the engine is asked for its own id 16 (Greek)');
  ctl.destroy();
});
