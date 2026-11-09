import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createPluginMusicSources } from './musicSources.js';
import { getMusicSourcesRevision, assertMusicSourcesRevision, notifyMusicSourcesChanged, subscribeMusicSources } from '../services/musicSources.js';

function sourceFixture(pluginId = 'fixture-source') {
  const sessionStore = createStore(() => ({ account: 'first' }));
  const pluginStore = createStore(() => ({ installed: true }));
  const controller = new AbortController();
  let pauses = 0, cancels = 0;
  const audio = { paused: false, pause() { pauses++; this.paused = true; } };
  const playerStore = createStore(set => ({ currentSong: { id: 'local', source: 'r2' }, playlist: [],
    isPlaying: true, shouldAutoPlay: true,
    cancelPendingPlayback() { cancels++; set({ isPlaying: false, shouldAutoPlay: false }); } }));
  const isCurrent = () => sessionStore.getState().account === 'first' && pluginStore.getState().installed && !controller.signal.aborted;
  const assertCurrent = () => { if (!isCurrent()) throw new DOMException('Source retired', 'AbortError'); };
  const api = createPluginMusicSources({ pluginId, playerStore, audioRef: { current: audio },
    isCurrent, assertCurrent, signal: controller.signal, sessionStore, pluginStore });
  const selectSource = () => {
    const song = { id: 'external', source: pluginId };
    audio.paused = false;
    playerStore.setState({ currentSong: song, playlist: [song], isPlaying: true, shouldAutoPlay: true });
  };
  return { api, sessionStore, pluginStore, playerStore, controller, selectSource, audio,
    counts: () => ({ pauses, cancels }), matches: song => song.source === pluginId };
}

test('source registration invalidates on startup and retirement once, preserving songs and queue', () => {
  const source = sourceFixture(); const events = [];
  const stopEvents = subscribeMusicSources((_revision, pluginId) => events.push(pluginId));
  const dispose = source.api.register({ matches: source.matches });
  assert.deepEqual(events, ['fixture-source']);
  assert.deepEqual(source.counts(), { pauses: 0, cancels: 0 });
  source.selectSource();
  dispose(); dispose();
  assert.deepEqual(events, ['fixture-source', 'fixture-source']);
  assert.deepEqual(source.counts(), { pauses: 1, cancels: 1 });
  assert.equal(source.playerStore.getState().playlist.length, 1);
  assert.equal(source.playerStore.getState().currentSong.id, 'external');
  notifyMusicSourcesChanged('fixture-source');
  assert.deepEqual(source.counts(), { pauses: 1, cancels: 1 });
  stopEvents();
});

test('a source change pauses its own selected media while other source changes leave it playing', () => {
  const source = sourceFixture();
  const dispose = source.api.register({ matches: source.matches }); source.selectSource();
  notifyMusicSourcesChanged('unrelated-source');
  assert.deepEqual(source.counts(), { pauses: 0, cancels: 0 });
  assert.equal(source.playerStore.getState().isPlaying, true);
  source.api.changed();
  assert.deepEqual(source.counts(), { pauses: 1, cancels: 1 });
  source.selectSource(); notifyMusicSourcesChanged();
  assert.deepEqual(source.counts(), { pauses: 2, cancels: 2 });
  dispose();
});

test('uninstall, account changes and runtime abort retire synchronously and reject old host actions', () => {
  for (const retire of [source => source.pluginStore.setState({ installed: false }),
    source => source.sessionStore.setState({ account: 'second' }), source => source.controller.abort()]) {
    const source = sourceFixture(); const dispose = source.api.register({ matches: source.matches }); source.selectSource();
    const revision = getMusicSourcesRevision();
    retire(source);
    assert.equal(source.audio.paused, true);
    assert.equal(source.playerStore.getState().shouldAutoPlay, false);
    assert.equal(getMusicSourcesRevision(), revision + 1);
    assert.throws(() => source.api.changed(), { name: 'AbortError' });
    assert.throws(() => source.api.register({ matches: source.matches }), { name: 'AbortError' });
    assert.throws(() => assertMusicSourcesRevision(revision), { name: 'AbortError' });
    source.selectSource();
    notifyMusicSourcesChanged('fixture-source');
    assert.equal(source.audio.paused, false, 'retired subscriptions do not affect a later selection');
    dispose();
  }
});

test('unrelated account-store and plugin-store updates keep the source live without invalidation', () => {
  const source = sourceFixture(); const dispose = source.api.register({ matches: source.matches });
  const revision = getMusicSourcesRevision();
  source.sessionStore.setState({ loading: true }); source.pluginStore.setState({ unrelatedRevision: 4 });
  assert.equal(getMusicSourcesRevision(), revision);
  source.selectSource(); source.api.changed(); assert.equal(source.audio.paused, true);
  dispose();
});

test('a live host rejects duplicate or invalid registrations without invalidating music', () => {
  const source = sourceFixture(); const revision = getMusicSourcesRevision();
  assert.throws(() => source.api.register(), TypeError);
  assert.equal(getMusicSourcesRevision(), revision);
  const dispose = source.api.register({ matches: source.matches });
  assert.throws(() => source.api.register({ matches: source.matches }), /already registered/);
  dispose();
});
