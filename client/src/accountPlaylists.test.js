import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountPlaylistRequestError, createAccountPlaylistStore, isAccountPlaylistStaleError } from './accountPlaylists.js';
import { useUIStore } from './store/useUIStore.js';

const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('an initially unavailable library recovers favorites and shelf on retry without creating playlists', async () => {
  let unavailable = true;
  const calls = [];
  const favorite = { id: 'fav', kind: 'favorite', name: '我的收藏', songCount: 11 };
  const store = createAccountPlaylistStore({ apiBase: '', fetchImpl: async (url, init) => {
    calls.push(init.method || 'GET');
    if (unavailable) return response({ ok: false }, 502);
    return url.endsWith('/playlist-shelf')
      ? response({ ok: true, data: { shelf: { revision: 3, items: [{ kind: 'member', id: 'fav' }] } } })
      : response({ ok: true, data: { playlists: [favorite, { id: 'p1', kind: 'regular', name: '测试' }] } });
  } });
  store.getState().setSubject('user-a');
  await assert.rejects(store.getState().refresh());
  assert.equal(store.getState().status, 'error');
  assert.equal(store.getState().error.status, 502);
  assert.deepEqual(store.getState().playlists, []);
  unavailable = false;
  await store.getState().refresh();
  assert.equal(store.getState().status, 'ready');
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().playlists[0].id, 'fav');
  assert.equal(store.getState().playlists.length, 2);
  assert.equal(store.getState().shelf.revision, 3);
  assert.ok(calls.every(method => method === 'GET'));
});

test('account playlist requests include credentials and new local-session CSRF', async () => {
  useUIStore.setState((state) => ({ authSession: { ...state.authSession, csrfToken: 'local-csrf-test' } }));
  const calls = [];
  const store = createAccountPlaylistStore({
    apiBase: 'https://music.test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/playlist-shelf')) return response({ ok: true, data: { shelf: { revision: 0, items: [] } } });
      if (init.method === 'POST') return response({ ok: true, data: { playlist: { id: 'p1', kind: 'regular' }, shelf: { revision: 1, items: [] } } }, 201);
      return response({ ok: true, data: { playlists: [] } });
    },
  });
  store.getState().setSubject('user-a');
  await store.getState().refresh();
  await store.getState().createPlaylist({ name: '夜航' });
  assert.ok(calls.every((call) => call.init.credentials === 'include'));
  const write = calls.find((call) => call.init.method === 'POST');
  assert.equal(write.init.headers['X-Requested-With'], 'FlareTune');
  assert.equal(write.init.headers['X-CSRF-Token'], 'local-csrf-test');
  assert.equal(write.init.headers['Content-Type'], 'application/json');
});

test('refresh preserves successful account data when the companion request fails', async () => {
  const favorite = { id: 'fav', kind: 'favorite', name: '我喜欢' };
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async (url) => url.endsWith('/playlist-shelf')
      ? response({ ok: false, error: 'MUSIC_STORAGE_UNAVAILABLE', message: '唱片架暂时不可用' }, 503)
      : response({ ok: true, data: { playlists: [favorite] } }),
  });
  store.getState().setSubject('user-a');

  await assert.rejects(store.getState().refresh(), (error) => (
    error instanceof AccountPlaylistRequestError && error.code === 'MUSIC_STORAGE_UNAVAILABLE'
  ));

  assert.deepEqual(store.getState().playlists, [{ ...favorite, name: '我的收藏', description: '' }]);
  assert.equal(store.getState().shelf, null);
  assert.equal(store.getState().status, 'error');
  assert.equal(store.getState().error.code, 'MUSIC_STORAGE_UNAVAILABLE');
});

