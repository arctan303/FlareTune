import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager, signInNative } from './upstream.mjs';

const credentials = { clientId: 'stage-fixture-client', clientSecret: 'stage-fixture-secret', refreshToken: 'stage-fixture-refresh' };
const token = () => ({ access_token: 'stage-fixture-access', expiry_date: new Date(Date.now() + 3600000).toISOString() });
function fakeSession() {
  return { oauth: { async refreshAccessToken() { this.oauth2_tokens = token(); } },
    async signIn(active) { this.oauth.oauth2_tokens = active; }, on() {} };
}
function safeCode(code) {
  return error => {
    assert.equal(error.code, code); assert.equal(error.message, code); assert.equal(error.status, 503);
    assert.equal(error.cause, undefined); assert.equal(JSON.stringify(error).includes('private-upstream'), false);
    return true;
  };
}

test('native TV bootstrap is local while guest metadata preserves its remote session option', async () => {
  const options = [];
  const manager = createSessionManager({ env: { YTM_KV: { get: async () => token() } }, credentials, epoch: 'options',
    async createSession(value) { options.push(value); return { session: fakeSession() }; } });
  await manager.guest(); await manager.tv();
  assert.equal(options[0].generate_session_locally, false);
  assert.equal(options[1].generate_session_locally, true);
  assert.equal(options[1].client_type, 'TVHTML5');
  assert.equal(options[1].retrieve_player, false);
  assert.equal(options[1].retrieve_innertube_config, false);
});

test('actual pinned SDK validates a cached TV session without any WEB metadata/network bootstrap', async () => {
  let networkCalls = 0;
  const manager = createSessionManager({ env: { YTM_KV: { get: async () => token() } }, credentials, epoch: 'real-sdk-bootstrap',
    async fetchImpl() { networkCalls++; throw new Error('private-upstream-must-not-be-called'); } });
  const yt = await manager.tv();
  assert.equal(networkCalls, 0);
  assert.equal(yt.session.context.client.clientName, 'TVHTML5');
  assert.equal(yt.session.logged_in, true);
});

test('session creation and KV reads report distinct finite sanitized stage errors', async () => {
  const createFailure = createSessionManager({ env: {}, credentials, epoch: 'create-failure',
    async createSession() { throw new Error('private-upstream token/url/body'); } });
  await assert.rejects(createFailure.tv(), safeCode('YOUTUBE_SESSION_UNAVAILABLE'));
  await assert.rejects(createFailure.guest(), safeCode('YOUTUBE_SESSION_UNAVAILABLE'));
  const cacheFailure = createSessionManager({ env: { YTM_KV: { async get() { throw new Error('private-upstream cache details'); } } },
    credentials, epoch: 'cache-failure', createSession: async () => ({ session: fakeSession() }) });
  await assert.rejects(cacheFailure.tv(), safeCode('YOUTUBE_CACHE_UNAVAILABLE'));
});

test('OAuth refresh maps only the SDK fixed HTTP statuses and never relays messages', async () => {
  for (const status of [400, 401, 403, 429, 500, 503, 599]) {
    const session = fakeSession();
    session.oauth.refreshAccessToken = async () => { throw new Error('Failed to refresh access token: ' + status); };
    await assert.rejects(signInNative(session, credentials, null), safeCode('YOUTUBE_OAUTH_REFRESH_HTTP_' + status));
  }
  for (const message of ['private-upstream Bearer abc 403', 'Failed to refresh access token: 403 private-upstream', 'Failed to refresh access token: 200']) {
    const session = fakeSession();
    session.oauth.refreshAccessToken = async () => { throw new Error(message); };
    await assert.rejects(signInNative(session, credentials, null), safeCode('YOUTUBE_OAUTH_REFRESH_FAILED'));
  }
  const invalid = fakeSession(); invalid.oauth.refreshAccessToken = async () => { invalid.oauth.oauth2_tokens = {}; };
  await assert.rejects(signInNative(invalid, credentials, null), safeCode('YOUTUBE_OAUTH_REFRESH_FAILED'));
});

test('cached sign-in failures are sanitized and optional token cache writes remain best effort', async () => {
  const rejected = fakeSession(); rejected.signIn = async () => { throw new Error('private-upstream invalid credentials'); };
  await assert.rejects(signInNative(rejected, credentials, token()), safeCode('YOUTUBE_OAUTH_SESSION_FAILED'));
  let writes = 0;
  const manager = createSessionManager({ env: { YTM_KV: { get: async () => null,
    async put() { writes++; throw new Error('private-upstream KV write rejected'); } } }, credentials, epoch: 'optional-write',
    createSession: async () => ({ session: fakeSession() }) });
  assert.ok(await manager.tv()); assert.equal(writes, 1);
});
