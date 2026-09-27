import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePersistedUISettings } from './useUIStore.js';

test('old scenery preference is discarded while independent UI preferences survive hydration', () => {
  const current = { immersiveAmbientEnabled: true, compactPlayerPlacement: 'dock' };
  const stored = {
    immersiveBgMode: 'scenery',
    immersiveAmbientEnabled: false,
    compactPlayerPlacement: 'sidebar',
  };
  assert.deepEqual(mergePersistedUISettings(stored, current), {
    immersiveAmbientEnabled: false,
    compactPlayerPlacement: 'sidebar',
  });
});
