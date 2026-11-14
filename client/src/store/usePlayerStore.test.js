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
    lyricOffsetMs: 0,
    lyricsRefreshRevision: 0,
    translationAvailable: false,
    translationState: 'unavailable',
    translationStartedAt: null,
    translationEnabled: false,
    queueContextReady: true,
  });
};

test('switching songs resets all resolved lyric document metadata', () => {
  resetStore();
  usePlayerStore.setState({
    currentSong: makeSong('a'),
    resolvedLyricSource: 'custom_krc',
    lyricFormat: 'krc',
    lyricSyncMode: 'word',
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
    source: 'custom_krc',
    format: 'krc',
    syncMode: 'word',
    offsetMs: 350,
    translationAvailable: false,
    translationState: 'pending',
    translationStartedAt: '2026-09-11T00:00:00.000Z',
  });
  unsubscribe();

  const state = usePlayerStore.getState();
  assert.equal(updates, 1);
  assert.equal(state.lyrics, lyrics);
  assert.equal(state.resolvedLyricSource, 'custom_krc');
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

test('ordinary sequence, loop, random and single playback work without a continuation provider', async () => {
  resetStore();
  assert.equal(usePlayerStore.getState().randomRoam, undefined);
  assert.equal(usePlayerStore.getState().startRandomRoam, undefined);
  const songs = ['a', 'b'].map(makeSong);
  const audio = { currentTime: 70, play: async () => {}, paused: true };
  usePlayerStore.setState({ playlist: songs, currentSong: songs[1], isPlaying: true, audioRef: { current: audio } });
  usePlayerStore.getState().playNext({ type: 'ended' });
  assert.equal(usePlayerStore.getState().currentSong.id, 'b');
  assert.equal(usePlayerStore.getState().isPlaying, false);
  usePlayerStore.getState().playNext();
  assert.equal(usePlayerStore.getState().currentSong.id, 'a');
  usePlayerStore.setState({ currentSong: songs[1], playMode: 'loop' });
  usePlayerStore.getState().playNext({ type: 'ended' });
  assert.equal(usePlayerStore.getState().currentSong.id, 'a');
  usePlayerStore.setState({ playMode: 'random' });
  usePlayerStore.getState().playNext({ type: 'ended' });
  assert.equal(usePlayerStore.getState().currentSong.id, 'b');
  usePlayerStore.setState({ playMode: 'single' });
  usePlayerStore.getState().playNext({ type: 'ended' });
  await Promise.resolve();
  assert.equal(usePlayerStore.getState().currentSong.id, 'b');
  assert.equal(audio.currentTime, 0);
});

test('a generic continuation can append after pause without resuming; queue and context changes reject stale results', t => {
  resetStore();
  const store = usePlayerStore.getState();
  const ended = [];
  const dispose = store.registerQueueContinuation({ onQueueEnd: snapshot => { ended.push(snapshot); return true; } });
  t.after(dispose);
  store.startQueueContinuation(['a', 'b'].map(makeSong));
  usePlayerStore.setState({ currentSong: usePlayerStore.getState().playlist[1] });
  store.playNext({ type: 'ended' });
  assert.equal(ended.length, 1);
  const captured = store.getQueueSnapshot();
  store.pause();
  assert.equal(store.getQueueSnapshot().revision, captured.revision, 'pause retains queue generation');
  const appended = store.appendQueueContinuation(['b', 'c', 'c'].map(makeSong), {
    expectedRevision: captured.revision, expectedCurrentSongId: 'b', resume: true,
  });
  assert.deepEqual(appended.added.map(song => song.id), ['c']);
  assert.equal(usePlayerStore.getState().currentSong.id, 'b');
  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.equal(usePlayerStore.getState().shouldAutoPlay, false);
  assert.equal(store.appendQueueContinuation([makeSong('late')], { expectedRevision: captured.revision }).stale, true);
  const beforeContext = store.getQueueSnapshot();
  store.setQueueContextReady(false); store.setQueueContextReady(true);
  assert.equal(store.appendQueueContinuation([makeSong('other-account')], { expectedRevision: beforeContext.revision }).stale, true);
  assert.deepEqual(usePlayerStore.getState().playlist.map(song => song.id), ['a', 'b', 'c']);
});

test('deleting a provider-owned current tail waits with an accurate snapshot and resumes from new additions', t => {
  resetStore();
  const store = usePlayerStore.getState();
  let requestSnapshot;
  const dispose = store.registerQueueContinuation({ onQueueEnd: snapshot => { requestSnapshot = snapshot; return true; } });
  t.after(dispose);
  const songs = ['a', 'b'].map(makeSong);
  usePlayerStore.setState({ playlist: songs, currentSong: songs[1], isPlaying: true });
  store.removePlaylistSong('b');
  assert.equal(usePlayerStore.getState().currentSong, null);
  assert.deepEqual(requestSnapshot.queue.map(song => song.id), ['a']);
  assert.equal(requestSnapshot.revision, store.getQueueSnapshot().revision);
  store.appendQueueContinuation([makeSong('c')], {
    expectedRevision: requestSnapshot.revision, expectedCurrentSongId: null, resume: true,
  });
  assert.equal(usePlayerStore.getState().currentSong.id, 'c');
  assert.equal(usePlayerStore.getState().isPlaying, true);
});

test('continuation cleanup preserves playback and ordinary insert-next preserves the current song', t => {
  resetStore();
  const store = usePlayerStore.getState();
  const events = [];
  const dispose = store.registerQueueContinuation({ onQueueEnd: () => true,
    onQueueCleared: () => events.push('clear'), onExplicitPlay: () => events.push('play'),
    onModeChange: () => events.push('mode'), onPause: () => events.push('pause') });
  t.after(dispose);
  store.startQueueContinuation(['a', 'b'].map(makeSong));
  store.insertAndPlay(makeSong('c'));
  assert.deepEqual(usePlayerStore.getState().playlist.map(song => song.id), ['a', 'c', 'b']);
  assert.equal(usePlayerStore.getState().currentSong.id, 'a');
  assert.deepEqual(events, []);
  const before = store.getQueueSnapshot();
  before.queue[0].title = 'mutated';
  assert.equal(usePlayerStore.getState().playlist[0].title, 'a');
  dispose();
  assert.equal(usePlayerStore.getState().isPlaying, true);
  assert.deepEqual(usePlayerStore.getState().playlist.map(song => song.id), ['a', 'c', 'b']);
  usePlayerStore.setState({ currentSong: usePlayerStore.getState().playlist[2] });
  store.playNext({ type: 'ended' });
  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.equal(usePlayerStore.getState().currentSong.id, 'b');
});

test('user clear, explicit play and mode changes notify a provider while plugin queue setup does not', t => {
  resetStore();
  const store = usePlayerStore.getState(), events = [];
  t.after(store.registerQueueContinuation({ onQueueEnd: () => true,
    onQueueCleared: () => events.push('clear'), onExplicitPlay: () => events.push('play'),
    onModeChange: () => events.push('mode') }));
  store.setQueueSequence(); store.startQueueContinuation([makeSong('a')]);
  store.trimQueueAfterCurrent();
  assert.deepEqual(events, []);
  store.playSong(makeSong('b'), [makeSong('b')]);
  store.handleModeChange('random'); store.clearPlaylist();
  assert.deepEqual(events, ['play', 'mode', 'clear']);
});

test('queue readiness is bound to the account session before React can reset the restore flag', async t => {
  resetStore();
  const { useUIStore } = await import('./useUIStore.js');
  const previous = useUIStore.getState().authSession;
  t.after(() => { useUIStore.setState({ authSession: previous }); usePlayerStore.getState().setQueueContextReady(false); });
  const auth = { authenticated: true, user: { accountId: 'A', role: 'member' }, csrfToken: 'A' };
  useUIStore.setState({ authSession: auth });
  const store = usePlayerStore.getState();
  store.startQueueContinuation([makeSong('preserved')]);
  store.setQueueContextReady(true);
  const snapshot = store.getQueueSnapshot();
  assert.equal(snapshot.ready, true);
  useUIStore.setState({ authSession: { ...auth, user: { ...auth.user, accountId: 'B' } } });
  assert.equal(store.getQueueSnapshot().ready, false);
  assert.notEqual(store.getQueueSnapshot().revision, snapshot.revision);
  assert.equal(usePlayerStore.getState().currentSong.id, 'preserved');
  store.setQueueContextReady(true);
  assert.equal(store.getQueueSnapshot().ready, true);
});

test('quiet cleanup cancels a native play promise without allowing its late completion to resume local sound', async () => {
  resetStore();
  const { capturePlaybackCleanup } = await import('../plugins/playbackCleanup.js');
  let finish, pauses = 0;
  const audio = { src: 'same.mp3', paused: true, currentTime: 0, play() {
    return new Promise(resolve => { finish = () => { audio.paused = false; resolve(); }; });
  }, pause() { pauses++; this.paused = true; } };
  usePlayerStore.setState({ currentSong: makeSong('same'), audioRef: { current: audio }, shouldAutoPlay: true, progress: 0 });
  usePlayerStore.getState().tryPlay();
  const cleanup = capturePlaybackCleanup(usePlayerStore); cleanup(); finish(); await Promise.resolve();
  assert.equal(usePlayerStore.getState().isPlaying, false); assert.equal(audio.paused, true); assert.equal(pauses, 1);
});

test('restoration establishes new ownership even for the same cached song and source', async t => {
  resetStore();
  const { useUIStore } = await import('./useUIStore.js');
  const { capturePlaybackCleanup } = await import('../plugins/playbackCleanup.js');
  const previous = useUIStore.getState().authSession;
  t.after(() => { useUIStore.setState({ authSession: previous }); usePlayerStore.getState().setQueueContextReady(false); });
  const auth = { authenticated: true, user: { accountId: 'A', role: 'member' }, csrfToken: 'session-A' };
  const audio = { src: 'same.mp3', paused: false, pause() { throw new Error('New owner must keep playing'); } };
  useUIStore.setState({ authSession: auth });
  usePlayerStore.setState({ currentSong: makeSong('same'), audioRef: { current: audio }, isPlaying: true });
  usePlayerStore.getState().setQueueContextReady(true);
  const generation = usePlayerStore.getState().playbackOwnershipGeneration;
  const cleanup = capturePlaybackCleanup(usePlayerStore);
  usePlayerStore.getState().setQueueContextReady(false);
  // Logging in again as the same account creates a fresh hydration owner.
  useUIStore.setState({ authSession: { ...auth, csrfToken: 'session-B' } });
  usePlayerStore.getState().setQueueContextReady(true);
  assert.ok(usePlayerStore.getState().playbackOwnershipGeneration > generation);
  assert.equal(cleanup(), false); assert.equal(usePlayerStore.getState().isPlaying, true);
  assert.equal(usePlayerStore.persist.getOptions().partialize(usePlayerStore.getState()).playbackOwnershipGeneration, undefined);
});
