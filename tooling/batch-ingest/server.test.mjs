import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchIngestServer } from './server.mjs';
const profileStore = () => {
  const values = [];
  return { list: async () => values,
    save: async (data) => { const profile = { id: String(values.length + 1), name: data.name, baseUrl: data.baseUrl,
      username: data.username, savedPassword: false }; values.push(profile); return { profile, warning: '' }; },
  };
};

test('local login, admin catalog and streamed Worker upload obey both session boundaries', async () => {
  const seen = [];
  const remoteFetch = async (url, options) => {
    const path = new URL(url).pathname;
    seen.push({ path, method: options.method, headers: options.headers });
    if (path === '/api/auth/login') return new Response(JSON.stringify({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: 'admin-id' }, csrfToken: 'remote-csrf' }),
    { status: 200, headers: { 'Set-Cookie': 'ft_session=remote-session; HttpOnly' } });
    if (path === '/api/admin/catalog/songs' && options.method === 'GET') return Response.json({
      ok: true, data: { songs: [{ id: 'old', title: '已有歌曲', artist: '歌手' }], total: 1 },
    });
    if (path === '/api/admin/catalog/media/audio/0123456789abcdef.mp3') {
      let bytes = 0;
      for await (const part of options.body) bytes += part.length;
      assert.equal(bytes, 18);
      return Response.json({ ok: true, data: { url: '/media/audio/0123456789abcdef.mp3' } }, { status: 201 });
    }
    if (path === '/media/audio/0123456789abcdef.mp3' && options.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Length': '18' } });
    }
    if (path === '/media/audio/1111111111111111.mp3' && options.method === 'HEAD') {
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const tool = await createBatchIngestServer({ fetchImpl: remoteFetch, profileStore: profileStore() });
  const mutationHeaders = { Origin: tool.url, 'X-Requested-With': 'FlareTuneIngest' };
  try {
    mutationHeaders['X-Ingest-CSRF'] = (await (await fetch(tool.url + '/api/state')).json()).csrf;
    const wrongOrigin = await fetch(tool.url + '/api/login', { method: 'POST',
      headers: { ...mutationHeaders, Origin: 'https://other.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', baseUrl: 'https://music.example', username: 'owner', password: 'pw' }) });
    assert.equal(wrongOrigin.status, 403);
    const login = await fetch(tool.url + '/api/login', { method: 'POST',
      headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', baseUrl: 'https://music.example', username: 'owner', password: 'pw' }) });
    assert.equal(login.status, 200);
    const { csrf } = await login.json();
    const Cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const catalog = await fetch(tool.url + '/api/catalog', { headers: { Cookie } });
    assert.equal((await catalog.json()).songs[0].id, 'old');
    const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(15)]);
    const upload = await fetch(tool.url + '/api/media/audio/0123456789abcdef.mp3?mode=worker', {
      method: 'PUT', headers: { ...mutationHeaders, Cookie, 'X-Ingest-CSRF': csrf,
        'Content-Type': 'audio/mpeg' }, body: audio,
    });
    assert.equal(upload.status, 200);
    assert.equal((await upload.json()).url, '/media/audio/0123456789abcdef.mp3');
    const mediaCall = seen.find((item) => item.method === 'PUT');
    assert.equal(mediaCall.headers.Cookie, 'ft_session=remote-session');
    assert.equal(mediaCall.headers['X-CSRF-Token'], 'remote-csrf');
    assert.equal(mediaCall.headers.Origin, 'https://music.example');
    const existingMedia = await fetch(tool.url + '/api/media/audio/0123456789abcdef.mp3', {
      method: 'HEAD', headers: { Cookie },
    });
    assert.equal(existingMedia.status, 200);
    assert.equal(existingMedia.headers.get('content-length'), '18');
    const absentMedia = await fetch(tool.url + '/api/media/audio/1111111111111111.mp3', {
      method: 'HEAD', headers: { Cookie },
    });
    assert.equal(absentMedia.status, 204);
  } finally { await tool.close(); }
});

