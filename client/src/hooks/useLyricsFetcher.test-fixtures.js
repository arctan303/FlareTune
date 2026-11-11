export const canonicalPayload = ({
  source = 'custom_krc',
  translation = ['现在 我们脱下鞋子', '走向海边'],
  translationState = translation ? 'ready' : 'missing',
  translationStartedAt = null,
  songId = 'song-1',
} = {}) => ({
  code: 200,
  data: {
    version: 2,
    source,
    format: source === 'custom_krc' ? 'krc' : 'lrc',
    syncMode: source === 'custom_krc' ? 'word' : 'line',
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
      source: 'custom_krc',
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

export const makeResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

export function createPlayerHarness(currentSong) {
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
    state.lyricOffsetMs = snapshot.offsetMs;
    state.translationAvailable = snapshot.translationAvailable;
    state.translationState = snapshot.translationState;
    state.translationStartedAt = snapshot.translationStartedAt;
  };
  return { state, getPlayerState: () => state };
}

export function createFakeTimerClock(initialNow) {
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

export const cloneLyrics = (lyrics) => lyrics.map((line) => ({
  ...line,
  ...(Array.isArray(line.words) ? { words: line.words.map((word) => ({ ...word })) } : {}),
}));

export const seedHarnessDocument = (harness, result, lyrics = cloneLyrics(result.lyrics)) => {
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
