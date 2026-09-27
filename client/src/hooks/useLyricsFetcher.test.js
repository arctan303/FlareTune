import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createLyricIntro,
  createLyricsTranslationPoller,
  createLyricsResultFromResponse,
  fetchLyricsAsset,
  getLyricsRequestKey,
  invalidateLyricsCacheForSong,
  loadLyricsDocumentIntoStore,
  normalizeLyricsResult,
  getTranslationPollRemaining,
  requestLyricsTranslationCompletion,
} from './useLyricsFetcher.js';

const canonicalPayload = ({
  source = 'kugou',
  translation = ['现在 我们脱下鞋子', '走向海边'],
  translationState = translation ? 'ready' : 'missing',
  translationStartedAt = null,
  songId = 'song-1',
} = {}) => ({
  code: 200,
  data: {
    version: 2,
    source,
    format: source === 'kugou' ? 'krc' : 'lrc',
    syncMode: source === 'kugou' ? 'word' : 'line',
    lines: [
      {
        time: 1,
        endTime: 2,
        text: '僕らは今靴を脱ぐ',
        words: [
          { text: '僕ら', startTime: 1, endTime: 1.25 },
          { text: 'は今靴を脱ぐ', startTime: 1.25, endTime: 2 },
        ],
      },
      { time: 2, endTime: 3, text: '海へ歩く' },
    ],
    translation: translation ? {
      source: 'kugou',
      originalTextHash: 'hash-1',
      lines: translation,
    } : null,
    translationAvailable: Boolean(translation),
    translationState,
    translationStartedAt,
    offsetMs: 50,
    provenance: { matchedTitle: '歌', matchedArtist: '歌手' },
    updatedAt: '2026-09-10T00:00:00.000Z',
    songId,
  },
});

const makeResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

function createPlayerHarness(currentSong) {
  const state = {
    currentSong,
    lyricsRefreshRevision: 0,
    lyrics: [],
    lyricsStatus: 'idle',
    translationAvailable: false,
    translationState: 'unavailable',
    translationStartedAt: null,
    resolvedLyricSource: null,
    lyricFormat: 'none',
    lyricSyncMode: 'none',
    lyricIntro: null,
    lyricOffsetMs: 0,
    currentLyricIndex: 0,
    isLyricsLoading: false,
    documentSnapshotCount: 0,
  };
  for (const [method, key] of Object.entries({
    setLyrics: 'lyrics',
    setLyricsStatus: 'lyricsStatus',
    setTranslationAvailable: 'translationAvailable',
    setTranslationState: 'translationState',
    setTranslationStartedAt: 'translationStartedAt',
    setResolvedLyricSource: 'resolvedLyricSource',
    setLyricFormat: 'lyricFormat',
    setLyricSyncMode: 'lyricSyncMode',
    setLyricIntro: 'lyricIntro',
    setLyricOffsetMs: 'lyricOffsetMs',
    setCurrentLyricIndex: 'currentLyricIndex',
    setIsLyricsLoading: 'isLyricsLoading',
  })) {
    state[method] = (value) => { state[key] = value; };
  }
  state.setTranslationSnapshot = ({ available, state: translationState, startedAt }) => {
    state.translationAvailable = Boolean(available);
    state.translationState = translationState;
    state.translationStartedAt = startedAt;
  };
  state.setLyricsDocumentSnapshot = (snapshot) => {
    state.documentSnapshotCount += 1;
    state.lyrics = snapshot.lyrics;
    state.lyricsStatus = snapshot.status;
    state.resolvedLyricSource = snapshot.source;
    state.lyricFormat = snapshot.format;
    state.lyricSyncMode = snapshot.syncMode;
    state.lyricIntro = snapshot.intro;
    state.lyricOffsetMs = snapshot.offsetMs;
    state.translationAvailable = snapshot.translationAvailable;
    state.translationState = snapshot.translationState;
    state.translationStartedAt = snapshot.translationStartedAt;
  };
  return { state, getPlayerState: () => state };
}

