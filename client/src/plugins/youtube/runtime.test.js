import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { startYouTubeRuntime } from './runtime.js';
import { createPluginRuntime } from '../runtime.js';
import { createPluginMusicSources } from '../musicSources.js';
import { getMusicSourcesRevision } from '../../services/musicSources.js';
import { readCatalog } from '../../services/catalogRead.js';

function fixture() {
  const sessionStore = createStore(() => ({ authSession: { authenticated: true,
    user: { accountId: 'first', role: 'member' }, csrfToken: 'first-session' } }));
  const identity = () => JSON.stringify(sessionStore.getState().authSession);
  const pluginStore = createStore(() => ({ loaded: true, plugins: [] }));
  let pauses = 0, cancels = 0, starts = 0;
  const signals = [];
  const audio = { paused: false, pause() { this.paused = true; pauses++; } };
  const playerStore = createStore(set => ({ currentSong: { id: 'local', source: 'r2' }, playlist: [],
    isPlaying: true, shouldAutoPlay: true,
    cancelPendingPlayback() { cancels++; set({ isPlaying: false, shouldAutoPlay: false }); } }));
  const manifest = { id: 'youtube-music', version: '0.1.0', buildDigest: 'current-build',
    capabilityRoles: ['admin', 'member'], pages: [], entries: [],
    start(host) { starts++; signals.push(host.signal); return startYouTubeRuntime(host); } };
  const runtime = createPluginRuntime({ plugins: [manifest],
    getState() {
      const session = sessionStore.getState().authSession;
      return { subject: session.authenticated ? identity() : '', role: session.user?.role,
        rows: pluginStore.getState().plugins, loaded: pluginStore.getState().loaded };
    },
    subscribe(callback) {
      const first = sessionStore.subscribe(callback), second = pluginStore.subscribe(callback);
      return () => { first(); second(); };
    },
    createHost(plugin, signal) {
      const owner = identity(), revision = pluginStore.getState().plugins.find(row => row.id === plugin.id).revision;
      const isCurrent = () => !signal.aborted && owner === identity()
        && pluginStore.getState().plugins.some(row => row.id === plugin.id && row.installed && row.revision === revision);
      const assertCurrent = () => { if (!isCurrent()) throw new DOMException('Source retired', 'AbortError'); };
      return { signal, musicSources: createPluginMusicSources({ pluginId: plugin.id, playerStore, audioRef: { current: audio },
        isCurrent, assertCurrent, signal, sessionStore, pluginStore }) };
    },
    onError(id) { throw new Error('Unexpected plugin error: ' + id); },
  });
  const setInstalled = (installed, revision) => pluginStore.setState({ plugins: [
    { id: manifest.id, installed, revision, version: manifest.version, buildDigest: manifest.buildDigest, availability: { available: installed } },
  ] });
  const select = song => { audio.paused = false; playerStore.setState({ currentSong: song,
    playlist: [song], isPlaying: true, shouldAutoPlay: true }); };
  return { runtime, sessionStore, pluginStore, playerStore, setInstalled, select, audio, signals,
    counts: () => ({ pauses, cancels, starts }) };
}

test('YouTube runtime declares its source matching through the public host and returns its disposer', () => {
  let matches;
  const dispose = () => {};
  assert.equal(startYouTubeRuntime({ musicSources: { register(options) { matches = options.matches; return dispose; } } }), dispose);
  assert.equal(matches({ id: 'yt:QBtVFL0Qefs' }), true);
  assert.equal(matches({ id: 'opaque', source: 'youtube' }), true);
  assert.equal(matches({ id: 'local', source: 'r2' }), false);
});

test('installation starts YouTube lifecycle, uninstall retires buffered media and reinstall never resumes audio', () => {
  const source = fixture(); const revision = getMusicSourcesRevision();
  assert.deepEqual(source.counts(), { pauses: 0, cancels: 0, starts: 0 });
  assert.equal(getMusicSourcesRevision(), revision);
  source.setInstalled(true, 1);
  assert.deepEqual(source.counts(), { pauses: 0, cancels: 0, starts: 1 });
  assert.equal(getMusicSourcesRevision(), revision + 1);
  source.select({ id: 'yt:QBtVFL0Qefs' });
  source.setInstalled(false, 2);
  assert.equal(source.signals[0].aborted, true);
  assert.equal(source.audio.paused, true);
  assert.equal(source.playerStore.getState().shouldAutoPlay, false);
  assert.equal(source.playerStore.getState().playlist[0].id, 'yt:QBtVFL0Qefs');
  source.setInstalled(true, 3);
  assert.equal(source.counts().starts, 2);
  assert.equal(source.audio.paused, true);
  assert.equal(source.playerStore.getState().shouldAutoPlay, false);
  source.runtime.dispose();
});

test('a YouTube installation or unrelated plugin update leaves local playback unchanged', () => {
  const source = fixture(); source.setInstalled(true, 1);
  const revision = getMusicSourcesRevision();
  source.pluginStore.setState(state => ({ plugins: [...state.plugins, { id: 'unrelated', installed: true, revision: 40 }] }));
  assert.equal(getMusicSourcesRevision(), revision);
  source.setInstalled(false, 2);
  assert.equal(source.audio.paused, false);
  assert.equal(source.playerStore.getState().isPlaying, true);
  assert.deepEqual({ pauses: source.counts().pauses, cancels: source.counts().cancels }, { pauses: 0, cancels: 0 });
  source.runtime.dispose();
});

test('a mismatched source build retires playback before refresh and matching code never auto resumes it', () => {
  const source = fixture(); source.setInstalled(true, 1); source.select({ id: 'yt:QBtVFL0Qefs' });
  source.pluginStore.setState(state => ({ plugins: state.plugins.map(row => ({ ...row, buildDigest: 'old-build' })) }));
  assert.equal(source.signals[0].aborted, true);
  assert.equal(source.counts().starts, 1);
  assert.equal(source.audio.paused, true);
  assert.equal(source.playerStore.getState().shouldAutoPlay, false);
  source.setInstalled(true, 1);
  assert.equal(source.counts().starts, 2);
  assert.equal(source.audio.paused, true);
  assert.equal(source.playerStore.getState().shouldAutoPlay, false);
  source.runtime.dispose();
});

test('account and session changes retire the old source and late mixed search cannot play old results', async () => {
  const source = fixture(); source.setInstalled(true, 1); source.select({ id: 'yt:QBtVFL0Qefs' });
  const previousFetch = globalThis.fetch; let reply;
  globalThis.fetch = () => new Promise(resolve => { reply = resolve; });
  try {
    let played = false;
    const pending = readCatalog('songs', { query: 'Old account result' }).then(() => { played = true; });
    source.sessionStore.setState({ authSession: { authenticated: true,
      user: { accountId: 'second', role: 'member' }, csrfToken: 'second-session' } });
    assert.equal(source.signals[0].aborted, true);
    assert.equal(source.counts().starts, 2);
    assert.equal(source.audio.paused, true);
    assert.equal(source.playerStore.getState().shouldAutoPlay, false);
    reply(new Response(JSON.stringify({ data: { songs: [{ id: 'yt:QBtVFL0Qefs', audio_url: '/media/youtube/audio/QBtVFL0Qefs' }] } })));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(played, false);
    source.sessionStore.setState({ authSession: { authenticated: false, user: null } });
    assert.equal(source.signals[1].aborted, true);
    assert.equal(source.playerStore.getState().playlist.length, 1);
  } finally { globalThis.fetch = previousFetch; source.runtime.dispose(); }
});
