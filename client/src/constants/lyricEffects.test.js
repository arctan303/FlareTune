import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LYRIC_EFFECTS,
  LYRIC_EFFECT_GROUPS,
  LYRIC_TRANSLATION_PROGRESS,
  LYRIC_WORD_EVENTS,
  getEffectConfig,
  getRandomEffect,
  resolveLyricEffect,
} from './lyricEffects.js';

const EXPECTED_EFFECTS = Object.freeze({
  drift: ['space', 'none', 'none'],
  'blur-focus': ['focus', 'focus', 'line'],
  spring: ['space', 'none', 'none'],
  breathe: ['space', 'none', 'none'],
  wind: ['direction', 'wind', 'none'],
  dew: ['focus', 'dew', 'line'],
  rain: ['direction', 'rain', 'none'],
  firefly: ['light', 'firefly', 'line'],
});

test('all eight persisted effect IDs expose explicit immutable runtime contracts', () => {
  assert.deepEqual(LYRIC_EFFECTS.map(({ id }) => id), Object.keys(EXPECTED_EFFECTS));
  assert.equal(new Set(LYRIC_EFFECTS.map(({ id }) => id)).size, 8);
  assert.ok(Object.isFrozen(LYRIC_EFFECTS));

  for (const effect of LYRIC_EFFECTS) {
    const [group, wordEvent, translationProgress] = EXPECTED_EFFECTS[effect.id];
    assert.equal(effect.group, group);
    assert.equal(effect.wordEvent, wordEvent);
    assert.equal(effect.translationProgress, translationProgress);
    assert.deepEqual(Object.keys(effect.motionBudget), [
      'enterMs',
      'exitMs',
      'resident',
    ]);
    assert.ok(effect.motionBudget.enterMs >= 600 && effect.motionBudget.enterMs <= 900);
    assert.ok(effect.motionBudget.exitMs >= 400 && effect.motionBudget.exitMs <= 600);
    assert.equal(effect.motionBudget.resident, true);
    assert.equal('perChar' in effect, false);
    assert.equal('charDelay' in effect, false);
    assert.equal('enterDuration' in effect, false);
    assert.equal('exitDuration' in effect, false);
    assert.ok(Object.isFrozen(effect));
    assert.ok(Object.isFrozen(effect.motionBudget));
  }
});

test('effect contract enums match the public configuration values', () => {
  assert.deepEqual(Object.values(LYRIC_EFFECT_GROUPS), [
    'space',
    'focus',
    'direction',
    'light',
  ]);
  assert.deepEqual(Object.values(LYRIC_WORD_EVENTS), [
    'none',
    'focus',
    'dew',
    'wind',
    'rain',
    'firefly',
  ]);
  assert.deepEqual(Object.values(LYRIC_TRANSLATION_PROGRESS), ['none', 'line']);
});

test('persisted IDs and invalid values retain the established lookup behavior', () => {
  for (const effect of LYRIC_EFFECTS) {
    assert.strictEqual(getEffectConfig(effect.id), effect);
    assert.strictEqual(resolveLyricEffect(effect.id, 'ignored-song'), effect);
  }
  assert.strictEqual(getEffectConfig('unknown'), LYRIC_EFFECTS[0]);
  assert.strictEqual(resolveLyricEffect(undefined, 'song-a'), LYRIC_EFFECTS[0]);
});

test('random resolution depends only on songKey and is deterministic for empty seeds', () => {
  const seeds = ['song-a', 'song-b', '同一首歌', '', undefined, null, 0];
  for (const songKey of seeds) {
    const resolved = Array.from({ length: 20 }, () => getRandomEffect(songKey));
    assert.ok(resolved.every((effect) => effect === resolved[0]));
    assert.strictEqual(resolveLyricEffect('random', songKey), resolved[0]);
    assert.ok(LYRIC_EFFECTS.includes(resolved[0]));
  }

  const source = readFileSync(new URL('./lyricEffects.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Date\.now|Math\.random|currentLyricIndex|lineIndex/);
});

test('random song fixtures remain stable across intervening resolutions', () => {
  assert.equal(getRandomEffect('song-a').id, 'rain');
  assert.equal(getRandomEffect('song-b').id, 'breathe');
  assert.notEqual(getRandomEffect('song-a').id, getRandomEffect('song-b').id);
  assert.equal(getRandomEffect('song-a').id, 'rain');
  assert.equal(getRandomEffect('').id, 'dew');
});
