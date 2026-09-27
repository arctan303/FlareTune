import test from 'node:test';
import assert from 'node:assert/strict';

const storageValues = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: (key) => storageValues.delete(key),
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: globalThis.localStorage },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    documentElement: {
      classList: { contains: () => false },
    },
  },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {},
});

const { usePlayerStore } = await import('./usePlayerStore.js');
const makeSong = (id) => ({ id, title: id, audio_url: `/${id}.mp3` });

const resetStore = () => {
  usePlayerStore.setState({
    playlist: [],
    currentSong: null,
    isPlaying: false,
    shouldAutoPlay: false,
    playMode: 'sequence',
    audioRef: null,
    lyrics: [],
    lyricsStatus: 'idle',
    resolvedLyricSource: null,
    lyricFormat: 'none',
    lyricSyncMode: 'none',
    lyricIntro: null,
    lyricOffsetMs: 0,
    lyricsRefreshRevision: 0,
    translationAvailable: false,
    translationState: 'unavailable',
    translationStartedAt: null,
    translationEnabled: false,
    randomRoam: {
      enabled: false,
      seenSongIds: [],
      totalPlayable: null,
      remainingPlayable: null,
      exhausted: false,
      status: 'idle',
      error: null,
      retryNonce: 0,
      waitingAtQueueEnd: false,
      resumeWhenAppended: false,
    },
  });
};

test('switching songs resets all resolved lyric document metadata', () => {
  resetStore();
  usePlayerStore.setState({
    currentSong: makeSong('a'),
    resolvedLyricSource: 'kugou',
    lyricFormat: 'krc',
    lyricSyncMode: 'word',
    lyricIntro: { time: 0, text: 'Artist - Song' },
    lyricOffsetMs: 350,
    translationAvailable: true,
    translationState: 'ready',
    translationStartedAt: '2026-09-11T00:00:00.000Z',
  });

  usePlayerStore.getState().setCurrentSong(makeSong('b'));

  const state = usePlayerStore.getState();
  assert.equal(state.resolvedLyricSource, null);
  assert.equal(state.lyricFormat, 'none');
  assert.equal(state.lyricSyncMode, 'none');
  assert.equal(state.lyricIntro, null);
  assert.equal(state.lyricOffsetMs, 0);
  assert.equal(state.translationAvailable, false);
  assert.equal(state.translationState, 'unavailable');
  assert.equal(state.translationStartedAt, null);
});

test('requestLyricsRefresh ignores a non-current song without changing lyric asset state', () => {
  resetStore();
  usePlayerStore.setState({
    currentSong: makeSong('current'),
    lyricsRefreshRevision: 7,
    translationAvailable: true,
    translationState: 'ready',
  });

  assert.equal(usePlayerStore.getState().requestLyricsRefresh('other'), false);
  const state = usePlayerStore.getState();
  assert.equal(state.lyricsRefreshRevision, 7);
  assert.equal(state.translationAvailable, true);
  assert.equal(state.translationState, 'ready');
});

test('requestLyricsRefresh increments only the current song and clears asset translation availability', () => {
  resetStore();
  usePlayerStore.setState({
    currentSong: makeSong('current'),
    lyricsRefreshRevision: 3,
    translationAvailable: true,
    translationState: 'ready',
    translationStartedAt: '2026-09-11T00:00:00.000Z',
    translationEnabled: true,
  });

  assert.equal(usePlayerStore.getState().requestLyricsRefresh('current'), true);
  const state = usePlayerStore.getState();
  assert.equal(state.lyricsRefreshRevision, 4);
  assert.equal(state.translationAvailable, false);
  assert.equal(state.translationState, 'unavailable');
  assert.equal(state.translationStartedAt, null);
  assert.equal(state.translationEnabled, true, 'refresh preserves the user translation preference');
});

test('setTranslationEnabled updates translationEnabled with direct and functional values', () => {
  resetStore();
  const store = usePlayerStore.getState();
  assert.equal(store.translationEnabled, false);
  store.setTranslationEnabled(true);
  assert.equal(usePlayerStore.getState().translationEnabled, true);
  usePlayerStore.getState().setTranslationEnabled(false);
  assert.equal(usePlayerStore.getState().translationEnabled, false);
  usePlayerStore.getState().setTranslationEnabled((prev) => !prev);
  assert.equal(usePlayerStore.getState().translationEnabled, true);
});

