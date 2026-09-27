import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPreviewOverflow } from './previewVisibility.js';

test('preview entry follows actual hidden content, including horizontal overflow and unloaded pages', () => {
  assert.equal(hasPreviewOverflow({ renderedCount: 6, visibleCount: 6, totalCount: 6 }), false);
  assert.equal(hasPreviewOverflow({ renderedCount: 6, visibleCount: 6, totalCount: 6, scrollOverflow: true }), true);
  assert.equal(hasPreviewOverflow({ renderedCount: 6, visibleCount: 4, totalCount: 6 }), true);
  assert.equal(hasPreviewOverflow({ renderedCount: 6, visibleCount: 6, hasMore: true }), true);
});
