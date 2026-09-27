import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteCatalog } from './remote.mjs';

test('admin login accepts the current secure Worker session cookie and forwards it', async () => {
  const requests = [];
  const remote = new RemoteCatalog('https://music.example', async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/auth/login')) return Response.json({ authenticated: true,
      user: { role: 'admin', username: 'owner', accountId: 'account-1' }, csrfToken: 'csrf-1' },
    { headers: { 'Set-Cookie': '__Host-ft_session=session-1; Path=/; Secure; HttpOnly; SameSite=Strict' } });
    if (url.includes('/api/admin/catalog/songs')) return Response.json({
      ok: true, data: { songs: [], total: 0 },
    });
    throw new Error(`Unexpected request: ${url}`);
  });
  assert.equal((await remote.login('owner', 'password')).accountId, 'account-1');
  assert.deepEqual(await remote.listSongs(), []);
  assert.equal(requests[1].options.headers.Cookie, '__Host-ft_session=session-1');
});

test('login rejects a response without the secure session cookie', async () => {
  const remote = new RemoteCatalog('https://music.example', async () => Response.json({ authenticated: true,
    user: { role: 'admin', username: 'owner', accountId: 'account-1' }, csrfToken: 'csrf-1' },
  { headers: { 'Set-Cookie': 'ft_session=legacy-token; Path=/; HttpOnly' } }));
  await assert.rejects(remote.login('owner', 'password'), /可用的管理员会话/);
});
