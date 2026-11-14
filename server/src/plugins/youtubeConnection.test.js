import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../subsonic/test-support.js';
import { pluginRegistry } from './registry.js';
import { readYouTubeConnection, saveYouTubeConnection, getYouTubeBinding,
  publicYouTubeStatus, sealYouTubeConnection, openYouTubeConnection, YOUTUBE_CONNECTION_KEY } from './youtubeConnection.js';
import { createYouTubeHandler } from './youtubeAdmin.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';

const credentials = { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret', refreshToken: 'synthetic-refresh-token' };
async function app(t) {
  const f = await fixture(); t.after(() => f.close());
  await pluginRegistry.setInstalled(f.env, f.signed.session, 'youtube-music', { installed: true, revision: 0 });
  return f;
}
test('one encrypted instance binding is administrator-only, absent from public status and not a catalog row', async t => {
  const f = await app(t), before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM Songs').get().n;
  const record = await readYouTubeConnection(f.env);
  const saved = await saveYouTubeConnection(f.env, f.signed.session, record, { binding: { id: 'one-binding', credentials, connectedAt: '2026-11-06T00:00:00Z' } });
  assert.equal((await getYouTubeBinding(f.env)).credentials.refreshToken, credentials.refreshToken);
  assert.equal(publicYouTubeStatus(saved).connected, true);
  const persisted = f.sqlite.prepare('SELECT value_json FROM instance_settings WHERE key=?').get(YOUTUBE_CONNECTION_KEY).value_json;
  for (const value of Object.values(credentials)) {
    assert.equal(persisted.includes(value), false); assert.equal(JSON.stringify(publicYouTubeStatus(saved)).includes(value), false);
  }
  const member = await f.signIn('member');
  await assert.rejects(saveYouTubeConnection(f.env, member.session, saved, {}), { code: 'forbidden' });
  await assert.rejects(saveYouTubeConnection(f.env, f.signed.session, record, {}), { code: 'YOUTUBE_CONNECTION_CHANGED' });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM Songs').get().n, before);
});
test('disconnect rotates authority; uninstall/reinstall cannot reactivate retained account credentials', async t => {
  const f = await app(t);
  const saved = await saveYouTubeConnection(f.env, f.signed.session, await readYouTubeConnection(f.env), { binding: { id: 'one', credentials } });
  const binding = await getYouTubeBinding(f.env);
  await saveYouTubeConnection(f.env, f.signed.session, saved, {});
  await assert.rejects(getYouTubeBinding(f.env), { code: 'YOUTUBE_NOT_CONNECTED' });
  const second = await saveYouTubeConnection(f.env, f.signed.session, await readYouTubeConnection(f.env), { binding: { id: 'two', credentials } });
  assert.notEqual((await getYouTubeBinding(f.env)).epoch, binding.epoch);
  await pluginRegistry.setInstalled(f.env, f.signed.session, 'youtube-music', { installed: false, revision: 1 });
  await assert.rejects(getYouTubeBinding(f.env), { code: 'PLUGIN_NOT_INSTALLED' });
  await pluginRegistry.setInstalled(f.env, f.signed.session, 'youtube-music', { installed: true, revision: 2 });
  await assert.rejects(getYouTubeBinding(f.env), { code: 'YOUTUBE_NOT_CONNECTED' });
  await assert.rejects(saveYouTubeConnection(f.env, f.signed.session, second, {}), { code: 'PLUGIN_NOT_INSTALLED' });
});
test('connection encryption detects tampering and different deployment secrets', async () => {
  const env = { SETUP_SECRET: 'synthetic-original-setup-secret-32-characters' };
  const encrypted = await sealYouTubeConnection(env, { binding: { credentials } });
  assert.equal((await openYouTubeConnection(env, encrypted)).binding.credentials.refreshToken, credentials.refreshToken);
  const [iv, body] = encrypted.split('.');
  await assert.rejects(openYouTubeConnection(env, `${iv}.${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`));
  await assert.rejects(openYouTubeConnection({ SETUP_SECRET: 'synthetic-different-setup-secret-32-characters' }, encrypted));
});
test('administrator import validates OAuth before CAS; member cannot call even account plugin namespace', async t => {
  const f = await app(t), record = await readYouTubeConnection(f.env); let validations = 0;
  const handler = createYouTubeHandler(f.env, f.signed.session, { createService: () => ({ validateAuth: async () => { validations++; } }) });
  const json = (data, status = 200) => Response.json(data, { status });
  const context = { identity: { role: 'admin' }, plugin: { epoch: record.epoch } };
  const request = new Request('https://test.example/api/admin/plugins/youtube-music/connection/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 0, credentials }) });
  assert.equal((await handler({ request: request.clone(), path: '/connection/import', scope: 'account', context, json })).status, 403);
  const response = await handler({ request, path: '/connection/import', scope: 'admin', context, json });
  assert.equal(response.status, 200); assert.equal(validations, 1);
  assert.equal((await response.json()).connected, true);
});

test('public Worker dispatch enforces session, administrator, CSRF and build before connection changes', async t => {
  const f = await app(t), member = await f.signIn('member');
  const digest = pluginBuilds.find(item => item.id === 'youtube-music').sourceDigest;
  const headers = { 'X-FlareTune-Plugin-Build': digest };
  assert.equal((await f.api('admin/plugins/youtube-music/status', 'GET', undefined, member, headers)).status, 403);
  assert.equal((await f.api('account/plugins/youtube-music/status', 'GET', undefined, member, headers)).status, 403);
  assert.equal((await f.api('admin/plugins/youtube-music/status', 'GET', undefined, f.signed, headers)).status, 200);
  assert.equal((await f.api('admin/plugins/youtube-music/connection/disconnect', 'POST', { revision: 0 }, f.signed,
    { ...headers, 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await f.api('admin/plugins/youtube-music/connection/disconnect', 'POST', { revision: 0 }, f.signed,
    { ...headers, 'X-FlareTune-Plugin-Build': 'stale' })).status, 409);
  assert.equal((await readYouTubeConnection(f.env)).revision, 0);
});
