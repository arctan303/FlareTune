import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedMutationRequest, readBoundedJson, readCookie } from './httpSecurity.js';

test('mutation origin and custom header must exactly match the same origin', () => {
  const request = (origin, extra = {}) => new Request('https://tune.example/api/auth/login', {
    method: 'POST', headers: { Origin: origin, 'X-Requested-With': 'FlareTune', ...extra }, body: '{}',
  });
  assert.equal(isTrustedMutationRequest(request('https://tune.example')), true);
  assert.equal(isTrustedMutationRequest(request('https://other.example')), false);
  assert.equal(isTrustedMutationRequest(request('https://other.example'), ['https://other.example']), true);
  assert.equal(isTrustedMutationRequest(request('https://tune.example', { 'X-Requested-With': 'other' })), false);
  assert.equal(isTrustedMutationRequest(request(null)), false);
});

test('bounded JSON accepts object and rejects oversized or non-JSON bodies', async () => {
  const request = (body, contentType = 'application/json') => new Request('https://tune.example/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': contentType }, body,
  });
  assert.deepEqual(await readBoundedJson(request('{"username":"a"}')), { username: 'a' });
  await assert.rejects(readBoundedJson(request('[]')), /invalid_json/);
  await assert.rejects(readBoundedJson(request('{}', 'text/plain')), /invalid_content_type/);
  await assert.rejects(readBoundedJson(request(`{"x":"${'a'.repeat(9000)}"}`)), /body_too_large/);
});

test('cookie parser does not confuse similarly named cookies', () => {
  const request = new Request('https://tune.example', { headers: { Cookie: 'other_ft_session=wrong; ft_session=right; value=x=y' } });
  assert.equal(readCookie(request, 'ft_session'), 'right');
  assert.equal(readCookie(request, 'value'), 'x=y');
  assert.equal(readCookie(request, 'missing'), null);
});
