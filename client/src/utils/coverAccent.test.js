import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COVER_ACCENT,
  rgbToHsl,
  hslToRgb,
  clampColorForReadability,
  getPlayerThemeColors,
  parseRgb,
} from './coverAccent.js';

test('default cover accent remains the current fixed runtime value', () => {
  assert.equal(DEFAULT_COVER_ACCENT, '#4f9da3');
});

test('rgbToHsl and hslToRgb accurately convert primary colors', () => {
  const red = rgbToHsl(255, 0, 0);
  assert.equal(red.h, 0);
  assert.equal(red.s, 100);
  assert.equal(red.l, 50);

  const backToRed = hslToRgb(0, 100, 50);
  assert.equal(backToRed.r, 255);
  assert.equal(backToRed.g, 0);
  assert.equal(backToRed.b, 0);
});

test('clampColorForReadability generates vibrant warm colors and avoids muddy brown in light mode', () => {
  // Pastel / bright yellow (大笑江湖 cover color range)
  const brightYellow = { r: 250, g: 240, b: 120 };
  const clampedLight = clampColorForReadability(brightYellow, false);
  const hsl = rgbToHsl(clampedLight.r, clampedLight.g, clampedLight.b);

  // Hue should be warm golden amber (36), not mud brown, with high saturation and readable lightness
  assert.equal(hsl.h, 36);
  assert.ok(hsl.s >= 80, `Saturation should be vivid (>= 80), got ${hsl.s}`);
  assert.ok(hsl.l <= 48 && hsl.l >= 38, `Lightness should be readable (38-48), got ${hsl.l}`);
  assert.match(clampedLight.hex, /^#[0-9a-f]{6}$/i);
});

test('clampColorForReadability outputs pure ink black for grayscale covers in light mode', () => {
  const grayscale = { r: 128, g: 128, b: 128 };
  const clampedLight = clampColorForReadability(grayscale, false);
  assert.equal(clampedLight.hex, '#18181b');
});

test('clampColorForReadability enforces high contrast in dark mode', () => {
  // Dark navy (very dark, would be invisible on dark background)
  const darkNavy = { r: 10, g: 15, b: 40 };
  const clampedDark = clampColorForReadability(darkNavy, true);
  const hsl = rgbToHsl(clampedDark.r, clampedDark.g, clampedDark.b);

  // Lightness should be boosted up to >= 70 for luminous clarity
  assert.ok(hsl.l >= 70, `Lightness should be >= 70, got ${hsl.l}`);
  assert.match(clampedDark.hex, /^#[0-9a-f]{6}$/i);
});

test('clampColorForReadability handles null or missing color gracefully', () => {
  const fallbackLight = clampColorForReadability(null, false);
  const fallbackDark = clampColorForReadability(null, true);

  assert.equal(fallbackLight.hex, '#0369a1');
  assert.equal(fallbackDark.hex, '#7dd3fc');
});

test('getPlayerThemeColors generates complete player theme tokens without white stroke in light mode', () => {
  const lightColors = getPlayerThemeColors('#e11d48', false);
  assert.ok(lightColors.lyricCurrent);
  assert.ok(lightColors.lyricUnheard);
  assert.ok(lightColors.iconColor);
  assert.ok(lightColors.iconHover);
  assert.ok(lightColors.playColor);
  // Light mode strictly disables white outline / stroke
  assert.equal(lightColors.textShadow, 'none');

  const darkColors = getPlayerThemeColors('#e11d48', true);
  assert.ok(darkColors.lyricCurrent);
  assert.ok(darkColors.lyricUnheard);
  assert.ok(darkColors.iconColor);
  assert.ok(darkColors.iconHover);
  assert.ok(darkColors.playColor);
  assert.notEqual(darkColors.textShadow, 'none');
});

test('parseRgb parses hex and rgb strings', () => {
  assert.deepEqual(parseRgb('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseRgb('rgb(12, 34, 56)'), { r: 12, g: 34, b: 56 });
  assert.equal(parseRgb('invalid'), null);
});
