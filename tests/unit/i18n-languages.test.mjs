// UI languages French, Spanish and German: every English key is translated, every {param} is kept,
// language names are given in the UI language, and the config accepts the new codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, missingTranslations } from '../../src/i18n/strings.ts';
import { FR, NAMES_FR } from '../../src/i18n/strings-fr.ts';
import { ES, NAMES_ES } from '../../src/i18n/strings-es.ts';
import { DE, NAMES_DE } from '../../src/i18n/strings-de.ts';
import { languageName, uiLanguage } from '../../src/i18n/languages.ts';

const params = (s) => [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');

test('i18n: French, Spanish and German have every key, with the same {params} as English', () => {
  assert.deepEqual(missingTranslations(), []);
  const en = createTranslator('en');
  for (const [code, table] of [['fr', FR], ['es', ES], ['de', DE]]) {
    const t = createTranslator(code);
    assert.equal(t('lang.ui'), code);
    assert.equal(uiLanguage(t), code);
    for (const k of Object.keys(table)) {
      assert.equal(params(table[k]), params(en(k)), code + ' ' + k);
      assert.ok(table[k].trim().length > 0, code + ' ' + k + ' empty');
    }
  }
  assert.equal(createTranslator('de')('home.countChannels', { n: 5 }).includes('5'), true);
});

test('i18n: language names follow the UI language; unknown codes stay as the code', () => {
  for (const names of [NAMES_FR, NAMES_ES, NAMES_DE]) { assert.ok(Object.keys(names).length >= 80); }
  assert.equal(languageName('dut', 'de'), NAMES_DE.nld);
  assert.equal(languageName('eng', 'fr'), NAMES_FR.eng);
  assert.equal(languageName('ger', 'es'), NAMES_ES.deu);
  assert.equal(languageName('eng', 'nl'), 'Engels');
  assert.equal(languageName('eng', 'en'), 'English');
  assert.equal(languageName('xyz', 'fr'), 'XYZ');
});
