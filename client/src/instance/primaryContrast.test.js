import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { SHELL_THEME } from '../constants/shellThemes.js';

const css = postcss.parse(readFileSync(new URL('./instance.css', import.meta.url), 'utf8'));
const luminance = color => {
  const rgb = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb.reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
};
const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

for (const mode of ['light', 'dark']) for (const login of [false, true]) for (const hover of [false, true]) {
  test(`${mode} ${login ? 'login' : 'setup'} primary action stays legible ${hover ? 'on hover' : 'by default'}`, () => {
    const theme = SHELL_THEME.modes[mode], state = hover ? ':hover:not(:disabled)' : '';
    const selectors = ['.instance-primary', '.instance-primary' + state];
    if (login) selectors.push('.instance-page--login .instance-primary', '.instance-page--login .instance-primary' + state);
    if (login && mode === 'dark') selectors.push('html.dark .instance-page--login .instance-primary');
    const values = {};
    for (const selector of [...new Set(selectors)]) css.walkRules(rule => {
      if (!rule.selectors?.includes(selector)) return;
      rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    });
    const resolve = value => value.replace(/var\(--([^,)]+)(?:,[^)]+)?\)/g, (_all, key) => theme[key]);
    const foreground = resolve(values.color), background = resolve(values.background);
    assert.ok(ratio(foreground, background) >= 4.5, `${foreground} on ${background} is only ${ratio(foreground, background).toFixed(3)}:1`);
  });
}
