import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('useWakeLock verifies touch device, fullscreen state, and foreground visibility', () => {
  const wakeLockSource = readSource('./useWakeLock.js');

  assert.match(wakeLockSource, /'wakeLock' in navigator/);
  assert.match(wakeLockSource, /\(pointer: coarse\), \(hover: none\)/);
  assert.match(wakeLockSource, /document\.visibilityState !== 'visible'/);
  assert.match(wakeLockSource, /navigator\.wakeLock\.request\('screen'\)/);
  assert.match(wakeLockSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(wakeLockSource, /lock\.release\(\)/);
});
