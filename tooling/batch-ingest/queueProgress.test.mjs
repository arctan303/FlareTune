import assert from 'node:assert/strict';
import test from 'node:test';
import { beginProgress, updateProgress } from './web/queueProgress.js';

test('batch progress counts only queued files and stays monotonic across audio and cover', () => {
  const entry = { identity: 'one', file: { size: 80 }, coverFile: { size: 20 }, progressBase: 0 };
  const progress = beginProgress([entry]);
  assert.deepEqual(updateProgress(progress, entry, 40), { item: 40, batch: 40 });
  entry.progressBase = 80;
  assert.deepEqual(updateProgress(progress, entry, 0), { item: 80, batch: 80 });
  assert.deepEqual(updateProgress(progress, entry, 20), { item: 100, batch: 100 });
});
