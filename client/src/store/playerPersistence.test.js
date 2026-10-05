import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerPersistenceStorage } from './playerPersistence.js';
import { createThrottledStorage } from './throttledStorage.js';

const memoryStorage = () => {
  const values = new Map();
  const writes = [];
  return {
    values, writes,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); writes.push([key, value]); },
    removeItem: (key) => values.delete(key),
  };
};
const snapshot = (state = {}, version = 1) => ({ version, state });

test('unchanged partialized fields skip serialization before string storage', () => {
  const memory = memoryStorage();
  const storage = createPlayerPersistenceStorage(() => memory);
  let serializedSongs = 0;
  const song = { id: 'a', toJSON() { serializedSongs += 1; return { id: this.id }; } };
  const state = { currentSong: song, playlist: [song], volume: 0.8,
    randomRoam: { enabled: false, seenSongIds: [], resumeWhenAppended: false } };
  storage.setItem('player', snapshot(state));
  const firstSerializationCount = serializedSongs;
  for (let index = 0; index < 120; index += 1) {
    storage.setItem('player', snapshot({ ...state, randomRoam: { ...state.randomRoam } }));
  }
  assert.equal(serializedSongs, firstSerializationCount);
  assert.equal(memory.writes.length, 1);
  assert.deepEqual(JSON.parse(memory.values.get('player')), {
    version: 1, state: { currentSong: { id: 'a' }, playlist: [{ id: 'a' }], volume: 0.8,
      randomRoam: { enabled: false, seenSongIds: [], resumeWhenAppended: false } },
  });
});

test('queue, metadata, preferences, roam changes and version changes retain the saved format', () => {
  const memory = memoryStorage();
  const storage = createPlayerPersistenceStorage(() => memory);
  let state = { currentSong: { id: 'a' }, playlist: [{ id: 'a' }, { id: 'b' }],
    volume: 0.8, playMode: 'loop', translationEnabled: false,
    randomRoam: { enabled: false, seenSongIds: [], resumeWhenAppended: false } };
  const edits = [
    (previous) => previous,
    (previous) => ({ ...previous, playlist: [...previous.playlist].reverse() }),
    (previous) => ({ ...previous, currentSong: { ...previous.currentSong, title: 'Edited' } }),
    (previous) => ({ ...previous, volume: 0.4 }),
    (previous) => ({ ...previous, playMode: 'sequence' }),
    (previous) => ({ ...previous, translationEnabled: true }),
    (previous) => ({ ...previous, randomRoam: { ...previous.randomRoam, seenSongIds: ['a'] } }),
    (previous) => ({ ...previous, playlist: [], currentSong: null }),
  ];
  for (const edit of edits) {
    state = edit(state);
    storage.setItem('player', snapshot(state));
    assert.deepEqual(JSON.parse(memory.values.get('player')), snapshot(state));
  }
  assert.equal(memory.writes.length, edits.length);
  storage.setItem('player', snapshot(state, 2));
  assert.equal(JSON.parse(memory.values.get('player')).version, 2);
});

test('rehydration, removal and failed synchronous writes cannot leave a stale deduplication baseline', () => {
  const memory = memoryStorage();
  const storage = createPlayerPersistenceStorage(() => memory);
  const value = snapshot({ volume: 0.8 });
  storage.setItem('player', value);
  memory.values.set('player', JSON.stringify(snapshot({ volume: 0.3 })));
  assert.equal(storage.getItem('player').state.volume, 0.3);
  storage.setItem('player', value);
  assert.equal(JSON.parse(memory.values.get('player')).state.volume, 0.8);
  storage.removeItem('player');
  storage.setItem('player', value);
  assert.ok(memory.values.has('player'));

  let attempts = 0;
  const retrying = createPlayerPersistenceStorage(() => ({ ...memory,
    setItem() { attempts += 1; if (attempts === 1) throw new Error('quota'); },
  }));
  assert.throws(() => retrying.setItem('player', value), /quota/);
  retrying.setItem('player', value);
  assert.equal(attempts, 2);
});

test('deduplication preserves latest pending writes and reverting to the saved state cancels them', async () => {
  const memory = memoryStorage();
  const storage = createPlayerPersistenceStorage(() => createThrottledStorage(memory, 10));
  storage.setItem('player', snapshot({ volume: 0.8 }));
  storage.setItem('player', snapshot({ volume: 0.4 }));
  storage.setItem('player', snapshot({ volume: 0.4 }));
  storage.setItem('player', snapshot({ volume: 0.2 }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(memory.writes.map(([, value]) => JSON.parse(value).state.volume), [0.8, 0.2]);
  const revertedMemory = memoryStorage();
  const reverted = createPlayerPersistenceStorage(() => createThrottledStorage(revertedMemory, 10));
  reverted.setItem('player', snapshot({ volume: 0.8 }));
  reverted.setItem('player', snapshot({ volume: 0.4 }));
  reverted.setItem('player', snapshot({ volume: 0.8 }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(revertedMemory.writes.map(([, value]) => JSON.parse(value).state.volume), [0.8]);
});
