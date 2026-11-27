// Language codes and names (Stage 7E). ISO 639-2/T is the canonical form; ISO 639-1 and the
// ISO 639-2/B "bibliographic" variants (dut, fre, ger, …) are folded into it. Names are given in
// the app's UI languages (English and Dutch here; French, Spanish and German from strings-fr/es/de.ts).
// A code not in the table is shown as the code itself.
//
// AVPlay reports audio languages cut to two letters ("tu" for tur, "du" for dut, Stage 7E TV run).
// Such a 2-letter value is only turned into a name when it cannot be the truncation of another
// language in this table: "sw" could be Swahili (639-1) or "swe" cut short, so it stays "SW".
import type { Translate } from './strings.ts';
import { NAMES_FR } from './strings-fr.ts';
import { NAMES_ES } from './strings-es.ts';
import { NAMES_DE } from './strings-de.ts';

const OTHER_NAMES: Record<string, Record<string, string>> = { fr: NAMES_FR, es: NAMES_ES, de: NAMES_DE };

// [639-2/T, 639-1, 639-2/B, English, Dutch]
const TABLE: Array<[string, string, string, string, string]> = [
  ['eng', 'en', '', 'English', 'Engels'], ['nld', 'nl', 'dut', 'Dutch', 'Nederlands'], ['fra', 'fr', 'fre', 'French', 'Frans'],
  ['deu', 'de', 'ger', 'German', 'Duits'], ['spa', 'es', '', 'Spanish', 'Spaans'], ['ita', 'it', '', 'Italian', 'Italiaans'],
  ['por', 'pt', '', 'Portuguese', 'Portugees'], ['ara', 'ar', '', 'Arabic', 'Arabisch'], ['tur', 'tr', '', 'Turkish', 'Turks'],
  ['pol', 'pl', '', 'Polish', 'Pools'], ['rus', 'ru', '', 'Russian', 'Russisch'], ['ukr', 'uk', '', 'Ukrainian', 'Oekraïens'],
  ['zho', 'zh', 'chi', 'Chinese', 'Chinees'], ['yue', '', '', 'Cantonese', 'Kantonees'], ['jpn', 'ja', '', 'Japanese', 'Japans'],
  ['kor', 'ko', '', 'Korean', 'Koreaans'], ['hin', 'hi', '', 'Hindi', 'Hindi'], ['urd', 'ur', '', 'Urdu', 'Urdu'],
  ['ben', 'bn', '', 'Bengali', 'Bengaals'], ['tam', 'ta', '', 'Tamil', 'Tamil'], ['tel', 'te', '', 'Telugu', 'Telugu'],
  ['pan', 'pa', '', 'Punjabi', 'Punjabi'], ['fas', 'fa', 'per', 'Persian', 'Perzisch'], ['kur', 'ku', '', 'Kurdish', 'Koerdisch'],
  ['heb', 'he', '', 'Hebrew', 'Hebreeuws'], ['ell', 'el', 'gre', 'Greek', 'Grieks'], ['swe', 'sv', '', 'Swedish', 'Zweeds'],
  ['dan', 'da', '', 'Danish', 'Deens'], ['nor', 'no', '', 'Norwegian', 'Noors'], ['nob', 'nb', '', 'Norwegian Bokmål', 'Noors (Bokmål)'],
  ['nno', 'nn', '', 'Norwegian Nynorsk', 'Noors (Nynorsk)'], ['fin', 'fi', '', 'Finnish', 'Fins'], ['isl', 'is', 'ice', 'Icelandic', 'IJslands'],
  ['ces', 'cs', 'cze', 'Czech', 'Tsjechisch'], ['slk', 'sk', 'slo', 'Slovak', 'Slowaaks'], ['slv', 'sl', '', 'Slovenian', 'Sloveens'],
  ['hun', 'hu', '', 'Hungarian', 'Hongaars'], ['ron', 'ro', 'rum', 'Romanian', 'Roemeens'], ['bul', 'bg', '', 'Bulgarian', 'Bulgaars'],
  ['srp', 'sr', '', 'Serbian', 'Servisch'], ['hrv', 'hr', '', 'Croatian', 'Kroatisch'], ['bos', 'bs', '', 'Bosnian', 'Bosnisch'],
  ['mkd', 'mk', 'mac', 'Macedonian', 'Macedonisch'], ['sqi', 'sq', 'alb', 'Albanian', 'Albanees'], ['lit', 'lt', '', 'Lithuanian', 'Litouws'],
  ['lav', 'lv', '', 'Latvian', 'Lets'], ['est', 'et', '', 'Estonian', 'Estisch'], ['cat', 'ca', '', 'Catalan', 'Catalaans'],
  ['eus', 'eu', 'baq', 'Basque', 'Baskisch'], ['glg', 'gl', '', 'Galician', 'Galicisch'], ['gle', 'ga', '', 'Irish', 'Iers'],
  ['cym', 'cy', 'wel', 'Welsh', 'Welsh'], ['afr', 'af', '', 'Afrikaans', 'Afrikaans'], ['swa', 'sw', '', 'Swahili', 'Swahili'],
  ['amh', 'am', '', 'Amharic', 'Amhaars'], ['som', 'so', '', 'Somali', 'Somalisch'], ['ber', '', '', 'Berber', 'Berbers'],
  ['tha', 'th', '', 'Thai', 'Thai'], ['vie', 'vi', '', 'Vietnamese', 'Vietnamees'], ['ind', 'id', '', 'Indonesian', 'Indonesisch'],
  ['msa', 'ms', 'may', 'Malay', 'Maleis'], ['tgl', 'tl', '', 'Tagalog', 'Tagalog'], ['fil', '', '', 'Filipino', 'Filipijns'],
  ['aze', 'az', '', 'Azerbaijani', 'Azerbeidzjaans'], ['kat', 'ka', 'geo', 'Georgian', 'Georgisch'], ['hye', 'hy', 'arm', 'Armenian', 'Armeens'],
  ['kaz', 'kk', '', 'Kazakh', 'Kazachs'], ['uzb', 'uz', '', 'Uzbek', 'Oezbeeks'], ['mon', 'mn', '', 'Mongolian', 'Mongools'],
  ['lat', 'la', '', 'Latin', 'Latijn'], ['epo', 'eo', '', 'Esperanto', 'Esperanto'], ['fry', 'fy', '', 'Western Frisian', 'Fries'],
  ['ltz', 'lb', '', 'Luxembourgish', 'Luxemburgs'], ['mlt', 'mt', '', 'Maltese', 'Maltees'], ['bel', 'be', '', 'Belarusian', 'Wit-Russisch'],
  ['che', 'ce', '', 'Chechen', 'Tsjetsjeens'], ['cha', 'ch', '', 'Chamorro', 'Chamorro'], ['mri', 'mi', 'mao', 'Maori', 'Maori'],
  ['zxx', '', '', 'No linguistic content', 'Geen taal'], ['mul', '', '', 'Multiple languages', 'Meerdere talen']
];