test('legacy favorite names and descriptions are canonicalized in account list and detail', async () => {
  const legacyFavorite = { id: 'fav', kind: 'favorite', name: '我喜欢', description: '旧简介', revision: 3 };
  const regular = { id: 'regular', kind: 'regular', name: '我的歌单', description: '保留简介' };
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async (url) => url.endsWith('/playlists/fav')
      ? response({ ok: true, data: { playlist: { ...legacyFavorite, songs: [{ id: 'song-1' }] } } })
      : response({ ok: true, data: { playlists: [legacyFavorite, regular] } }),
  });
  store.getState().setSubject('user-a');

  await store.getState().refreshLists();
  const detail = await store.getState().loadDetail('fav');

  assert.deepEqual(store.getState().playlists, [
    { ...legacyFavorite, name: '我的收藏', description: '' },
    regular,
  ]);
  assert.equal(detail.name, '我的收藏');
  assert.equal(detail.description, '');
  assert.deepEqual(detail.songs, [{ id: 'song-1' }]);
  assert.deepEqual(store.getState().details.fav, detail);
});

test('subject changes clear account data immediately and late requests cannot overwrite the new subject', async () => {
  let resolveLists;
  const fetchImpl = (url) => {
    if (url.endsWith('/playlists')) return new Promise((resolve) => { resolveLists = resolve; });
    return Promise.resolve(response({ ok: true, data: { shelf: { revision: 0, items: [] } } }));
  };
  const store = createAccountPlaylistStore({ apiBase: '', fetchImpl });
  store.getState().setSubject('user-a');
  const pending = store.getState().refreshLists();
  store.setState({ playlists: [{ id: 'old' }], details: { old: { id: 'old' } }, shelf: { revision: 1 } });
  store.getState().setSubject('user-b');
  store.getState().setSubject(null);
  assert.deepEqual(store.getState().playlists, []);
  assert.deepEqual(store.getState().details, {});
  assert.equal(store.getState().shelf, null);
  resolveLists(response({ ok: true, data: { playlists: [{ id: 'late-a' }] } }));
  await assert.rejects(pending, isAccountPlaylistStaleError);
  assert.equal(store.getState().subject, null);
  assert.deepEqual(store.getState().playlists, []);
});

test('a late response from an earlier generation cannot flash after A switches away and back to A', async () => {
  let resolveOldLists;
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: (url) => url.endsWith('/playlists')
      ? new Promise((resolve) => { resolveOldLists = resolve; })
      : Promise.resolve(response({ ok: true, data: { shelf: { revision: 0, items: [] } } })),
  });
  store.getState().setSubject('user-a');
  const oldRequest = store.getState().refreshLists();
  store.getState().setSubject('user-b');
  store.getState().setSubject('user-a');
  resolveOldLists(response({ ok: true, data: { playlists: [{ id: 'old-generation' }] } }));
  await assert.rejects(oldRequest, isAccountPlaylistStaleError);
  assert.equal(store.getState().subject, 'user-a');
  assert.deepEqual(store.getState().playlists, []);
  assert.equal(store.getState().generation, 3);
});

test('store retains lists, details and shelf and exposes CRUD/song/shelf actions', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method]);
    if (url.endsWith('/playlist-shelf/visibility')) return response({ ok: true, data: { outcome: 'applied', shelf: { revision: 3, items: [] } } });
    if (url.endsWith('/playlist-shelf') && init.method === 'PUT') return response({ ok: true, data: { outcome: 'applied', shelf: { revision: 2, items: [] } } });
    if (url.endsWith('/playlist-shelf')) return response({ ok: true, data: { shelf: { revision: 1, items: [] } } });
    if (url.includes('/songs/') && init.method === 'DELETE') return response({ ok: true, data: { outcome: 'applied', playlist: { id: 'fav', revision: 2, songs: [] } } });
    if (url.endsWith('/songs') && init.method === 'PUT') return response({ ok: true, data: { outcome: 'applied', playlist: { id: 'fav', revision: 3, songs: [] } } });
    if (url.endsWith('/playlist-songs')) return response({ ok: true, data: { outcome: 'noop', affectedPlaylistIds: [] } });
    if (url.endsWith('/playlists/fav') && init.method === 'GET') return response({ ok: true, data: { playlist: { id: 'fav', kind: 'favorite', revision: 1, songs: [] } } });
    if (url.endsWith('/playlists/fav') && init.method === 'PUT') return response({ ok: true, data: { outcome: 'applied', playlist: { id: 'fav', name: '新名', revision: 2 } } });
    if (url.endsWith('/playlists/p1') && init.method === 'DELETE') return response({ ok: true, data: { outcome: 'applied', deletedPlaylistId: 'p1', shelf: { revision: 4, items: [] } } });
    if (url.endsWith('/playlists') && init.method === 'POST') return response({ ok: true, data: { playlist: { id: 'p1', kind: 'regular' }, shelf: { revision: 1, items: [] } } }, 201);
    return response({ ok: true, data: { playlists: [{ id: 'fav', kind: 'favorite', revision: 1 }] } });
  };
  const store = createAccountPlaylistStore({ apiBase: '', fetchImpl });
  store.getState().setSubject('user-a');
  await store.getState().refresh();
  await store.getState().loadDetail('fav');
  await store.getState().createPlaylist({ name: 'A' });
  await store.getState().updatePlaylist('fav', { name: '新名', expectedRevision: 1 });
  await store.getState().addSongs([{ playlistId: 'fav', expectedRevision: 2 }], ['s1']);
  await store.getState().removeSong('fav', 's1', 2);
  await store.getState().replaceSongs('fav', ['s2'], 2);
  await store.getState().clearPlaylist('fav', 3);
  await store.getState().reorderSongs('fav', [], 3);
  await store.getState().updateShelfOrder([], 1);
  await store.getState().deletePlaylist('p1', 0);
  assert.equal(store.getState().details.fav.id, 'fav');
  assert.equal(store.getState().shelf.revision, 4);
  assert.ok(calls.some(([url, method]) => url.endsWith('/playlist-songs') && method === 'POST'));
  assert.ok(calls.some(([url, method]) => url.endsWith('/songs/s1') && method === 'DELETE'));
});

