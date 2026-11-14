import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../test/fullscreenBackgroundHarness.js';
import { createQueueContinuationRegistry } from '../store/queueContinuation.js';

function harness({ role = 'member' } = {}) {
  let auth = { authenticated: true, user: { accountId: 'A', role }, csrfToken: 'synthetic-csrf' };
  let installation = { loaded: true, installedIds: ['sample'], plugins: [{ id: 'sample', version: '1.0.0', revision: 1 }] };
  const sessionStore = { getState: () => ({ authSession: auth }), subscribe: () => () => {} };
  const pluginStore = { getState: () => installation };
  const playerStore = { getState: () => ({ currentSong: { id: 'playing' }, playlist: [{ id: 'queued' }] }) };
  const requests = [], navigations = [];
  let finish;
  const subject = createBackgroundModuleHarness({ file: new URL('./host.js', import.meta.url), modules: {
    '../store/useUIStore.js': { useUIStore: sessionStore }, '../store/usePlayerStore.js': { usePlayerStore: playerStore },
    '../store/usePluginStore.js': { usePluginStore: pluginStore }, '../instance/api.js': {},
    '../services/runtimeFetch.js': {}, '../utils/navigation.js': {},
    '../services/songApi.js': { fetchSongById: async id => ({ id, language: 'en', audio_url: 'https://media.test/song.mp3' }) },
    '../resolveSongs.js': { repairSongLanguages: async songs => ({ songs }), songHasValidLanguage: song => song.language === 'en' }, '../services/apiBase.js': { getApiBaseUrl: () => '' },
    '../store/useOutputTargetStore.js': {},
    '../constants/explore.js': { EXPLORE_CATEGORIES: [{ key: 'zh', label: '中文' }] }, '../utils.js': { hydrateSong: song => song },
    '../hooks/useLyricsFetcher.js': { invalidateLyricsCacheForSong() {} }, './playerActions.js': { dispatchScopedPlayerAction() {} },
  }, globals: { AbortController, DOMException, URLSearchParams },
  });
  const plugin = { id: 'sample', version: '1.0.0', pages: [{ id: 'tools', access: 'authenticated' }, { id: 'admin', access: 'admin' }, { id: 'members', roles: ['member'] }] };
  const host = subject.exports.createPluginHost(plugin, { sessionStore, playerStore, pluginStore,
    navigate: route => navigations.push(route), request: async (path, options) => {
      requests.push({ path, options }); return new Promise(resolve => { finish = resolve; });
    } });
  return { host, requests, navigations, finish: result => finish(result),
    replaceAccount() { auth = { ...auth, user: { accountId: 'B', role: 'member' } }; },
    reinstall() { installation = { ...installation, plugins: [{ id: 'sample', version: '1.0.0', revision: 3 }] }; },
  };
}
test('public host owns route and endpoint namespaces, and does not expose mutable stores', async () => {
  const subject = harness();
  subject.host.navigate('tools');
  assert.deepEqual(JSON.parse(JSON.stringify(subject.navigations)), [{ type: 'page', page: 'plugin', pluginId: 'sample', pluginPage: 'tools' }]);
  assert.throws(() => subject.host.navigate('admin'), { name: 'AbortError' });
  assert.throws(() => subject.host.navigate('missing'), { name: 'AbortError' });
  assert.equal(subject.host.player.setState, undefined);
  assert.equal(subject.host.session.get().csrfToken, undefined);
  assert.equal(Object.isFrozen(subject.host.session.get().user), true);
  assert.equal(subject.host.player.getSnapshot().queue[0].id, 'queued');
  await assert.rejects(subject.host.request('../other/secrets'), /Invalid plugin endpoint/);
  const pending = subject.host.request('channels/list');
  assert.equal(subject.requests[0].path, 'account/plugins/sample/channels/list');
  assert.equal(subject.requests[0].options.expectedAccountId, 'A');
  subject.finish({ ok: true }); assert.deepEqual(await pending, { ok: true });
});

