import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRandomSongsUrl, normalizeRandomExcludeIds } from './randomSongRequest.js';

test('random refresh URL carries up to twenty unique normalized current song ids', () => {
  const ids = [' a ', 'a', '', 'b', 123, ...Array.from({ length: 25 }, (_, index) => `id-${index}`)];
  const normalized = normalizeRandomExcludeIds(ids);
  assert.equal(normalized.length, 20);
  assert.equal(normalized[0], 'a');
  assert.equal(normalized[1], 'b');

  const url = new URL(buildRandomSongsUrl('https://music-api.example/', ids));
  assert.equal(url.pathname, '/api/songs/random');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.get('exclude'), normalized.join(','));
});

test('initial random request requests 20 songs without exclusions', () => {
  assert.equal(
    buildRandomSongsUrl('https://music-api.example', []),
    'https://music-api.example/api/songs/random?limit=20',
  );
});

test('supports same-origin relative base when apiBase is empty', () => {
  assert.equal(
    buildRandomSongsUrl('', ['a', 'b']),
    '/api/songs/random?exclude=a%2Cb&limit=20',
  );
  assert.equal(
    buildRandomSongsUrl('', []),
    '/api/songs/random?limit=20',
  );
});