test('409 responses retain status, code and server conflict DTO', async () => {
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async () => response({ ok: false, error: 'REVISION_CONFLICT', message: '已更新', data: { playlist: { revision: 2 } } }, 409),
  });
  store.getState().setSubject('user-a');
  await assert.rejects(store.getState().updatePlaylist('p1', { name: 'X', expectedRevision: 1 }), (error) => {
    assert.ok(error instanceof AccountPlaylistRequestError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.equal(error.data.playlist.revision, 2);
    return true;
  });
  assert.equal(store.getState().error.status, 409);
});

test('batch add failures reject with the result-level CAS error instead of reporting success', async () => {
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async (url, init) => {
      if (url.endsWith('/playlist-songs') && init.method === 'POST') {
        return response({
          ok: true,
          data: {
            outcome: 'failed',
            affectedPlaylistIds: [],
            results: [{ playlistId: 'fav', outcome: 'failed', error: 'REVISION_CONFLICT', revision: 2 }],
          },
        });
      }
      if (url.endsWith('/playlists/fav')) return response({ ok: true, data: { playlist: { id: 'fav', revision: 2, songs: [] } } });
      return response({ ok: true, data: { playlists: [{ id: 'fav', revision: 2 }] } });
    },
  });
  store.getState().setSubject('user-a');
  await assert.rejects(
    store.getState().addSongs([{ playlistId: 'fav', expectedRevision: 1 }], ['s1']),
    (error) => error instanceof AccountPlaylistRequestError
      && error.status === 409
      && error.code === 'REVISION_CONFLICT'
      && error.data.results[0].revision === 2,
  );
});

test('a successful batch add remains successful when the authoritative refresh fails', async () => {
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async (url, init) => {
      if (url.endsWith('/playlist-songs') && init.method === 'POST') {
        return response({ ok: true, data: { outcome: 'applied', affectedPlaylistIds: ['fav'], results: [] } });
      }
      return response({ ok: false, error: 'MUSIC_STORAGE_UNAVAILABLE', message: '暂时不可用' }, 503);
    },
  });
  store.getState().setSubject('user-a');
  const result = await store.getState().addSongs([{ playlistId: 'fav', expectedRevision: 1 }], ['s1']);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.refreshFailed, true);
});

