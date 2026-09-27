import test from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_THEME } from './shellThemes.js';

const parseHex = (value) => value
  .slice(1)
  .match(/.{2}/g)
  .map((channel) => Number.parseInt(channel, 16));

const parseColor = (value, backdrop) => {
  if (value.startsWith('#')) return parseHex(value);
  const match = value.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  assert.ok(match, `unsupported color value: ${value}`);
  const alpha = Number(match[4]);
  return match.slice(1, 4).map((channel, index) => (
    (Number(channel) * alpha) + (backdrop[index] * (1 - alpha))
  ));
};

const luminance = (rgb) => {
  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
};

const contrast = (foreground, background) => {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
};

test('shell text tokens meet WCAG AA across their page and surface backgrounds', () => {
  for (const [modeName, mode] of Object.entries(SHELL_THEME.modes)) {
      const page = parseHex(mode.page);
      const backgrounds = {
        page,
        surface: parseColor(mode.surface, page),
        'surface-raised': parseColor(mode['surface-raised'], page),
        'player-bg': parseColor(mode['player-bg'], page),
        'drawer-bg': parseColor(mode['drawer-bg'], page),
      };
      for (const token of ['ink', 'muted', 'faint', 'accent-strong']) {
        for (const [backgroundName, background] of Object.entries(backgrounds)) {
          assert.ok(
            contrast(parseHex(mode[token]), background) >= 4.5,
            `${SHELL_THEME.id}.${modeName}.${token} must reach 4.5:1 against ${backgroundName}`,
          );
        }
      }
  }
});

test('every shell theme mode exposes a valid header swatch token', () => {
  for (const [modeName, mode] of Object.entries(SHELL_THEME.modes)) {
    assert.match(mode.swatch, /^#[\da-f]{6}$/i, `${SHELL_THEME.id}.${modeName}.swatch must be a hex color`);
  }
});