test('translation snapshot updates availability, lifecycle state and server start atomically', () => {
  resetStore();
  usePlayerStore.getState().setTranslationSnapshot({
    available: false,
    state: 'pending',
    startedAt: '2026-09-11T00:00:00.000Z',
  });
  let state = usePlayerStore.getState();
  assert.equal(state.translationAvailable, false);
  assert.equal(state.translationState, 'pending');
  assert.equal(state.translationStartedAt, '2026-09-11T00:00:00.000Z');

  usePlayerStore.getState().setTranslationSnapshot({ available: true, state: 'ready', startedAt: null });
  state = usePlayerStore.getState();
  assert.equal(state.translationAvailable, true);
  assert.equal(state.translationState, 'ready');
  assert.equal(state.translationStartedAt, null);
});

test('lyric document snapshot applies original metadata and translation lifecycle in one store update', () => {
  resetStore();
  let updates = 0;
  const unsubscribe = usePlayerStore.subscribe(() => { updates += 1; });
  const lyrics = [{ time: 1, endTime: 2, text: 'line' }];

  usePlayerStore.getState().setLyricsDocumentSnapshot({
    lyrics,
    status: 'ready',
    source: 'kugou',
    format: 'krc',
    syncMode: 'word',
    intro: { time: 0, text: 'Artist - Song' },
    offsetMs: 350,
    translationAvailable: false,
    translationState: 'pending',
    translationStartedAt: '2026-09-11T00:00:00.000Z',
  });
  unsubscribe();

  const state = usePlayerStore.getState();
  assert.equal(updates, 1);
  assert.equal(state.lyrics, lyrics);
  assert.equal(state.resolvedLyricSource, 'kugou');
  assert.equal(state.lyricFormat, 'krc');
  assert.equal(state.lyricSyncMode, 'word');
  assert.equal(state.lyricOffsetMs, 350);
  assert.equal(state.translationState, 'pending');
  assert.equal(state.translationStartedAt, '2026-09-11T00:00:00.000Z');
});

test('patchSongMetadata updates current song and playlist without creating a ghost queue state', () => {
  resetStore();
  const songs = ['a', 'b'].map(makeSong);
  usePlayerStore.setState({ currentSong: songs[0], playlist: songs });

  usePlayerStore.getState().patchSongMetadata('a', { language: 'en' });

  const state = usePlayerStore.getState();
  assert.equal(state.currentSong.language, 'en');
  assert.equal(state.playlist[0].language, 'en');
  assert.equal(Object.hasOwn(state, 'queue'), false);
});

test('starting random roam replaces the queue, uses sequence mode and marks the first batch seen', () => {
  resetStore();
  const songs = ['a', 'b', 'c'].map(makeSong);
  assert.equal(usePlayerStore.getState().startRandomRoam(songs), true);
  const state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((song) => song.id), ['a', 'b', 'c']);
  assert.equal(state.currentSong.id, 'a');
  assert.equal(state.playMode, 'sequence');
  assert.equal(state.randomRoam.enabled, true);
  assert.deepEqual(state.randomRoam.seenSongIds, ['a', 'b', 'c']);
});

test('random roam appends only unseen songs and resumes after waiting at the old queue end', () => {
  resetStore();
  const songs = ['a', 'b'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);
  usePlayerStore.setState((state) => ({
    currentSong: songs[1],
    isPlaying: false,
    randomRoam: { ...state.randomRoam, waitingAtQueueEnd: true, resumeWhenAppended: true },
  }));

  usePlayerStore.getState().appendRandomRoamBatch([makeSong('b'), makeSong('c')], {
    totalPlayable: 3,
    remainingPlayable: 0,
    exhausted: true,
  });
  const state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((song) => song.id), ['a', 'b', 'c']);
  assert.deepEqual(state.randomRoam.seenSongIds, ['a', 'b', 'c']);
  assert.equal(state.currentSong.id, 'c');
  assert.equal(state.isPlaying, true);
  assert.equal(state.randomRoam.waitingAtQueueEnd, false);
});

test('random roam stops after the final queued song ends', () => {
  resetStore();
  const songs = ['a', 'b'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);
  usePlayerStore.setState((state) => ({
    currentSong: songs[1],
    randomRoam: { ...state.randomRoam, totalPlayable: 2, remainingPlayable: 0, exhausted: true },
  }));

  usePlayerStore.getState().playNext({ type: 'ended', stopPropagation() {} });
  const state = usePlayerStore.getState();
  assert.equal(state.isPlaying, false);
  assert.equal(state.randomRoam.enabled, false);
  assert.equal(state.randomRoam.status, 'exhausted');
});

