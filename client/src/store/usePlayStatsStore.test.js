import assert from 'node:assert/strict';
import test from 'node:test';

const memoryStore = new Map();
globalThis.localStorage = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
};
globalThis.window = { localStorage: globalThis.localStorage };
globalThis.document = {
  documentElement: { classList: { contains: () => false } },
};

const { usePlayStatsStore, resetSyncBackoff } = await import('./usePlayStatsStore.js');
const { useUIStore } = await import('./useUIStore.js');

function resetStats(overrides = {}) {
  resetSyncBackoff();
  usePlayStatsStore.setState({
    ownerSubject: null,
    identityReady: false,
    playCounts: {},
    pendingQueue: [],
    songMetaMap: {},
    topSongs: [],
    topAlbums: [],
    totalPlays: 0,
    totalUniqueSongs: 0,
    isSyncing: false,
    lastSyncedAt: 0,
    ...overrides,
  });
}

function queuedEvents(count) {
  return Array.from({ length: count }, (_, index) => ({
    event_id: `event_${index + 1}`,
    song_id: `song-${index + 1}`,
    played_at: 1000 + index,
  }));
}

test('usePlayStatsStore: a qualified play immediately updates every local aggregate', () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  const store = usePlayStatsStore.getState();
  store.recordQualifiedPlay({ id: 'song-1', title: 'Song One', artist: 'Artist' });
  store.recordQualifiedPlay({ id: 'song-2', title: 'Song Two', artist: 'Artist' });
  store.recordQualifiedPlay({ id: 'song-1', title: 'Song One', artist: 'Artist' });

  const state = usePlayStatsStore.getState();
  assert.equal(state.getPlayCount('song-1'), 2);
  assert.equal(state.totalPlays, 3);
  assert.equal(state.totalUniqueSongs, 2);
  assert.equal(state.pendingQueue.length, 3);
  assert.equal(new Set(state.pendingQueue.map((item) => item.event_id)).size, 3);
  assert.deepEqual(state.topSongs.map((song) => [song.id, song.play_count]), [
    ['song-1', 2],
    ['song-2', 1],
  ]);

  const persisted = memoryStore.get('music-play-stats-v2');
  assert.doesNotThrow(() => JSON.parse(persisted));
  assert.notEqual(persisted, '[object Object]');
});

test('usePlayStatsStore: plays without a confirmed owner are discarded and account changes clear private state', () => {
  resetStats({ identityReady: true });
  usePlayStatsStore.getState().recordQualifiedPlay({ id: 'guest-song', title: 'Guest Song' });

  assert.equal(usePlayStatsStore.getState().pendingQueue.length, 0);
  assert.deepEqual(usePlayStatsStore.getState().topSongs, []);

  usePlayStatsStore.getState().setSubject('account-a');
  assert.equal(usePlayStatsStore.getState().pendingQueue.length, 0);
  assert.deepEqual(usePlayStatsStore.getState().playCounts, {});

  usePlayStatsStore.getState().setSubject('account-b');
  const accountB = usePlayStatsStore.getState();
  assert.equal(accountB.ownerSubject, 'account-b');
  assert.deepEqual(accountB.pendingQueue, []);
  assert.deepEqual(accountB.playCounts, {});
  assert.deepEqual(accountB.topSongs, []);
  assert.deepEqual(accountB.topAlbums, []);
  assert.equal(accountB.totalPlays, 0);

  usePlayStatsStore.getState().setSubject(null);
  assert.equal(usePlayStatsStore.getState().ownerSubject, null);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
});

