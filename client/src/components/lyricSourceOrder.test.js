import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedLyricSources, moveLyricSource } from './lyricSourceOrder.js';

test('source settings preserve configured order and omit unavailable providers', () => {
  const result = orderedLyricSources({ order: ['youtube-music', 'removed', 'file', 'lyrics-workbench'], sources: [
    { id: 'lyrics-workbench', name: 'Lyrics workbench' }, { id: 'youtube-music', name: 'YT' },
    { id: 'file', name: 'File' }, { id: 'removed', enabled: false }, { id: 'third-party' },
  ] });
  assert.deepEqual(result.map(source => source.id), ['youtube-music', 'file', 'lyrics-workbench', 'third-party']);
});

test('source movement exchanges only its neighbor and keeps the remaining priority', () => {
  const order = ['lyrics-workbench', 'youtube-music', 'file'];
  assert.deepEqual(moveLyricSource(order, 'youtube-music', -1), ['youtube-music', 'lyrics-workbench', 'file']);
  assert.deepEqual(moveLyricSource(order, 'lyrics-workbench', 1), ['youtube-music', 'lyrics-workbench', 'file']);
  assert.equal(moveLyricSource(order, 'file', 1), order);
  assert.deepEqual(order, ['lyrics-workbench', 'youtube-music', 'file']);
});
