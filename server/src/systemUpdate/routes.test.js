import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../subsonic/test-support.js';

const buildToken = 'synthetic_route_update_token_12345678901234567890';
const deployHookUrl = 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/synthetic-route-hook-12345';

test('system-update administrator routes enforce real session, role, CSRF, same origin and expected account', async t => {
  const f = await fixture(); t.after(() => f.close());
  const anonymous = { cookie: '', session: { csrfToken: '' } }, member = await f.signIn('member');
  assert.equal((await f.api('admin/system-update', 'GET', undefined, anonymous)).status, 401);
  assert.equal((await f.api('admin/system-update', 'GET', undefined, member)).status, 403);
  const read = await f.api('admin/system-update'); assert.equal(read.status, 200);
  const state = await read.json(); assert.equal(state.configured, false); assert.equal(typeof state.current.sourceDigest, 'string');
  const verify = { revision: state.revision, taskId: '24ce29cf-3dfb-4fd5-922b-eca99a506b07' };
  assert.equal((await f.api('admin/system-update/verify', 'POST', verify, anonymous)).status, 401);
  assert.equal((await f.api('admin/system-update/verify', 'POST', verify, member)).status, 403);
  assert.equal((await f.api('admin/system-update/verify', 'POST', verify, f.signed, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await f.api('admin/system-update/verify', 'POST', verify)).status, 409);
  const body = { revision: state.revision, deployHookUrl, buildToken };
  for (const extra of [{ 'X-CSRF-Token': '' }, { Origin: 'https://untrusted.example' }]) {
    assert.equal((await f.api('admin/system-update', 'PUT', body, f.signed, extra)).status, 403);
  }
  assert.equal((await f.api('admin/system-update', 'PUT', body, f.signed, { 'X-FlareTune-Expected-Account': 'member' })).status, 409);
  const saved = await f.api('admin/system-update', 'PUT', body); assert.equal(saved.status, 200);
  const publicState = JSON.stringify(await saved.json()); assert.equal(publicState.includes(buildToken), false); assert.equal(publicState.includes(deployHookUrl), false);
});

test('system-update build namespace does not accept an administrator cookie as its capability', async t => {
  const f = await fixture(); t.after(() => f.close());
  const configured = await f.api('admin/system-update', 'PUT', { revision: 0, deployHookUrl, buildToken });
  assert.equal(configured.status, 200);
  assert.equal((await f.api('system-update/plan')).status, 403);
  const noTask = await f.api('system-update/plan', 'GET', undefined, f.signed, { Authorization: `Bearer ${buildToken}` });
  assert.equal(noTask.status, 404); assert.equal((await noTask.json()).error, 'SYSTEM_UPDATE_JOB_UNAVAILABLE');
  assert.equal((await f.api('system-update/anything', 'POST', { sql: 'SELECT * FROM accounts' }, f.signed,
    { Authorization: `Bearer ${buildToken}` })).status, 404);
});
