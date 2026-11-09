import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoamHandler } from './handler.js';
import { createRoamCatalog } from './catalog.js';
import { handlePluginApi } from '../../routes/plugins.js';
import { BUILD_DIGEST, SAMPLE_BODY, SAMPLE_PATHS, roamFixture } from './test-support.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function sample(f, path, { session = f.signed.session, body = SAMPLE_BODY, build = BUILD_DIGEST, catalog } = {}) {
  const request = new Request(`https://test.example${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(build === null ? {} : { 'X-FlareTune-Plugin-Build': build }) },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return handlePluginApi(request, path, f.env, session, json, { registry: f.registry,
    handlers: { roam: createRoamHandler(f.env, session, catalog ? { catalog } : {}) } });
}
const sampledCatalog = f => f.db.queries.some(sql => /FROM Songs\b/u.test(sql));

test('new and legacy roam URLs require manual installation, a live identity and the current build', async t => {
  const f = await roamFixture(t);
  const member = await f.signIn('member');
  assert.equal((await f.registry.readInstallation(f.env, 'roam')).installed, false);
  await assert.rejects(f.registry.setInstalled(f.env, member.session, 'roam', { installed: true, revision: 0 }), { code: 'forbidden' });
  for (const path of SAMPLE_PATHS) {
    for (const session of [f.signed.session, member.session]) {
      f.db.queries.length = 0;
      const response = await sample(f, path, { session });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'PLUGIN_NOT_INSTALLED' });
      assert.equal(sampledCatalog(f), false);
    }
    assert.equal((await sample(f, path, { session: null })).status, 403);
  }
  await f.install();
  const noBuildRegistry = { ...f.registry, getBuildDigest: () => null };
  const request = new Request('https://test.example/api/songs/roam', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SAMPLE_BODY) });
  assert.equal((await handlePluginApi(request, '/api/songs/roam', f.env, f.signed.session, json,
    { registry: noBuildRegistry })).status, 409, 'a missing compiled fingerprint never enables a headless compatibility path');
  for (const path of SAMPLE_PATHS) {
    for (const session of [f.signed.session, member.session]) {
      const response = await sample(f, path, { session });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.code, 200);
      assert.equal(result.data.strategy, 'recent');
      assert.equal(result.data.songs.length, 2);
    }
    for (const build of [null, 'old-build']) {
      f.db.queries.length = 0;
      const response = await sample(f, path, { build });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'PLUGIN_BUILD_MISMATCH' });
      assert.equal(sampledCatalog(f), false);
    }
  }
  await f.install(false);
  for (const path of SAMPLE_PATHS) assert.equal((await sample(f, path)).status, 409);
});

test('plugin role declarations and revoked credentials cannot be bypassed by either URL', async t => {
  const f = await roamFixture(t, { roles: ['admin'] });
  const member = await f.signIn('member');
  await f.install();
  for (const path of SAMPLE_PATHS) assert.equal((await sample(f, path, { session: member.session })).status, 403);
  f.sqlite.exec('DELETE FROM account_sessions');
  for (const path of SAMPLE_PATHS) assert.equal((await sample(f, path)).status, 403);
});

test('an in-flight batch cannot escape uninstall/reinstall, role changes or logout', async t => {
  for (const path of SAMPLE_PATHS) for (const change of ['reinstall', 'logout', 'role']) {
    await t.test(`${path}: ${change}`, async t => {
      const f = await roamFixture(t);
      await f.install();
      const delegate = createRoamCatalog(f.db);
      const catalog = { ...delegate, async sampleRecent(options) {
        const result = await delegate.sampleRecent(options);
        if (change === 'reinstall') { await f.install(false); await f.install(); }
        if (change === 'logout') f.sqlite.exec('DELETE FROM account_sessions');
        if (change === 'role') f.sqlite.prepare('UPDATE accounts SET status=? WHERE account_id=?').run('disabled', f.owner);
        return result;
      } };
      const response = await sample(f, path, { catalog });
      assert.equal(response.status, change === 'reinstall' ? 409 : 403);
      assert.equal(Object.hasOwn(await response.json(), 'data'), false);
    });
  }
});

test('invalid plugin payloads fail before catalog reads and never expose parser details', async t => {
  const f = await roamFixture(t);
  await f.install();
  for (const body of [null, [], 'not-json', { seenSongIds: 's1' }, { seenSongIds: [], language: 'unknown' },
    { ...SAMPLE_BODY, limit: 51 }, { ...SAMPLE_BODY, recentSongIds: ['\u0000'] }, { ...SAMPLE_BODY, queuedSongIds: Array(5001).fill('s1') },
    { ...SAMPLE_BODY, padding: 'x'.repeat(1024 * 1024) }]) {
    f.db.queries.length = 0;
    const response = await sample(f, SAMPLE_PATHS[0], { body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 400, error: 'invalid_input', message: 'Invalid roam parameters' });
    assert.equal(sampledCatalog(f), false);
  }
});