test('authoritative list refresh removes cached details for playlists deleted elsewhere', async () => {
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async (url) => url.endsWith('/playlist-shelf')
      ? response({ ok: true, data: { shelf: { revision: 2, items: [] } } })
      : response({ ok: true, data: { playlists: [{ id: 'fav', kind: 'favorite' }] } }),
  });
  store.getState().setSubject('user-a');
  store.setState({
    playlists: [{ id: 'fav', kind: 'favorite' }, { id: 'deleted', kind: 'regular' }],
    details: { fav: { id: 'fav' }, deleted: { id: 'deleted' } },
  });

  await store.getState().refresh();

  assert.deepEqual(Object.keys(store.getState().details), ['fav']);
  assert.equal(store.getState().details.deleted, undefined);
});

test('a late detail response cannot restore a playlist removed by an authoritative refresh', async () => {
  let resolveDetail;
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async (url) => {
      if (url.endsWith('/playlists/deleted')) return new Promise((resolve) => { resolveDetail = resolve; });
      return response({ ok: true, data: { playlists: [{ id: 'fav', kind: 'favorite' }] } });
    },
  });
  store.getState().setSubject('user-a');
  store.setState({ playlists: [{ id: 'fav' }, { id: 'deleted' }] });
  const pendingDetail = store.getState().loadDetail('deleted');
  await store.getState().refreshLists();
  resolveDetail(response({ ok: true, data: { playlist: { id: 'deleted', songs: [] } } }));
  await pendingDetail;

  assert.equal(store.getState().details.deleted, undefined);
});

test('a late successful write rejects as stale instead of returning toastable success', async () => {
  let resolveWrite;
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: () => new Promise((resolve) => { resolveWrite = resolve; }),
  });
  store.getState().setSubject('user-a');
  const pending = store.getState().createPlaylist({ name: 'A 的歌单' });
  store.getState().setSubject('user-b');
  store.getState().setSubject(null);
  resolveWrite(response({
    ok: true,
    data: { outcome: 'applied', playlist: { id: 'late-a', name: 'A 的歌单' }, shelf: { revision: 1, items: [] } },
  }, 201));

  await assert.rejects(pending, (error) => isAccountPlaylistStaleError(error) && error.code === 'STALE_ACCOUNT_CONTEXT');
  assert.equal(store.getState().subject, null);
  assert.deepEqual(store.getState().playlists, []);
});

test('failed shelf writes retain the authoritative shelf while exposing a retryable error', async () => {
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async () => response({ ok: false, error: 'MUSIC_STORAGE_UNAVAILABLE', message: '暂时不可用' }, 503),
  });
  store.getState().setSubject('user-a');
  const shelf = { revision: 7, items: [{ kind: 'member', id: 'p1' }] };
  store.setState({ shelf });

  await assert.rejects(
    store.getState().updateShelfOrder([{ kind: 'member', id: 'p1' }], 7),
    (error) => error instanceof AccountPlaylistRequestError && error.status === 503,
  );
  assert.equal(store.getState().shelf, shelf);
  assert.equal(store.getState().error.status, 503);
});

test('favorite detail storage failures make the account state observable and retryable', async () => {
  let fail = true;
  const store = createAccountPlaylistStore({
    apiBase: '',
    fetchImpl: async (url) => {
      if (url.endsWith('/api/account/playlists')) {
        return response({ ok: true, data: { playlists: [{ id: 'fav', kind: 'favorite', name: '我喜欢' }] } });
      }
      if (url.endsWith('/api/account/playlist-shelf')) {
        return response({ ok: true, data: { shelf: { revision: 0, items: [] } } });
      }
      return fail
        ? response({ ok: false, error: 'MUSIC_STORAGE_UNAVAILABLE', message: '暂时不可用' }, 503)
        : response({ ok: true, data: { playlist: { id: 'fav', kind: 'favorite', name: '我喜欢', songs: [], revision: 0 } } });
    },
  });
  store.getState().setSubject('user-a');
  store.setState({ status: 'ready', playlists: [{ id: 'fav', kind: 'favorite', name: '我喜欢' }] });

  await assert.rejects(store.getState().loadDetail('fav'));
  assert.equal(store.getState().status, 'error');
  assert.equal(store.getState().error.code, 'MUSIC_STORAGE_UNAVAILABLE');
  assert.equal(store.getState().details.fav, undefined);

  fail = false;
  await store.getState().refresh();
  await store.getState().loadDetail('fav');
  assert.equal(store.getState().status, 'ready');
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().details.fav.name, '我的收藏');
});