function createFakeTimerClock(initialNow) {
  let clock = initialNow;
  let nextId = 0;
  const timers = new Map();
  const setTimer = (callback, delay = 0) => {
    const id = ++nextId;
    timers.set(id, {
      callback,
      dueAt: clock + Math.max(0, Number(delay) || 0),
    });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const advance = async (elapsedMs) => {
    const target = clock + elapsedMs;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      clock = timer.dueAt;
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    clock = target;
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    now: () => clock,
    setTimer,
    clearTimer,
    advance,
    timers,
  };
}

const cloneLyrics = (lyrics) => lyrics.map((line) => ({
  ...line,
  ...(Array.isArray(line.words) ? { words: line.words.map((word) => ({ ...word })) } : {}),
}));

const seedHarnessDocument = (harness, result, lyrics = cloneLyrics(result.lyrics)) => {
  Object.assign(harness.state, {
    lyrics,
    lyricsStatus: result.status,
    resolvedLyricSource: result.source,
    lyricFormat: result.format,
    lyricSyncMode: result.syncMode,
    lyricOffsetMs: result.offsetMs,
    translationAvailable: result.translationAvailable,
    translationState: result.translationState,
    translationStartedAt: result.translationStartedAt,
  });
  return lyrics;
};

test('request identity is one song asset and ignores old viewer/source dimensions', () => {
  const song = { id: 'same / song' };
  assert.equal(getLyricsRequestKey(song, 'kugou', 'auth:a'), 'v3|same%20%2F%20song');
  assert.equal(getLyricsRequestKey(song, 'lrclib', 'anon'), 'v3|same%20%2F%20song');
});

test('one response attaches static translations without changing original word timing', () => {
  const result = createLyricsResultFromResponse(canonicalPayload());
  assert.equal(result.source, 'kugou');
  assert.equal(result.syncMode, 'word');
  assert.equal(result.translationAvailable, true);
  assert.equal(result.lyrics[0].translation, '现在 我们脱下鞋子');
  assert.deepEqual(result.lyrics[0].words, [
    { text: '僕ら', startTime: 1, endTime: 1.25 },
    { text: 'は今靴を脱ぐ', startTime: 1.25, endTime: 2 },
  ]);
  assert.equal(result.offsetMs, 50);
  assert.deepEqual(result.provenance, { matchedTitle: '歌', matchedArtist: '歌手' });
});

test('translation button availability follows actual returned content', () => {
  const withoutTranslation = createLyricsResultFromResponse(canonicalPayload({ translation: null }));
  assert.equal(withoutTranslation.translationAvailable, false);
  assert.equal(withoutTranslation.translationState, 'missing');
  assert.equal('translation' in withoutTranslation.lyrics[0], false);

  const normalized = normalizeLyricsResult({
    status: 'ready',
    syncMode: 'line',
    lyrics: [{ time: 0, text: 'English', translation: '英语' }],
  });
  assert.equal(normalized.translationAvailable, true);
  assert.equal(normalized.translationState, 'ready');
});

test('public translation state is source-agnostic and defensive across all five states', () => {
  const startedAt = '2026-09-11T00:00:00.000Z';
  for (const state of ['missing', 'failed']) {
    const result = createLyricsResultFromResponse(canonicalPayload({ translation: null, translationState: state }));
    assert.equal(result.translationState, state);
    assert.equal(result.translationStartedAt, null);
  }
  const pending = createLyricsResultFromResponse(canonicalPayload({
    translation: null,
    translationState: 'pending',
    translationStartedAt: startedAt,
  }));
  assert.equal(pending.translationState, 'pending');
  assert.equal(pending.translationStartedAt, startedAt);
  assert.equal(createLyricsResultFromResponse(canonicalPayload()).translationState, 'ready');
  assert.equal(
    createLyricsResultFromResponse({ code: 200, data: { status: 'not_needed' } }).translationState,
    'unavailable',
  );
});

test('not-found asset becomes a stable unavailable result', () => {
  const result = createLyricsResultFromResponse({ code: 200, data: { status: 'not_found' } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.translationAvailable, false);
  assert.equal(result.lyrics[0].text, '暂无歌词');
});

test('song-not-found remains an error while lyrics-not-found remains a stable empty state', () => {
  assert.throws(
    () => createLyricsResultFromResponse({ code: 404, reason: 'song_not_found' }, 404),
    (error) => error.status === 404 && error.reason === 'song_not_found',
  );
  const result = createLyricsResultFromResponse({ code: 404, reason: 'lyrics_not_found' }, 404);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.lyrics[0].text, '暂无歌词');
});

test('normal playback performs a fresh songId-only GET on each later visit', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const song = { id: 'single-get-asset' };
  invalidateLyricsCacheForSong(song.id);
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return makeResponse(canonicalPayload({ songId: song.id }));
  };
  try {
    const first = await fetchLyricsAsset(song, 'lrclib', 'auth:user');
    const second = await fetchLyricsAsset(song, 'kugou', 'anon');
    assert.equal(first.translationAvailable, true);
    assert.equal(second.translationAvailable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/lyrics\?songId=single-get-asset$/);
  assert.doesNotMatch(calls[0].url, /source|translation/);
  assert.equal(calls[0].init.credentials, 'include');
});

