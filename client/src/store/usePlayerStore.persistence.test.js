import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.window = { localStorage: globalThis.localStorage };
globalThis.document = { documentElement: { classList: { contains: () => false } } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

const { usePlayerStore } = await import('./usePlayerStore.js');
const song = (id) => ({ id, title: id, audio_url: `/${id}.mp3` });

test('actual player actions skip progress serialization and persist queue and preference changes', () => {
  const songs = [song('a'), song('b'), song('c')];
  usePlayerStore.setState({ currentSong: songs[0], playlist: songs, audioRef: null });
  const nativeStringify = JSON.stringify;
  const saved = [];
  JSON.stringify = function (value, ...args) {
    const text = nativeStringify(value, ...args);
    if (value?.state && Array.isArray(value.state.playlist)) saved.push(JSON.parse(text));
    return text;
  };
  try {
    for (let index = 0; index < 120; index += 1) {
      const state = usePlayerStore.getState();
      state.setProgress(index * 0.25);
      state.setCurrentLyricIndex(index % 3);
      state.setIsPlaying(index % 2 === 0);
    }
    assert.equal(saved.length, 0);
    const actions = [
      (state) => state.reorderPlaylist(2, 1),
      (state) => state.patchSongMetadata('a', { title: 'Updated' }),
      (state) => state.insertAndPlay(song('d')),
      (state) => state.removePlaylistSong('b'),
      (state) => state.setVolume(0.3),
      (state) => state.toggleTranslation(),
      (state) => state.setRandomRoamEnabled(true),
      (state) => state.clearPlaylist(),
    ];
    for (const action of actions) {
      const count = saved.length;
      action(usePlayerStore.getState());
      assert.equal(saved.length, count + 1);
      const persisted = saved.at(-1);
      const current = usePlayerStore.getState();
      assert.equal(persisted.version, 1);
      assert.deepEqual(persisted.state.playlist, current.playlist);
      assert.deepEqual(persisted.state.currentSong, current.currentSong);
      assert.equal(persisted.state.volume, current.volume);
      assert.equal(persisted.state.translationEnabled, current.translationEnabled);
      assert.equal(persisted.state.randomRoam.resumeWhenAppended, false);
      assert.equal(Object.hasOwn(persisted.state, 'progress'), false);
    }
  } finally {
    JSON.stringify = nativeStringify;
  }
});

test('existing version-one JSON hydrates queue and preferences without restoring autoplay authorization', async () => {
  const songs = [song('restore-a'), song('restore-b')];
  values.set('musicPlayer_player', JSON.stringify({ version: 1, state: {
    currentSong: songs[1], playlist: songs, volume: 0.6, playMode: 'sequence',
    translationEnabled: true,
    randomRoam: { enabled: true, seenSongIds: songs.map((item) => item.id),
      waitingAtQueueEnd: true, resumeWhenAppended: true },
  } }));
  await usePlayerStore.persist.rehydrate();
  const state = usePlayerStore.getState();
  assert.deepEqual(state.currentSong, songs[1]);
  assert.deepEqual(state.playlist, songs);
  assert.equal(state.volume, 0.6);
  assert.equal(state.playMode, 'sequence');
  assert.equal(state.translationEnabled, true);
  assert.equal(state.randomRoam.waitingAtQueueEnd, true);
  assert.equal(state.randomRoam.resumeWhenAppended, false);
});