test('host navigation respects member-only pages without administrator inheritance', () => {
  const admin = harness({ role: 'admin' }), member = harness();
  assert.throws(() => admin.host.navigate('members'), { name: 'AbortError' });
  member.host.navigate('members');
  assert.equal(member.navigations[0].pluginPage, 'members');
});
test('a pending plugin response cannot cross accounts or installation generations', async () => {
  for (const retire of ['replaceAccount', 'reinstall']) {
    const subject = harness(), pending = subject.host.request('status');
    subject[retire](); subject.finish({ private: 'synthetic' });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(subject.host.session.get(), null);
  }
});

function queueHarness() {
  let auth = { authenticated: true, user: { accountId: 'A', role: 'member' }, csrfToken: 'session-A' };
  let installation = { loaded: true, installedIds: ['sample'], plugins: [{ id: 'sample', version: '1.0.0', revision: 1 }] };
  const sessionListeners = new Set(), pluginListeners = new Set(), playerListeners = new Set();
  const subscribe = listeners => callback => { listeners.add(callback); return () => listeners.delete(callback); };
  const sessionStore = { getState: () => ({ authSession: auth }), subscribe: subscribe(sessionListeners) };
  const pluginStore = { getState: () => installation, subscribe: subscribe(pluginListeners) };
  const registry = createQueueContinuationRegistry();
  const state = { queueContextReady: false, playlist: [{ id: 'existing', metadata: { title: 'safe' } }],
    currentSong: { id: 'existing' }, isPlaying: true, playMode: 'sequence', revision: 1,
    getQueueSnapshot() { return JSON.parse(JSON.stringify({ queue: this.playlist, currentSong: this.currentSong,
      isPlaying: this.isPlaying, playMode: this.playMode, revision: this.revision, ready: this.queueContextReady })); },
    registerQueueContinuation: registry.register,
    appendQueueContinuation(songs) { this.playlist = [...this.playlist, ...songs]; return { added: songs, snapshot: this.getQueueSnapshot() }; },
    startQueueContinuation(songs) { this.playlist = songs; return true; },
    trimQueueAfterCurrent() { this.playlist = this.playlist.slice(0, 1); },
    setQueueSequence() { this.playMode = 'sequence'; },
  };
  const playerStore = { getState: () => state, subscribe: subscribe(playerListeners) };
  const abort = new AbortController(), navigations = [], toasts = [];
  const subject = createBackgroundModuleHarness({ file: new URL('./host.js', import.meta.url), modules: {
    '../store/useUIStore.js': { useUIStore: sessionStore, showToast: message => toasts.push(message) }, '../store/usePlayerStore.js': { usePlayerStore: playerStore },
    '../store/usePluginStore.js': { usePluginStore: pluginStore }, '../instance/api.js': {},
    '../services/runtimeFetch.js': {}, '../utils/navigation.js': {},
    '../services/songApi.js': { fetchSongById: async id => ({ id, language: 'en', audio_url: 'https://media.test/song.mp3' }) },
    '../resolveSongs.js': { repairSongLanguages: async songs => ({ songs }), songHasValidLanguage: song => song.language === 'en' }, '../services/apiBase.js': { getApiBaseUrl: () => '' },
    '../store/useOutputTargetStore.js': {},
    '../constants/explore.js': { EXPLORE_CATEGORIES: [{ key: 'zh', label: '中文' }] },
    '../utils.js': { hydrateSong: value => ({ ...value, hydrated: true }), hydratePlayableSong: value => value },
  }, globals: { AbortController, DOMException } });
  const plugin = { id: 'sample', version: '1.0.0', pages: [{ id: 'tools', access: 'authenticated' }] };
  const host = subject.exports.createPluginHost(plugin, { sessionStore, playerStore, pluginStore, signal: abort.signal,
    navigate: route => navigations.push(route) });
  return { host, state, registry, navigations, toasts, playerListeners, sessionListeners, pluginListeners,
    notify() { for (const callback of [...playerListeners]) callback(); },
    retire(kind) {
      if (kind === 'account') auth = { ...auth, user: { ...auth.user, accountId: 'B' } };
      if (kind === 'role') auth = { ...auth, user: { ...auth.user, role: 'admin' } };
      if (kind === 'session') auth = { ...auth, csrfToken: 'session-B' };
      if (kind === 'uninstall') installation = { ...installation, installedIds: [] };
      if (kind === 'reinstall') installation = { ...installation, plugins: [{ ...installation.plugins[0], revision: 2 }] };
      if (kind === 'abort') abort.abort();
      for (const callback of [...sessionListeners, ...pluginListeners]) callback();
    },
  };
}