test('parallel readers share one in-flight GET', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const song = { id: 'singleflight-client' };
  invalidateLyricsCacheForSong(song.id);
  globalThis.fetch = async () => {
    callCount += 1;
    await gate;
    return makeResponse(canonicalPayload({ songId: song.id }));
  };
  try {
    const first = fetchLyricsAsset(song);
    const second = fetchLyricsAsset(song);
    release();
    await Promise.all([first, second]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(callCount, 1);
});

test('a non-JSON upstream failure retains its HTTP status for the retry decision', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token <'); },
  });
  try {
    await assert.rejects(fetchLyricsAsset({ id: 'bad-gateway' }), (error) => error.status === 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an original-only asset is re-read so a later asynchronous translation can appear', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  const song = { id: 'translation-pending' };
  invalidateLyricsCacheForSong(song.id);
  globalThis.fetch = async () => {
    callCount += 1;
    return makeResponse(canonicalPayload({
      songId: song.id,
      translation: callCount === 1 ? null : ['现在 我们脱下鞋子', '走向海边'],
    }));
  };
  try {
    const pending = await fetchLyricsAsset(song);
    const completed = await fetchLyricsAsset(song);
    assert.equal(pending.translationAvailable, false);
    assert.equal(completed.translationAvailable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(callCount, 2);
});

test('member mutation invalidation advances the request epoch and the next visit reads again', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  const song = { id: 'invalidate-asset' };
  invalidateLyricsCacheForSong(song.id);
  globalThis.fetch = async () => {
    callCount += 1;
    return makeResponse(canonicalPayload({ songId: song.id }));
  };
  try {
    await fetchLyricsAsset(song);
    const removed = invalidateLyricsCacheForSong(song.id);
    assert.equal(removed.memory, 0);
    assert.equal(removed.session, 0);
    await fetchLyricsAsset(song);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(callCount, 2);
});

test('store loader publishes original and translation availability atomically', async () => {
  const song = { id: 'loaded', title: '歌', artist: '歌手', language: 'ja' };
  const harness = createPlayerHarness(song);
  await loadLyricsDocumentIntoStore({
    currentSong: song,
    resolvedHasLyrics: true,
    getPlayerState: harness.getPlayerState,
    fetchLyrics: async () => createLyricsResultFromResponse(canonicalPayload()),
  });
  assert.equal(harness.state.lyricsStatus, 'ready');
  assert.equal(harness.state.resolvedLyricSource, 'kugou');
  assert.equal(harness.state.lyricSyncMode, 'word');
  assert.equal(harness.state.translationAvailable, true);
  assert.equal(harness.state.translationState, 'ready');
  assert.equal(harness.state.lyrics[0].translation, '现在 我们脱下鞋子');
  assert.equal(harness.state.isLyricsLoading, false);
});

test('identical pending refreshes preserve the lyrics reference and do not restart lyric presentation', async () => {
  const song = { id: 'loaded', title: '歌', artist: '歌手', language: 'ja' };
  const harness = createPlayerHarness(song);
  const pendingResult = createLyricsResultFromResponse(canonicalPayload({
    translation: null,
    translationState: 'pending',
    translationStartedAt: '2026-09-11T00:00:00.000Z',
  }));
  const existingLyrics = seedHarnessDocument(harness, pendingResult);
  harness.state.currentLyricIndex = 4;
  for (let index = 0; index < 2; index += 1) {
    await loadLyricsDocumentIntoStore({
      currentSong: song,
      resolvedHasLyrics: true,
      getPlayerState: harness.getPlayerState,
      preserveExisting: true,
      fetchLyrics: async () => pendingResult,
    });
    assert.equal(harness.state.lyrics, existingLyrics);
  }
  assert.equal(harness.state.currentLyricIndex, 4);
  assert.equal(harness.state.isLyricsLoading, false);
});

test('ready refresh injects translation without replacing original lyric timing', async () => {
  const song = { id: 'loaded', title: '歌', artist: '歌手', language: 'ja' };
  const harness = createPlayerHarness(song);
  const pendingResult = createLyricsResultFromResponse(canonicalPayload({
    translation: null,
    translationState: 'pending',
    translationStartedAt: '2026-09-11T00:00:00.000Z',
  }));
  const existingLyrics = cloneLyrics(pendingResult.lyrics);
  existingLyrics[1] = { ...existingLyrics[1], translation: '过期译文' };
  seedHarnessDocument(harness, pendingResult, existingLyrics);
  const originalLine = existingLyrics[0];
  const words = originalLine.words;
  harness.state.currentLyricIndex = 4;

  await loadLyricsDocumentIntoStore({
    currentSong: song,
    resolvedHasLyrics: true,
    getPlayerState: harness.getPlayerState,
    preserveExisting: true,
    fetchLyrics: async () => createLyricsResultFromResponse(canonicalPayload({
      translation: ['现在 我们脱下鞋子', ''],
    })),
  });

  assert.equal(harness.state.lyrics[0].text, '僕らは今靴を脱ぐ');
  assert.equal(harness.state.lyrics[0].translation, '现在 我们脱下鞋子');
  assert.equal(harness.state.lyrics[0].time, 1);
  assert.equal(harness.state.lyrics[0].endTime, 2);
  assert.equal(harness.state.lyrics[0].words, words);
  assert.notEqual(harness.state.lyrics[0], originalLine);
  assert.equal('translation' in harness.state.lyrics[1], false, 'ready response clears an explicitly empty stale line');
  assert.equal(harness.state.resolvedLyricSource, 'kugou');
  assert.equal(harness.state.lyricSyncMode, 'word');
  assert.equal(harness.state.translationState, 'ready');
  assert.equal(harness.state.currentLyricIndex, 4);
  assert.equal(harness.state.isLyricsLoading, false);
});

test('pending refresh atomically replaces the full document when any original identity field changes', async () => {
  const song = { id: 'loaded', title: '歌', artist: '歌手', language: 'ja' };
  const startedAt = '2026-09-11T00:00:00.000Z';
  const createPending = () => createLyricsResultFromResponse(canonicalPayload({
    translation: null,
    translationState: 'pending',
    translationStartedAt: startedAt,
  }));
  const variants = [
    ['text', (result) => { result.lyrics[0] = { ...result.lyrics[0], text: 'changed' }; }],
    ['time', (result) => { result.lyrics[0] = { ...result.lyrics[0], time: 1.1 }; }],
    ['endTime', (result) => { result.lyrics[0] = { ...result.lyrics[0], endTime: 2.1 }; }],
    ['words', (result) => {
      result.lyrics[0] = {
        ...result.lyrics[0],
        words: result.lyrics[0].words.map((word, index) => (
          index === 0 ? { ...word, endTime: word.endTime + 0.1 } : word
        )),
      };
    }],
    ['source', (result) => { result.source = 'lrclib'; }],
    ['format', (result) => { result.format = 'lrc'; }],
    ['syncMode', (result) => { result.syncMode = 'line'; }],
    ['offset', (result) => { result.offsetMs += 50; }],
  ];

  for (const [name, mutate] of variants) {
    const baseline = createPending();
    const incoming = createPending();
    mutate(incoming);
    const harness = createPlayerHarness(song);
    const previousLyrics = seedHarnessDocument(harness, baseline);
    harness.state.currentLyricIndex = 3;

    await loadLyricsDocumentIntoStore({
      currentSong: song,
      resolvedHasLyrics: true,
      getPlayerState: harness.getPlayerState,
      preserveExisting: true,
      fetchLyrics: async () => incoming,
    });

    assert.notEqual(harness.state.lyrics, previousLyrics, `${name} must not use translation-only merge`);
    assert.equal(harness.state.lyrics, incoming.lyrics, `${name} applies the canonical lines`);
    assert.equal(harness.state.resolvedLyricSource, incoming.source);
    assert.equal(harness.state.lyricFormat, incoming.format);
    assert.equal(harness.state.lyricSyncMode, incoming.syncMode);
    assert.equal(harness.state.lyricOffsetMs, incoming.offsetMs);
    assert.equal(harness.state.currentLyricIndex, 3);
    assert.equal(harness.state.documentSnapshotCount, 1, `${name} applies one atomic snapshot`);
  }
});

test('translation completion requires login and coalesces repeated administrator clicks', async () => {
  const song = { id: 'translate-me' };
  const harness = createPlayerHarness(song);
  harness.state.translationState = 'missing';
  let writes = 0;
  const messages = [];
  const guest = await requestLyricsTranslationCompletion({
    songId: song.id,
    authenticated: false,
    getPlayerState: harness.getPlayerState,
    completeTranslation: async () => { writes += 1; },
    notify: (message) => messages.push(message),
  });
  assert.equal(guest.state, 'login_required');
  assert.equal(writes, 0);
  assert.deepEqual(messages, ['请先登录后补全歌词翻译']);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const completeTranslation = async () => {
    writes += 1;
    await gate;
    return { data: { status: 'started', translationStartedAt: '2026-09-11T00:00:00.000Z' } };
  };
  const first = requestLyricsTranslationCompletion({
    songId: song.id,
    authenticated: true,
    getPlayerState: harness.getPlayerState,
    completeTranslation,
    now: () => Date.parse('2026-09-11T00:00:00.000Z'),
  });
  const second = requestLyricsTranslationCompletion({
    songId: song.id,
    authenticated: true,
    getPlayerState: harness.getPlayerState,
    completeTranslation,
  });
  assert.equal(harness.state.translationState, 'pending');
  assert.equal(writes, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(harness.state.translationStartedAt, '2026-09-11T00:00:00.000Z');
});

test('translation polling uses the server start window, pauses while hidden and refreshes on return', async () => {
  const startedAt = '2026-09-11T00:00:00.000Z';
  let clock = Date.parse(startedAt);
  assert.equal(getTranslationPollRemaining(startedAt, clock), 30_000);
  assert.equal(getTranslationPollRemaining(startedAt, clock + 29_500), 500);
  assert.equal(getTranslationPollRemaining(startedAt, clock + 31_000), 0);

  const song = { id: 'poll-me' };
  const harness = createPlayerHarness(song);
  harness.state.translationState = 'pending';
  harness.state.translationStartedAt = startedAt;
  const timers = new Map();
  let nextTimer = 0;
  const listeners = new Map();
  const documentTarget = {
    visibilityState: 'visible',
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  };
  let loads = 0;
  let latestSignal;
  let finishLoad;
  const loadGate = new Promise((resolve) => { finishLoad = resolve; });
  const poller = createLyricsTranslationPoller({
    songId: song.id,
    lyricsRefreshRevision: 0,
    startedAt,
    getPlayerState: harness.getPlayerState,
    documentTarget,
    now: () => clock,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    loadDocument: async (signal) => {
      loads += 1;
      latestSignal = signal;
      await loadGate;
    },
  });
  assert.equal([...timers.values()][0].delay, 2_000);
  documentTarget.visibilityState = 'hidden';
  listeners.get('visibilitychange')();
  assert.equal(timers.size, 1, 'hiding cancels poll work but keeps the independent deadline armed');
  assert.equal([...timers.values()][0].delay, 30_000);
  documentTarget.visibilityState = 'visible';
  listeners.get('visibilitychange')();
  assert.equal(loads, 1, 'becoming visible performs an immediate same-song read');
  assert.equal(latestSignal.aborted, false);
  poller.stop();
  assert.equal(latestSignal.aborted, true);
  assert.equal(listeners.size, 0);
  finishLoad();
  await Promise.resolve();
});

test('translation polling performs one final read at the server deadline and then stops', async () => {
  const startedAt = '2026-09-11T00:00:00.000Z';
  const fakeTime = createFakeTimerClock(Date.parse(startedAt) + 29_500);
  const song = { id: 'poll-deadline' };
  const harness = createPlayerHarness(song);
  harness.state.translationState = 'pending';
  harness.state.translationStartedAt = startedAt;
  let loads = 0;
  createLyricsTranslationPoller({
    songId: song.id,
    lyricsRefreshRevision: 0,
    startedAt,
    getPlayerState: harness.getPlayerState,
    documentTarget: null,
    now: fakeTime.now,
    setTimer: fakeTime.setTimer,
    clearTimer: fakeTime.clearTimer,
    loadDocument: async () => { loads += 1; },
  });
  assert.deepEqual(
    [...fakeTime.timers.values()].map((timer) => timer.dueAt - fakeTime.now()),
    [500, 500],
  );
  await fakeTime.advance(500);
  assert.equal(loads, 1);
  assert.equal(harness.state.translationState, 'failed');
  assert.equal(harness.state.translationStartedAt, null);
  assert.equal(fakeTime.timers.size, 0);
});

test('translation polling has a hard deadline when a read ignores abort and never settles', async () => {
  const startedAt = '2026-09-11T00:00:00.000Z';
  const fakeTime = createFakeTimerClock(Date.parse(startedAt));
  const song = { id: 'poll-never-settles' };
  const harness = createPlayerHarness(song);
  harness.state.translationState = 'pending';
  harness.state.translationStartedAt = startedAt;
  let loads = 0;
  let signal;
  const neverSettles = new Promise(() => {});
  createLyricsTranslationPoller({
    songId: song.id,
    lyricsRefreshRevision: 0,
    startedAt,
    getPlayerState: harness.getPlayerState,
    documentTarget: null,
    now: fakeTime.now,
    setTimer: fakeTime.setTimer,
    clearTimer: fakeTime.clearTimer,
    loadDocument: async (nextSignal) => {
      loads += 1;
      signal = nextSignal;
      await neverSettles;
    },
  });

  await fakeTime.advance(2_000);
  assert.equal(loads, 1);
  assert.equal(signal.aborted, false);
  await fakeTime.advance(28_000);
  assert.equal(signal.aborted, true, 'the independent deadline aborts the active read');
  assert.equal(harness.state.translationState, 'failed');
  assert.equal(harness.state.translationStartedAt, null);
  assert.equal(fakeTime.timers.size, 0, 'no polling remains after the hard deadline');
});

test('translation polling ignores an abort-insensitive read that settles after the hard deadline', async () => {
  const startedAt = '2026-09-11T00:00:00.000Z';
  const fakeTime = createFakeTimerClock(Date.parse(startedAt));
  const song = { id: 'poll-late-settle' };
  const harness = createPlayerHarness(song);
  const pendingResult = createLyricsResultFromResponse(canonicalPayload({
    songId: song.id,
    translation: ['旧译文一', '旧译文二'],
    translationState: 'pending',
    translationStartedAt: startedAt,
  }));
  seedHarnessDocument(harness, pendingResult);
  const readyResult = createLyricsResultFromResponse(canonicalPayload({
    songId: song.id,
    translation: ['迟到的新译文一', '迟到的新译文二'],
  }));
  let signal;
  let release;
  const ignoredAbortGate = new Promise((resolve) => { release = resolve; });
  createLyricsTranslationPoller({
    songId: song.id,
    lyricsRefreshRevision: 0,
    startedAt,
    getPlayerState: harness.getPlayerState,
    documentTarget: null,
    now: fakeTime.now,
    setTimer: fakeTime.setTimer,
    clearTimer: fakeTime.clearTimer,
    loadDocument: async (nextSignal) => {
      signal = nextSignal;
      await loadLyricsDocumentIntoStore({
        currentSong: song,
        resolvedHasLyrics: true,
        getPlayerState: harness.getPlayerState,
        lyricsRefreshRevision: 0,
        preserveExisting: true,
        isCancelled: () => nextSignal.aborted,
        fetchLyrics: async () => {
          await ignoredAbortGate;
          return readyResult;
        },
      });
    },
  });

  await fakeTime.advance(2_000);
  await fakeTime.advance(28_000);
  assert.equal(signal.aborted, true);
  assert.equal(harness.state.translationState, 'ready', 'an existing translation survives timeout');
  assert.equal(harness.state.translationStartedAt, null);
  assert.equal(harness.state.lyrics[0].translation, '旧译文一');
  release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.state.translationState, 'ready');
  assert.equal(harness.state.translationStartedAt, null);
  assert.equal(harness.state.lyrics[0].translation, '旧译文一', 'the aborted loader cannot apply its late document');
  assert.equal(harness.state.documentSnapshotCount, 0);
  assert.equal(fakeTime.timers.size, 0, 'the late settlement cannot restart polling');
});

test('translation deadline does not project state after stop, song change or revision change', async (context) => {
  const startedAt = '2026-09-11T00:00:00.000Z';
  for (const scenario of ['stop', 'song', 'revision']) {
    await context.test(scenario, async () => {
      const fakeTime = createFakeTimerClock(Date.parse(startedAt));
      const song = { id: `poll-${scenario}` };
      const harness = createPlayerHarness(song);
      harness.state.translationState = 'pending';
      harness.state.translationStartedAt = startedAt;
      let signal;
      const poller = createLyricsTranslationPoller({
        songId: song.id,
        lyricsRefreshRevision: 0,
        startedAt,
        getPlayerState: harness.getPlayerState,
        documentTarget: null,
        now: fakeTime.now,
        setTimer: fakeTime.setTimer,
        clearTimer: fakeTime.clearTimer,
        loadDocument: async (nextSignal) => {
          signal = nextSignal;
          await new Promise(() => {});
        },
      });
      await fakeTime.advance(2_000);
      if (scenario === 'stop') poller.stop();
      if (scenario === 'song') harness.state.currentSong = { id: 'replacement-song' };
      if (scenario === 'revision') harness.state.lyricsRefreshRevision = 1;
      await fakeTime.advance(28_000);
      assert.equal(harness.state.translationState, 'pending');
      assert.equal(harness.state.translationStartedAt, startedAt);
      if (scenario === 'stop') {
        assert.equal(signal.aborted, true);
        assert.equal(fakeTime.timers.size, 0);
      }
    });
  }
});

test('instrumental language short-circuits before any lyric request', async () => {
  const song = { id: 'instrumental', language: 'instrumental' };
  const harness = createPlayerHarness(song);
  let fetchCount = 0;
  await loadLyricsDocumentIntoStore({
    currentSong: song,
    resolvedHasLyrics: false,
    getPlayerState: harness.getPlayerState,
    fetchLyrics: async () => { fetchCount += 1; },
  });
  assert.equal(fetchCount, 0);
  assert.equal(harness.state.lyricsStatus, 'none');
  assert.equal(harness.state.translationAvailable, false);
  assert.equal(harness.state.lyrics[0].text, '纯音乐，请欣赏');
});

test('stale song response cannot overwrite the current song state', async () => {
  const song = { id: 'old', language: 'en' };
  const harness = createPlayerHarness(song);
  let resolveLyrics;
  const pending = loadLyricsDocumentIntoStore({
    currentSong: song,
    resolvedHasLyrics: true,
    getPlayerState: harness.getPlayerState,
    fetchLyrics: () => new Promise((resolve) => { resolveLyrics = resolve; }),
  });
  harness.state.currentSong = { id: 'new', language: 'en' };
  resolveLyrics(createLyricsResultFromResponse(canonicalPayload()));
  await pending;
  assert.deepEqual(harness.state.lyrics, []);
});

test('a temporary lyric service failure retries without publishing no-lyrics and then displays the document', async () => {
  const song = { id: 'temporary-failure', language: 'en' };
  const harness = createPlayerHarness(song);
  const retryDelays = [];
  let fetchCount = 0;
  const pending = loadLyricsDocumentIntoStore({
    currentSong: song,
    resolvedHasLyrics: true,
    getPlayerState: harness.getPlayerState,
    fetchLyrics: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        const error = new Error('Lyric source temporarily unavailable');
        error.status = 503;
        throw error;
      }
      return createLyricsResultFromResponse(canonicalPayload());
    },
    waitBeforeRetry: async (delayMs) => {
      retryDelays.push(delayMs);
      assert.equal(harness.state.lyricsStatus, 'loading');
      assert.deepEqual(harness.state.lyrics, []);
      assert.equal(harness.state.isLyricsLoading, true);
    },
  });
  await pending;
  assert.equal(fetchCount, 2);
  assert.deepEqual(retryDelays, [1_500]);
  assert.equal(harness.state.lyricsStatus, 'ready');
  assert.equal(harness.state.lyrics[0].text, '僕らは今靴を脱ぐ');
  assert.equal(harness.state.isLyricsLoading, false);
});

