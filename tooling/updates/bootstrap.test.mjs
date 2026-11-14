import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { canonical, sha256 } from '../../server/src/systemUpdate/common.js';
import { createPluginHostBuild } from '../plugins/host-identity.mjs';
import { sanitizedBuildEnvironment, verifySourceCheckout, buildSystemUpdate, runSystemUpdate, runBuildCommand } from './bootstrap.mjs';
import { fetchUpdatePlan, updateConnection, withUpdateLease, reportUpdate } from './protocol.mjs';

const TASK = '895c1cb8-cea8-4f32-abf7-b324191005c8';
const environment = { FLARETUNE_SYSTEM_UPDATE_SITE_URL: 'https://music.example.net',
  FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN: 'synthetic-build-token-not-a-real-secret',
  FLARETUNE_SYSTEM_UPDATE_WORKER_NAME: 'synthetic-worker', FLARETUNE_SYSTEM_UPDATE_WORKER_TAG: 'd'.repeat(32),
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-provider-token-123456', WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' };
async function makePlan() {
  const target = { schemaVersion: 1, id: `1.3.0:${'e'.repeat(40)}`, version: '1.3.0', commit: 'e'.repeat(40),
    host: { version: '1.3.0', sourceDigest: 'f'.repeat(64) }, hostApiVersion: 5, minVersion: '1.3.0', notes: { zh: '更新', en: 'Update' },
    source: { url: 'https://github.com/arctan303/FlareTune/releases/download/1.3.0/flaretune-source.tar.gz', sha256: '1'.repeat(64) },
    migration: { compatible: true }, channel: 'stable' };
  const plan = { schemaVersion: 1, taskId: TASK, status: 'queued', from: { host: { version: '1.3.0', sourceDigest: '2'.repeat(64) }, hostApiVersion: 5 },
    target, plugins: [], receipt: null, revision: 1 };
  plan.planDigest = await sha256(canonical({ from: plan.from, target: plan.target, plugins: plan.plugins })); return plan;
}
async function directory(t) {
  const path = await mkdtemp(resolve(tmpdir(), 'flaretune-system-bootstrap-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('compilation inherits a narrow non-secret environment and only the confirmed commit', () => {
  const build = sanitizedBuildEnvironment({ PATH: '/synthetic/bin', HOME: '/synthetic/home', ...environment,
    FLARETUNE_PLUGIN_BUILD_TOKEN: 'another-synthetic-secret', GITHUB_TOKEN: 'synthetic-github-secret', NODE_OPTIONS: '--require attacker.js',
    npm_config_registry: 'https://attacker.example.net' }, 'e'.repeat(40));
  assert.equal(build.PATH, '/synthetic/bin'); assert.equal(build.FLARETUNE_UPDATE_COMMIT, 'e'.repeat(40));
  assert.equal(build.CI, 'true');
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN', 'FLARETUNE_PLUGIN_BUILD_TOKEN',
    'GITHUB_TOKEN', 'NODE_OPTIONS', 'npm_config_registry', 'WRANGLER_CI_OVERRIDE_NAME']) assert.equal(Object.hasOwn(build, key), false);
});
test('official source identity and locked capability are checked against real checkout bytes', async t => {
  const root = await directory(t); await mkdir(resolve(root, 'server/src'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), '{"type":"module","version":"1.3.0"}');
  await writeFile(resolve(root, 'server/src/main.js'), 'export const value = 42;');
  const host = await createPluginHostBuild(root); await writeFile(resolve(root, 'plugins.lock.json'), JSON.stringify({ host, hostApiVersion: 5 }));
  assert.deepEqual(await verifySourceCheckout(root, { host, hostApiVersion: 5 }), host);
  await writeFile(resolve(root, 'server/src/main.js'), 'export const value = 43;');
  await assert.rejects(verifySourceCheckout(root, { host, hostApiVersion: 5 }), { code: 'SYSTEM_UPDATE_HOST_MISMATCH' });
});
test('the build executes the fixed trusted preparation, lock, runtime and asset sequence without HTTP commands', async t => {
  const root = await directory(t), plan = await makePlan(), calls = []; let verified = 0;
  plan.command = 'curl attacker'; // Extra source material never selects a command.
  await buildSystemUpdate(plan, { root, environment,
    downloadImpl: async target => { assert.equal(target.commit, plan.target.commit); return Buffer.from('synthetic'); },
    extractImpl: async () => {}, verifySourceImpl: async () => { verified++; },
    runCommandImpl: async (cwd, command, args, env) => {
      assert.equal(cwd, root); assert.equal(env.CLOUDFLARE_API_TOKEN, undefined); assert.equal(env.FLARETUNE_UPDATE_COMMIT, plan.target.commit);
      calls.push([command, ...args]);
    } });
  assert.deepEqual(calls.map(row => row.slice(0, 3)), [['npm', 'ci'], ['npm', 'run', 'plugins:hydrate'],
    ['node', 'tooling/build/system-update-runtime.mjs', 'prepare'], ['npm', 'run', 'plugins:lock'],
    ['node', 'tooling/build/system-update-runtime.mjs', 'generate'], ['npm', 'run', 'build']]);
  assert.equal(verified, 2); assert.equal(JSON.stringify(calls).includes('curl attacker'), false);
  await assert.rejects(stat(resolve(root, '.system-update-plan.json')), { code: 'ENOENT' });
});
test('failed compilation removes its private plan input and stops before later steps', async t => {
  const root = await directory(t), plan = await makePlan(); let calls = 0;
  await assert.rejects(buildSystemUpdate(plan, { root, environment, downloadImpl: async () => Buffer.from('x'), extractImpl: async () => {},
    verifySourceImpl: async () => {}, runCommandImpl: async () => { calls++; throw Error('synthetic build failure'); } }));
  assert.equal(calls, 1); await assert.rejects(stat(resolve(root, '.system-update-plan.json')), { code: 'ENOENT' });
});
test('no confirmed task is a safe idle result with no provider call or build', async () => {
  const result = await runSystemUpdate({ environment,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'SYSTEM_UPDATE_JOB_UNAVAILABLE' }), { status: 404 }),
    buildImpl: async () => assert.fail('No task must not build'), deployImpl: async () => assert.fail('No task must not deploy'),
    verifyTargetImpl: async () => assert.fail('No task must not request provider') });
  assert.deepEqual(result, { status: 'idle' });
});
test('the real HTTP plan transport preserves authentication and validates the decoded frozen plan', async t => {
  const plan = await makePlan(), requests = [];
  const server = createServer((request, reply) => {
    requests.push({ path: request.url, token: request.headers.authorization });
    reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(plan));
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise(accept => server.close(accept)));
  const address = server.address();
  const fetchImpl = (url, options) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, options);
  assert.equal((await fetchUpdatePlan(updateConnection(environment), { fetchImpl })).taskId, TASK);
  assert.deepEqual(requests, [{ path: '/api/system-update/plan', token: `Bearer ${environment.FLARETUNE_SYSTEM_UPDATE_BUILD_TOKEN}` }]);
});
test('lost lease heartbeat aborts a long-running real child process', async t => {
  const root = await directory(t), plan = await makePlan(), connection = updateConnection(environment); let claims = 0;
  const fetchImpl = async () => {
    claims++;
    if (claims > 1) return new Response(JSON.stringify({ error: 'SYSTEM_UPDATE_RUNNER_CHANGED' }), { status: 409 });
    return new Response(JSON.stringify({ taskId: TASK, planDigest: plan.planDigest, runnerId: connection.runnerId, leaseExpiresAt: Date.now() + 180000, revision: 1 }));
  };
  await assert.rejects(withUpdateLease(connection, plan, lease => runBuildCommand(root, 'node', ['-e', 'setInterval(() => {}, 1000)'],
    sanitizedBuildEnvironment(process.env, plan.target.commit), { signal: lease.signal }), { fetchImpl, heartbeatMs: 15 }), { code: 'SYSTEM_UPDATE_LEASE_LOST' });
  assert.ok(claims >= 2);
});
test('heartbeat claims and phase writes share one serialized mutation queue', async () => {
  const plan = await makePlan(), connection = updateConnection(environment); let active = 0, highest = 0;
  const fetchImpl = async (url, init) => {
    active++; highest = Math.max(highest, active); const body = JSON.parse(init.body);
    await new Promise(accept => setTimeout(accept, 8)); active--;
    return new Response(JSON.stringify(url.endsWith('/claim')
      ? { taskId: TASK, planDigest: plan.planDigest, runnerId: body.runnerId, leaseExpiresAt: Date.now() + 180000, revision: 1 }
      : { ok: true, status: body.status }));
  };
  await withUpdateLease(connection, plan, async lease => {
    await Promise.all([reportUpdate(connection, plan, 'building', { fetchImpl }), lease.renew()]);
    await new Promise(accept => setTimeout(accept, 25)); lease.check();
  }, { fetchImpl, heartbeatMs: 2 });
  assert.equal(highest, 1);
});
test('initial BUSY acquisition has a 185 second total wait budget and never starts unowned work', async () => {
  const plan = await makePlan(), connection = updateConnection(environment); let elapsed = 0, calls = 0, started = false;
  await assert.rejects(withUpdateLease(connection, plan, async () => { started = true; }, {
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: 'SYSTEM_UPDATE_RUNNER_BUSY' }), { status: 409 }); },
    nowImpl: () => elapsed, sleepImpl: async delay => { assert.ok(delay > 0 && delay <= 3000); elapsed += delay; },
  }), error => error.remoteCode === 'SYSTEM_UPDATE_RUNNER_BUSY');
  assert.equal(elapsed, 185000); assert.ok(calls <= 64); assert.equal(started, false);
});
test('non-BUSY, malformed and oversized claim failures never enter the initial wait loop', async () => {
  const plan = await makePlan();
  for (const [body, status] of [[{ error: 'SYSTEM_UPDATE_RUNNER_CHANGED' }, 409], [{ error: 'SYSTEM_UPDATE_RETRY_REQUIRED' }, 409],
    [{ error: 'SYSTEM_UPDATE_RUNNER_BUSY' }, 503], [{ error: 'forbidden' }, 403], ['not json', 409],
    [{ error: 'SYSTEM_UPDATE_RUNNER_BUSY', padding: 'x'.repeat(5000) }, 409]]) {
    const connection = updateConnection(environment); let calls = 0, sleeps = 0;
    await assert.rejects(withUpdateLease(connection, plan, async () => assert.fail('Unclaimed work must not run'), {
      fetchImpl: async () => { calls++; return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); },
      sleepImpl: async () => { sleeps++; },
    }), { code: 'SYSTEM_UPDATE_REQUEST_REJECTED' });
    assert.equal(calls, 1); assert.equal(sleeps, 0);
  }
});
test('an existing owner receiving BUSY on heartbeat aborts immediately without initial-acquisition waiting', async () => {
  const plan = await makePlan(), connection = updateConnection(environment); let calls = 0, sleeps = 0;
  await assert.rejects(withUpdateLease(connection, plan, async lease => {
    await new Promise(accept => {
      const timeout = setTimeout(accept, 1000);
      lease.signal.addEventListener('abort', () => { clearTimeout(timeout); accept(); }, { once: true });
    });
    lease.check();
  }, { heartbeatMs: 10, sleepImpl: async () => { sleeps++; }, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response(JSON.stringify({ taskId: TASK, planDigest: plan.planDigest, runnerId: connection.runnerId,
      leaseExpiresAt: Date.now() + 180000, revision: 1 })) : new Response(JSON.stringify({ error: 'SYSTEM_UPDATE_RUNNER_BUSY' }), { status: 409 });
  } }), { code: 'SYSTEM_UPDATE_LEASE_LOST' });
  assert.equal(calls, 2); assert.equal(sleeps, 0);
});
