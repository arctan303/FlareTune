import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageLoadRegistry,
  IMAGE_READY_TTL_MS,
  IMAGE_REGISTRY_MAX_ENTRIES,
} from './imageLoadRegistry.js';

const createFakeImage = () => {
  const image = {
    onload: null,
    onerror: null,
    src: '',
    decode: () => Promise.resolve(),
    succeed() {
      this.onload?.();
    },
    fail() {
      this.onerror?.();
    },
  };
  return image;
};

const createHarness = (options = {}) => {
  let clock = 0;
  const images = [];
  const timers = new Map();
  let timerId = 0;
  const registry = createImageLoadRegistry({
    now: () => clock,
    createImage: () => {
      const image = {
        onload: null,
        onerror: null,
        src: '',
        decode: () => Promise.resolve(),
      };
      images.push(image);
      return image;
    },
    setTimer: (callback, delay) => {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  return { registry, images, timers, setClock: (value) => { clock = value; } };
};

test('image registry shares an in-flight request and reuses ready state within the ttl', async () => {
  const harness = createHarness();
  const first = harness.registry.load('/cover-a.jpg');
  const shared = harness.registry.load('/cover-a.jpg');
  assert.equal(harness.images.length, 1);

  harness.images[0].onload();
  const [firstResult, sharedResult] = await Promise.all([first, shared]);
  assert.equal(firstResult.fromCache, false);
  assert.equal(sharedResult.fromCache, false);

  const cached = await harness.registry.load('/cover-a.jpg');
  assert.equal(cached.fromCache, true);
  assert.equal(harness.images.length, 1);
});

test('image registry expires ready state after ten minutes', async () => {
  const harness = createHarness();
  const first = harness.registry.load('/cover-a.jpg');
  harness.images[0].onload();
  await first;

  harness.setClock(IMAGE_READY_TTL_MS + 1);
  const second = harness.registry.load('/cover-a.jpg');
  assert.equal(harness.images.length, 2);
  harness.images[1].onload();
  await second;
});

test('image registry uses fallback after failure and remembers the failed primary', async () => {
  const harness = createHarness();
  const first = harness.registry.loadWithFallback('/broken.jpg', '/placeholder.svg');
  harness.images[0].onerror();
  await Promise.resolve();
  assert.equal(harness.images.length, 2);
  harness.images[1].onload();
  const result = await first;
  assert.equal(result.url, '/placeholder.svg');
  assert.equal(result.usedFallback, true);

  const cachedFallback = harness.registry.getReadySource('/broken.jpg', '/placeholder.svg');
  assert.equal(cachedFallback, '/placeholder.svg');
});

test('image registry limits settled entries with least-recently-used eviction', async () => {
  const harness = createHarness({ maxEntries: 2 });
  for (const url of ['/a.jpg', '/b.jpg', '/c.jpg']) {
    const pending = harness.registry.load(url);
    harness.images.at(-1).onload();
    await pending;
  }

  assert.equal(harness.registry.size, 2);
  assert.deepEqual(harness.registry.snapshot().map((entry) => entry.url), ['/b.jpg', '/c.jpg']);
  assert.equal(IMAGE_REGISTRY_MAX_ENTRIES, 160);
});

test('image registry queues overflow while every retained entry is loading', async () => {
  const pendingImages = [];
  const registry = createImageLoadRegistry({
    maxEntries: 2,
    createImage: () => {
      const image = createFakeImage();
      pendingImages.push(image);
      return image;
    },
  });

  const first = registry.load('/a.jpg');
  const second = registry.load('/b.jpg');
  const third = registry.load('/c.jpg');
  await Promise.resolve();
  assert.equal(registry.size, 2);
  assert.equal(pendingImages.length, 2);
  assert.deepEqual(registry.snapshot().map(({ url, status }) => ({ url, status })), [
    { url: '/a.jpg', status: 'loading' },
    { url: '/b.jpg', status: 'loading' },
  ]);

  pendingImages[0].succeed();
  await first;
  await Promise.resolve();
  assert.equal(pendingImages.length, 3);
  assert.equal(registry.size, 2);

  pendingImages[1].succeed();
  pendingImages[2].succeed();
  await Promise.all([second, third]);
});

test('queued image groups still complete through fallback without exceeding capacity', async () => {
  const images = [];
  const registry = createImageLoadRegistry({
    maxEntries: 2,
    createImage: () => {
      const image = createFakeImage();
      images.push(image);
      return image;
    },
  });

  const first = registry.load('/a.jpg');
  const second = registry.load('/b.jpg');
  const group = registry.loadGroup(['/broken.jpg'], '/fallback.svg');
  await Promise.resolve();
  assert.equal(images.length, 2);
  assert.equal(registry.size, 2);

  images[0].succeed();
  await first;
  await Promise.resolve();
  assert.equal(images.length, 3);
  images[2].fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(images.length, 4);
  assert.equal(registry.size, 2);

  images[3].succeed();
  const [result] = await group;
  assert.equal(result.url, '/fallback.svg');
  assert.equal(result.usedFallback, true);

  images[1].succeed();
  await second;
});

test('first-time primary failure still reveals a cached fallback', async () => {
  const images = [];
  const registry = createImageLoadRegistry({
    createImage: () => {
      const image = createFakeImage();
      images.push(image);
      return image;
    },
  });

  const fallbackLoad = registry.load('/placeholder.svg');
  images[0].succeed();
  await fallbackLoad;

  const firstBrokenLoad = registry.loadWithFallback('/broken.jpg', '/placeholder.svg');
  images[1].fail();
  const firstResult = await firstBrokenLoad;
  assert.equal(firstResult.usedFallback, true);
  assert.equal(firstResult.fromCache, false);

  const cachedResult = await registry.loadWithFallback('/broken.jpg', '/placeholder.svg');
  assert.equal(cachedResult.usedFallback, true);
  assert.equal(cachedResult.fromCache, true);
});

test('image registry releases a stalled request slot without reporting a failure', async () => {
  const harness = createHarness({ maxEntries: 1, staleMs: 25 });
  const stalled = harness.registry.load('/stalled.jpg');
  const timer = harness.timers.values().next().value;
  assert.equal(timer.delay, 25);
  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));

  const next = harness.registry.load('/next.jpg');
  assert.equal(harness.images.length, 2);
  harness.images[1].onload();
  await next;

  harness.images[0].onload();
  const stalledResult = await stalled;
  assert.equal(stalledResult.url, '/stalled.jpg');
});

test('slow cache revalidation is not replaced by fallback before the browser reports failure', async () => {
  const harness = createHarness({ staleMs: 25 });
  const pending = harness.registry.loadWithFallback('/revalidating.jpg', '/placeholder.svg');
  const timer = harness.timers.values().next().value;

  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.images.length, 1);

  harness.images[0].onload();
  const result = await pending;
  assert.equal(result.url, '/revalidating.jpg');
  assert.equal(result.usedFallback, undefined);
});