test('replacing the queue or changing away from sequence resets an active roam round', () => {
  resetStore();
  const songs = ['a', 'b'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);
  usePlayerStore.getState().playSong(makeSong('x'), [makeSong('x')]);
  assert.equal(usePlayerStore.getState().randomRoam.enabled, false);

  usePlayerStore.getState().startRandomRoam(songs);
  usePlayerStore.getState().handleModeChange('random');
  assert.equal(usePlayerStore.getState().randomRoam.enabled, false);
});

test('a restored queue-end continuation appends the batch without auto-playing', async () => {
  resetStore();
  const songs = ['a', 'b'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);
  const { normalizeRandomRoamState } = await import('../randomRoam.js');
  const restoredRoam = normalizeRandomRoamState({
    ...usePlayerStore.getState().randomRoam,
    waitingAtQueueEnd: true,
    resumeWhenAppended: true,
  });
  usePlayerStore.setState({
    currentSong: songs[1],
    isPlaying: false,
    shouldAutoPlay: false,
    randomRoam: restoredRoam,
  });

  usePlayerStore.getState().appendRandomRoamBatch([makeSong('c')], {
    totalPlayable: 4,
    remainingPlayable: 1,
    exhausted: false,
  });
  const state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(state.currentSong.id, 'b');
  assert.equal(state.isPlaying, false);
  assert.equal(state.shouldAutoPlay, false);
  assert.equal(state.randomRoam.waitingAtQueueEnd, false);
});

test('removing the active roam song advances within the existing queue without waiting for a new batch', () => {
  resetStore();
  const songs = ['a', 'b', 'c', 'd'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);
  usePlayerStore.setState({ currentSong: songs[1] });

  assert.equal(usePlayerStore.getState().removePlaylistSong(1), true);
  const state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((item) => item.id), ['a', 'c', 'd']);
  assert.equal(state.currentSong.id, 'c');
  assert.equal(state.randomRoam.waitingAtQueueEnd, false);
});

test('removing the active roam queue head advances to the original second song', () => {
  resetStore();
  const songs = ['a', 'b', 'c'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);

  usePlayerStore.getState().removePlaylistSong(0);
  const state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((item) => item.id), ['b', 'c']);
  assert.equal(state.currentSong.id, 'b');
  assert.equal(state.randomRoam.waitingAtQueueEnd, false);
});

test('removing the active roam queue tail waits for a fresh batch instead of replaying an old song', () => {
  resetStore();
  const songs = ['a', 'b', 'c'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);
  usePlayerStore.setState({ currentSong: songs[2] });

  usePlayerStore.getState().removePlaylistSong(2);
  const waiting = usePlayerStore.getState();
  assert.deepEqual(waiting.playlist.map((item) => item.id), ['a', 'b']);
  assert.equal(waiting.currentSong, null);
  assert.equal(waiting.randomRoam.waitingAtQueueEnd, true);
  assert.equal(waiting.randomRoam.resumeWhenAppended, true);

  usePlayerStore.getState().appendRandomRoamBatch([makeSong('d')], {
    totalPlayable: 4,
    remainingPlayable: 0,
    exhausted: true,
  });
  const resumed = usePlayerStore.getState();
  assert.deepEqual(resumed.playlist.map((item) => item.id), ['a', 'b', 'd']);
  assert.equal(resumed.currentSong.id, 'd');
});

test('removePlaylistSong seamlessly supports index, string song id, and song object', () => {
  resetStore();
  const songs = ['s1', 's2', 's3', 's4'].map(makeSong);
  usePlayerStore.setState({ playlist: songs, currentSong: songs[0] });

  // 1. 传入字符串 song.id 删除
  assert.equal(usePlayerStore.getState().removePlaylistSong('s2'), true);
  let state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((item) => item.id), ['s1', 's3', 's4']);

  // 2. 传入歌曲对象删除
  assert.equal(usePlayerStore.getState().removePlaylistSong({ id: 's4' }), true);
  state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((item) => item.id), ['s1', 's3']);

  // 3. 传入索引整数删除
  assert.equal(usePlayerStore.getState().removePlaylistSong(1), true);
  state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((item) => item.id), ['s1']);

  // 4. 无效参数安全返回 false
  assert.equal(usePlayerStore.getState().removePlaylistSong('non-existent'), false);
  assert.equal(usePlayerStore.getState().removePlaylistSong(999), false);
  assert.equal(usePlayerStore.getState().removePlaylistSong(null), false);
  assert.equal(usePlayerStore.getState().removePlaylistSong(undefined), false);
});

