import assert from 'node:assert/strict';
import test from 'node:test';

const memoryStore = new Map();
globalThis.localStorage = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, val) => memoryStore.set(key, String(val)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
};

const { usePlayHistoryStore, formatRelativeTime, MAX_HISTORY_COUNT } = await import('./usePlayHistoryStore.js');
const { setUiLanguage } = await import('../i18n/index.js');

test('formatRelativeTime returns accurate human-readable intervals', () => {
  setUiLanguage('zh');
  const now = Date.now();
  assert.equal(formatRelativeTime(now - 10 * 1000), '刚刚');
  assert.equal(formatRelativeTime(now - 5 * 60 * 1000), '5分钟前');
  assert.equal(formatRelativeTime(now - 2 * 3600 * 1000), '2小时前');
  assert.equal(formatRelativeTime(now - 24 * 3600 * 1000), '1天前');
  setUiLanguage('en');
  assert.equal(formatRelativeTime(now - 10 * 1000), 'just now');
  assert.equal(formatRelativeTime(now - 5 * 60 * 1000), '5 min ago');
});

test('usePlayHistoryStore: adds song to history with dedup and top unshift', () => {
  const store = usePlayHistoryStore.getState();
  store.clearHistory();

  store.addSong({ id: 'song-1', title: 'Song One', artist: 'Artist 1' });
  assert.equal(usePlayHistoryStore.getState().history.length, 1);
  assert.equal(usePlayHistoryStore.getState().history[0].id, 'song-1');

  store.addSong({ id: 'song-2', title: 'Song Two', artist: 'Artist 2' });
  assert.equal(usePlayHistoryStore.getState().history.length, 2);
  assert.equal(usePlayHistoryStore.getState().history[0].id, 'song-2');

  // Re-play song-1: it should move to the front
  store.addSong({ id: 'song-1', title: 'Song One Updated', artist: 'Artist 1' });
  const updated = usePlayHistoryStore.getState().history;
  assert.equal(updated.length, 2);
  assert.equal(updated[0].id, 'song-1');
  assert.equal(updated[1].id, 'song-2');

  const persisted = memoryStore.get('music-play-history-v2');
  assert.doesNotThrow(() => JSON.parse(persisted));
  assert.notEqual(persisted, '[object Object]');
});

test('usePlayHistoryStore: restores multiple songs after a store rehydrate', async () => {
  const store = usePlayHistoryStore.getState();
  store.clearHistory();
  store.addSong({ id: 'persist-1', title: 'Persist One' });
  store.addSong({ id: 'persist-2', title: 'Persist Two' });
  const persisted = memoryStore.get('music-play-history-v2');

  usePlayHistoryStore.setState({ history: [] });
  memoryStore.set('music-play-history-v2', persisted);
  await usePlayHistoryStore.persist.rehydrate();

  assert.deepEqual(usePlayHistoryStore.getState().history.map((song) => song.id), [
    'persist-2',
    'persist-1',
  ]);
});

test('usePlayHistoryStore: keeps history on same-account reload and clears on account change', async () => {
  const store = usePlayHistoryStore.getState();
  store.setSubject('account-a');
  store.addSong({ id: 'account-a-song', title: 'Saved Song' });

  const persisted = memoryStore.get('music-play-history-v2');
  usePlayHistoryStore.setState({ subject: null, history: [] });
  memoryStore.set('music-play-history-v2', persisted);
  await usePlayHistoryStore.persist.rehydrate();

  usePlayHistoryStore.getState().setSubject('account-a');
  assert.deepEqual(usePlayHistoryStore.getState().history.map((song) => song.id), ['account-a-song']);

  usePlayHistoryStore.getState().setSubject('account-b');
  assert.deepEqual(usePlayHistoryStore.getState().history, []);
  assert.equal(usePlayHistoryStore.getState().subject, 'account-b');

  usePlayHistoryStore.getState().addSong({ id: 'account-b-song' });
  usePlayHistoryStore.getState().setSubject(null);
  assert.deepEqual(usePlayHistoryStore.getState().history, []);
});

test('usePlayHistoryStore: removes song and clears history', () => {
  const store = usePlayHistoryStore.getState();
  store.clearHistory();

  store.addSong({ id: 's1', title: 'A' });
  store.addSong({ id: 's2', title: 'B' });
  assert.equal(usePlayHistoryStore.getState().history.length, 2);

  store.removeSong('s1');
  assert.equal(usePlayHistoryStore.getState().history.length, 1);
  assert.equal(usePlayHistoryStore.getState().history[0].id, 's2');

  store.clearHistory();
  assert.equal(usePlayHistoryStore.getState().history.length, 0);
});

test('usePlayHistoryStore: enforces maximum 100 items limit', () => {
  const store = usePlayHistoryStore.getState();
  store.clearHistory();

  for (let i = 0; i < 110; i++) {
    store.addSong({ id: `bulk-${i}`, title: `Song ${i}` });
  }

  assert.equal(usePlayHistoryStore.getState().history.length, MAX_HISTORY_COUNT);
  assert.equal(usePlayHistoryStore.getState().history[0].id, 'bulk-109');
});
