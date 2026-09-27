import assert from 'node:assert/strict';
import test from 'node:test';

test('development auth proxy rewrites only the exact local browser Origin', async () => {
  const { default: config } = await import('../../client/vite.config.js');
  const proxy = config.server.proxy['/api'];
  let onProxyRequest;
  proxy.configure({ on(event, callback) {
    assert.equal(event, 'proxyReq');
    onProxyRequest = callback;
  } });
  assert.equal(typeof onProxyRequest, 'function');
  const headers = new Map();
  const outgoing = { setHeader(name, value) { headers.set(name, value); } };
  onProxyRequest(outgoing, { headers: { origin: 'https://attacker.example' } });
  assert.equal(headers.has('Origin'), false);
  onProxyRequest(outgoing, { headers: { origin: 'http://127.0.0.1:3000' } });
  assert.equal(headers.get('Origin'), new URL(proxy.target).origin);
});
