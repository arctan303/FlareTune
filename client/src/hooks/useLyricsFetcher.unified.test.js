import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLyricsResultFromResponse,
  createLyricsTranslationPoller,
  fetchLyricsAsset,
  loadLyricsDocumentIntoStore,
  requestLyricsTranslationCompletion,
} from './useLyricsFetcher.js';
import {
  canonicalPayload, createFakeTimerClock, createPlayerHarness, makeResponse,
} from './useLyricsFetcher.test-fixtures.js';

test('new lyric responses declare translation capability independently from content and source', () => {
  const payload = canonicalPayload({ source: 'plugin:third-party-lyrics', translation: null });
  payload.data.sourceId = 'third-party-lyrics';
  payload.data.resultRef = 'signed-provider-result';
  payload.data.translation = { supported: true, state: 'idle', lines: [] };
  const result = createLyricsResultFromResponse(payload);
  assert.equal(result.translationSupported, true);
  assert.equal(result.translationAvailable, false);
  assert.equal(result.translationState, 'idle');
  assert.equal(result.resultRef, 'signed-provider-result');
  assert.equal(result.sourceId, 'third-party-lyrics');
  const disabled = canonicalPayload();
  disabled.data.translation.supported = false;
  assert.equal(createLyricsResultFromResponse(disabled).translationSupported, false,
    'returned text must not override the provider capability declaration');
});

test('translation failure preserves its backend message and available original', () => {
  const payload = canonicalPayload({ translation: null });
  payload.data.translation = { supported: true, state: 'failed', error: { code: 'alignment_failed', message: '源返回的译文无法对应正文。' } };
  const result = createLyricsResultFromResponse(payload);
  assert.equal(result.status, 'ready');
  assert.equal(result.lyrics[0].text, '僕らは今靴を脱ぐ');
  assert.equal(result.translationSupported, true);
  assert.equal(result.translationState, 'failed');
  assert.equal(result.translationError.message, '源返回的译文无法对应正文。');
});

test('an older document without a result reference never invokes translation mutation', async () => {
  const harness = createPlayerHarness({ id: 'legacy-document' });
  harness.state.translationState = 'missing';
  let calls = 0;
  const result = await requestLyricsTranslationCompletion({ songId: 'legacy-document', authenticated: true,
    getPlayerState: harness.getPlayerState, completeTranslation: async () => { calls++; } });
  assert.equal(result.state, 'unavailable');
  assert.equal(calls, 0);
});

test('translation submission passes the signed result reference and ignores a replaced document', async () => {
  const harness = createPlayerHarness({ id: 'reference-owner' });
  Object.assign(harness.state, { translationState: 'idle', translationSupported: true, lyricsResultRef: 'signed-first-result' });
  let sent, finish;
  const pending = requestLyricsTranslationCompletion({ songId: 'reference-owner', authenticated: true,
    getPlayerState: harness.getPlayerState, completeTranslation: ref => {
      sent = ref; return new Promise(resolve => { finish = resolve; });
    } });
  assert.equal(sent, 'signed-first-result');
  harness.state.lyricsResultRef = 'signed-new-result';
  harness.state.translationState = 'ready';
  finish(canonicalPayload({ translation: null, translationState: 'failed' }));
  await pending;
  assert.equal(harness.state.translationState, 'ready');
});

test('signed-result polling retains pending beyond the old deadline and stops on server readiness', async () => {
  const startedAt = '2026-09-11T00:00:00.000Z';
  const fakeTime = createFakeTimerClock(Date.parse(startedAt));
  const harness = createPlayerHarness({ id: 'long-native-translation' });
  Object.assign(harness.state, { translationState: 'pending', lyricsResultRef: 'signed-poll-result' });
  let loads = 0;
  const poller = createLyricsTranslationPoller({ songId: 'long-native-translation', lyricsRefreshRevision: 0,
    resultRef: 'signed-poll-result', startedAt, getPlayerState: harness.getPlayerState, documentTarget: null,
    now: fakeTime.now, setTimer: fakeTime.setTimer, clearTimer: fakeTime.clearTimer,
    loadDocument: async () => { loads++; if (loads === 18) harness.state.translationState = 'ready'; } });
  await fakeTime.advance(31_000);
  assert.equal(harness.state.translationState, 'pending');
  await fakeTime.advance(10_000);
  assert.equal(harness.state.translationState, 'ready');
  poller.stop();
  assert.equal(fakeTime.timers.size, 0);
});

test('an earlier account playback cannot publish a lyric result for the same song', async () => {
  const song = { id: 'same-song-new-account' }, harness = createPlayerHarness(song);
  harness.state.playbackOwnershipGeneration = 1;
  let release;
  const waiting = loadLyricsDocumentIntoStore({ currentSong: song, resolvedHasLyrics: true,
    getPlayerState: harness.getPlayerState,
    fetchLyrics: () => new Promise(resolve => { release = () => resolve(createLyricsResultFromResponse(canonicalPayload())); }),
  });
  harness.state.playbackOwnershipGeneration = 2;
  harness.state.lyrics = [{ time: 0, text: 'Current account lyrics' }];
  release(); await waiting;
  assert.equal(harness.state.lyrics[0].text, 'Current account lyrics');
});

test('a polling read sends the signed source reference without changing the song identity', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  try {
    globalThis.fetch = async url => { requestUrl = url; return makeResponse(canonicalPayload()); };
    await fetchLyricsAsset({ id: 'yt:WqkrwFSFeAE' }, { resultRef: 'signed.source/result' });
    const query = new URL(requestUrl, 'https://example.test').searchParams;
    assert.equal(query.get('songId'), 'yt:WqkrwFSFeAE');
    assert.equal(query.get('resultRef'), 'signed.source/result');
  } finally { globalThis.fetch = originalFetch; }
});

test('late translation completion cannot modify or notify a new owner reusing the same cached song', async () => {
  for (const failure of [false, true]) {
    const song = { id: `same-owner-fixture-${failure}` }, harness = createPlayerHarness(song), notices = [];
    harness.state.translationState = 'missing'; harness.state.playbackOwnershipGeneration = 1;
    harness.state.lyricsResultRef = 'signed-old-owner-result'; harness.state.translationSupported = true;
    let settle;
    const pending = requestLyricsTranslationCompletion({ songId: song.id, authenticated: true,
      getPlayerState: harness.getPlayerState, notify: value => notices.push(value),
      completeTranslation: () => new Promise((resolve, reject) => { settle = () => failure
        ? reject(new Error('Old session failed')) : resolve({ data: { status: 'not_needed' } }); }) });
    harness.state.playbackOwnershipGeneration = 2;
    harness.state.translationState = 'ready'; harness.state.translationAvailable = true;
    settle(); await pending;
    assert.equal(harness.state.translationState, 'ready'); assert.equal(harness.state.translationAvailable, true);
    assert.deepEqual(notices, []);
  }
});
