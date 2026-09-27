import test from 'node:test';
import assert from 'node:assert/strict';
import { readThemePreference, resolveDarkAppearance, writeThemePreference } from './themePreference.js';

const createStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
};

test('system is the default and follows the current device appearance', () => {
  const storage = createStorage();
  assert.equal(readThemePreference(storage), 'system');
  assert.equal(resolveDarkAppearance('system', false), false);
  assert.equal(resolveDarkAppearance('system', true), true);
});

test('explicit appearance survives reload and system choice restores following', () => {
  const storage = createStorage();
  assert.equal(writeThemePreference(storage, 'dark'), true);
  assert.equal(readThemePreference(storage), 'dark');
  assert.equal(resolveDarkAppearance('dark', false), true);
  assert.equal(writeThemePreference(storage, 'system'), true);
  assert.equal(readThemePreference(storage), 'system');
});

test('valid old expiring preferences migrate while expired values return to system', () => {
  const storage = createStorage();
  storage.setItem('theme_pref', JSON.stringify({ value: 'light', expires: 200 }));
  assert.equal(readThemePreference(storage, 100), 'light');
  assert.equal(readThemePreference(storage, 201), 'system');
  assert.equal(storage.getItem('theme_pref'), null);
});
