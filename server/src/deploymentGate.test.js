import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentGateAllows } from './deploymentGate.js';
import worker from './flaretune.js';

const request = (token) => new Request('https://flaretuneworker.example/api/health', {
  headers: token === undefined ? {} : { 'X-FlareTune-Migration-Gate': token },
});

test('migration gate blocks every unauthenticated request and requires a separate secret', async () => {
  const env = { MIGRATION_GATE_ACTIVE: 'true', MIGRATION_GATE_SECRET: 'a'.repeat(64) };
  assert.equal(await deploymentGateAllows(request(), env), false);
  assert.equal(await deploymentGateAllows(request('b'.repeat(64)), env), false);
  assert.equal(await deploymentGateAllows(request('a'.repeat(64)), env), true);
  assert.equal(await deploymentGateAllows(request('a'.repeat(64)), { MIGRATION_GATE_ACTIVE: 'true' }), false);
  assert.equal(await deploymentGateAllows(request(), { MIGRATION_GATE_ACTIVE: 'false' }), true);
});

test('worker gate closes status, login and media before touching DB or R2', async () => {
  let touched = 0;
  const env = {
    MIGRATION_GATE_ACTIVE: 'true', MIGRATION_GATE_SECRET: 'a'.repeat(64),
    DB: { prepare() { touched += 1; throw new Error('DB should stay closed'); } },
    MEDIA_BUCKET: { get() { touched += 1; throw new Error('R2 should stay closed'); } },
  };
  for (const path of ['/api/instance/status', '/api/auth/login', '/media/track.mp3']) {
    const response = await worker.fetch(requestFor(path), env);
    assert.equal(response.status, 503);
  }
  assert.equal(touched, 0);
  assert.equal((await worker.fetch(requestFor('/api', 'a'.repeat(64)), env)).status, 404);
});

function requestFor(path, token) {
  return new Request(`https://flaretuneworker.example${path}`, {
    headers: token === undefined ? {} : { 'X-FlareTune-Migration-Gate': token },
  });
}