test('usePlayStatsStore: 51 events flush in three D1-safe batches and concurrent callers share one flight', async () => {
  resetStats({
    ownerSubject: 'account-a',
    identityReady: true,
    pendingQueue: queuedEvents(51),
  });

  const requests = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) await firstGate;
    return new Response(JSON.stringify({
      ok: true,
      data: {
        recorded: body.events.length,
        acceptedEventIds: body.events.map((event) => event.event_id),
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const first = usePlayStatsStore.getState().flushQueue();
  const concurrent = usePlayStatsStore.getState().flushQueue({ keepalive: true });
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  releaseFirst();

  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.submitted, 51);
  assert.deepEqual(requests.map((request) => request.events.length), [25, 25, 1]);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  assert.equal(usePlayStatsStore.getState().isSyncing, false);
});

test('usePlayStatsStore: failed sync reports failure and retains every pending event', async () => {
  resetStats({
    ownerSubject: 'account-a',
    identityReady: true,
    pendingQueue: queuedEvents(2),
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: 'MUSIC_STORAGE_UNAVAILABLE',
    message: 'temporarily unavailable',
  }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  const result = await usePlayStatsStore.getState().flushQueue();
  assert.equal(result.ok, false);
  assert.equal(usePlayStatsStore.getState().pendingQueue.length, 2);
  assert.equal(usePlayStatsStore.getState().isSyncing, false);
  assert.ok(result.retryAfterMs > 0);

  // 冷却期内再次调用 flushQueue，绝不发起额外网络请求，直接返回 cooling-down
  let secondFetchCalled = false;
  globalThis.fetch = async () => { secondFetchCalled = true; };
  const coolResult = await usePlayStatsStore.getState().flushQueue();
  assert.equal(coolResult.ok, false);
  assert.equal(coolResult.reason, 'cooling-down');
  assert.equal(secondFetchCalled, false);

  // 强制同步可突破冷却
  const forceResult = await usePlayStatsStore.getState().flushQueue({ force: true });
  assert.equal(secondFetchCalled, true);
});

test('usePlayStatsStore: remote refresh is subject-bound and returns an honest result', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    data: {
      songs: [{ id: 'remote-song', title: 'Remote', play_count: 7, last_played_at: 9000 }],
      topAlbums: [{ id: 'album-a', title: 'Album A', artist: 'Artist', playCount: 7 }],
      totalPlays: 7,
      totalUniqueSongs: 1,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const result = await usePlayStatsStore.getState().refreshRemoteStats(50);
  assert.equal(result.ok, true);
  assert.equal(usePlayStatsStore.getState().getPlayCount('remote-song'), 7);
  assert.equal(usePlayStatsStore.getState().totalPlays, 7);
  assert.equal(usePlayStatsStore.getState().topSongs[0].id, 'remote-song');
  assert.deepEqual(usePlayStatsStore.getState().topAlbums.map((album) => album.id), ['album-a']);

  usePlayStatsStore.getState().setSubject(null);
  assert.deepEqual(usePlayStatsStore.getState().topAlbums, []);
  assert.deepEqual(await usePlayStatsStore.getState().refreshRemoteStats(), {
    ok: false,
    reason: 'unauthenticated',
  });
});

test('usePlayStatsStore: unconfirmed identity neither submits hydrated account data nor assigns new plays to the next account', async () => {
  resetStats({
    ownerSubject: 'account-a',
    identityReady: false,
    pendingQueue: queuedEvents(2),
    playCounts: { 'old-song': 2 },
    songMetaMap: { 'old-song': { id: 'old-song', title: 'Old Song' } },
    topSongs: [{ id: 'old-song', title: 'Old Song', play_count: 2 }],
    totalPlays: 2,
    totalUniqueSongs: 1,
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error('must not submit before identity confirmation');
  };

  usePlayStatsStore.getState().recordQualifiedPlay({ id: 'new-song', title: 'New Song' });
  assert.equal(usePlayStatsStore.getState().pendingQueue.length, 2);
  assert.deepEqual(await usePlayStatsStore.getState().flushQueue(), {
    ok: false,
    submitted: 0,
    remaining: 2,
    reason: 'identity-unconfirmed',
  });
  assert.equal(requestCount, 0);

  usePlayStatsStore.getState().setSubject('account-b');
  const accountB = usePlayStatsStore.getState();
  assert.equal(accountB.identityReady, true);
  assert.equal(accountB.ownerSubject, 'account-b');
  assert.deepEqual(accountB.pendingQueue, []);
  assert.deepEqual(accountB.playCounts, {});
  assert.equal(accountB.totalPlays, 0);
});

test('usePlayStatsStore: transient auth failure can mark identity unknown without clearing its queue', () => {
  resetStats({
    ownerSubject: 'account-a',
    identityReady: true,
    pendingQueue: queuedEvents(2),
  });
  usePlayStatsStore.getState().markIdentityUnconfirmed();
  const state = usePlayStatsStore.getState();
  assert.equal(state.ownerSubject, 'account-a');
  assert.equal(state.identityReady, false);
  assert.equal(state.pendingQueue.length, 2);
});

test('useUIStore: failed session verification clears identity-bound stats immediately', () => {
  resetStats({
    ownerSubject: 'account-a',
    identityReady: false,
    pendingQueue: queuedEvents(2),
  });
  useUIStore.getState().setAuthSession({
    authenticated: false,
    user: null,
    initialized: true,
    error: 'session unavailable',
  });
  assert.equal(usePlayStatsStore.getState().ownerSubject, null);
  assert.equal(usePlayStatsStore.getState().identityReady, true);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);

  useUIStore.getState().setAuthSession({
    authenticated: false,
    user: null,
    initialized: true,
    error: null,
  });
  assert.equal(usePlayStatsStore.getState().ownerSubject, null);
  assert.equal(usePlayStatsStore.getState().identityReady, true);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
});

test('usePlayStatsStore: authoritative refresh removes server-rejected songs but preserves events added in flight', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  usePlayStatsStore.getState().recordQualifiedPlay({ id: 'deleted-song', title: 'Deleted Song' });
  const submittedId = usePlayStatsStore.getState().pendingQueue[0].event_id;
  let resolveRefresh;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      return new Response(JSON.stringify({
        ok: true,
        data: { recorded: 0, acceptedEventIds: [submittedId] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Promise((resolve) => { resolveRefresh = resolve; });
  };

  const syncing = usePlayStatsStore.getState().synchronizeAccountStats();
  while (!resolveRefresh) await Promise.resolve();
  usePlayStatsStore.getState().recordQualifiedPlay({ id: 'in-flight-song', title: 'In Flight' });
  resolveRefresh(new Response(JSON.stringify({
    ok: true,
    data: { songs: [], totalPlays: 0, totalUniqueSongs: 0 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  assert.equal((await syncing).ok, true);
  const state = usePlayStatsStore.getState();
  assert.equal(state.getPlayCount('deleted-song'), 0);
  assert.equal(state.getPlayCount('in-flight-song'), 1);
  assert.equal(state.totalPlays, 1);
  assert.deepEqual(state.topSongs.map((song) => song.id), ['in-flight-song']);
  assert.deepEqual(state.pendingQueue.map((item) => item.song_id), ['in-flight-song']);
  usePlayStatsStore.getState().markIdentityUnconfirmed();
});

test('usePlayStatsStore: preserves language without retired visibility metadata and supports self-healing', () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  const store = usePlayStatsStore.getState();

  // 1. 本地记录只保留当前仍有运行意义的歌曲元数据。
  store.recordQualifiedPlay({
    id: 'song-zh',
    title: '中文歌曲',
    artist: '歌手',
    language: 'zh',
    requires_login: 1,
  });

  let state = usePlayStatsStore.getState();
  assert.equal(state.songMetaMap['song-zh']?.language, 'zh');
  assert.equal('requires_login' in state.songMetaMap['song-zh'], false);
  assert.equal(state.topSongs[0]?.language, 'zh');
  assert.equal('requires_login' in state.topSongs[0], false);

  // 2. 模拟旧数据缺失 language
  usePlayStatsStore.setState({
    songMetaMap: {
      'legacy-song': {
        id: 'legacy-song',
        title: '老歌曲',
        artist: '老歌手',
        language: null,
      },
    },
    playCounts: { 'legacy-song': 5 },
    topSongs: [{
      id: 'legacy-song',
      title: '老歌曲',
      artist: '老歌手',
      play_count: 5,
      language: null,
    }],
  });

  state = usePlayStatsStore.getState();
  assert.equal(state.topSongs[0]?.language, null);

  // 3. 执行自愈补丁 patchSongMetadata
  store.patchSongMetadata([{ id: 'legacy-song', language: 'ja' }]);
  state = usePlayStatsStore.getState();
  assert.equal(state.songMetaMap['legacy-song']?.language, 'ja');
  assert.equal(state.topSongs[0]?.language, 'ja');
});
