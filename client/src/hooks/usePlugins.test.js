import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';

test('plugin availability refreshes only on session/scope changes, not store updates or route content renders', () => {
  const calls = [], state = { lists: { account: { plugins: [], loaded: false }, admin: { plugins: [], loaded: false } },
    installedIds: [], busy: false, isInstalled: () => false,
    refresh: async (session, options) => calls.push([session.user.accountId, options.admin]), setInstalled() {} };
  const store = Object.assign(() => state, { getState: () => state });
  const harness = createBackgroundModuleHarness({ file: new URL('./usePlugins.js', import.meta.url), exportName: 'usePlugins',
    modules: { '../store/usePluginStore.js': { usePluginStore: store }, '../services/runtimeFetch.js': { isDemoRuntime: false } }, globals: {},
    render: (module, props) => module.usePlugins(props.session, props.options) });
  const props = { session: { authenticated: true, user: { accountId: 'A', role: 'admin' }, csrfToken: 'csrf-A' }, options: { admin: false } };
  harness.render(props); state.installedIds = ['xiaomi-speaker']; harness.render(props); harness.render({ ...props });
  assert.deepEqual(calls, [['A', false]]);
  harness.render({ ...props, options: { admin: true } });
  assert.deepEqual(calls, [['A', false], ['A', true]]);
  harness.render({ ...props, session: { ...props.session, csrfToken: 'new-session' } });
  assert.deepEqual(calls, [['A', false], ['A', true], ['A', false]]);
  harness.unmount();
});

test('Demo does not request plugin installation or account availability', () => {
  const state = { lists: { account: { plugins: [] } }, installedIds: [], refresh: () => assert.fail('Demo cannot request plugin state') };
  const harness = createBackgroundModuleHarness({ file: new URL('./usePlugins.js', import.meta.url), exportName: 'usePlugins',
    modules: { '../store/usePluginStore.js': { usePluginStore: Object.assign(() => state, { getState: () => state }) },
      '../services/runtimeFetch.js': { isDemoRuntime: true } }, globals: {},
    render: module => module.usePlugins({ authenticated: true, user: { accountId: 'A' } }) });
  assert.equal(harness.render().demo, true); harness.unmount();
});