test('stale cache revalidation remains shared for the same URL after releasing its capacity slot', async () => {
  const harness = createHarness({ staleMs: 25 });
  const first = harness.registry.load('/revalidating.jpg');
  const timer = harness.timers.values().next().value;

  timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  const shared = harness.registry.load('/revalidating.jpg');
  assert.equal(harness.images.length, 1);

  harness.images[0].onload();
  const [firstResult, sharedResult] = await Promise.all([first, shared]);
  assert.equal(firstResult.url, '/revalidating.jpg');
  assert.equal(sharedResult.url, '/revalidating.jpg');
});

test('stale cache revalidation still uses fallback after a real browser error', async () => {
  const harness = createHarness({ staleMs: 25 });
  const pending = harness.registry.loadWithFallback('/broken.jpg', '/placeholder.svg');
  const timer = harness.timers.values().next().value;

  timer.callback();
  harness.images[0].onerror();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.images.length, 2);

  harness.images[1].onload();
  const result = await pending;
  assert.equal(result.url, '/placeholder.svg');
  assert.equal(result.usedFallback, true);
});

test('a ready event from a cleared generation cannot replace a newer same-URL load', async () => {
  const harness = createHarness();
  const oldLoad = harness.registry.load('/same.jpg');
  harness.registry.clear();
  const currentLoad = harness.registry.load('/same.jpg');

  harness.images[0].onload();
  await oldLoad;
  assert.deepEqual(harness.registry.snapshot(), [{ url: '/same.jpg', status: 'loading' }]);

  harness.images[1].onload();
  await currentLoad;
  assert.equal(harness.registry.getReadySource('/same.jpg'), '/same.jpg');
});

test('an error event from a cleared generation cannot poison a newer same-URL result', async () => {
  const harness = createHarness();
  const oldLoad = harness.registry.load('/same.jpg');
  harness.registry.clear();
  const currentLoad = harness.registry.load('/same.jpg');

  harness.images[1].onload();
  await currentLoad;
  harness.images[0].onerror();
  await assert.rejects(oldLoad, /failed to load/);

  assert.equal(harness.registry.getReadySource('/same.jpg'), '/same.jpg');
});

test('a displayed cover result supersedes an older explicit prefetch result', async () => {
  const harness = createHarness();
  const prefetch = harness.registry.load('/cover.jpg');
  harness.registry.markReady('/cover.jpg');
  harness.images[0].onerror();
  await assert.rejects(prefetch, /failed to load/);
  assert.equal(harness.registry.getReadySource('/cover.jpg'), '/cover.jpg');

  harness.registry.markReady('/placeholder.svg');
  harness.registry.markError('/cover.jpg');
  assert.equal(harness.registry.getReadySource('/cover.jpg', '/placeholder.svg'), '/placeholder.svg');
});
