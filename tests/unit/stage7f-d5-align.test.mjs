// Stage 7F-D5: audio metadata when the player (AVPlay) lists fewer audio tracks than the file.
// The engine's list (ids, order, selection) is the truth of what can be played; the file probe only
// adds labels, and only when the in-order placement of engine tracks onto file tracks is unique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProbe, alignHidden } from '../../src/player/track-info.ts';
import { trackLabels } from '../../src/screens/track-sheet.ts';
import { createTranslator } from '../../src/i18n/strings.ts';
import { createVodController } from '../../src/player/vod-controller.ts';
import { createFakeEngine } from '../fakes/fake-engine.mjs';
import { createLogger } from '../../src/utils/log.ts';

const t = createTranslator('en');
// AVPlay-style audio track: two-letter language, codec only for ac3/eac3/dts, channels or 0.
const av = (id, language, codec = '', channels = 0, selected = false) => ({ kind: 'audio', id, language, label: '', selected, langExact: false, codec, channels });
// Probe-style file track.
const pf = (language, codec, channels, bitrate = 0) => ({ kind: 'audio', language, name: '', codec, channels, sampleRate: 48000, bitrate, forced: false });
const audioOf = (list) => list.filter((x) => x.kind === 'audio');
const labels = (list) => trackLabels(t, audioOf(list), []);

// The TV's lab file (Stage 7F run 4, E10): 7 audio tracks, AVPlay hides TrueHD and lists 6.
const LAB_FILE = [pf('eng', 'aac', 2), pf('fre', 'ac3', 6), pf('dut', 'eac3', 6), pf('ger', 'dts', 6), pf('spa', 'mp3', 2), pf('ita', 'opus', 2), pf('tur', 'truehd', 6)];
const LAB_AV = () => [av(1, 'en', '', 2, true), av(2, 'fr', 'ac3', 6), av(3, 'du', 'eac3', 6), av(4, 'de', 'dts', 6), av(5, 'es', '', 2), av(6, 'it', '', 0)];

test('D5 1+8: unambiguous language/codec match with a hidden (unsupported) track; the hidden track is not offered', () => {
  assert.deepEqual(alignHidden(LAB_AV(), LAB_FILE), [0, 1, 2, 3, 4, 5]);
  const m = mergeProbe(LAB_AV(), LAB_FILE);
  assert.equal(m.length, 6, 'TrueHD (hidden by AVPlay) is not added');
  assert.deepEqual(m.map((x) => [x.id, x.language, x.codec, x.channels]), [
    [1, 'eng', 'aac', 2], [2, 'fre', 'ac3', 6], [3, 'dut', 'eac3', 6], [4, 'ger', 'dts', 6], [5, 'spa', 'mp3', 2], [6, 'ita', 'opus', 2]
  ]);
  assert.deepEqual(labels(m), ['English · Stereo · AAC', 'French · 5.1 · Dolby Digital', 'Dutch · 5.1 · Dolby Digital Plus', 'German · 5.1 · DTS', 'Spanish · Stereo · MP3', 'Italian · Stereo · Opus']);
  // Hidden track in the middle: the placement skips it.
  const file = [pf('ger', 'ac3', 6), pf('eng', 'truehd', 8), pf('eng', 'ac3', 6)];
  assert.deepEqual(alignHidden([av(1, 'de', 'ac3', 6), av(2, 'en', 'ac3', 6)], file), [0, 2]);
});

