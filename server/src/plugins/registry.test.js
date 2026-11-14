import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fixture } from '../subsonic/test-support.js';
import { readInstallation, setInstalled, INSTALLATION_KEY } from './registry.js';
import { compiledPluginManifests } from '../../../shared/plugins/catalog.js';
import { canonicalPluginManifest } from '../../../shared/plugins/manifest.js';
import { pluginBuilds } from '../../../shared/plugins/build.generated.js';

async function app(t) { const f = await fixture(); t.after(() => f.close()); return f; }
const listed = (installed, revision, id = 'xiaomi-speaker') => ({ id, version: compiledPluginManifests.find(item => item.id === id).version, installed, revision,
  manifestDigest: createHash('sha256').update(canonicalPluginManifest(compiledPluginManifests.find(item => item.id === id))).digest('hex'),
  buildDigest: pluginBuilds.find(build => build.id === id).sourceDigest,
  availability: { available: installed, reason: installed ? null : 'not_installed',
    issues: installed ? [] : [{ code: 'not_installed', pluginId: id }], optionalFeatures: {} } });

test('compiled plugin is absent by default; only an explicit administrator installation exposes it to accounts', async t => {
  const f = await app(t);
  const initial = (await (await f.api('admin/plugins')).json()).plugins;
  assert.deepEqual(initial.map(({ id, installed, revision }) => ({ id, installed, revision })),
    compiledPluginManifests.map(({ id }) => ({ id, installed: false, revision: 0 })));
  assert.ok(initial.every(row => row.availability.available === false && row.availability.reason === 'not_installed'));
  assert.deepEqual(initial.find(row => row.id === 'xiaomi-speaker'), listed(false, 0));
  const member = await f.signIn('member');
  assert.deepEqual(await (await f.api('account/plugins', 'GET', undefined, member)).json(), { plugins: [] });
  for (const [path, method, body] of [['admin/plugins', 'GET'], ['admin/plugins/xiaomi-speaker', 'PUT', { installed: true, revision: 0 }]]) {
    assert.equal((await f.api(path, method, body, member)).status, 403);
  }
  const installed = await f.api('admin/plugins/xiaomi-speaker', 'PUT', { installed: true, revision: 0 });
  assert.equal(installed.status, 200);
  assert.deepEqual(await installed.json(), { plugin: listed(true, 1) });
  assert.deepEqual(await (await f.api('account/plugins', 'GET', undefined, member)).json(), { plugins: [listed(true, 1)] });
  const epoch = (await readInstallation(f.env)).epoch;
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 1 });
  assert.equal((await readInstallation(f.env)).epoch, epoch, 'same-state saves retain playback capabilities');
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: false, revision: 2 });
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 3 });
  assert.notEqual((await readInstallation(f.env)).epoch, epoch, 'a new installation has a new authority generation');
});

test('a new plugin installation captures its UI language and same-installation updates preserve it', async t => {
  const f = await app(t);
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 0 }, { uiLanguage: 'ja-JP' });
  const initial = await readInstallation(f.env), readSaved = () => JSON.parse(f.sqlite
    .prepare('SELECT value_json FROM instance_settings WHERE key=?').get(INSTALLATION_KEY).value_json);
  assert.equal(initial.uiLanguage, 'ja'); assert.equal(readSaved().uiLanguage, 'ja');
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 1 }, { uiLanguage: 'ko-KR' });
  assert.equal((await readInstallation(f.env)).uiLanguage, 'ja');
  assert.equal((await readInstallation(f.env)).epoch, initial.epoch);
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: false, revision: 2 }, { uiLanguage: 'en' });
  assert.equal(readSaved().uiLanguage, 'ja', 'uninstall retains metadata without treating another UI language as a reinstall');
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 3 }, { uiLanguage: 'ko-KR' });
  const reinstalled = await readInstallation(f.env);
  assert.equal(reinstalled.uiLanguage, 'ko'); assert.notEqual(reinstalled.epoch, initial.epoch);
});

test('legacy installed metadata stays unlabelled while an unknown new UI language safely becomes English', async t => {
  const f = await app(t);
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 0 });
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 1 }, { uiLanguage: 'ja' });
  assert.equal(Object.hasOwn(await readInstallation(f.env), 'uiLanguage'), false);
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: false, revision: 2 });
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 3 }, { uiLanguage: 'unknown' });
  assert.equal((await readInstallation(f.env)).uiLanguage, 'en');
});

test('the real installation HTTP action captures UI language from request metadata', async t => {
  const f = await app(t);
  const response = await f.api('admin/plugins/xiaomi-speaker', 'PUT', { installed: true, revision: 0 }, f.signed,
    { 'Accept-Language': 'zh-Hant-TW' });
  assert.equal(response.status, 200);
  assert.equal((await readInstallation(f.env)).uiLanguage, 'zh-Hant');
});

test('plugin mutation validates input, CSRF/account intent and revision without partial changes', async t => {
  const f = await app(t);
  for (const body of [{ installed: true }, { installed: 1, revision: 0 }, { installed: true, revision: -1 },
    { installed: true, revision: 0.5 }, { installed: true, revision: 0, url: 'https://untrusted.example/plugin.js' }]) {
    assert.equal((await f.api('admin/plugins/xiaomi-speaker', 'PUT', body)).status, 400);
  }
  const input = { installed: true, revision: 0 };
  assert.equal((await f.api('admin/plugins/xiaomi-speaker', 'PUT', input, f.signed, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.api('admin/plugins/xiaomi-speaker', 'PUT', input, f.signed, { 'X-FlareTune-Expected-Account': 'member' })).status, 409);
  assert.equal((await f.api('admin/plugins/unknown', 'PUT', input)).status, 404);
  assert.equal((await readInstallation(f.env)).revision, 0);
  const results = await Promise.all([f.api('admin/plugins/xiaomi-speaker', 'PUT', input), f.api('admin/plugins/xiaomi-speaker', 'PUT', input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await results.find(r => r.status === 409).json()).error, 'PLUGIN_REVISION_MISMATCH');
  assert.equal((await readInstallation(f.env)).revision, 1);
});

test('revocation or administrator demotion during an installation cannot write the setting', async t => {
  for (const action of ['logout', 'demote']) await t.test(action, async t => {
    const f = await app(t);
    const batch = f.db.batch.bind(f.db);
    f.db.batch = async statements => {
      if (action === 'logout') f.sqlite.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?').run(Date.now(), f.signed.session.tokenHash);
      else f.sqlite.prepare("UPDATE accounts SET role='member' WHERE account_id=?").run(f.owner);
      return batch(statements);
    };
    await assert.rejects(setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 0 }), { code: 'forbidden' });
    assert.equal((await readInstallation(f.env)).installed, false);
  });
});

test('malformed installation state fails closed and can be explicitly replaced using its revision', async t => {
  const f = await app(t);
  f.sqlite.prepare('INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by) VALUES (?,?,1,?,?)')
    .run(INSTALLATION_KEY, JSON.stringify({ installed: true }), Date.now(), f.owner);
  assert.deepEqual(await readInstallation(f.env), { installed: false, revision: 1, epoch: null });
  await setInstalled(f.env, f.signed.session, 'xiaomi-speaker', { installed: true, revision: 1 });
  assert.equal((await readInstallation(f.env)).installed, true);
});
