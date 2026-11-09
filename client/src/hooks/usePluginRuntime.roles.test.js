import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { createPluginRuntime } from '../plugins/runtime.js';

test('account and administrator refresh orders cannot start member-only code under an administrator session', () => {
  for (const order of [['admin', 'account'], ['account', 'admin']]) {
    let session = { authenticated: true, user: { accountId: 'same-account', role: 'admin' }, csrfToken: 'synthetic' };
    let state = { loaded: true, plugins: [] };
    const uiListeners = new Set(), pluginListeners = new Set(), events = [], signals = [];
    const store = (read, listeners) => ({ getState: read, subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); } });
    const plugin = { id: 'members', version: '1.0.0', pages: [{ id: 'service', kind: 'service', roles: ['member'] }], entries: [] };
    const memberRow = { id: plugin.id, installed: true, revision: 1, version: '1.0.0', availability: { available: true } };
    const audioRef = { current: null };
    const harness = createBackgroundModuleHarness({ file: new URL('./usePluginRuntime.js', import.meta.url), exportName: 'usePluginRuntime',
      modules: {
        '../store/useUIStore.js': { useUIStore: store(() => ({ authSession: session }), uiListeners) },
        '../store/usePluginStore.js': { usePluginStore: store(() => state, pluginListeners) },
        '../plugins/registry.js': { getPlugins: () => [plugin] },
        '../plugins/compiled.js': { pluginBindings: { members: { start(host) {
          events.push('start'); signals.push(host.signal); return () => events.push('stop');
        } } } },
        '../plugins/host.js': { createPluginHost: (_plugin, options) => {
          assert.equal(options.audioRef, audioRef, 'the generic host receives the current audio reference');
          return { signal: options.signal };
        } },
        '../plugins/runtime.js': { createPluginRuntime },
        '../../../shared/plugins/build.generated.js': { pluginBuilds: [] },
        '../i18n/index.js': { t: value => value },
      }, globals: {},
    });
    const applyRead = scope => {
      state = { ...state, plugins: scope === 'admin' ? [memberRow] : [] };
      for (const listener of pluginListeners) listener();
    };
    harness.render({ audioRef });
    for (const scope of order) applyRead(scope);
    assert.deepEqual(events, [], `${order.join('→')}: management refresh must not execute member-only code`);
    applyRead('admin');
    assert.equal(state.plugins[0].id, 'members', 'the administrator can retain the plugin management row');
    session = { ...session, user: { ...session.user, role: 'member' } };
    for (const listener of uiListeners) listener();
    assert.deepEqual(events, ['start']);
    session = { ...session, user: { ...session.user, role: 'admin' } };
    for (const listener of uiListeners) listener();
    assert.deepEqual(events, ['start', 'stop']);
    assert.equal(signals[0].aborted, true);
    harness.unmount();
  }
});