test('D5 2+5: duplicate language the player track could be either of → rejected, player values kept', () => {
  // File: French E-AC-3 and French AAC + English; AVPlay hides one French track and states no codec.
  const file = [pf('fre', 'eac3', 2, 384000), pf('fre', 'aac', 2, 194000), pf('eng', 'aac', 2)];
  const avList = [av(1, 'fr', '', 2, true), av(2, 'en', '', 2)];
  assert.equal(alignHidden(avList, file), null, 'two placements for "fr" → ambiguous');
  const m = mergeProbe(avList, file);
  assert.deepEqual(m.map((x) => [x.language, x.codec || '', x.bitrate || 0]), [['fr', '', 0], ['en', '', 0]], 'no metadata attached');
  assert.deepEqual(labels(m), ['FR · Stereo', 'English · Stereo'], 'original player labels: Stage 7E rule ("en" named, "fr" may be cut short so shown as it is)');
  // The same duplicate becomes unique when the player states the codec.
  assert.deepEqual(alignHidden([av(1, 'fr', 'eac3', 2), av(2, 'en', '', 2)], file), [0, 2]);
});

test('D5 6: duplicate codecs decided by language; same language + same codec twice stays ambiguous', () => {
  const file = [pf('eng', 'ac3', 6), pf('ger', 'ac3', 6), pf('fre', 'truehd', 6)];
  assert.deepEqual(alignHidden([av(1, 'en', 'ac3', 6), av(2, 'de', 'ac3', 6)], file), [0, 1]);
  const twins = [pf('eng', 'ac3', 6), pf('eng', 'ac3', 6), pf('eng', 'truehd', 8)];
  assert.equal(alignHidden([av(1, 'en', 'ac3', 6)], twins), null, 'either English AC-3 → ambiguous');
});

test('D5 3+4: missing metadata on one side never matches a stated language', () => {
  // File states no languages: player "en" cannot be placed → nothing attached.
  assert.equal(alignHidden([av(1, 'en', '', 2)], [pf('', 'aac', 2), pf('', 'truehd', 6)]), null);
  // Player states no language ("un"), file does: not matched (stricter than the equal-count rule).
  assert.equal(alignHidden([av(1, 'un', '', 2)], [pf('eng', 'aac', 2), pf('fre', 'truehd', 6)]), null);
  // Neither states a language: only a codec stated on both sides can make it unique.
  assert.deepEqual(alignHidden([av(1, 'un', 'ac3', 6)], [pf('', 'ac3', 6), pf('', 'truehd', 6)]), [0]);
  assert.equal(alignHidden([av(1, 'un', '', 2)], [pf('', 'aac', 2), pf('', 'mp3', 2)]), null, 'nothing tells them apart');
  // Player track without codec or channels but a stated language: language alone, when unique.
  assert.deepEqual(alignHidden([av(1, 'it', '', 0)], [pf('ita', 'opus', 2), pf('tur', 'truehd', 6)]), [0]);
});

test('D5 7: different order between file and player → no in-order placement → rejected; conflicts reject', () => {
  const file = [pf('eng', 'aac', 2), pf('fre', 'aac', 2), pf('ger', 'truehd', 6)];
  assert.equal(alignHidden([av(1, 'fr', '', 2), av(2, 'en', '', 2)], file), null);
  assert.equal(alignHidden([av(1, 'en', 'ac3', 6)], [pf('eng', 'aac', 2), pf('fre', 'truehd', 6)]), null, 'codec conflict');
  assert.equal(alignHidden([av(1, 'en', '', 6)], [pf('eng', 'aac', 2), pf('fre', 'truehd', 6)]), null, 'channel conflict');
});

test('D5 9: fallback keeps the original player label; equal counts and subtitles use the existing rule unchanged', () => {
  // More player tracks than file tracks: nothing attached.
  const m = mergeProbe([av(1, 'en', '', 2), av(2, 'fr', '', 2)], [pf('eng', 'aac', 2)]);
  assert.deepEqual(m.map((x) => x.language), ['en', 'fr']);
  assert.deepEqual(labels(m), ['English · Stereo', 'FR · Stereo']);
  // Equal counts: the Stage 7E rule (order + language agreement) is unchanged.
  const eq = mergeProbe([av(1, 'tu', '', 2), av(2, 'po', '', 2)], [pf('tur', 'aac', 2), pf('por', 'aac', 2)]);
  assert.deepEqual(eq.map((x) => x.language), ['tur', 'por']);
  // Fewer subtitle tracks than the file: still not aligned (D5 covers audio only).
  const sub = (language, codec) => ({ kind: 'text', language, name: '', codec, channels: 0, sampleRate: 0, bitrate: 0, forced: false });
  const subs = mergeProbe([{ kind: 'text', id: 3, language: '', label: '', selected: false }], [sub('eng', 'srt'), sub('fre', 'pgs')]);
  assert.equal(subs[0].language, '');
  // Inputs are not modified.
  const input = LAB_AV();
  mergeProbe(input, LAB_FILE);
  assert.equal(input[0].language, 'en');
});

