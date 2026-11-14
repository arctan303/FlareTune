import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const session = id => ({ authenticated: true, csrfToken: 'csrf-' + id, user: { accountId: id, role: 'admin' } });
test('delivery resources abort and discard late reads after an account changes; members never fetch', async () => {
  const requests = [], scheduler = createBackgroundScheduler();
  const hook = createBackgroundModuleHarness({ file: new URL('./usePluginDelivery.js', import.meta.url),
    render: (module, props) => module.usePluginDelivery(props.session),
    modules: { '../services/runtimeFetch.js': { isDemoRuntime: false }, '../services/pluginDelivery.js': {
      deliveryErrorMessage: error => error.code, pluginDeliveryRequest: (owner, path, options) => new Promise(resolve => requests.push({ owner, path, options, resolve })),
    } }, globals: { AbortController, ...scheduler },
  });
  hook.render({ session: session('A') });
  hook.render({ session: session('B') });
  assert.equal(requests[0].options.signal.aborted, true);
  requests[0].resolve({ revision: 1, sources: [{ name: 'private A catalog' }] });
  await flushBackgroundAsync();
  assert.equal(hook.render({ session: session('B') }).data, null);
  requests[1].resolve({ revision: 2, sources: [] }); await flushBackgroundAsync();
  assert.equal(hook.render({ session: session('B') }).data.revision, 2);
  assert.equal(hook.render({ session: { ...session('B'), user: { accountId: 'B', role: 'member' } } }).data, null);
  assert.equal(requests.length, 2);
  hook.unmount();
});

test('actions carry the current revision and duplicate submissions are suppressed', async () => {
  const requests = [], scheduler = createBackgroundScheduler();
  const hook = createBackgroundModuleHarness({ file: new URL('./usePluginDelivery.js', import.meta.url),
    render: (module, props) => module.usePluginDelivery(props.session),
    modules: { '../services/runtimeFetch.js': { isDemoRuntime: false }, '../services/pluginDelivery.js': {
      deliveryErrorMessage: error => error.code, pluginDeliveryRequest: (owner, path, options) => new Promise(resolve => requests.push({ owner, path, options, resolve })),
    } }, globals: { AbortController, ...scheduler },
  });
  const owner = session('A'); hook.render({ session: owner });
  requests[0].resolve({ revision: 7, build: null }); await flushBackgroundAsync();
  let state = hook.render(); const write = state.action('/selection', 'PUT', { pluginId: 'test', installed: true });
  await state.action('/build');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.body.revision, 7);
  requests[1].resolve({ revision: 8, build: { status: 'queued' } }); await write;
  state = hook.render(); assert.equal(state.data.revision, 8);
  assert.equal(scheduler.intervals.size, 1);
  hook.unmount(); assert.equal(scheduler.intervals.size, 0);
});
