import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { songLanguageHasLyrics } from '../constants/language.js';
import { getLyricVocalStart } from '../utils/lyricTimeline.js';
import * as lyricSources from '../../../shared/lyricSources.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createHarness({ failFirst = false } = {}) {
  const state = { currentSong: { id: 'first', language: 'en' }, lyricsRefreshRevision: 0,
    translationState: 'unavailable', translationStartedAt: null, lyrics: [] };
  for (const [setter, field] of Object.entries({
    setLyrics: 'lyrics', setLyricsStatus: 'lyricsStatus', setCurrentLyricIndex: 'currentLyricIndex',
    setIsLyricsLoading: 'isLyricsLoading', setResolvedLyricSource: 'resolvedLyricSource',
    setLyricFormat: 'lyricFormat', setLyricSyncMode: 'lyricSyncMode',
    setLyricOffsetMs: 'lyricOffsetMs',
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
    '../../../shared/lyricSources.js': lyricSources,
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


test('YT unknown-language playback requests canonical lyrics and displays untimed YouTube text', async () => {
  const harness = createHarness();
  harness.state.currentSong = { id: 'yt:QBtVFL0Qefs', source: 'youtube', language: null, has_lyrics: 0 };
  harness.render();
  assert.equal(harness.requests.length, 1, 'unknown metadata must not short-circuit as instrumental');
  assert.equal(harness.requests[0].url, '/api/lyrics?songId=yt%3AQBtVFL0Qefs');
  const lines = [{ text: 'Oops!... I did it again' }, { text: 'I played with your heart' }];
  harness.requests[0].resolve({ status: 200, json: async () => ({ code: 200, data: {
    version: 2, source: 'youtube', format: 'plain', syncMode: 'none', lines, translationState: 'unavailable',
  } }) });
  await flush();
  assert.equal(harness.state.lyricsStatus, 'ready');
  assert.deepEqual(harness.state.lyrics, lines);
  assert.equal(Object.hasOwn(harness.state.lyrics[0], 'time'), false, 'no timestamps are invented');
  assert.equal(harness.state.isLyricsLoading, false);
  harness.unmount();
});

test('YT unknown-language lyrics not found remains unavailable, rather than labelled instrumental', async () => {
  const harness = createHarness();
  harness.state.currentSong = { id: 'yt:QBtVFL0Qefs', source: 'youtube', language: null };
  harness.render();
  assert.equal(harness.requests.length, 1);
  harness.requests[0].resolve({ status: 200, json: async () => ({ code: 200, data: { status: 'not_found' } }) });
  await flush();
  assert.equal(harness.state.lyricsStatus, 'unavailable');
  assert.equal(harness.state.lyrics[0].text, '暂无歌词');
  harness.unmount();
});

test('the global lyric hook still skips requests for an explicitly instrumental local song', () => {
  const harness = createHarness();
  harness.state.currentSong = { id: 'local-instrumental', language: 'instrumental' };
  harness.render();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.state.lyricsStatus, 'none');
  assert.equal(harness.state.lyrics[0].text, '纯音乐，请欣赏');
  harness.unmount();
});