test('D5 10: matching does not change selection — ids, order, selected flags and the engine call stay the player\'s', async () => {
  const fe = createFakeEngine();
  let release = null;
  const ctl = createVodController({
    engine: fe.engine,
    resolve: async (ref) => ({ url: 'http://s.example/' + ref.id + '.mkv', type: 'mkv', live: false }),
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), now: () => Date.now(), prepareTimeoutMs: 15000,
    log: createLogger(200),
    probe: () => new Promise((r) => { release = r; })
  });
  ctl.play({ kind: 'movie', id: 'lab' });
  await new Promise((r) => setTimeout(r, 5));
  fe.prepared();
  fe.picture();
  fe.setTracks(LAB_AV());
  const before = ctl.tracks().map((x) => [x.id, x.selected]);
  assert.ok(release, 'probe started after the picture');
  release({ container: 'mkv', requests: 2, tracks: [{ kind: 'video', language: '', name: '', codec: 'h264', channels: 0, sampleRate: 0, bitrate: 0, forced: false }].concat(LAB_FILE) });
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(ctl.tracksFinal(), true);
  assert.deepEqual(ctl.tracks().map((x) => [x.id, x.selected]), before, 'same ids, same order, same selection');
  assert.equal(ctl.tracks()[3].language, 'ger');
  ctl.selectTrack('audio', 4);
  assert.deepEqual(fe.calls.filter((c) => c.op === 'track').slice(-1)[0], { op: 'track', kind: 'audio', id: 4 }, 'the engine is asked for its own id 4 (DTS)');
  ctl.destroy();
});

test('D5 TV case "Do Not Disturb": file states 2-letter codes (pl, pt, tr), AVPlay cut 3-letter ones (po, po, tu) → matched in order', () => {
  const file = [pf('en', 'aac', 2, 128000), pf('de', 'aac', 2, 128000), pf('pl', 'aac', 2, 128000), pf('pt', 'aac', 2, 128000), pf('es', 'aac', 2, 128000), pf('tr', 'aac', 2, 128000)];
  const avList = [av(1, 'en', '', 2, true), av(2, 'de', '', 2), av(3, 'po', '', 2), av(4, 'po', '', 2), av(5, 'es', '', 2), av(6, 'tu', '', 2)];
  const m = mergeProbe(avList, file);
  assert.deepEqual(m.map((x) => x.language), ['en', 'de', 'pl', 'pt', 'es', 'tr']);
  assert.deepEqual(labels(m), ['English · Stereo · AAC · 128 kb/s', 'German · Stereo · AAC · 128 kb/s', 'Polish · Stereo · AAC · 128 kb/s', 'Portuguese · Stereo · AAC · 128 kb/s', 'Spanish · Stereo · AAC · 128 kb/s', 'Turkish · Stereo · AAC · 128 kb/s']);
  // With one of the two "po" tracks hidden, "po" could be Polish or Portuguese → ambiguous → player values.
  assert.equal(alignHidden([av(1, 'en', '', 2), av(2, 'po', '', 2)], [pf('en', 'aac', 2), pf('pl', 'aac', 2), pf('pt', 'aac', 2)]), null);
  // A cut code never matches an unrelated language.
  assert.equal(mergeProbe([av(1, 'po', '', 2)], [pf('ru', 'aac', 2)])[0].language, 'po');
});
