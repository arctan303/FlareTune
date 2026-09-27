import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSongById, SongFetchError } from './songApi.js';

test('fetchSongById uses the current path endpoint and returns its object payload', async () => {
  const requests = [];
  const song = await fetchSongById('song / one', {
    apiBase: 'https://music-api.example/',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        code: 200,
        data: { id: 'song / one', title: 'Current contract' },
      }));
    },
  });

  assert.deepEqual(requests, [{
    url: 'https://music-api.example/api/songs/song%20%2F%20one',
    init: { credentials: 'include', cache: 'no-store' },
  }]);
  assert.deepEqual(song, { id: 'song / one', title: 'Current contract' });
});

test('fetchSongById rejects the retired array response shape', async () => {
  const song = await fetchSongById('legacy', {
    apiBase: 'https://music-api.example',
    fetchImpl: async () => new Response(JSON.stringify({
      code: 200,
      data: [{ id: 'legacy' }],
    })),
  });

  assert.equal(song, null);
});

test('fetchSongById exposes HTTP status without accepting an error payload', async () => {
  await assert.rejects(
    fetchSongById('missing', {
      apiBase: 'https://music-api.example',
      fetchImpl: async () => new Response('{}', { status: 404 }),
    }),
    (error) => error instanceof SongFetchError && error.status === 404,
  );
});
