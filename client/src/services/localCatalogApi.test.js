import assert from 'node:assert/strict';
import test from 'node:test';
import { updateSongLanguage } from './localCatalogApi.js';
import { useUIStore } from '../store/useUIStore.js';

const respond = (data) => new Response(JSON.stringify({ ok: true, data }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

test('song language update uses versioned local-admin API and account CSRF headers', async () => {
  useUIStore.setState({ authSession: {
    authenticated: true, user: { accountId: 'admin-1', role: 'admin' }, csrfToken: 'csrf-1',
  } });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(calls.length === 1
      ? { song: { id: 'song-1', version: 'version-1' } }
      : { song: { id: 'song-1', language: 'ja', version: 'version-2' } });
  };
  const song = await updateSongLanguage('song-1', 'ja', fetchImpl);
  assert.equal(song.language, 'ja');
  assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
    ['/api/admin/catalog/songs/song-1', 'GET'],
    ['/api/admin/catalog/songs/song-1', 'PUT'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { language: 'ja', expectedVersion: 'version-1' });
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(calls[1].init.headers['X-FlareTune-Expected-Account'], 'admin-1');
  assert.equal(calls[1].init.headers['X-Requested-With'], 'FlareTune');
  assert.equal(calls[1].init.headers['x-admin-api-key'], undefined);
});

test('song language edit fails closed without a normal administrator CSRF session', async () => {
  useUIStore.setState({ authSession: {
    authenticated: true, user: { accountId: 'member-1', role: 'member' }, csrfToken: 'csrf-1',
  } });
  await assert.rejects(updateSongLanguage('song-1', 'ja', () => {
    throw new Error('request must not be sent');
  }), { status: 403 });
  useUIStore.setState({ authSession: {
    authenticated: true, user: { accountId: 'admin-1', role: 'admin' }, csrfToken: null,
  } });
  await assert.rejects(updateSongLanguage('song-1', 'ja', () => {
    throw new Error('request must not be sent');
  }), { status: 403 });
});
