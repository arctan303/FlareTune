import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBatchIngestServer } from './server.mjs';
import { request as httpRequest } from 'node:http';
const profileStore = () => {
  const values = [];
  return { list: async () => values,
    save: async (data) => { const profile = { id: String(values.length + 1), name: data.name, baseUrl: data.baseUrl,
      username: data.username, savedPassword: false }; values.push(profile); return { profile, warning: '' }; },
  };
};

test('malformed literal request targets return 400 and the local server survives', async () => {
  const tool = await createBatchIngestServer({ profileStore: profileStore() });
  try {
    for (const path of ['//[', '//[invalid']) {
      const status = await new Promise((resolve, reject) => {
        const request = httpRequest(tool.url, { path }, (response) => {
          response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject); request.end();
      });
      assert.equal(status, 400);
    }
    const healthy = await fetch(`${tool.url}/api/state`);
    assert.equal(healthy.status, 200);
    assert.ok((await healthy.json()).csrf);
  } finally { await tool.close(); }
});

test('local directory scanning and uploads require the current local admin session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flaretune-local-http-'));
  const zh = join(root, 'zh');
  const path = join(zh, 'song.mp3');
  await mkdir(zh);
  await writeFile(path, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]));
  let received = 0;
  const remoteFetch = async (target, options) => {
    const route = new URL(target).pathname;
    if (route === '/api/auth/login') return Response.json({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: 'admin-id' }, csrfToken: 'remote-csrf' },
    { headers: { 'Set-Cookie': '__Host-ft_session=remote-session; Secure; HttpOnly' } });
    if (route === '/api/admin/catalog/media/audio/0123456789abcdef.mp3') {
      for await (const chunk of options.body) received += chunk.length;
      return Response.json({ ok: true, data: { url: '/media/audio/0123456789abcdef.mp3' } }, { status: 201 });
    }
    throw new Error(`Unexpected ${route}`);
  };
  const tool = await createBatchIngestServer({ fetchImpl: remoteFetch, profileStore: profileStore() });
  try {
    const headers = { Origin: tool.url, 'X-Requested-With': 'FlareTuneIngest', 'Content-Type': 'application/json' };
    headers['X-Ingest-CSRF'] = (await (await fetch(tool.url + '/api/state')).json()).csrf;
    const anonymous = await fetch(tool.url + '/api/local-folder/scan', { method: 'POST', headers,
      body: JSON.stringify({ path: root }) });
    assert.equal(anonymous.status, 401);
    const login = await fetch(tool.url + '/api/login', { method: 'POST', headers,
      body: JSON.stringify({ name: 'Test', baseUrl: 'https://music.example', username: 'owner', password: 'pw' }) });
    headers.Cookie = login.headers.get('set-cookie').split(';', 1)[0];
    headers['X-Ingest-CSRF'] = (await login.json()).csrf;
    const scan = await fetch(tool.url + '/api/local-folder/scan', { method: 'POST', headers,
      body: JSON.stringify({ path: root }) });
    assert.equal(scan.status, 200);
    const fileId = (await scan.json()).files[0].id;
    assert.equal((await fetch(`${tool.url}/api/local-file/${fileId}/audio`)).status, 401);
    const preview = await fetch(`${tool.url}/api/local-file/${fileId}/audio`, { headers: { Cookie: headers.Cookie, Range: 'bytes=0-2' } });
    assert.equal(preview.status, 206);
    assert.equal(await preview.text(), 'ID3');
    const suffix = await fetch(`${tool.url}/api/local-file/${fileId}/audio`, {
      headers: { Cookie: headers.Cookie, Range: 'bytes=-2' },
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), 'bytes 41-42/43');
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), Buffer.alloc(2));
    assert.equal((await fetch(`${tool.url}/api/local-file/${fileId}/audio`, {
      headers: { Cookie: headers.Cookie, Range: 'bytes=-0' },
    })).status, 416);
    const upload = await fetch(`${tool.url}/api/local-file/${fileId}/upload/audio/0123456789abcdef`, {
      method: 'POST', headers, body: JSON.stringify({ mode: 'worker' }),
    });
    assert.equal(upload.status, 200);
    assert.match(await upload.text(), /"result":\{"url":"\/media\/audio\/0123456789abcdef\.mp3"\}/);
    assert.equal(received, 43);
    const logout = await fetch(tool.url + '/api/logout', { method: 'POST', headers, body: '{}' });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${tool.url}/api/local-file/${fileId}/audio`, { headers: { Cookie: headers.Cookie } })).status, 401);
  } finally { await tool.close(); await unlink(path); await rmdir(zh); await rmdir(root); }
});

test('logout waits for an in-flight local upload and revokes its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flaretune-retire-'));
  const path = join(root, 'song.mp3');
  await writeFile(path, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]));
  let startedResolve, releaseUpload;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const gate = new Promise((resolve) => { releaseUpload = resolve; });
  let written = 0;
  const remoteFetch = async (target, options) => {
    const route = new URL(target).pathname;
    if (route === '/api/auth/login') return Response.json({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: 'admin-id' }, csrfToken: 'remote-csrf' },
    { headers: { 'Set-Cookie': '__Host-ft_session=remote-session; Secure; HttpOnly' } });
    if (route === '/api/admin/catalog/media/audio/0123456789abcdef.mp3') {
      startedResolve();
      await gate;
      for await (const chunk of options.body) written += chunk.length;
      return Response.json({ ok: true, data: { url: '/media/audio/0123456789abcdef.mp3' } }, { status: 201 });
    }
    if (route === '/api/auth/logout') return Response.json({ ok: true });
    throw new Error(`Unexpected ${route}`);
  };
  const tool = await createBatchIngestServer({ fetchImpl: remoteFetch, profileStore: profileStore() });
  try {
    const headers = { Origin: tool.url, 'X-Requested-With': 'FlareTuneIngest', 'Content-Type': 'application/json' };
    headers['X-Ingest-CSRF'] = (await (await fetch(tool.url + '/api/state')).json()).csrf;
    const login = await fetch(tool.url + '/api/login', { method: 'POST', headers,
      body: JSON.stringify({ name: 'Test', baseUrl: 'https://music.example', username: 'owner', password: 'pw' }) });
    headers.Cookie = login.headers.get('set-cookie').split(';', 1)[0];
    headers['X-Ingest-CSRF'] = (await login.json()).csrf;
    const scan = await fetch(tool.url + '/api/local-folder/scan', { method: 'POST', headers,
      body: JSON.stringify({ path: root }) });
    const id = (await scan.json()).files[0].id;
    const upload = fetch(`${tool.url}/api/local-file/${id}/upload/audio/0123456789abcdef`, {
      method: 'POST', headers, body: JSON.stringify({ mode: 'worker' }),
    });
    await started;
    let loggedOut = false;
    const logout = fetch(tool.url + '/api/logout', { method: 'POST', headers, body: '{}' })
      .then((response) => { loggedOut = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(loggedOut, false);
    releaseUpload();
    assert.match(await (await upload).text(), /上传已取消|This operation was aborted/);
    assert.equal((await logout).status, 200);
    assert.equal(written, 0);
    assert.equal((await fetch(`${tool.url}/api/local-file/${id}/audio`, { headers: { Cookie: headers.Cookie } })).status, 401);
  } finally { await tool.close(); await unlink(path); await rmdir(root); }
});

test('local login, admin catalog and streamed Worker upload obey both session boundaries', async () => {
  const seen = [];
  const remoteFetch = async (url, options) => {
    const path = new URL(url).pathname;
    seen.push({ path, method: options.method, headers: options.headers });
    if (path === '/api/auth/login') return new Response(JSON.stringify({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: 'admin-id' }, csrfToken: 'remote-csrf' }),
    { status: 200, headers: { 'Set-Cookie': '__Host-ft_session=remote-session; Path=/; Secure; HttpOnly' } });
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
    if (path === '/media/cover/0123456789abcdef.jpg' && options.method === 'GET') {
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200,
        headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (path === '/media/audio/0123456789abcdef.mp3' && options.method === 'GET') {
      assert.equal(options.headers.Range, 'bytes=0-2');
      return new Response(Buffer.from('ID3'), { status: 206,
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-2/18', 'Content-Length': '3' } });
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
    assert.equal(mediaCall.headers.Cookie, '__Host-ft_session=remote-session');
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
    const anonymousCover = await fetch(tool.url + '/api/cover/1/0123456789abcdef.jpg');
    assert.equal(anonymousCover.status, 401);
    const cover = await fetch(tool.url + '/api/cover/1/0123456789abcdef.jpg', { headers: { Cookie } });
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('content-type'), 'image/jpeg');
    assert.equal(cover.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await cover.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.equal(seen.find((item) => item.path === '/media/cover/0123456789abcdef.jpg').headers.Cookie,
      '__Host-ft_session=remote-session');
    assert.equal((await fetch(tool.url + '/api/cover/2/0123456789abcdef.jpg', { headers: { Cookie } })).status, 403);
    assert.equal((await fetch(tool.url + '/api/cover/1/0123456789abcdef.svg', { headers: { Cookie } })).status, 404);
    assert.equal((await fetch(tool.url + '/api/audio/1/0123456789abcdef.mp3',
      { headers: { Range: 'bytes=0-2' } })).status, 401);
    const preview = await fetch(tool.url + '/api/audio/1/0123456789abcdef.mp3',
      { headers: { Cookie, Range: 'bytes=0-2' } });
    assert.equal(preview.status, 206);
    assert.equal(preview.headers.get('content-range'), 'bytes 0-2/18');
    assert.equal(await preview.text(), 'ID3');
    assert.equal((await fetch(tool.url + '/api/audio/2/0123456789abcdef.mp3',
      { headers: { Cookie, Range: 'bytes=0-2' } })).status, 403);
  } finally { await tool.close(); }
});

test('local tool exposes upstream 503 separately from its own request status', async () => {
  const remoteFetch = async (url) => new URL(url).pathname === '/api/auth/login'
    ? Response.json({ authenticated: true, user: { role: 'admin', username: 'owner', accountId: 'admin-id' },
      csrfToken: 'remote-csrf' }, { headers: { 'Set-Cookie': '__Host-ft_session=remote-session; Secure' } })
    : Response.json({ error: 'service_unavailable' }, { status: 503 });
  const tool = await createBatchIngestServer({ fetchImpl: remoteFetch, profileStore: profileStore() });
  try {
    const csrf = (await (await fetch(tool.url + '/api/state')).json()).csrf;
    const login = await fetch(tool.url + '/api/login', { method: 'POST',
      headers: { Origin: tool.url, 'X-Requested-With': 'FlareTuneIngest',
        'X-Ingest-CSRF': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', baseUrl: 'https://music.example', username: 'owner', password: 'pw' }) });
    assert.equal(login.status, 200);
    const response = await fetch(tool.url + '/api/song/song-1', {
      headers: { Cookie: login.headers.get('set-cookie').split(';', 1)[0] },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Could not read the song (503).', upstreamStatus: 503 });
  } finally { await tool.close(); }
});

test('local deletion preview and confirmed cleanup use the current admin session', async () => {
  const seen = [];
  const digest = 'a'.repeat(64);
  const remoteFetch = async (target, options) => {
    const path = new URL(target).pathname;
    if (path === '/api/auth/login') return new Response(JSON.stringify({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: 'admin-id' }, csrfToken: 'remote-csrf' }),
    { headers: { 'Set-Cookie': '__Host-ft_session=remote-session; Path=/; Secure; HttpOnly' } });
    seen.push({ path, options });
    if (path === '/api/admin/catalog/delete-preview') return Response.json({ code: 200,
      data: { songs: [{ id: 'song-1' }], impact_digest: digest } });
    if (path === '/api/admin/catalog/delete') return Response.json({ code: 207,
      data: { deleted_ids: ['song-1'], media: { failures: [{ path: 'audio/1.mp3' }] } } }, { status: 207 });
    throw new Error(`Unexpected ${path}`);
  };
  const tool = await createBatchIngestServer({ fetchImpl: remoteFetch, profileStore: profileStore() });
  try {
    const mutation = { Origin: tool.url, 'X-Requested-With': 'FlareTuneIngest',
      'Content-Type': 'application/json' };
    mutation['X-Ingest-CSRF'] = (await (await fetch(tool.url + '/api/state')).json()).csrf;
    const guest = await fetch(`${tool.url}/api/song/song-1/delete-preview`, { method: 'POST', headers: mutation, body: '{}' });
    assert.equal(guest.status, 401);
    const login = await fetch(tool.url + '/api/login', { method: 'POST', headers: mutation,
      body: JSON.stringify({ name: 'Test', baseUrl: 'https://music.example', username: 'owner', password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    mutation['X-Ingest-CSRF'] = (await login.json()).csrf;
    mutation.Cookie = cookie;
    const preview = await fetch(`${tool.url}/api/song/song-1/delete-preview`, { method: 'POST', headers: mutation, body: '{}' });
    assert.equal((await preview.json()).impact_digest, digest);
    const denied = await fetch(`${tool.url}/api/song/song-1/delete-with-impact`, { method: 'POST',
      headers: { ...mutation, Origin: 'https://other.example' },
      body: JSON.stringify({ impactDigest: digest, deleteMedia: true }) });
    assert.equal(denied.status, 403);
    const result = await fetch(`${tool.url}/api/song/song-1/delete-with-impact`, { method: 'POST',
      headers: mutation, body: JSON.stringify({ impactDigest: digest, deleteMedia: true }) });
    assert.deepEqual(await result.json(), { status: 207, code: 207,
      data: { deleted_ids: ['song-1'], media: { failures: [{ path: 'audio/1.mp3' }] } } });
    assert.deepEqual(seen.map((item) => item.path), ['/api/admin/catalog/delete-preview', '/api/admin/catalog/delete']);
    assert.ok(seen.every((item) => item.options.headers.Cookie === '__Host-ft_session=remote-session'
      && item.options.headers['X-CSRF-Token'] === 'remote-csrf'));
    assert.deepEqual(JSON.parse(seen[1].options.body), { ids: ['song-1'], delete_media: true, impact_digest: digest });
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
    { status: 200, headers: { 'Set-Cookie': '__Host-ft_session=remote-session; Path=/; Secure; HttpOnly' } });
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
    { status: 200, headers: { 'Set-Cookie': '__Host-ft_session=remote-session; Path=/; Secure; HttpOnly' } });
    if (url.pathname === '/api/auth/logout') return Response.json({ ok: true });
    if (url.pathname === '/media/cover/0123456789abcdef.jpg') return new Response(Buffer.from([0xff, 0xd8]),
      { headers: { 'Content-Type': 'image/jpeg' } });
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
    const oldCoverPath = '/api/cover/1/0123456789abcdef.jpg';
    assert.equal((await fetch(tool.url + oldCoverPath, { headers: { Cookie: first.cookie } })).status, 200);
    assert.equal((await fetch(tool.url + '/api/r2/config', { method: 'POST', headers: firstHeaders,
      body: '{}' })).status, 200);
    const second = await login('two', 'https://two.example', first.cookie, first.data.csrf);
    assert.equal(destroyed, 1);
    assert.equal((await fetch(tool.url + '/api/catalog', { headers: { Cookie: first.cookie } })).status, 401);
    assert.equal((await fetch(tool.url + oldCoverPath, { headers: { Cookie: first.cookie } })).status, 401);
    assert.equal((await fetch(tool.url + oldCoverPath, { headers: { Cookie: second.cookie } })).status, 403);
    assert.equal((await fetch(tool.url + '/api/cover/2/0123456789abcdef.jpg',
      { headers: { Cookie: second.cookie } })).status, 200);
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