test('repeated lyric service failures end in an error rather than no-lyrics', async () => {
  const song = { id: 'lasting-failure', language: 'en' };
  const harness = createPlayerHarness(song);
  let fetchCount = 0;
  const reported = [];
  await loadLyricsDocumentIntoStore({
    currentSong: song,
    resolvedHasLyrics: true,
    getPlayerState: harness.getPlayerState,
    fetchLyrics: async () => {
      fetchCount += 1;
      const error = new Error('Lyric source temporarily unavailable');
      error.status = 503;
      throw error;
    },
    waitBeforeRetry: async () => {},
    reportError: (...args) => reported.push(args),
  });
  assert.equal(fetchCount, 3);
  assert.equal(reported.length, 1);
  assert.equal(harness.state.lyricsStatus, 'error');
  assert.equal(harness.state.lyrics[0].text, '歌词加载失败');
  assert.equal(harness.state.isLyricsLoading, false);
});

test('a confirmed lyric miss does not retry', async () => {
  const song = { id: 'confirmed-miss', language: 'en' };
  const harness = createPlayerHarness(song);
  let fetchCount = 0;
  await loadLyricsDocumentIntoStore({
    currentSong: song,
    resolvedHasLyrics: true,
    getPlayerState: harness.getPlayerState,
    fetchLyrics: async () => {
      fetchCount += 1;
      return createLyricsResultFromResponse({ code: 404, reason: 'lyrics_not_found' }, 404);
    },
    waitBeforeRetry: async () => { throw new Error('Unexpected retry'); },
  });
  assert.equal(fetchCount, 1);
  assert.equal(harness.state.lyricsStatus, 'unavailable');
  assert.equal(harness.state.lyrics[0].text, '暂无歌词');
});

test('the normal lyric hook stays source-agnostic while polling only an explicit pending state', () => {
  const source = readFileSync(new URL('./useLyricsFetcher.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /lyricSource|translationStatus|requestAiTranslation|\/api\/lyrics\/translation|source=/);
  assert.match(source, /\/api\/lyrics\?songId=/);
  assert.match(source, /state\.translationState === 'pending'/);
  assert.match(source, /preserveExisting: true/);
  assert.match(source, /documentTarget\?\.addEventListener\?\.\('visibilitychange'/);
});