const CANON: Record<string, number> = {};
const SAFE2: Record<string, number> = {};
(function build(): void {
  for (let i = 0; i < TABLE.length; i++) {
    const r = TABLE[i];
    CANON[r[0]] = i;
    if (r[1]) { CANON[r[1]] = i; }
    if (r[2]) { CANON[r[2]] = i; }
  }
  // A 2-letter code is safe when no other language's 3-letter code (T or B) starts with it.
  for (let i = 0; i < TABLE.length; i++) {
    const two = TABLE[i][1];
    if (!two) { continue; }
    let safe = true;
    for (let j = 0; j < TABLE.length && safe; j++) {
      if (j === i) { continue; }
      if (TABLE[j][0].substring(0, 2) === two || (TABLE[j][2] && TABLE[j][2].substring(0, 2) === two)) { safe = false; }
    }
    if (safe) { SAFE2[two] = i; }
  }
})();

/** Lower case, region dropped ("pt-BR" → "pt"), then folded to ISO 639-2/T when known ("dut", "nl" → "nld"). */
export function normLang(code: string): string {
  const c = String(code || '').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 12);
  const base = c.split('-')[0];
  const i = Object.prototype.hasOwnProperty.call(CANON, base) ? CANON[base] : -1;
  return i >= 0 ? TABLE[i][0] : base;
}

/** Canonical code for a value that may be AVPlay's 2-letter truncation: only unambiguous ones are folded. */
export function normLangLoose(code: string): string {
  const base = String(code || '').toLowerCase().replace(/[^a-z-]/g, '').split('-')[0];
  if (base.length === 2) { return Object.prototype.hasOwnProperty.call(SAFE2, base) ? TABLE[SAFE2[base]][0] : base; }
  return normLang(base);
}

/**
 * Stage 7F-D5: can `two` (a player's two-letter value) be `fileCode`? True when it is the file
 * language's ISO 639-1 code, or the first two letters of its ISO 639-2 T or B code (AVPlay cuts
 * "pol" to "po"; the file may state the same language as "pl"). Unknown file codes: plain prefix.
 */
export function cutMatches(two: string, fileCode: string): boolean {
  const e = String(two || '').toLowerCase().split('-')[0];
  const base = String(fileCode || '').toLowerCase().replace(/[^a-z-]/g, '').split('-')[0];
  if (e.length !== 2 || !base) { return false; }
  const i = Object.prototype.hasOwnProperty.call(CANON, base) ? CANON[base] : -1;
  if (i < 0) { return base.substring(0, 2) === e; }
  const r = TABLE[i];
  return r[1] === e || r[0].substring(0, 2) === e || (!!r[2] && r[2].substring(0, 2) === e);
}

/** No / undetermined language. */
export function noLanguage(code: string): boolean {
  const base = String(code || '').toLowerCase().replace(/[^a-z-]/g, '').split('-')[0];
  return !base || base === 'und' || base === 'un' || base === 'qaa' || base === 'mis';
}

/**
 * Display name in the UI language. `exact` = false for codes that may be cut short (AVPlay's two
 * letters): only unambiguous 2-letter codes get a name. '' for no / undetermined language;
 * unknown codes are shown as the code itself in capitals.
 */
export function languageName(code: string, ui?: string, exact?: boolean): string {
  if (noLanguage(code)) { return ''; }
  const base = String(code || '').toLowerCase().replace(/[^a-z-]/g, '').split('-')[0];
  let i = -1;
  if (exact === false && base.length === 2) {
    i = Object.prototype.hasOwnProperty.call(SAFE2, base) ? SAFE2[base] : -1;
  } else if (Object.prototype.hasOwnProperty.call(CANON, base)) {
    i = CANON[base];
  }
  if (i < 0) { return base.toUpperCase(); }
  if (ui === 'nl') { return TABLE[i][4]; }
  const names = ui && Object.prototype.hasOwnProperty.call(OTHER_NAMES, ui) ? OTHER_NAMES[ui] : null;
  return names && Object.prototype.hasOwnProperty.call(names, TABLE[i][0]) ? names[TABLE[i][0]] : TABLE[i][3];
}

/** The UI language of a translator ('en' | 'nl' | 'fr' | 'es' | 'de'), read from its "lang.ui" string. */
export function uiLanguage(t: Translate): string {
  const l = t('lang.ui');
  return l === 'nl' || l === 'fr' || l === 'es' || l === 'de' ? l : 'en';
}
