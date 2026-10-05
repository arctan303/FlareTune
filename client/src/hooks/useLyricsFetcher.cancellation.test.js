import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { songLanguageHasLyrics } from '../constants/language.js';
import { getLyricVocalStart } from '../utils/lyricTimeline.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createHarness({ failFirst = false } = {}) {
  const state = { currentSong: { id: 'first', language: 'en' }, lyricsRefreshRevision: 0,
    translationState: 'unavailable', translationStartedAt: null, lyrics: [] };
  for (const [setter, field] of Object.entries({
    setLyrics: 'lyrics', setLyricsStatus: 'lyricsStatus', setCurrentLyricIndex: 'currentLyricIndex',
    setIsLyricsLoading: 'isLyricsLoading', setResolvedLyricSource: 'resolvedLyricSource',
    setLyricFormat: 'lyricFormat', setLyricSyncMode: 'lyricSyncMode',
    setLyricIntro: 'lyricIntro', setLyricOffsetMs: 'lyricOffsetMs',
  })) state[setter] = (value) => { state[field] = value; };
  state.setTranslationSnapshot = ({ available, state: status, startedAt }) => {
    state.translationAvailable = available; state.translationState = status; state.translationStartedAt = startedAt;
  };
  state.setLyricsDocumentSnapshot = (snapshot) => {
    state.lyrics = snapshot.lyrics; state.lyricsStatus = snapshot.status;
    state.translationState = snapshot.translationState;
  };
  const store = (selector) => selector(state);
  store.getState = () => state;
  const effects = [];
  let cursor = 0;
  const react = { useEffect(create, deps) {
    const index = cursor++;
    const previous = effects[index];
    if (previous && deps.every((value, position) => Object.is(value, previous.deps[position]))) return;
    previous?.cleanup?.();
    effects[index] = { deps, cleanup: create() };
  } };
  const requests = [];
  const modules = {
    react,
    '../utils.js': { getApiBaseUrl: () => '' },
    '../store/usePlayerStore.js': { usePlayerStore: store },
    '../constants/language.js': { songLanguageHasLyrics },
    '../utils/lyricTimeline.js': { getLyricVocalStart },
    '../services/localLyricsWorkspaceApi.js': { lyricsWorkspaceApi: {} },
    '../services/authenticatedFetch.js': { authenticatedFetch(url, options) {
      return new Promise((resolve, reject) => {
        const request = { url, signal: options.signal, resolve, reject };
        requests.push(request);
        options.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
        if (failFirst && requests.length === 1) reject(Object.assign(new Error('temporary'), { status: 503 }));
      });
    } },
  };
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL('./useLyricsFetcher.js', import.meta.url), 'utf8'), {
    loader: 'js', format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)((name) => modules[name], module, module.exports);
  return {
    state, requests,
    render(enabled = true) { cursor = 0; module.exports.useLyricsFetcher({ enabled }); },
    unmount() { effects.forEach((effect) => effect?.cleanup?.()); },
    load: module.exports.loadLyricsDocumentIntoStore,
  };
}

const response = (text) => ({ status: 200, json: async () => ({ code: 200, data: {
  version: 2, source: 'manual', format: 'lrc', syncMode: 'line',
  lines: [{ time: 0, text }], translationState: 'unavailable',
} }) });

test('global lyric consumer survives fullscreen changes and aborts only its superseded song request', async () => {
  const harness = createHarness();
  harness.render();
  assert.equal(harness.requests.length, 1);
  const first = harness.requests[0];
  assert.ok(first.signal instanceof AbortSignal);
  harness.state.isFullScreen = false;
  harness.render();
  assert.equal(first.signal.aborted, false);
  assert.equal(harness.requests.length, 1);

  harness.state.currentSong = { id: 'second', language: 'en' };
  harness.render();
  assert.equal(first.signal.aborted, true);
  assert.equal(harness.requests.length, 2);
  const second = harness.requests[1];
  second.resolve(response('Second song lyrics'));
  await flush();
  assert.equal(harness.state.lyrics[0].text, 'Second song lyrics');
  assert.equal(harness.state.lyricsStatus, 'ready');
  assert.equal(harness.state.isLyricsLoading, false);
  harness.unmount();
});

test('disabling or unmounting the global consumer aborts its request without publishing an error', async () => {
  for (const action of ['disable', 'unmount']) {
    const harness = createHarness();
    harness.render();
    if (action === 'disable') harness.render(false);
    else harness.unmount();
    assert.equal(harness.requests[0].signal.aborted, true);
    await flush();
    assert.notEqual(harness.state.lyricsStatus, 'error');
    assert.deepEqual(harness.state.lyrics, []);
    harness.unmount();
  }
});

test('aborting while waiting to retry settles the loader without a later network request', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  let attempts = 0;
  const loading = harness.load({ currentSong: harness.state.currentSong,
    resolvedHasLyrics: true, getPlayerState: () => harness.state, signal: controller.signal,
    fetchLyrics: async () => { attempts += 1; throw Object.assign(new Error('temporary'), { status: 503 }); },
  });
  await flush();
  controller.abort();
  await loading;
  assert.equal(attempts, 1);
  assert.notEqual(harness.state.lyricsStatus, 'error');
});
