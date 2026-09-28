import assert from 'node:assert/strict';
import test from 'node:test';
import { startPreview } from '../dev/preview-worker.mjs';

const setupSecret = 'local-preview-only-claim-secret-not-for-deployment-2026';
const password = 'pass2026';

test('real local D1 Worker serves setup, login, settings and CSRF', async () => {
  const preview = await startPreview({ ephemeral: true, seedEmpty: true,
    workerTestBindings: { SETUP_SECRET: setupSecret } });
  const api = (path, options) => fetch(`${preview.origin}${path}`, options);
  const post = (path, body, headers = {}, method = 'POST') => api(path, {
    method, body: JSON.stringify(body), headers: {
      'Content-Type': 'application/json', Origin: preview.origin,
      'X-Requested-With': 'FlareTune', ...headers,
    },
  });
  try {
    assert.deepEqual(await (await api('/api/instance/status')).json(),
      { state: 'setup_required', schemaVersion: 0, targetVersion: 2 });
    const verified = await post('/api/auth/verify-setup', { setupSecret });
    assert.equal(verified.status, 200, JSON.stringify(await verified.clone().json()));
    const { proof } = await verified.json();
    assert.equal((await (await api('/api/instance/status')).json()).schemaVersion, 0);
    const claim = await post('/api/auth/setup', { proof, username: 'owner', password });
    assert.equal(claim.status, 201);
    assert.deepEqual(await (await api('/api/instance/status')).json(),
      { state: 'ready', schemaVersion: 2, targetVersion: 2 });
    const login = await post('/api/auth/login', { username: 'owner', password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('Set-Cookie');
    assert.match(cookie, /^__Host-ft_session=/);
    const session = await api('/api/auth/session', { headers: { Cookie: cookie } });
    const { csrfToken, user } = await session.json();
    assert.equal(user.username, 'owner');
    assert.ok(csrfToken);
    const anonymousLibrary = await api('/api/init');
    assert.equal(anonymousLibrary.status, 401);
    const emptyLibrary = await api('/api/init', { headers: { Cookie: cookie } });
    assert.equal(emptyLibrary.status, 200);
    assert.deepEqual((await emptyLibrary.json()).data.default_playlist.songs, []);
    assert.equal((await api('/api/account/playlists')).status, 401);
    const accountPlaylists = await api('/api/account/playlists', { headers: { Cookie: cookie } });
    assert.equal(accountPlaylists.status, 200);
    assert.equal((await accountPlaylists.json()).data.playlists[0].kind, 'favorite');
    assert.equal((await post('/api/account/playlists', { name: 'Local only' }, { Cookie: cookie })).status, 403);
    const addedPlaylist = await post('/api/account/playlists', { name: 'Local only' },
      { Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(addedPlaylist.status, 201);
    const createdPersonal = (await addedPlaylist.json()).data.playlist;
    assert.equal(createdPersonal.name, 'Local only');
    assert.equal((await api('/api/songs/random', { headers: { Cookie: cookie } })).status, 200);
    const assistantBootstrap = await api('/api/ai/bootstrap', { headers: { Cookie: cookie } });
    assert.equal(assistantBootstrap.status, 200);
    assert.equal((await assistantBootstrap.json()).assistant.name, '小A');
    assert.equal((await post('/api/ai/chat', { message: 'test' }, { Cookie: cookie })).status, 403);
    assert.equal((await api('/api/admin/catalog/songs')).status, 401);
    assert.equal((await api('/api/admin/catalog/songs', { headers: { Cookie: cookie } })).status, 200);
    const mediaPath = '/api/admin/catalog/media/audio/0123456789abcdef.mp3';
    const mediaBytes = Uint8Array.of(0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00);
    const upload = (headers = {}, body = mediaBytes) => api(mediaPath, { method: 'PUT', body, headers: {
      'Content-Type': 'audio/mpeg', Origin: preview.origin, 'X-Requested-With': 'FlareTune', ...headers,
    } });
    assert.equal((await upload()).status, 401);
    assert.equal((await upload({ Cookie: cookie })).status, 403);
    const uploaded = await upload({ Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(uploaded.status, 201, JSON.stringify(await uploaded.clone().json()));
    assert.equal((await uploaded.json()).data.url, '/media/audio/0123456789abcdef.mp3');
    assert.equal((await upload({ Cookie: cookie, 'X-CSRF-Token': csrfToken })).status, 409);
    assert.equal((await api('/media/audio/0123456789abcdef.mp3')).status, 401);
    const mediaRead = await api('/media/audio/0123456789abcdef.mp3', { headers: { Cookie: cookie } });
    assert.equal(mediaRead.status, 200);
    assert.equal(mediaRead.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(new Uint8Array(await mediaRead.arrayBuffer()), mediaBytes);
    const mediaHead = await api('/media/audio/0123456789abcdef.mp3', {
      method: 'HEAD', headers: { Cookie: cookie },
    });
    assert.equal(mediaHead.status, 200);
    const mediaRange = await api('/media/audio/0123456789abcdef.mp3', {
      headers: { Cookie: cookie, Range: 'bytes=0-2' },
    });
    assert.equal(mediaRange.status, 206);
    assert.deepEqual(new Uint8Array(await mediaRange.arrayBuffer()), mediaBytes.subarray(0, 3));
    assert.equal((await post('/api/admin/catalog/songs', {
      id: 'local-instrumental', title: 'Local instrumental', language: 'instrumental',
      audio_url: 'https://media.example/local-instrumental.mp3',
    }, { Cookie: cookie })).status, 403);
    const createdSong = await post('/api/admin/catalog/songs', {
      id: 'local-instrumental', title: 'Local instrumental', language: 'instrumental',
      audio_url: 'https://media.example/local-instrumental.mp3',
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(createdSong.status, 201);
    const songVersion = (await createdSong.json()).data.song.version;
    assert.match(songVersion, /^[a-f0-9]{64}$/);
    assert.equal((await api('/api/admin/catalog/playlists', { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await post('/api/admin/catalog/playlists', { name: 'Retired' },
      { Cookie: cookie, 'X-CSRF-Token': csrfToken })).status, 404);
    assert.equal((await api('/api/playlists/legacy', { headers: { Cookie: cookie } })).status, 404);
    const addedToPersonal = await post('/api/account/playlist-songs', {
      targets: [{ playlistId: createdPersonal.id, expectedRevision: createdPersonal.revision }],
      songIds: ['local-instrumental'],
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(addedToPersonal.status, 200);
    const personalDetail = await api(`/api/account/playlists/${createdPersonal.id}`, { headers: { Cookie: cookie } });
    assert.equal(personalDetail.status, 200);
    const personalData = (await personalDetail.json()).data.playlist;
    assert.deepEqual(personalData.songs.map((item) => item.id), ['local-instrumental']);
    const removedFromPersonal = await post(`/api/account/playlists/${createdPersonal.id}/songs/local-instrumental`, {
      expectedRevision: personalData.revision,
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken }, 'DELETE');
    assert.equal(removedFromPersonal.status, 200);
    const personalList = await api('/api/account/playlists', { headers: { Cookie: cookie } });
    assert.equal(personalList.status, 200);
    const favorite = (await personalList.json()).data.playlists.find((item) => item.kind === 'favorite');
    assert.ok(favorite?.id);
    const favorited = await post('/api/account/playlist-songs', {
      targets: [{ playlistId: favorite.id, expectedRevision: favorite.revision }],
      songIds: ['local-instrumental'],
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(favorited.status, 200);
    assert.equal((await favorited.json()).data.outcome, 'applied');
    const favoriteDetail = await api(`/api/account/playlists/${favorite.id}`, { headers: { Cookie: cookie } });
    assert.equal(favoriteDetail.status, 200);
    const favoriteData = (await favoriteDetail.json()).data.playlist;
    assert.deepEqual(favoriteData.songs.map((item) => item.id), ['local-instrumental']);
    const unfavorited = await post(`/api/account/playlists/${favorite.id}/songs/local-instrumental`, {
      expectedRevision: favoriteData.revision,
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken }, 'DELETE');
    assert.equal(unfavorited.status, 200);
    assert.deepEqual((await unfavorited.json()).data.playlist.songs, []);
    assert.equal((await api('/api/lyrics/workspace/local-instrumental')).status, 401);
    const lyricWorkspace = await api('/api/lyrics/workspace/local-instrumental',
      { headers: { Cookie: cookie } });
    assert.equal(lyricWorkspace.status, 200);
    assert.equal((await lyricWorkspace.json()).data.status, 'not_needed');
    const temporaryPassword = 'temp2026';
    const memberPassword = 'safe2026';
    assert.equal((await post('/api/admin/accounts', {
      username: 'listener', role: 'member', temporaryPassword,
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken })).status, 201);
    const temporaryLogin = await post('/api/auth/login', { username: 'listener', password: temporaryPassword });
    assert.equal(temporaryLogin.status, 200);
    const temporarySession = await temporaryLogin.json();
    assert.equal(temporarySession.mustChangePassword, true);
    assert.equal((await post('/api/auth/change-password', {
      currentPassword: temporaryPassword, newPassword: memberPassword,
    }, { Cookie: temporaryLogin.headers.get('Set-Cookie'), 'X-CSRF-Token': temporarySession.csrfToken })).status, 200);
    const memberLogin = await post('/api/auth/login', { username: 'listener', password: memberPassword });
    assert.equal(memberLogin.status, 200);
    const memberCookie = memberLogin.headers.get('Set-Cookie');
    const memberCsrf = (await memberLogin.json()).csrfToken;
    assert.equal((await api(`/api/account/playlists/${createdPersonal.id}`,
      { headers: { Cookie: memberCookie } })).status, 404);
    assert.equal((await api('/api/admin/catalog/songs', { headers: { Cookie: memberCookie } })).status, 403);
    assert.equal((await upload({ Cookie: memberCookie, 'X-CSRF-Token': memberCsrf })).status, 403);
    assert.equal((await api('/api/lyrics/workspace/local-instrumental',
      { headers: { Cookie: memberCookie } })).status, 200);
    for (const [suffix, method, body] of [
      ['', 'PUT', { source: 'auto', etag: null }],
      ['', 'DELETE', { etag: null }],
      ['/offset', 'PATCH', { offsetMs: 0, etag: null }],
      ['/translation', 'DELETE', { etag: null }],
      ['/ai-completion', 'POST', {}],
    ]) {
      const denied = await post(`/api/lyrics/workspace/local-instrumental${suffix}`, body,
        { Cookie: memberCookie, 'X-CSRF-Token': memberCsrf }, method);
      assert.equal(denied.status, suffix === '/ai-completion' ? 422 : 403);
    }
    const deletionPreviewPath = '/api/admin/catalog/delete-preview';
    assert.equal((await post(deletionPreviewPath, { ids: ['local-instrumental'] })).status, 401);
    assert.equal((await post(deletionPreviewPath, { ids: ['local-instrumental'] },
      { Cookie: memberCookie, 'X-CSRF-Token': memberCsrf })).status, 403);
    const deletionPreview = await post(deletionPreviewPath, { ids: ['local-instrumental'] },
      { Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(deletionPreview.status, 200);
    assert.match((await deletionPreview.json()).data.impact_digest, /^[a-f0-9]{64}$/);
    const removedSong = await post('/api/admin/catalog/songs/local-instrumental', {
      expectedVersion: songVersion, confirmDelete: true,
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken }, 'DELETE');
    assert.equal(removedSong.status, 200);
    assert.equal((await removedSong.json()).data.deletedSongId, 'local-instrumental');
    const settings = await api('/api/admin/settings', { headers: { Cookie: cookie } });
    assert.equal(settings.status, 200);
    const current = await settings.json();
    assert.deepEqual(current.settings['cors.allowed_origins'].value, []);
    const changed = await post('/api/admin/settings', {
      key: 'cors.allowed_origins', value: ['https://music.example'],
      expectedRevision: current.settings['cors.allowed_origins'].revision,
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken }, 'PUT');
    assert.equal(changed.status, 200);
    const preflight = await api('/api/admin/settings', { method: 'OPTIONS', headers: {
      Origin: 'https://music.example', 'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type,x-requested-with,x-csrf-token',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://music.example');
    assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');
    const unlisted = await api('/api/admin/settings', { method: 'OPTIONS',
      headers: { Origin: 'https://unlisted.example', 'Access-Control-Request-Method': 'PUT' } });
    assert.equal(unlisted.headers.get('Access-Control-Allow-Origin'), null);
    const crossLogin = await api('/api/auth/login', { method: 'POST', headers: {
      Origin: 'https://music.example', 'X-Requested-With': 'FlareTune',
      'Content-Type': 'application/json',
    }, body: JSON.stringify({ username: 'owner', password }) });
    assert.equal(crossLogin.status, 200);
    assert.equal(crossLogin.headers.get('Access-Control-Allow-Origin'), 'https://music.example');
    assert.match(crossLogin.headers.get('Set-Cookie'), /SameSite=None/);
    const crossRecovery = await api('/api/auth/recovery', { method: 'POST', headers: {
      Origin: 'https://music.example', 'X-Requested-With': 'FlareTune',
      'Content-Type': 'application/json',
    }, body: JSON.stringify({ setupSecret, action: 'inspect' }) });
    assert.equal(crossRecovery.status, 404);
    assert.equal(crossRecovery.headers.get('Access-Control-Allow-Origin'), null);
    const conflict = await post('/api/admin/settings', {
      key: 'cors.allowed_origins', value: [],
      expectedRevision: current.settings['cors.allowed_origins'].revision,
    }, { Cookie: cookie, 'X-CSRF-Token': csrfToken }, 'PUT');
    assert.equal(conflict.status, 409);
    assert.equal((await api('/api/auth/session', { headers: { Cookie: cookie } })).status, 200);
  } finally {
    await preview.stop();
  }
});

test('maintenance keeps business closed and upgrades only after the setup secret is verified', async () => {
  const preview = await startPreview({ ephemeral: true, seedMigrationPending: true,
    workerTestBindings: { SETUP_SECRET: setupSecret } });
  const api = (path, options) => fetch(`${preview.origin}${path}`, options);
  try {
    assert.deepEqual(await (await api('/api/instance/status')).json(),
      { state: 'maintenance', schemaVersion: 1, targetVersion: 2 });
    assert.equal((await api('/api/init')).status, 503);
    const removed = await api('/api/auth/recovery', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: preview.origin,
        'X-Requested-With': 'FlareTune' },
      body: JSON.stringify({ setupSecret, action: 'retry_migration', version: 2, confirmation: true }) });
    assert.equal(removed.status, 404);
    assert.deepEqual(await (await api('/api/instance/status')).json(),
      { state: 'maintenance', schemaVersion: 1, targetVersion: 2 });
    const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body), headers: {
      'Content-Type': 'application/json', Origin: preview.origin, 'X-Requested-With': 'FlareTune',
    } });
    assert.equal((await post('/api/instance/upgrade', { proof: 'invalid' })).status, 403);
    const verified = await post('/api/instance/verify-maintenance', { setupSecret });
    assert.equal(verified.status, 200);
    const { proof } = await verified.json();
    let step;
    for (let index = 0; index < 5; index += 1) {
      const response = await post('/api/instance/upgrade', { proof });
      assert.equal(response.status, 200);
      step = await response.json();
      if (step.status === 'completed') break;
    }
    assert.equal(step.status, 'completed');
    assert.deepEqual(await (await api('/api/instance/status')).json(),
      { state: 'setup_required', schemaVersion: 2, targetVersion: 2 });
  } finally {
    await preview.stop();
  }
});
