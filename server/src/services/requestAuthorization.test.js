import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestEnvironment, authorizeRequestEnvironment, requestAuthorizationSnapshot, requestLifetime, bindRequestResponse,
  retainRequestTask, authorizeProtocolRequestEnvironment } from './requestAuthorization.js';

const session = { mode: 'normal', tokenHash: 'token-a', account: { accountId: 'account-a', role: 'member' } };
const scope = () => createRequestEnvironment({ DB: {} }, new Request('https://example.test/api/lyrics'));
test('only a host-authorized request supplies an identity snapshot', () => {
  const env = scope(); assert.equal(requestAuthorizationSnapshot(env, session), null);
  authorizeRequestEnvironment(env, session);
  assert.deepEqual(requestAuthorizationSnapshot(env, session).identity, session.account);
  assert.throws(() => requestAuthorizationSnapshot(env, { ...session, tokenHash: 'another-token' }), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
  assert.throws(() => requestAuthorizationSnapshot({ ...env, DB: {} }, session), { code: 'PLUGIN_SERVICE_CONTEXT_MISMATCH' });
  assert.equal(requestAuthorizationSnapshot(scope(), session), null);
});
test('request authorization ends when the response finishes or is cancelled', async () => {
  const env = scope(); authorizeRequestEnvironment(env, session);
  const authorized = requestAuthorizationSnapshot(env, session);
  const response = bindRequestResponse(env, new Response('done'));
  await response.text(); assert.throws(() => authorized.assertCurrent(), { name: 'AbortError' });
  const other = scope(); authorizeRequestEnvironment(other, session);
  const lifetime = requestLifetime(other);
  const pending = bindRequestResponse(other, new Response(new ReadableStream({ start() {} })));
  await pending.body.cancel(); assert.throws(() => lifetime.assertCurrent(), { name: 'AbortError' });
});
test('copied environments preserve only the same request and database authority', () => {
  const env = scope(); authorizeRequestEnvironment(env, session);
  assert.deepEqual(requestAuthorizationSnapshot({ ...env }, session).identity, session.account);
  assert.equal(requestLifetime({ DB: env.DB }), null);
});

test('only an accepted lyric request can retain its finite task after normal EOF', async () => {
  const env = scope(); assert.equal(retainRequestTask(env), null);
  assert.equal(retainRequestTask({ DB: env.DB }), null);
  authorizeRequestEnvironment(env, session);
  const accepted = requestAuthorizationSnapshot(env, session);
  const task = retainRequestTask(env);
  await bindRequestResponse(env, new Response('original lyrics')).text();
  assert.deepEqual(accepted.assertCurrent(), session.account);
  task.release(); assert.equal(task.signal.aborted, true);
  assert.throws(() => accepted.assertCurrent(), { name: 'AbortError' });
  const other = createRequestEnvironment({ DB: {} }, new Request('https://example.test/api/admin/settings'));
  authorizeRequestEnvironment(other, session); assert.equal(retainRequestTask(other), null);
});

test('a second hold cannot renew the first deadline and one release cannot close another task', async () => {
  const env = scope(); authorizeRequestEnvironment(env, session);
  const accepted = requestAuthorizationSnapshot(env, session);
  const first = retainRequestTask(env, { timeoutMs: 120 });
  await new Promise(resolve => setTimeout(resolve, 15));
  const second = retainRequestTask(env, { timeoutMs: 30_000 });
  assert.equal(first.expiresAt, second.expiresAt);
  await bindRequestResponse(env, new Response('original')).text();
  first.release(); first.release(); accepted.assertCurrent();
  assert.equal(second.signal.aborted, false);
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.equal(second.signal.aborted, true);
  assert.throws(() => accepted.assertCurrent(), { name: 'AbortError' });
});

test('response cancellation and native abort revoke a retained task immediately', async () => {
  for (const native of [false, true]) {
    const controller = new AbortController();
    const env = createRequestEnvironment({ DB: {} }, new Request('https://example.test/api/lyrics', { signal: controller.signal }));
    authorizeRequestEnvironment(env, session);
    const accepted = requestAuthorizationSnapshot(env, session), task = retainRequestTask(env);
    const response = bindRequestResponse(env, new Response(new ReadableStream({ start() {} })));
    if (native) controller.abort(); else await response.body.cancel();
    assert.equal(task.signal.aborted, true);
    assert.throws(() => accepted.assertCurrent(), { name: 'AbortError' });
    task.release();
  }
});

test('protocol continuation requires the host accepted protocol marker', () => {
  const env = createRequestEnvironment({ DB: {} }, new Request('https://example.test/rest/getLyricsBySongId'));
  assert.equal(retainRequestTask(env), null);
  authorizeProtocolRequestEnvironment(env);
  const task = retainRequestTask(env); assert.ok(task); task.release();
});