test('R2 target changes, failed validation, direct upload and logout revoke local state', async () => {
  let destroyed = 0;
  let verified = 0;
  let directWrites = 0;
  const remoteFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/login') return new Response(JSON.stringify({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: 'admin-id' }, csrfToken: 'remote-csrf' }),
    { status: 200, headers: { 'Set-Cookie': 'ft_session=remote-session; HttpOnly' } });
    if (path === '/api/auth/logout') return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${path}`);
  };
  const tool = await createBatchIngestServer({ fetchImpl: remoteFetch, profileStore: profileStore(),
    makeR2Settings: ({ bucket }) => ({ bucket, prefix: 'media', client: { destroy: () => { destroyed += 1; } } }),
    verifyR2: async (config) => { verified += 1; if (config.bucket === 'wrong') throw new Error('wrong target'); },
    uploadDirect: async (_config, media) => {
      directWrites += 1;
      let bytes = 0;
      for await (const part of media.body) bytes += part.length;
      assert.equal(bytes, media.length);
      return { url: `/media/${media.kind}/${media.id}.${media.extension}` };
    },
  });
  const common = { Origin: tool.url, 'X-Requested-With': 'FlareTuneIngest' };
  try {
    common['X-Ingest-CSRF'] = (await (await fetch(tool.url + '/api/state')).json()).csrf;
    const login = await fetch(tool.url + '/api/login', { method: 'POST',
      headers: { ...common, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', baseUrl: 'https://music.example', username: 'owner', password: 'pw' }) });
    const { csrf } = await login.json();
    const Cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const auth = { ...common, Cookie, 'X-Ingest-CSRF': csrf };
    const config = async (bucket) => fetch(tool.url + '/api/r2/config', { method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket }) });
    assert.equal((await config('music')).status, 200);
    assert.equal((await (await fetch(tool.url + '/api/state', { headers: { Cookie } })).json()).r2Ready, true);
    assert.equal((await config('wrong')).status, 400);
    assert.equal(destroyed, 2);
    assert.equal((await (await fetch(tool.url + '/api/state', { headers: { Cookie } })).json()).r2Ready, false);
    assert.equal((await config('music')).status, 200);
    const body = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(15)]);
    const upload = await fetch(tool.url + '/api/media/audio/0123456789abcdef.mp3?mode=direct', {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'audio/mpeg' }, body,
    });
    assert.equal(upload.status, 200);
    assert.equal(directWrites, 1);
    const clear = await fetch(tool.url + '/api/r2/clear', { method: 'POST', headers: auth });
    assert.equal(clear.status, 200);
    assert.equal(destroyed, 3);
    const deniedUpload = await fetch(tool.url + '/api/media/audio/1111111111111111.mp3?mode=direct', {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'audio/mpeg' }, body,
    });
    assert.equal(deniedUpload.status, 400);
    assert.equal(directWrites, 1);
    assert.equal(verified, 3);
    assert.equal((await fetch(tool.url + '/api/logout', { method: 'POST', headers: auth })).status, 200);
    assert.equal((await (await fetch(tool.url + '/api/state', { headers: { Cookie } })).json()).loggedIn, false);
  } finally { await tool.close(); }
});

test('switching instances revokes the old session and sends catalog changes to the selected instance', async () => {
  const seen = [];
  let destroyed = 0;
  const fetchImpl = async (target, options) => {
    const url = new URL(target);
    seen.push({ host: url.host, path: url.pathname, method: options.method, body: options.body });
    if (url.pathname === '/api/auth/login') return new Response(JSON.stringify({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: url.host }, csrfToken: 'remote-csrf' }),
    { status: 200, headers: { 'Set-Cookie': 'ft_session=remote-session; HttpOnly' } });
    if (url.pathname === '/api/auth/logout') return Response.json({ ok: true });
    if (url.pathname === '/api/admin/catalog/songs' && options.method === 'GET') return Response.json({
      ok: true, data: { songs: [{ id: url.host, title: 'Song', version: 'a'.repeat(64) }], total: 1 },
    });
    if (url.pathname === '/api/admin/catalog/songs/song' && ['PUT', 'DELETE'].includes(options.method)) {
      return Response.json({ ok: true, data: { song: { title: 'Changed' }, deletedSongId: 'song' } });
    }
    throw new Error(`Unexpected ${url.pathname}`);
  };
  const tool = await createBatchIngestServer({ fetchImpl, profileStore: profileStore(),
    makeR2Settings: () => ({ bucket: 'b', prefix: 'media', client: { destroy: () => { destroyed += 1; } } }),
    verifyR2: async () => {},
  });
  try {
    const common = { Origin: tool.url, 'X-Requested-With': 'FlareTuneIngest',
      'Content-Type': 'application/json' };
    const appCsrf = (await (await fetch(tool.url + '/api/state')).json()).csrf;
    const login = async (name, address, Cookie, csrf) => {
      const response = await fetch(tool.url + '/api/login', { method: 'POST',
        headers: { ...common, 'X-Ingest-CSRF': csrf, ...(Cookie ? { Cookie } : {}) },
        body: JSON.stringify({ name, baseUrl: address, username: 'owner', password: 'pw' }) });
      assert.equal(response.status, 200);
      return { data: await response.json(), cookie: response.headers.get('set-cookie').split(';', 1)[0] };
    };
    const first = await login('one', 'https://one.example', null, appCsrf);
    const firstHeaders = { ...common, Cookie: first.cookie, 'X-Ingest-CSRF': first.data.csrf };
    assert.equal((await fetch(tool.url + '/api/r2/config', { method: 'POST', headers: firstHeaders,
      body: '{}' })).status, 200);
    const second = await login('two', 'https://two.example', first.cookie, first.data.csrf);
    assert.equal(destroyed, 1);
    assert.equal((await fetch(tool.url + '/api/catalog', { headers: { Cookie: first.cookie } })).status, 401);
    const secondHeaders = { ...common, Cookie: second.cookie, 'X-Ingest-CSRF': second.data.csrf };
    const catalog = await (await fetch(tool.url + '/api/catalog', { headers: { Cookie: second.cookie } })).json();
    assert.equal(catalog.songs[0].id, 'two.example');
    assert.equal((await fetch(tool.url + '/api/song/song', { method: 'PUT', headers: secondHeaders,
      body: JSON.stringify({ title: 'Changed', expectedVersion: 'a'.repeat(64) }) })).status, 200);
    assert.equal((await fetch(tool.url + '/api/song/song', { method: 'DELETE', headers: secondHeaders,
      body: JSON.stringify({ expectedVersion: 'a'.repeat(64) }) })).status, 200);
    const changes = seen.filter((item) => item.path === '/api/admin/catalog/songs/song');
    assert.equal(changes.length, 2);
    assert.ok(changes.every((item) => item.host === 'two.example'));
    assert.deepEqual(JSON.parse(changes[1].body), { expectedVersion: 'a'.repeat(64), confirmDelete: true });
  } finally { await tool.close(); }
});