test('queue continuation registers before restoration, then requires a ready context and a live lease for writes', () => {
  const subject = queueHarness();
  let calls = 0;
  const cleanup = subject.host.queue.registerContinuation({ onQueueEnd() { calls++; return true; } });
  assert.equal(subject.registry.notify('onQueueEnd', {}), false);
  assert.throws(() => subject.host.queue.append([{ id: 'too-early' }]), /not ready/);
  subject.state.queueContextReady = true;
  assert.equal(subject.registry.notify('onQueueEnd', {}), true);
  subject.host.queue.append([{ id: 'new' }]);
  assert.equal(calls, 1);
  cleanup(); cleanup();
  assert.throws(() => subject.host.queue.append([{ id: 'late' }]), { name: 'AbortError' });
  assert.throws(() => subject.host.queue.start([{ id: 'late' }]), { name: 'AbortError' });
  assert.equal(subject.registry.notify('onQueueEnd', {}), false);
  assert.equal(subject.state.isPlaying, true);
  assert.deepEqual(subject.state.playlist.map(song => song.id), ['existing', 'new']);
});

test('uninstall, account, role, session and installation changes retire callbacks and prevent late queue writes', () => {
  for (const kind of ['account', 'role', 'session', 'uninstall', 'reinstall', 'abort']) {
    const subject = queueHarness(); subject.state.queueContextReady = true;
    let events = 0, updates = 0;
    subject.host.queue.registerContinuation({ onQueueEnd() { events++; return true; } });
    subject.host.queue.subscribe(() => updates++);
    subject.notify(); assert.equal(updates, 1);
    subject.retire(kind);
    assert.equal(subject.registry.notify('onQueueEnd', {}), false, kind);
    assert.throws(() => subject.host.queue.append([{ id: 'late' }]), { name: 'AbortError' });
    subject.notify();
    assert.equal(events, 0); assert.equal(updates, 1);
    assert.equal(subject.playerListeners.size, 0);
    assert.equal(subject.sessionListeners.size, 0);
    assert.equal(subject.pluginListeners.size, 0);
    assert.equal(subject.state.currentSong.id, 'existing');
    assert.equal(subject.state.isPlaying, true);
    assert.deepEqual(subject.state.playlist.map(song => song.id), ['existing']);
  }
});

test('queue snapshots and language catalog are copied or frozen and catalog actions check the live owner', () => {
  const subject = queueHarness();
  const snapshot = subject.host.queue.getSnapshot();
  snapshot.queue[0].metadata.title = 'mutated';
  assert.equal(subject.state.playlist[0].metadata.title, 'safe');
  assert.equal(Object.isFrozen(subject.host.catalog.categories), true);
  assert.equal(Object.isFrozen(subject.host.catalog.categories[0]), true);
  assert.throws(() => subject.host.catalog.openLanguage('unknown'), /Invalid catalog language/);
  subject.host.catalog.openLanguage('zh');
  assert.equal(subject.navigations[0].type, 'explore');
  assert.equal(subject.navigations[0].language, 'zh');
  assert.equal(subject.host.catalog.hydrateSong({ id: 'dto' }).hydrated, true);
  subject.retire('account');
  assert.throws(() => subject.host.catalog.hydrateSong({ id: 'dto' }), { name: 'AbortError' });
  assert.throws(() => subject.host.catalog.openLanguage('zh'), { name: 'AbortError' });
});

test('a retired plugin cannot show a host notification', () => {
  const subject = queueHarness();
  subject.host.notify('已更新偏好');
  subject.retire('uninstall');
  assert.throws(() => subject.host.notify('迟到提示'), { name: 'AbortError' });
  assert.deepEqual(subject.toasts, ['已更新偏好']);
});

test('catalog resolution uses the host song reader and rejects late data after retirement', async () => {
  const subject = queueHarness();
  assert.equal((await subject.host.catalog.resolveSong('looked-up')).id, 'looked-up');
  await assert.rejects(subject.host.catalog.resolveSong(''), /Invalid song/);
  const pending = subject.host.catalog.resolveSong('old-account'); subject.retire('account');
  await assert.rejects(pending, { name: 'AbortError' });
});
