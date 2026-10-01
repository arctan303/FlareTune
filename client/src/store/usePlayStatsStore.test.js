import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { memoryStore, resetStats, usePlayStatsStore, useUIStore, resetSyncBackoff } from './playStatsTestSupport.js';

function queuedEvents(count) {
  return Array.from({ length: count }, (_, index) => ({
    event_id: `event_${index + 1}`,
    song_id: `song-${index + 1}`,
    played_at: Date.now() + index,
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
  assert.equal(accountB.totalPlays, 0);

  usePlayStatsStore.getState().setSubject(null);
  assert.equal(usePlayStatsStore.getState().ownerSubject, null);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
});

test('usePlayStatsStore: first play uploads by ten minutes while stats wait one hour', async () => {
  resetStats();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(1_000_000) });
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init.method);
    if (init.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, data: {
        songs: [], playCounts: {}, totalPlays: 0, totalUniqueSongs: 0,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const { events } = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, data: {
      recorded: events.length,
      acceptedEventIds: events.map((event) => event.event_id),
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const store = usePlayStatsStore.getState();
    store.setSubject('account-a');
    assert.equal((await store.synchronizeAccountStats()).ok, true);
    assert.deepEqual(requests, ['GET']);
    store.recordQualifiedPlay('song-1');
    assert.equal(usePlayStatsStore.getState().getPlayCount('song-1'), 1);
    mock.timers.tick(590_000);
    store.recordQualifiedPlay('song-2');
    assert.equal(usePlayStatsStore.getState().getPlayCount('song-2'), 1);
    mock.timers.tick(9999);
    assert.deepEqual(requests, ['GET']);
    mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.deepEqual(requests, ['GET', 'POST']);
    assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
    mock.timers.tick(3_000_000);
    await new Promise(setImmediate);
    assert.deepEqual(requests, ['GET', 'POST', 'GET']);
  } finally {
    resetSyncBackoff();
    mock.timers.reset();
  }
});

test('usePlayStatsStore: ten plays upload as one batch without refreshing stats', async () => {
  resetStats();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(1_000_000) });
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init.method);
    if (init.method === 'GET') return new Response(JSON.stringify({ ok: true, data: {
      songs: [], playCounts: {}, totalPlays: 0, totalUniqueSongs: 0,
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { events } = JSON.parse(init.body);
    assert.equal(events.length, 10);
    return new Response(JSON.stringify({ ok: true, data: {
      recorded: events.length, acceptedEventIds: events.map((event) => event.event_id),
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const store = usePlayStatsStore.getState();
    store.setSubject('account-a');
    await store.synchronizeAccountStats();
    for (let i = 0; i < 9; i += 1) store.recordQualifiedPlay(`song-${i}`);
    mock.timers.tick(9000);
    assert.deepEqual(requests, ['GET']);
    store.recordQualifiedPlay('song-9');
    mock.timers.tick(0);
    await new Promise(setImmediate);
    assert.deepEqual(requests, ['GET', 'POST']);
    assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  } finally {
    resetSyncBackoff();
    mock.timers.reset();
  }
});

test('usePlayStatsStore: failed batch retries automatically with unchanged event IDs', async () => {
  resetStats();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(1_000_000) });
  const attempts = [];
  globalThis.fetch = async (_url, init) => {
    if (init.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, data: {
        songs: [{ id: 'song-1', title: 'Song One', play_count: 1 }],
        totalPlays: 1, totalUniqueSongs: 1,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const { events } = JSON.parse(init.body);
    attempts.push(events.map((event) => event.event_id));
    if (attempts.length === 1) {
      return new Response(JSON.stringify({ ok: false, error: 'MUSIC_STORAGE_UNAVAILABLE' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: {
      recorded: events.length,
      acceptedEventIds: events.map((event) => event.event_id),
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    usePlayStatsStore.getState().setSubject('account-a');
    usePlayStatsStore.getState().recordQualifiedPlay('song-1');
    mock.timers.tick(600_000);
    await new Promise(setImmediate);
    assert.equal(attempts.length, 1);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length, 1);
    mock.timers.tick(30_000);
    await new Promise(setImmediate);
    assert.deepEqual(attempts, [attempts[0], attempts[0]]);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length, 0);
  } finally {
    resetSyncBackoff();
    mock.timers.reset();
  }
});

test('usePlayStatsStore: A to B to A restores only the original account pending events', () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  const store = usePlayStatsStore.getState();
  store.recordQualifiedPlay('song-a');
  const eventA = usePlayStatsStore.getState().pendingQueue[0];
  store.setSubject('account-b');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  assert.equal(memoryStore.has(`music-play-stats-pending-v1:account-a:${eventA.event_id}`), true);
  store.recordQualifiedPlay('song-b');
  const eventB = usePlayStatsStore.getState().pendingQueue[0];
  store.setSubject(null);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  store.setSubject('account-a');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, [eventA]);
  assert.equal(usePlayStatsStore.getState().getPlayCount('song-a'), 1);
  assert.equal(usePlayStatsStore.getState().getPlayCount('song-b'), 0);
  store.setSubject('account-b');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, [eventB]);
});

test('usePlayStatsStore: an in-flight A acknowledgement clears only A after switching to B', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  usePlayStatsStore.getState().recordQualifiedPlay('song-a');
  const eventA = usePlayStatsStore.getState().pendingQueue[0];
  let release;
  globalThis.fetch = async () => new Promise((resolve) => {
    release = () => resolve(new Response(JSON.stringify({ ok: true, data: {
      recorded: 1,
      acceptedEventIds: [eventA.event_id],
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  const flushingA = usePlayStatsStore.getState().flushQueue();
  usePlayStatsStore.getState().setSubject('account-b');
  usePlayStatsStore.getState().recordQualifiedPlay('song-b');
  const eventB = usePlayStatsStore.getState().pendingQueue[0];
  release();
  assert.equal((await flushingA).reason, 'identity-changed');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, [eventB]);
  assert.equal(usePlayStatsStore.getState().pendingBySubject['account-a'], undefined);
  usePlayStatsStore.getState().setSubject('account-a');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
});

test('usePlayStatsStore: reload restores an old same-account event with its ID', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  usePlayStatsStore.getState().recordQualifiedPlay('song-a');
  const eventA = usePlayStatsStore.getState().pendingQueue[0];
  usePlayStatsStore.getState().setSubject(null);
  usePlayStatsStore.getState().setSubject('account-a');
  const persisted = memoryStore.get('music-play-stats-v2');
  usePlayStatsStore.setState({
    ownerSubject: null, identityReady: false, pendingQueue: [], playCounts: {}, totalPlays: 0,
  });
  memoryStore.set('music-play-stats-v2', persisted);
  await usePlayStatsStore.persist.rehydrate();
  assert.equal(usePlayStatsStore.getState().identityReady, false);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  usePlayStatsStore.getState().setSubject('account-a');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, [eventA]);
  assert.equal(usePlayStatsStore.getState().getPlayCount('song-a'), 1);
});

test('usePlayStatsStore: two tabs retain distinct events despite stale whole-state overwrites', async () => {
  resetStats();
  const store = usePlayStatsStore.getState();
  store.setSubject('account-a');
  store.recordQualifiedPlay('song-from-tab-a');
  const eventA = usePlayStatsStore.getState().pendingQueue[0];
  const eventB = { event_id: 'play_from_other_tab', song_id: 'song-from-tab-b', played_at: Date.now() + 1 };
  const eventBKey = `music-play-stats-pending-v1:account-a:${eventB.event_id}`;

  // A second tab can overwrite the old Zustand snapshot, but each event owns a separate key.
  memoryStore.set('music-play-stats-v2', JSON.stringify({ version: 2, state: {
    ownerSubject: 'account-a', playCounts: {}, pendingQueue: [],
  } }));
  memoryStore.set(eventBKey, JSON.stringify(eventB));
  window.dispatch('storage', { key: eventBKey });
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue.map((event) => event.event_id), [
    eventA.event_id, eventB.event_id,
  ]);

  usePlayStatsStore.setState({ ownerSubject: null, identityReady: false, pendingQueue: [] });
  memoryStore.set('music-play-stats-v2', JSON.stringify({ version: 2, state: {
    ownerSubject: 'account-a', playCounts: {}, pendingQueue: [],
  } }));
  await usePlayStatsStore.persist.rehydrate();
  usePlayStatsStore.getState().setSubject('account-a');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue.map((event) => event.event_id), [
    eventA.event_id, eventB.event_id,
  ]);
});

test('usePlayStatsStore: another tab acknowledgement is rebased without double counting', async () => {
  resetStats();
  const store = usePlayStatsStore.getState();
  store.setSubject('account-a');
  store.recordQualifiedPlay('song-a');
  const event = usePlayStatsStore.getState().pendingQueue[0];
  const key = `music-play-stats-pending-v1:account-a:${event.event_id}`;
  memoryStore.delete(key);
  window.dispatch('storage', { key });
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  assert.equal(usePlayStatsStore.getState().getPlayCount('song-a'), 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: {
    songs: [{ id: 'song-a', title: 'Song A', play_count: 1 }],
    totalPlays: 1, totalUniqueSongs: 1,
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await store.refreshRemoteStats()).ok, true);
  assert.equal(usePlayStatsStore.getState().getPlayCount('song-a'), 1);
  assert.equal(usePlayStatsStore.getState().totalPlays, 1);
});

test('usePlayStatsStore: a stats refresh waits for an in-flight upload before replacing counts', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  const store = usePlayStatsStore.getState();
  store.recordQualifiedPlay('song-a');
  const eventId = usePlayStatsStore.getState().pendingQueue[0].event_id;
  const methods = [];
  let acknowledgeUpload;
  globalThis.fetch = async (_url, init) => {
    methods.push(init.method);
    if (init.method === 'POST') return new Promise((resolve) => {
      acknowledgeUpload = () => resolve(new Response(JSON.stringify({ ok: true, data: {
        recorded: 1, acceptedEventIds: [eventId],
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    return new Response(JSON.stringify({ ok: true, data: {
      songs: [{ id: 'song-a', play_count: 1 }], playCounts: { 'song-a': 1 },
      totalPlays: 1, totalUniqueSongs: 1,
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const uploading = store.flushQueue();
  while (!acknowledgeUpload) await Promise.resolve();
  const refreshing = store.refreshRemoteStats();
  await Promise.resolve();
  assert.deepEqual(methods, ['POST']);
  acknowledgeUpload();
  assert.equal((await uploading).ok, true);
  assert.equal((await refreshing).ok, true);
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(usePlayStatsStore.getState().getPlayCount('song-a'), 1);
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  resetSyncBackoff();
});

test('usePlayStatsStore: forced and keepalive uploads cannot make a concurrent stale GET roll back local plays', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(1_000_000) });
  try {
    for (const uploadOptions of [{ force: true }, { keepalive: true }]) {
      resetStats({ ownerSubject: 'account-a', identityReady: true });
      const store = usePlayStatsStore.getState();
      const methods = [];
      let releaseStaleGet;
      let getCount = 0;
      globalThis.fetch = async (_url, init) => {
        methods.push(init.method);
        if (init.method === 'GET') {
          getCount += 1;
          if (getCount === 1) return new Promise((resolve) => {
            releaseStaleGet = () => resolve(new Response(JSON.stringify({ ok: true, data: {
              songs: [], playCounts: {}, totalPlays: 0, totalUniqueSongs: 0,
            } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          });
          return new Response(JSON.stringify({ ok: true, data: {
            songs: [{ id: 'song-a', play_count: 1 }], playCounts: { 'song-a': 1 },
            totalPlays: 1, totalUniqueSongs: 1,
          } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const { events } = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, data: {
          recorded: 1, acceptedEventIds: events.map((event) => event.event_id),
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const refreshing = store.refreshRemoteStats();
      while (!releaseStaleGet) await Promise.resolve();
      store.recordQualifiedPlay('song-a');
      assert.equal((await store.flushQueue(uploadOptions)).ok, true);
      assert.equal(usePlayStatsStore.getState().getPlayCount('song-a'), 1);
      releaseStaleGet();
      assert.equal((await refreshing).ok, true);
      assert.deepEqual(methods, ['GET', 'POST', 'GET']);
      assert.equal(usePlayStatsStore.getState().getPlayCount('song-a'), 1);
      assert.equal(usePlayStatsStore.getState().totalPlays, 1);
      assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
    }
  } finally {
    resetSyncBackoff();
    mock.timers.reset();
  }
});

test('usePlayStatsStore: legacy v2 queues migrate idempotently to account/event keys', async () => {
  resetStats();
  const eventA = { event_id: 'play_old_a', song_id: 'song-a', played_at: 1000 };
  const eventB = { event_id: 'play_old_b', song_id: 'song-b', played_at: 2000 };
  memoryStore.set('music-play-stats-v2', JSON.stringify({ version: 2, state: {
    ownerSubject: 'account-a', pendingQueue: [eventA],
    pendingBySubject: { 'account-b': [eventB] },
  } }));
  await usePlayStatsStore.persist.rehydrate();
  const keysAfterFirst = [...memoryStore.keys()].filter((key) => key.startsWith('music-play-stats-pending-v1:'));
  assert.equal(keysAfterFirst.length, 2);
  assert.equal(JSON.parse(memoryStore.get('music-play-stats-v2')).state.pendingQueue, undefined);
  await usePlayStatsStore.persist.rehydrate();
  assert.deepEqual(
    [...memoryStore.keys()].filter((key) => key.startsWith('music-play-stats-pending-v1:')),
    keysAfterFirst,
  );
  usePlayStatsStore.getState().setSubject('account-a');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, [eventA]);
  usePlayStatsStore.getState().setSubject('account-b');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, [eventB]);
});

test('usePlayStatsStore: interrupted legacy migration keeps the original queue for retry', async () => {
  resetStats();
  const eventA = { event_id: 'play_old_a', song_id: 'song-a', played_at: 1000 };
  const eventB = { event_id: 'play_old_b', song_id: 'song-b', played_at: 2000 };
  memoryStore.set('music-play-stats-v2', JSON.stringify({ version: 2, state: {
    ownerSubject: 'account-a', pendingQueue: [eventA, eventB],
  } }));
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key.endsWith('play_old_b')) throw new Error('simulated full storage');
    originalSetItem(key, value);
  };
  try {
    await usePlayStatsStore.persist.rehydrate();
    assert.deepEqual(JSON.parse(memoryStore.get('music-play-stats-v2')).state.pendingQueue, [eventA, eventB]);
  } finally {
    localStorage.setItem = originalSetItem;
  }
  usePlayStatsStore.getState().setSubject('account-b');
  assert.deepEqual(JSON.parse(memoryStore.get('music-play-stats-v2')).state.pendingBySubject['account-a'], [eventA, eventB]);
  await usePlayStatsStore.persist.rehydrate();
  assert.equal(JSON.parse(memoryStore.get('music-play-stats-v2')).state.pendingQueue, undefined);
  usePlayStatsStore.getState().setSubject('account-a');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, [eventA, eventB]);
});

test('usePlayStatsStore: legacy events without an owner remain quarantined across login', async () => {
  resetStats();
  const orphan = { event_id: 'play_orphan', song_id: 'song-a', played_at: 1000 };
  memoryStore.set('music-play-stats-v2', JSON.stringify({ version: 2, state: {
    ownerSubject: null, pendingQueue: [orphan], pendingBySubject: { '': [orphan] },
  } }));
  await usePlayStatsStore.persist.rehydrate();
  await usePlayStatsStore.persist.rehydrate();
  assert.deepEqual(usePlayStatsStore.getState().legacyUnownedPending, [orphan]);
  usePlayStatsStore.getState().setSubject('account-b');
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  const persisted = JSON.parse(memoryStore.get('music-play-stats-v2')).state;
  assert.deepEqual(persisted.legacyUnownedPending, [orphan]);
  assert.deepEqual(persisted.pendingBySubject[''], [orphan]);
  await usePlayStatsStore.persist.rehydrate();
  assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
});

test('usePlayStatsStore: failed per-event storage writes trigger immediate best-effort POST', async () => {
  resetStats();
  usePlayStatsStore.getState().setSubject('storage-error-account');
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key.startsWith('music-play-stats-pending-v1:')) throw new Error('simulated full storage');
    originalSetItem(key, value);
  };
  let submitted = 0;
  globalThis.fetch = async (_url, init) => {
    const { events } = JSON.parse(init.body);
    submitted += events.length;
    return new Response(JSON.stringify({ ok: true, data: {
      recorded: events.length,
      acceptedEventIds: events.map((event) => event.event_id),
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    usePlayStatsStore.getState().recordQualifiedPlay('song-a');
    await new Promise(setImmediate);
    assert.equal(submitted, 1);
    assert.deepEqual(usePlayStatsStore.getState().pendingQueue, []);
  } finally {
    localStorage.setItem = originalSetItem;
  }
});

test('usePlayStatsStore: hidden page pauses due upload until visible', async () => {
  resetStats();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(1_000_000) });
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init.method);
    if (init.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, data: {
        songs: [{ id: 'song-a', title: 'Song A', play_count: 1 }],
        totalPlays: 1, totalUniqueSongs: 1,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const { events } = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, data: {
      recorded: events.length,
      acceptedEventIds: events.map((event) => event.event_id),
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    usePlayStatsStore.getState().setSubject('hidden-account');
    usePlayStatsStore.getState().recordQualifiedPlay('song-a');
    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    await new Promise(setImmediate);
    assert.deepEqual(requests, []);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length, 1);
    mock.timers.tick(1_200_000);
    assert.deepEqual(requests, []);
    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    mock.timers.tick(0);
    await new Promise(setImmediate);
    assert.deepEqual(requests, ['POST']);
  } finally {
    resetSyncBackoff();
    mock.timers.reset();
    document.visibilityState = 'visible';
  }
});

test('usePlayStatsStore: explicit keepalive flush submits pending events', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  usePlayStatsStore.getState().recordQualifiedPlay('song-a');
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init);
    const { events } = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, data: {
      recorded: events.length,
      acceptedEventIds: events.map((event) => event.event_id),
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  assert.equal((await usePlayStatsStore.getState().flushQueue({ keepalive: true })).ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].keepalive, true);
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
  assert.equal(Object.hasOwn(usePlayStatsStore.getState(), 'topAlbums'), false);

  usePlayStatsStore.getState().setSubject(null);
  assert.equal(Object.hasOwn(usePlayStatsStore.getState(), 'topAlbums'), false);
  assert.deepEqual(await usePlayStatsStore.getState().refreshRemoteStats(), {
    ok: false,
    reason: 'unauthenticated',
  });
});

test('usePlayStatsStore: complete cloud counts preserve a low-ranked locally known song', async () => {
  resetStats({
    ownerSubject: 'account-a', identityReady: true,
    playCounts: { 'low-song': 2 },
    songMetaMap: { 'low-song': { id: 'low-song', title: 'Low Song', artist: 'Artist' } },
    totalPlays: 2, totalUniqueSongs: 1,
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: {
    songs: [{ id: 'top-song', title: 'Top Song', play_count: 20 }],
    playCounts: { 'top-song': 20, 'low-song': 2 },
    totalPlays: 22, totalUniqueSongs: 2,
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await usePlayStatsStore.getState().refreshRemoteStats()).ok, true);
  const state = usePlayStatsStore.getState();
  assert.equal(state.getPlayCount('low-song'), 2);
  assert.equal(state.songMetaMap['low-song'].title, 'Low Song');
  assert.equal(state.totalPlays, 22);
});

test('usePlayStatsStore: complete cloud counts drop deleted songs but overlay unsent events', async () => {
  resetStats({
    ownerSubject: 'account-a', identityReady: true,
    playCounts: { 'deleted-song': 2 },
    songMetaMap: { 'deleted-song': { id: 'deleted-song', title: 'Deleted' } },
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: {
    songs: [], playCounts: {}, totalPlays: 0, totalUniqueSongs: 0,
  } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await usePlayStatsStore.getState().refreshRemoteStats()).ok, true);
  assert.equal(usePlayStatsStore.getState().getPlayCount('deleted-song'), 0);
  usePlayStatsStore.getState().recordQualifiedPlay('still-pending');
  assert.equal((await usePlayStatsStore.getState().refreshRemoteStats()).ok, true);
  assert.equal(usePlayStatsStore.getState().getPlayCount('still-pending'), 1);
  assert.equal(usePlayStatsStore.getState().getPlayCount('deleted-song'), 0);
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

test('usePlayStatsStore: authoritative refresh removes deleted songs and preserves events added in flight', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true });
  usePlayStatsStore.setState({
    playCounts: { 'deleted-song': 1 },
    topSongs: [{ id: 'deleted-song', title: 'Deleted Song', play_count: 1 }],
    totalPlays: 1,
    totalUniqueSongs: 1,
  });
  let resolveRefresh;
  globalThis.fetch = async () => new Promise((resolve) => { resolveRefresh = resolve; });

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
