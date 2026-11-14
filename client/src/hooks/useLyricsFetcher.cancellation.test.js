import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { songLanguageHasLyrics } from '../constants/language.js';
import { getLyricVocalStart } from '../utils/lyricTimeline.js';
import * as lyricSources from '../../../shared/lyricSources.js';
import { createFakeTimerClock } from './useLyricsFetcher.test-fixtures.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createHarness({ failFirst = false, ignoreAbort = false, completeTranslation, clock } = {}) {
  const state = { currentSong: { id: 'first', language: 'en' }, lyricsRefreshRevision: 0,
    playbackOwnershipGeneration: 0, translationState: 'unavailable', translationStartedAt: null, lyrics: [] };
  for (const [setter, field] of Object.entries({
    setLyrics: 'lyrics', setLyricsStatus: 'lyricsStatus', setCurrentLyricIndex: 'currentLyricIndex',
    setIsLyricsLoading: 'isLyricsLoading', setResolvedLyricSource: 'resolvedLyricSource',
    setLyricFormat: 'lyricFormat', setLyricSyncMode: 'lyricSyncMode',
    setLyricOffsetMs: 'lyricOffsetMs',
    setLyricsResultRef: 'lyricsResultRef', setLyricSourceId: 'lyricSourceId',
  })) state[setter] = (value) => { state[field] = value; };
  state.setTranslationSnapshot = ({ available, supported, state: status, startedAt, error }) => {
    state.translationAvailable = available; state.translationState = status; state.translationStartedAt = startedAt;
    if (supported !== undefined) state.translationSupported = supported;
    if (error !== undefined) state.translationError = error;
  };
  state.setLyricsDocumentSnapshot = (snapshot) => {
    state.lyrics = snapshot.lyrics; state.lyricsStatus = snapshot.status;
    state.resolvedLyricSource = snapshot.source; state.lyricFormat = snapshot.format;
    state.lyricSyncMode = snapshot.syncMode; state.lyricOffsetMs = snapshot.offsetMs;
    state.translationAvailable = snapshot.translationAvailable;
    state.translationState = snapshot.translationState;
    state.translationSupported = snapshot.translationSupported;
    state.translationStartedAt = snapshot.translationStartedAt;
    state.lyricsResultRef = snapshot.resultRef;
    state.lyricSourceId = snapshot.sourceId;
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
  const translationRequests = [];
  const modules = {
    react,
    '../../../shared/lyricSources.js': lyricSources,
    '../utils.js': { getApiBaseUrl: () => '' },
    '../store/usePlayerStore.js': { usePlayerStore: store },
    '../constants/language.js': { songLanguageHasLyrics },
    '../i18n/index.js': { getLocale: () => 'en' },
    '../utils/lyricTimeline.js': { getLyricVocalStart },
    '../services/localLyricsWorkspaceApi.js': { lyricsWorkspaceApi: {} },
    '../services/lyricsApi.js': { requestLyricTranslation: async ref => {
      translationRequests.push(ref);
      if (completeTranslation) return completeTranslation(ref);
      return { data: { status: 'started', translationStartedAt: new Date().toISOString() } };
    } },
    '../services/authenticatedFetch.js': { authenticatedFetch(url, options) {
      return new Promise((resolve, reject) => {
        const request = { url, signal: options.signal, headers: options.headers, credentials: options.credentials, resolve, reject };
        requests.push(request);
        if (!ignoreAbort) options.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
        if (failFirst && requests.length === 1) reject(Object.assign(new Error('temporary'), { status: 503 }));
      });
    } },
  };
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL('./useLyricsFetcher.js', import.meta.url), 'utf8'), {
    loader: 'js', format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', code)(
    (name) => modules[name], module, module.exports, clock?.setTimer || setTimeout, clock?.clearTimer || clearTimeout);
  return {
    state, requests, translationRequests,
    render(enabled = true) { cursor = 0; module.exports.useLyricsFetcher({ enabled }); },
    unmount() { effects.forEach((effect) => effect?.cleanup?.()); },
    load: module.exports.loadLyricsDocumentIntoStore,
  };
}

const response = (text) => ({ status: 200, json: async () => ({ code: 200, data: {
  version: 2, source: 'manual', format: 'lrc', syncMode: 'line',
  lines: [{ time: 0, text }], translationState: 'unavailable',
} }) });

const sourcePayload = (text, resultRef, state = 'pending') => ({ code: 200, data: {
  version: 2, source: 'plugin:example', sourceId: 'example', resultRef,
  format: 'lrc', syncMode: 'line', lines: [{ time: 0, text }],
  translation: { supported: true, state, lines: state === 'ready' ? ['Current translation'] : [] },
  translationAvailable: state === 'ready',
} });

test('playback ownership changes restart a restored same-object song request and settle its loading state', async () => {
  const h = createHarness({ ignoreAbort: true }), song = h.state.currentSong;
  h.render();
  const old = h.requests[0];
  h.state.playbackOwnershipGeneration++;
  h.render();
  assert.equal(h.state.currentSong, song);
  assert.equal(old.signal.aborted, true);
  assert.equal(h.requests.length, 2);
  old.resolve(response('Retired owner lyrics')); await flush();
  assert.deepEqual(h.state.lyrics, []);
  assert.equal(h.state.isLyricsLoading, true, 'the replacement request retains the loading indicator');
  h.requests[1].resolve(response('Restored owner lyrics')); await flush();
  assert.equal(h.state.lyrics[0].text, 'Restored owner lyrics');
  assert.equal(h.state.lyricsStatus, 'ready');
  assert.equal(h.state.isLyricsLoading, false);
  h.unmount();
});

