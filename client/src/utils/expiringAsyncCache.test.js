import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExpiringAsyncCache,
  createLatestRequestGuard,
  revalidateExpiringCache,
  shouldCancelPlaylistNavigation,
} from './expiringAsyncCache.js';

test('expiring async cache deduplicates in-flight work and reuses ready data', async () => {
  let resolveLoad;
  let calls = 0;
  const cache = createExpiringAsyncCache({ ttlMs: 300_000, now: () => 0 });
  const loader = () => {
    calls += 1;
    return new Promise((resolve) => { resolveLoad = resolve; });
  };

  const first = cache.load('playlist-a', loader);
  const shared = cache.load('playlist-a', loader);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveLoad({ songs: [1] });
  assert.deepEqual(await first, { songs: [1] });
  assert.deepEqual(await shared, { songs: [1] });
  assert.deepEqual(await cache.load('playlist-a', loader), { songs: [1] });
  assert.equal(calls, 1);
});

test('expiring async cache reloads after ttl', async () => {
  let clock = 0;
  let calls = 0;
  const cache = createExpiringAsyncCache({ ttlMs: 10, now: () => clock });
  const loader = async () => ({ version: ++calls });

  assert.deepEqual(await cache.load('playlist-a', loader), { version: 1 });
  clock = 11;
  assert.deepEqual(await cache.load('playlist-a', loader), { version: 2 });
});

test('explicit refresh bypasses a fresh value while deduplicating in-flight work', async () => {
  let calls = 0;
  const cache = createExpiringAsyncCache({ ttlMs: 300_000, now: () => 0 });
  const loader = async () => ({ version: ++calls });

  assert.deepEqual(await cache.load('playlist-a', loader), { version: 1 });
  const firstRefresh = cache.refresh('playlist-a', loader);
  const sharedRefresh = cache.refresh('playlist-a', loader);
  assert.equal(firstRefresh, sharedRefresh);
  assert.deepEqual(await firstRefresh, { version: 2 });
  assert.deepEqual(cache.peek('playlist-a'), { version: 2 });
});

test('required revalidation never returns cached data and propagates refresh failure', async () => {
  let rejectRefresh;
  const cache = createExpiringAsyncCache({ ttlMs: 300_000, now: () => 0 });
  await cache.load('playlist-a', async () => ({ visibility: 'old' }));

  const result = revalidateExpiringCache(
    cache,
    'playlist-a',
    () => new Promise((resolve, reject) => { rejectRefresh = reject; }),
  );
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  rejectRefresh(new Error('playlist is no longer visible'));
  await assert.rejects(result, /no longer visible/);
  assert.deepEqual(cache.peek('playlist-a'), { visibility: 'old' });
});

test('stale-while-revalidate remains opt-in for ordinary playlist opening', async () => {
  let resolveRefresh;
  let resolveApplied;
  const refreshed = [];
  const applied = new Promise((resolve) => { resolveApplied = resolve; });
  const cache = createExpiringAsyncCache({ ttlMs: 300_000, now: () => 0 });
  await cache.load('playlist-a', async () => ({ version: 1 }));

  const result = revalidateExpiringCache(
    cache,
    'playlist-a',
    () => new Promise((resolve) => { resolveRefresh = resolve; }),
    {
      staleWhileRevalidate: true,
      onRefresh: (value) => {
        refreshed.push(value);
        resolveApplied();
      },
    },
  );
  assert.deepEqual(await result, { version: 1 });
  resolveRefresh({ version: 2 });
  await applied;
  assert.deepEqual(refreshed, [{ version: 2 }]);
});

test('latest request guard rejects a stale completion', () => {
  const guard = createLatestRequestGuard();
  const first = guard.next();
  const second = guard.next();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
  guard.cancel();
  assert.equal(guard.isCurrent(second), false);
});

test('latest request guard rejects an earlier request that completes after identity changes', async () => {
  let resolveFirst;
  const applied = [];
  const guard = createLatestRequestGuard();
  const firstToken = guard.next();
  const firstRequest = new Promise((resolve) => { resolveFirst = resolve; })
    .then((value) => {
      if (guard.isCurrent(firstToken)) applied.push(value);
    });

  const secondToken = guard.next();
  assert.equal(guard.isCurrent(secondToken), true);
  resolveFirst('old identity payload');
  await firstRequest;
  assert.deepEqual(applied, []);
});

test('home navigation cancels every non-idle playlist transition', () => {
  assert.equal(shouldCancelPlaylistNavigation(true, 'idle'), true);
  assert.equal(shouldCancelPlaylistNavigation(false, 'opening'), true);
  assert.equal(shouldCancelPlaylistNavigation(false, 'skeleton'), true);
  assert.equal(shouldCancelPlaylistNavigation(false, 'error'), true);
  assert.equal(shouldCancelPlaylistNavigation(false, 'idle'), false);
});
