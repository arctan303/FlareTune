import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { memoryStore, resetStats, usePlayStatsStore, useUIStore, resetSyncBackoff } from './playStatsTestSupport.js';

const statsResponse = (data) => Response.json({ ok: true, data });

test('preview refresh preserves the complete ledger and pending events, including with an older full-response server', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true,
    playCounts: { low: 4 }, totalPlays: 4, totalUniqueSongs: 1 });
  const store = usePlayStatsStore.getState();
  store.recordQualifiedPlay({ id: 'low', title: 'Low' });
  const before = usePlayStatsStore.getState();
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('view=summary'));
    return statsResponse({ songs: [{ id: 'top', title: 'Top', artist: 'Artist', play_count: 80 }],
      playCounts: { top: 80 }, totalPlays: 80, totalUniqueSongs: 1 });
  };
  assert.equal((await store.synchronizeListeningPreview()).ok, true);
  const after = usePlayStatsStore.getState();
  assert.deepEqual(after.playCounts, { low: 5 });
  assert.deepEqual(after.pendingQueue, before.pendingQueue);
  assert.deepEqual(after.topSongs, before.topSongs);
  assert.equal(after.totalPlays, 5);
  assert.equal(after.listeningPreview[0].play_count, 80);
  store.recordQualifiedPlay({ id: 'low', title: 'Low' });
  assert.deepEqual(usePlayStatsStore.getState().listeningPreview, after.listeningPreview);
  globalThis.fetch = async () => statsResponse({ songs: [{ id: 'top', title: 'Top', play_count: 80 }],
    playCounts: { top: 80, low: 4 }, totalPlays: 84, totalUniqueSongs: 2 });
  await store.refreshRemoteStats(50);
  assert.equal(usePlayStatsStore.getState().getPlayCount('low'), 6);
  assert.equal(usePlayStatsStore.getState().totalPlays, 86);
  assert.equal(usePlayStatsStore.getState().pendingQueue.length, 2);
  resetSyncBackoff();
});

test('detail waits for a preview then requests complete counts; leaving before it starts suppresses the extra read', async () => {
  for (const leave of [false, true]) {
    resetStats({ ownerSubject: 'account-a', identityReady: true });
    const store = usePlayStatsStore.getState();
    const urls = [];
    let resolvePreview;
    globalThis.fetch = async (url) => {
      urls.push(url);
      if (url.includes('view=summary')) return new Promise((resolve) => { resolvePreview = resolve; });
      return statsResponse({ songs: [], playCounts: { outside: 9 }, totalPlays: 9, totalUniqueSongs: 1 });
    };
    const preview = store.synchronizeListeningPreview();
    store.setDetailViewActive(true);
    const detail = store.refreshRemoteStats(50, { requireDetailView: true });
    assert.equal(urls.length, 1);
    if (leave) store.setDetailViewActive(false);
    resolvePreview(statsResponse({ songs: [] }));
    await preview;
    assert.equal((await detail).ok, !leave);
    assert.equal(urls.length, leave ? 1 : 2);
    assert.equal(usePlayStatsStore.getState().getPlayCount('outside'), leave ? 0 : 9);
    resetSyncBackoff();
  }
});

test('hourly reads use summary outside the detail view, full while open, and summary again after leaving', async () => {
  resetStats();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(1_000_000) });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return statsResponse({ songs: [], playCounts: {}, totalPlays: 0, totalUniqueSongs: 0 });
  };
  try {
    const store = usePlayStatsStore.getState();
    store.setSubject('account-a');
    await store.synchronizeListeningPreview();
    mock.timers.tick(3_600_000);
    await new Promise(setImmediate);
    store.setDetailViewActive(true);
    mock.timers.tick(3_600_000);
    await new Promise(setImmediate);
    store.setDetailViewActive(false);
    mock.timers.tick(3_600_000);
    await new Promise(setImmediate);
    assert.deepEqual(urls.map((url) => url.includes('view=summary')), [true, true, false, true]);
    globalThis.document.visibilityState = 'hidden';
    globalThis.document.dispatch('visibilitychange');
    mock.timers.tick(7_200_000);
    await new Promise(setImmediate);
    assert.equal(urls.length, 4);
  } finally {
    resetSyncBackoff();
    mock.timers.reset();
    globalThis.document.visibilityState = 'visible';
  }
});

test('an old account preview cannot publish into a new account or clear its pending events', async () => {
  resetStats({ ownerSubject: 'account-a', identityReady: true,
    listeningPreview: [{ id: 'old', title: 'Old' }] });
  let resolvePreview;
  globalThis.fetch = async () => new Promise((resolve) => { resolvePreview = resolve; });
  const store = usePlayStatsStore.getState();
  const pending = store.synchronizeListeningPreview();
  store.setSubject('account-b');
  store.recordQualifiedPlay({ id: 'new', title: 'New' });
  resolvePreview(statsResponse({ songs: [{ id: 'old', title: 'Old' }] }));
  assert.equal((await pending).reason, 'identity-changed');
  assert.deepEqual(usePlayStatsStore.getState().listeningPreview, []);
  assert.equal(usePlayStatsStore.getState().getPlayCount('new'), 1);
  assert.equal(usePlayStatsStore.getState().pendingQueue.length, 1);
  resetSyncBackoff();
});

test('leaving detail while its hourly read waits for upload keeps future preview refreshes alive', async () => {
  resetStats();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(1_000_000) });
  const reads = [];
  let finishUpload;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') return new Promise((resolve) => {
      const { events } = JSON.parse(init.body);
      finishUpload = () => resolve(statsResponse({ acceptedEventIds: events.map((event) => event.event_id) }));
    });
    reads.push(url);
    return statsResponse({ songs: [] });
  };
  try {
    const store = usePlayStatsStore.getState();
    store.setSubject('account-a');
    await store.synchronizeListeningPreview();
    store.recordQualifiedPlay('new-song');
    const uploading = store.flushQueue({ force: true });
    store.setDetailViewActive(true);
    mock.timers.tick(3_600_000);
    store.setDetailViewActive(false);
    finishUpload();
    await uploading;
    await new Promise(setImmediate);
    mock.timers.tick(0);
    await new Promise(setImmediate);
    assert.equal(reads.length, 2);
    assert.ok(reads.every((url) => url.includes('view=summary')));
    mock.timers.tick(3_600_000);
    await new Promise(setImmediate);
    assert.equal(reads.length, 3);
    assert.equal(usePlayStatsStore.getState().getPlayCount('new-song'), 1);
    assert.equal(usePlayStatsStore.getState().pendingQueue.length, 0);
  } finally {
    resetSyncBackoff();
    mock.timers.reset();
  }
});