test('playback ownership changes abort old translation polling and poll the newly selected source result', async () => {
  const clock = createFakeTimerClock(Date.now()), h = createHarness({ ignoreAbort: true, clock });
  const answer = payload => ({ status: 200, json: async () => payload });
  h.render(); h.requests[0].resolve(answer(sourcePayload('Old original', 'old-owner-source')));
  await flush(); h.render(); await clock.advance(2000); await flush();
  const oldPoll = h.requests[1];
  assert.match(oldPoll.url, /resultRef=old-owner-source$/);
  h.state.playbackOwnershipGeneration++; h.render();
  assert.equal(oldPoll.signal.aborted, true);
  assert.equal(h.requests.length, 3);
  oldPoll.resolve(answer(sourcePayload('Old original', 'old-owner-source', 'ready'))); await flush();
  assert.deepEqual(h.state.lyrics, []);
  h.requests[2].resolve(answer(sourcePayload('New original', 'new-owner-source')));
  await flush(); h.render(); await clock.advance(2000); await flush();
  const newPoll = h.requests[3];
  assert.match(newPoll.url, /resultRef=new-owner-source$/);
  newPoll.resolve(answer(sourcePayload('New original', 'new-owner-source', 'ready'))); await flush();
  assert.equal(h.state.lyricsResultRef, 'new-owner-source');
  assert.equal(h.state.lyrics[0].text, 'New original');
  assert.equal(h.state.translationState, 'ready');
  h.unmount(); assert.equal(clock.timers.size, 0);
});

test('playback ownership changes retrigger a retained translation preference without accepting an old completion', async () => {
  const completions = new Map(), clock = createFakeTimerClock(Date.now());
  const h = createHarness({ clock, completeTranslation: ref => new Promise(resolve => completions.set(ref, resolve)) });
  const answer = payload => ({ status: 200, json: async () => payload });
  h.state.translationEnabled = true;
  h.render(); h.requests[0].resolve(answer(sourcePayload('Old original', 'old-preference-source', 'idle')));
  await flush(); h.render(); await flush();
  assert.deepEqual(h.translationRequests, ['old-preference-source']);
  h.state.playbackOwnershipGeneration++; h.render();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(answer(sourcePayload('New original', 'new-preference-source', 'idle')));
  await flush(); h.render(); await flush();
  assert.deepEqual(h.translationRequests, ['old-preference-source', 'new-preference-source']);
  completions.get('old-preference-source')({ data: { status: 'not_needed' } }); await flush();
  assert.equal(h.state.lyricsResultRef, 'new-preference-source');
  assert.equal(h.state.translationState, 'pending');
  completions.get('new-preference-source')(sourcePayload('New original', 'new-preference-source', 'ready'));
  await flush();
  assert.equal(h.state.lyrics[0].text, 'New original');
  assert.equal(h.state.translationState, 'ready');
  h.unmount(); assert.equal(clock.timers.size, 0);
});

test('a retained show-translation preference requests the selected source through its signed result', async () => {
  const harness = createHarness();
  harness.state.translationEnabled = true;
  harness.render();
  harness.requests[0].resolve({ status: 200, json: async () => ({ code: 200, data: {
    version: 2, source: 'plugin:example', sourceId: 'example', resultRef: 'opaque-source-result',
    format: 'lrc', syncMode: 'line', lines: [{ time: 0, text: 'Original lyrics' }],
    translation: { supported: true, state: 'idle', lines: [] }, translationAvailable: false,
  } }) });
  await flush();
  harness.render();
  await flush();
  assert.deepEqual(harness.translationRequests, ['opaque-source-result']);
  assert.equal(harness.state.translationState, 'pending');
  harness.render();
  assert.equal(harness.translationRequests.length, 1);
  harness.unmount();
});

test('showing translation does not request a source that declares no capability', async () => {
  const harness = createHarness();
  harness.state.translationEnabled = true;
  harness.render();
  harness.requests[0].resolve({ status: 200, json: async () => ({ code: 200, data: {
    version: 2, source: 'manual', resultRef: 'no-capability', format: 'lrc', syncMode: 'line',
    lines: [{ time: 0, text: 'Original', translation: 'Existing text' }],
    translation: { supported: false, state: 'idle', lines: [] }, translationAvailable: true,
  } }) });
  await flush(); harness.render(); await flush();
  assert.equal(harness.state.translationSupported, false);
  assert.deepEqual(harness.translationRequests, []);
  harness.unmount();
});

test('global lyric consumer survives fullscreen changes and aborts only its superseded song request', async () => {
  const harness = createHarness();
  harness.render();
  assert.equal(harness.requests.length, 1);
  const first = harness.requests[0];
  assert.ok(first.signal instanceof AbortSignal);
  assert.equal(first.headers['Accept-Language'], 'en');
  assert.equal(first.credentials, 'include');
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
