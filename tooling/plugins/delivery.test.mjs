import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { deliveryPlanDigest } from './assemble.mjs';
import { createPluginHostBuild } from './host-identity.mjs';
import { checkDeliveryPlan, deliveryConnection, fetchDeliverySnapshot, reportDelivery, runDeliveryCommand } from './delivery.mjs';

const host = { version: '1.2.1', sourceDigest: createHash('sha256').update('synthetic').digest('hex') };
const snapshot = () => {
  const value = { schemaVersion: 1, buildId: '895c1cb8-cea8-4f32-abf7-b324191005c8', host, plugins: [] };
  value.planDigest = deliveryPlanDigest(value); return value;
};
const environment = { FLARETUNE_PLUGIN_SITE_URL: 'https://music.example.net', FLARETUNE_PLUGIN_BUILD_TOKEN: 'synthetic-build-token-that-is-not-a-real-secret' };

test('CI connection accepts only an HTTPS origin and never embeds its token in a URL', () => {
  assert.deepEqual(deliveryConnection(environment), { origin: environment.FLARETUNE_PLUGIN_SITE_URL, token: environment.FLARETUNE_PLUGIN_BUILD_TOKEN });
  for (const value of ['http://music.example.net', 'https://music.example.net/path', 'https://music.example.net/?token=secret', 'https://127.0.0.1', 'https://user:secret@music.example.net']) {
    assert.throws(() => deliveryConnection({ ...environment, FLARETUNE_PLUGIN_SITE_URL: value }));
  }
  assert.throws(() => deliveryConnection({ ...environment, FLARETUNE_PLUGIN_BUILD_TOKEN: 'short' }), { code: 'PLUGIN_BUILD_CONNECTION_MISSING' });
});

test('snapshot and report use separate fixed endpoints, bearer authorization and no redirects', async () => {
  const calls = []; const plan = snapshot(); const connection = deliveryConnection(environment);
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(init.method === 'GET' ? plan : { accepted: true })); };
  assert.deepEqual(await fetchDeliverySnapshot(connection, { fetchImpl }), plan);
  await reportDelivery(connection, plan, 'building', { fetchImpl });
  assert.deepEqual(calls.map(call => call.url), ['https://music.example.net/api/plugin-build/snapshot', 'https://music.example.net/api/plugin-build/report']);
  assert.ok(calls.every(call => call.init.redirect === 'error' && call.init.headers.Authorization === `Bearer ${connection.token}`));
  assert.deepEqual(JSON.parse(calls[1].init.body), { buildId: plan.buildId, planDigest: plan.planDigest, status: 'building' });
  assert.equal(calls[1].init.body.includes(connection.token), false);
  await assert.rejects(reportDelivery(connection, plan, 'succeeded', { fetchImpl }), { code: 'PLUGIN_BUILD_REPORT_INVALID' });
});

test('a superseded build cannot pass the deployment preflight even when its desired plan is identical', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-delivery-check-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'package.json'), '{"version":"1.2.1"}');
  await writeFile(resolve(root, 'package-lock.json'), '{}');
  const localHost = await createPluginHostBuild(root);
  await writeFile(resolve(root, 'plugins.lock.json'), JSON.stringify({ host: localHost }));
  const plan = snapshot(); plan.host = localHost; plan.planDigest = deliveryPlanDigest(plan);
  const deployment = { ...plan };
  const connection = deliveryConnection(environment);
  assert.deepEqual(await checkDeliveryPlan(connection, deployment, { root, fetchImpl: async () => new Response(JSON.stringify(plan)) }), { buildId: plan.buildId, planDigest: plan.planDigest });
  plan.buildId = '81708e45-6f0b-40dc-a145-8e1fb0c1f791';
  await assert.rejects(checkDeliveryPlan(connection, deployment, { root, fetchImpl: async () => new Response(JSON.stringify(plan)) }), { code: 'PLUGIN_BUILD_SUPERSEDED' });
});

test('failed package preparation reports failure for the same immutable task and does not leak backend error text', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-delivery-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'plugins.lock.json'), JSON.stringify({ host: { ...host, version: '2.0.0' }, plugins: [] }));
  const plan = snapshot(); const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(init.method === 'GET' ? plan : { accepted: true })); };
  await assert.rejects(runDeliveryCommand('prepare', { root, environment, fetchImpl }), { code: 'PLUGIN_HOST_BUILD_MISMATCH' });
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { buildId: plan.buildId, planDigest: plan.planDigest, status: 'failed' });
  await assert.rejects(fetchDeliverySnapshot(deliveryConnection(environment), { fetchImpl: async () => new Response('secret response body', { status: 403 }) }), { code: 'PLUGIN_BUILD_AUTH_FAILED' });
});