test('reorderPlaylist updates store playlist order without affecting current playback identity', () => {
  resetStore();
  const songs = ['a', 'b', 'c', 'd'].map(makeSong);
  usePlayerStore.setState({ playlist: songs, currentSong: songs[0] });

  // 将 'd' (index 3) 移动到 'a' 之后 (index 1) => a, d, b, c
  const changed = usePlayerStore.getState().reorderPlaylist(3, 1);
  assert.equal(changed, true);
  const state = usePlayerStore.getState();
  assert.deepEqual(state.playlist.map((item) => item.id), ['a', 'd', 'b', 'c']);
  assert.equal(state.currentSong.id, 'a');

  // 原地移动返回 false，不更新
  assert.equal(usePlayerStore.getState().reorderPlaylist(1, 1), false);
});

test('setRandomRoamLanguage updates language, resets state and preserves language preference on disable', () => {
  resetStore();
  usePlayerStore.getState().setRandomRoamLanguage('ja');
  assert.equal(usePlayerStore.getState().randomRoam.language, 'ja');

  const songs = ['ja-1', 'ja-2'].map(makeSong);
  usePlayerStore.getState().startRandomRoam(songs);
  const roam = usePlayerStore.getState().randomRoam;
  assert.equal(roam.enabled, true);
  assert.equal(roam.language, 'ja');
  assert.deepEqual(roam.seenSongIds, ['ja-1', 'ja-2']);

  // 关闭漫游后依然保留语言偏好
  usePlayerStore.getState().setRandomRoamEnabled(false);
  assert.equal(usePlayerStore.getState().randomRoam.enabled, false);
  assert.equal(usePlayerStore.getState().randomRoam.language, 'ja');

  // 当漫游处于开启状态时，修改偏好立即修剪当前歌曲之后的待播列表，确保新偏好即时生效
  usePlayerStore.getState().startRandomRoam(['s1', 's2', 's3', 's4'].map(makeSong));
  assert.equal(usePlayerStore.getState().randomRoam.enabled, true);
  assert.equal(usePlayerStore.getState().playlist.length, 4);
  assert.equal(usePlayerStore.getState().currentSong.id, 's1');

  // 当前正在播 s1，后面排了 s2, s3, s4；切换语言至 'en'
  usePlayerStore.getState().setRandomRoamLanguage('en');
  assert.equal(usePlayerStore.getState().randomRoam.language, 'en');
  // s1 之后的 s2, s3, s4 被清除，只保留 s1，队列长度为 1，从而立即满足 prefetch 阈值（剩余 0 <= 2）
  assert.equal(usePlayerStore.getState().playlist.length, 1);
  assert.equal(usePlayerStore.getState().playlist[0].id, 's1');
  assert.deepEqual(usePlayerStore.getState().randomRoam.seenSongIds, ['s1']);
});

test('tryPlay synchronizes audio.currentTime with store progress before playing when restored', async () => {
  resetStore();
  let playCalled = false;
  const mockAudio = {
    currentTime: 0,
    duration: 180,
    play: async () => {
      playCalled = true;
    },
  };
  usePlayerStore.setState({
    audioRef: { current: mockAudio },
    progress: 45,
    duration: 180,
    isPlaying: false,
  });

  usePlayerStore.getState().tryPlay();
  assert.equal(mockAudio.currentTime, 45);
  // Wait for promise resolution
  await Promise.resolve();
  assert.equal(playCalled, true);
  assert.equal(usePlayerStore.getState().isPlaying, true);
});

