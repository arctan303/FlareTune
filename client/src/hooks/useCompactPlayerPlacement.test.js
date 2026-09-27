import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCompactPlayerPlacement } from './useCompactPlayerPlacement.js';

test('assistant temporarily uses the sidebar without replacing the chosen layout', () => {
  const selected = { preferred: 'dock' };
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'home' }), 'dock');
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'assistant' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'lyrics' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ ...selected, activePage: 'roam' }), 'dock');
  assert.equal(selected.preferred, 'dock');
});

test('the global sidebar preference resumes after page overrides', () => {
  assert.equal(resolveCompactPlayerPlacement({ preferred: 'sidebar', activePage: 'home' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ preferred: 'sidebar', activePage: 'assistant' }), 'sidebar');
  assert.equal(resolveCompactPlayerPlacement({ preferred: 'dock', activePage: 'home' }), 'dock');
});
