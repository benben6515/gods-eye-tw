import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { t, QUICK_PLACES, placeName, UI_STRINGS } from './uiStrings.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the zh and en dictionaries cover exactly the same keys', () => {
  const zh = Object.keys(UI_STRINGS.zh).sort();
  const en = Object.keys(UI_STRINGS.en).sort();
  assert.deepEqual(en, zh, 'a missing key silently falls back to zh');
  for (const [lang, dict] of Object.entries(UI_STRINGS)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.ok(
        typeof value === 'string' || typeof value === 'function',
        `${lang}.${key} must be a string or template function`,
      );
      if (typeof value === 'string') assert.ok(value.length > 0);
    }
  }
});

test('t() serves the requested language and defaults to zh', () => {
  assert.equal(t('voiceError'), '語音系統錯誤');
  assert.equal(t('voiceError', 'en'), 'Voice system error');
  assert.equal(t('runningAction', 'en')('fly_to_location'), 'Running fly_to_location…');
  assert.equal(t('flyTo')('台北 101'), '飛往 台北 101…');
});

test('quick places carry both language names', () => {
  assert.equal(QUICK_PLACES.length, 6);
  for (const place of QUICK_PLACES) {
    assert.ok(place.code && place.zh && place.en);
    assert.equal(placeName(place, 'zh'), place.zh);
    assert.equal(placeName(place, 'en'), place.en);
  }
});

/**
 * The fail-closed contract: user-visible CJK lives ONLY in the dictionary.
 * Consumer modules may still carry Chinese in comments (this codebase
 * comments in Chinese), so CJK is only allowed in comment text — a `//`
 * trailing comment or a block-comment line. Anything in actual code is a
 * hardcoded string that would ignore the 中/EN switch.
 */
const CONSUMERS = [
  './voiceDock.js',
  './siteGate.js',
  '../voice/control.js',
  './playerSheet.js',
  './voiceSession.js',
];

/** Drop a trailing line comment; `://` (URLs) does not start one. */
const stripLineComment = (line) => {
  const idx = line.indexOf('//');
  if (idx === -1 || (idx > 0 && line[idx - 1] === ':')) return line;
  return line.slice(0, idx);
};

test('no hardcoded CJK strings outside the dictionary', () => {
  for (const path of CONSUMERS) {
    const lines = read(path).split('\n');
    lines.forEach((line, index) => {
      const code = stripLineComment(line);
      if (!/[一-龥]/.test(code)) return; // comment text is allowed
      assert.fail(
        `${path}:${index + 1} hardcodes user-visible text — move it to uiStrings.js`,
      );
    });
  }
});

test('the layer panel resolves bilingual labels at render time', () => {
  const source = read('./layerPanel.js');
  assert.match(source, /langLabel\(PANEL_LABELS\[layer\.id\]\)/);
  assert.match(source, /langLabel\(PANEL_ORDER\[PANEL_POSITIONS\.get\(layer\.id\)\]\?\.label\)/);
  assert.match(source, /addEventListener\?\.\('gev-lang-change'/);
});