test('enabling roam on empty playlist enters waiting-at-queue-end state and auto-plays on append', () => {
  resetStore();
  assert.equal(usePlayerStore.getState().playlist.length, 0);

  // 1. 空列表开启漫游成功
  const enabled = usePlayerStore.getState().setRandomRoamEnabled(true);
  assert.equal(enabled, true);
  const roam = usePlayerStore.getState().randomRoam;
  assert.equal(roam.enabled, true);
  assert.equal(roam.waitingAtQueueEnd, true);
  assert.equal(roam.resumeWhenAppended, true);

  // 2. 第一批歌曲拉取并 append 后，自动起播
  const newSongs = ['roam-1', 'roam-2'].map(makeSong);
  usePlayerStore.getState().appendRandomRoamBatch(newSongs, { totalPlayable: 50, remainingPlayable: 48, exhausted: false });

  const state = usePlayerStore.getState();
  assert.equal(state.playlist.length, 2);
  assert.equal(state.currentSong?.id, 'roam-1');
  assert.equal(state.randomRoam.waitingAtQueueEnd, false);
});

test('clearing playlist or emptying by removal disables roam to prevent loop', () => {
  resetStore();
  // 1. 开启漫游并设置偏好
  usePlayerStore.getState().setRandomRoamBatchSize(15);
  usePlayerStore.getState().setRandomRoamLanguage('yue');
  usePlayerStore.getState().startRandomRoam(['s1', 's2'].map(makeSong));
  assert.equal(usePlayerStore.getState().randomRoam.enabled, true);
  assert.equal(usePlayerStore.getState().randomRoam.batchSize, 15);
  assert.equal(usePlayerStore.getState().randomRoam.language, 'yue');

  // 2. clearPlaylist 强制关闭漫游，并保留偏好
  usePlayerStore.getState().clearPlaylist();
  assert.equal(usePlayerStore.getState().randomRoam.enabled, false);
  assert.equal(usePlayerStore.getState().randomRoam.batchSize, 15);
  assert.equal(usePlayerStore.getState().randomRoam.language, 'yue');
  assert.equal(usePlayerStore.getState().playlist.length, 0);

  // 3. removePlaylistSong 删完至 0 首时强制关闭漫游
  usePlayerStore.getState().startRandomRoam(['single-song'].map(makeSong));
  assert.equal(usePlayerStore.getState().randomRoam.enabled, true);
  usePlayerStore.getState().removePlaylistSong(0);
  assert.equal(usePlayerStore.getState().playlist.length, 0);
  assert.equal(usePlayerStore.getState().randomRoam.enabled, false);
  assert.equal(usePlayerStore.getState().randomRoam.batchSize, 15);
  assert.equal(usePlayerStore.getState().randomRoam.language, 'yue');

  // 4. setPlaylist([]) 强制关闭漫游
  usePlayerStore.getState().startRandomRoam(['s1'].map(makeSong));
  assert.equal(usePlayerStore.getState().randomRoam.enabled, true);
  usePlayerStore.getState().setPlaylist([]);
  assert.equal(usePlayerStore.getState().randomRoam.enabled, false);
});

test('triggerManualRandomRoam and setRandomRoamBatchSize configure and trigger batch prefetch', () => {
  resetStore();
  usePlayerStore.getState().setRandomRoamBatchSize(20);
  assert.equal(usePlayerStore.getState().randomRoam.batchSize, 20);

  // 边界保护：非法或超限值
  usePlayerStore.getState().setRandomRoamBatchSize(100);
  assert.equal(usePlayerStore.getState().randomRoam.batchSize, 50);
  usePlayerStore.getState().setRandomRoamBatchSize(-1);
  assert.equal(usePlayerStore.getState().randomRoam.batchSize, 10);

  // 手动触发漫游：队列为空时
  usePlayerStore.getState().triggerManualRandomRoam();
  let roam = usePlayerStore.getState().randomRoam;
  assert.equal(roam.enabled, true);
  assert.equal(roam.manualNonce, 1);
  assert.equal(roam.retryNonce, 1);
  assert.equal(roam.waitingAtQueueEnd, true);
  assert.equal(roam.resumeWhenAppended, true);

  // 队列不为空且未启用漫游时触发：不应擅自开启漫游
  usePlayerStore.setState({
    playlist: ['a', 'b'].map(makeSong),
    currentSong: makeSong('a'),
    randomRoam: { ...usePlayerStore.getState().randomRoam, enabled: false },
  });
  usePlayerStore.getState().triggerManualRandomRoam();
  roam = usePlayerStore.getState().randomRoam;
  assert.equal(roam.enabled, false);
  assert.equal(roam.manualNonce, 2);
  assert.equal(roam.retryNonce, 2);
});
