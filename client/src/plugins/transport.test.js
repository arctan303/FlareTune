import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginTransport, pluginEndpoint } from './transport.js';

function fixture(fetchImpl) {
  let active = true;
  const observers = new Set(), requests = [];
  const store = { subscribe(fn) { observers.add(fn); return () => observers.delete(fn); } };
  const transport = createPluginTransport({ pluginId: 'lyrics-workbench', buildDigest: 'b'.repeat(64),
    session: { user: { accountId: 'A', role: 'member' }, csrfToken: 'fake-csrf' }, isCurrent: () => active,
    sessionStore: store, pluginStore: store, fetchImpl: async (...args) => { requests.push(args); return fetchImpl(...args); } });
  return { transport, requests, observers, retire() { active = false; for (const fn of [...observers]) fn(); } };
}

test('plugin transport preserves external song IDs and query while rejecting namespace escapes', () => {
  assert.equal(pluginEndpoint('workspace/yt%3Aabc/candidates', { title: 'A & B', source: 'all' }), 'workspace/yt%3Aabc/candidates?title=A+%26+B&source=all');
  for (const path of ['https://evil.test', '/other', '../other', 'a/%2fother', 'a/%5cother', 'a/%252fother', 'a?other', 'a#other', 'a/%00']) assert.throws(() => pluginEndpoint(path), /Invalid plugin endpoint/);
});

test('JSON transport owns account, build and auth headers and releases observers after consumption', async () => {
  const f = fixture(() => Response.json({ ok: true }));
  assert.deepEqual(await f.transport.json('workspace/yt%3Aabc', { method: 'PUT', body: { lines: [] } }), { ok: true });
  const [url, init] = f.requests[0];
  assert.equal(url, '/api/account/plugins/lyrics-workbench/workspace/yt%3Aabc');
  assert.equal(init.headers['X-FlareTune-Expected-Account'], 'A');
  assert.equal(init.headers['X-FlareTune-Plugin-Build'], 'b'.repeat(64));
  assert.equal(init.headers['X-CSRF-Token'], 'fake-csrf');
  assert.equal(f.observers.size, 0);
  await assert.rejects(f.transport.json('settings', { admin: true }), { name: 'AbortError' });
  assert.equal(f.requests.length, 1);
});

test('raw stream stays bound to its owner after headers arrive and refuses late chunks', async () => {
  let upstream;
  const f = fixture(() => new Response(new ReadableStream({ start(controller) { upstream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await f.transport.response('chat', { method: 'POST', body: { message: 'fixture' } });
  const reader = response.body.getReader();
  upstream.enqueue(new TextEncoder().encode('data: first\n\n'));
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  f.retire();
  upstream.enqueue(new TextEncoder().encode('data: late\n\n'));
  await assert.rejects(reader.read(), { name: 'AbortError' });
  assert.equal(f.requests[0][1].signal.aborted, true);
  assert.equal(f.observers.size, 0);
});

test('pending headers cannot return across uninstall and JSON errors keep status and safe data', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.transport.response('chat'); f.retire(); finish(Response.json({ old: true }));
  await assert.rejects(pending, { name: 'AbortError' });
  const denied = fixture(() => Response.json({ error: 'PLUGIN_NOT_INSTALLED' }, { status: 409 }));
  await assert.rejects(denied.transport.json('workspace/one'), error => error.status === 409 && error.code === 'PLUGIN_NOT_INSTALLED');
});
