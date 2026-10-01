import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageLoadRegistry,
  IMAGE_READY_TTL_MS,
  IMAGE_REGISTRY_MAX_ENTRIES,
  PRIVATE_COVER_CACHE_TTL_MS,
  PRIVATE_COVER_CACHE_MAX_ENTRIES,
  PRIVATE_COVER_MAX_BYTES,
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

test('private media covers reuse one authenticated download within a session and never cache external URLs', async () => {
  const requested = [];
  let nextObjectId = 0;
  const registry = createImageLoadRegistry({
    origin: () => 'https://tune.example',
    fetchImpl: async (url, init) => {
      requested.push({ url, init });
      return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 });
    },
    createObjectURL: () => `blob:cover-${++nextObjectId}`,
    revokeObjectURL: () => {},
  });
  registry.setSessionScope({ authenticated: true, user: { accountId: 'account-a' }, csrfToken: 'session-1' });
  assert.equal(registry.shouldLoadPrivately('/media/cover/a.png'), true);
  assert.equal(registry.shouldLoadPrivately('https://tune.example/media/cover/a.png'), true);
  assert.equal(registry.shouldLoadPrivately('https://other.example/media/cover/a.png'), false);

  const [first, shared] = await Promise.all([
    registry.load('/media/cover/a.png'),
    registry.load('/media/cover/a.png'),
  ]);
  assert.equal(first.url, shared.url);
  assert.equal(registry.getReadySource('/media/cover/a.png'), first.url);
  assert.equal((await registry.load('/media/cover/a.png')).fromCache, true);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].init.credentials, 'include');
  assert.equal(requested[0].init.cache, 'no-store');
});

test('private cover bytes are revoked on logout, account switch, and session renewal', async () => {
  const revoked = [];
  let requests = 0;
  const registry = createImageLoadRegistry({
    fetchImpl: async () => { requests += 1; return new Response(new Blob(['image'])); },
    createObjectURL: () => `blob:cover-${requests}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  const session = (accountId, csrfToken) => ({ authenticated: true, user: { accountId }, csrfToken });
  registry.setSessionScope(session('a', 'one'));
  const first = await registry.load('/media/cover/a.png');
  registry.setSessionScope(session('a', 'one'));
  assert.equal(registry.getReadySource('/media/cover/a.png'), first.url);

  registry.setSessionScope(session('a', 'two'));
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  assert.deepEqual(revoked, [first.url]);
  const second = await registry.load('/media/cover/a.png');
  registry.setSessionScope(session('b', 'two'));
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  assert.deepEqual(revoked, [first.url, second.url]);

  const third = await registry.load('/media/cover/a.png');
  registry.setSessionScope(null);
  assert.equal(registry.shouldLoadPrivately('/media/cover/a.png'), false);
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  assert.deepEqual(revoked, [first.url, second.url, third.url]);
});

test('late private cover responses cannot repopulate a cleared session', async () => {
  let finish;
  const registry = createImageLoadRegistry({
    fetchImpl: () => new Promise((resolve) => { finish = resolve; }),
    createObjectURL: () => 'blob:late',
    revokeObjectURL: () => {},
  });
  registry.setSessionScope({ authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' });
  const pending = registry.load('/media/cover/a.png');
  registry.setSessionScope(null);
  finish(new Response(new Blob(['image'])));
  await assert.rejects(pending, /session changed/);
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
});

test('private cover cache evicts by capacity and expires within the active session', async () => {
  let clock = 0;
  const revoked = [];
  let objectId = 0;
  const registry = createImageLoadRegistry({
    now: () => clock,
    fetchImpl: async () => new Response(new Blob(['image'])),
    createObjectURL: () => `blob:cover-${++objectId}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  registry.setSessionScope({ authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' });
  for (let index = 0; index <= PRIVATE_COVER_CACHE_MAX_ENTRIES; index += 1) {
    await registry.load(`/media/cover/${index}.png`);
  }
  assert.equal(registry.getReadySource('/media/cover/0.png'), null);
  assert.deepEqual(revoked, ['blob:cover-1']);
  clock = PRIVATE_COVER_CACHE_TTL_MS + 1;
  assert.equal(registry.getReadySource('/media/cover/64.png'), null);
  assert.equal(revoked.length, PRIVATE_COVER_CACHE_MAX_ENTRIES + 1);
});

test('a new route checks the live session once before showing cached private covers', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let checks = 0;
  let downloads = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => { checks += 1; return session; },
    fetchImpl: async () => { downloads += 1; return new Response(new Blob(['image'])); },
    createObjectURL: () => `blob:cover-${downloads}`,
    revokeObjectURL: () => {},
  });
  registry.setSessionScope(session);
  await registry.load('/media/cover/one.png');
  await registry.load('/media/cover/two.png');
  route = '/library';
  assert.equal(registry.getReadySource('/media/cover/one.png'), null);
  const [first, second] = await Promise.all([
    registry.load('/media/cover/one.png'), registry.load('/media/cover/two.png'),
  ]);
  assert.equal(first.fromCache, true);
  assert.equal(second.fromCache, true);
  assert.equal(checks, 1);
  assert.equal(downloads, 2);
});

test('remote session revocation prevents cached private cover reuse after navigation', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let downloads = 0;
  const revoked = [];
  let invalidations = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => ({ authenticated: false }),
    onSessionRejected: () => { invalidations += 1; },
    fetchImpl: async () => { downloads += 1; return new Response(new Blob(['image'])); },
    createObjectURL: () => 'blob:private-cover',
    revokeObjectURL: (url) => revoked.push(url),
  });
  registry.setSessionScope(session);
  await registry.load('/media/cover/a.png');
  route = '/library';
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  await assert.rejects(registry.load('/media/cover/a.png'), /invalidated/);
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  assert.equal(downloads, 1);
  assert.deepEqual(revoked, ['blob:private-cover']);
  assert.equal(invalidations, 1);
});

test('returning through a route without covers still checks a silently revoked session', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let downloads = 0;
  let checks = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => { checks += 1; return { authenticated: false }; },
    fetchImpl: async () => { downloads += 1; return new Response(new Blob(['image'])); },
    createObjectURL: () => 'blob:former-session',
    revokeObjectURL: () => {},
    onSessionRejected: () => {},
  });
  registry.setSessionScope(session);
  await registry.load('/media/cover/a.png');
  route = '/settings';
  registry.invalidateRoute();
  route = '/home';
  registry.invalidateRoute();
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  await assert.rejects(registry.load('/media/cover/a.png'), /invalidated/);
  assert.equal(checks, 1);
  assert.equal(downloads, 1);
});

test('a failed route check never leaves an earlier route authorized', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let checks = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => {
      checks += 1;
      if (checks === 1) throw new Error('network unavailable');
      return { authenticated: false };
    },
    fetchImpl: async () => new Response(new Blob(['image'])),
    createObjectURL: () => 'blob:former-session',
    revokeObjectURL: () => {},
    onSessionRejected: () => {},
  });
  registry.setSessionScope(session);
  await registry.load('/media/cover/a.png');
  route = '/library';
  registry.invalidateRoute();
  await assert.rejects(registry.load('/media/cover/a.png'), /network unavailable/);
  route = '/home';
  registry.invalidateRoute();
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  await assert.rejects(registry.load('/media/cover/a.png'), /invalidated/);
  assert.equal(checks, 2);
});

test('a media response from the prior route cannot authorize the new route', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let finish;
  let checks = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => { checks += 1; return session; },
    fetchImpl: () => new Promise((resolve) => { finish = resolve; }),
    createObjectURL: () => 'blob:late-route',
    revokeObjectURL: () => {},
  });
  registry.setSessionScope(session);
  const pending = registry.load('/media/cover/a.png');
  route = '/library';
  registry.invalidateRoute();
  finish(new Response(new Blob(['image'])));
  await pending;
  assert.equal(registry.getReadySource('/media/cover/a.png'), 'blob:late-route');
  assert.equal((await registry.load('/media/cover/a.png')).fromCache, true);
  assert.equal(checks, 1);
});

test('an old media response cannot reauthorize A after A to B to A navigation', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let finish;
  let checks = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => { checks += 1; return { authenticated: false }; },
    fetchImpl: () => new Promise((resolve) => { finish = resolve; }),
    createObjectURL: () => 'blob:late-route',
    revokeObjectURL: () => {},
    onSessionRejected: () => {},
  });
  registry.setSessionScope(session);
  const pending = registry.load('/media/cover/a.png');
  route = '/settings'; registry.invalidateRoute();
  route = '/home'; registry.invalidateRoute();
  finish(new Response(new Blob(['image'])));
  await assert.rejects(pending, /invalidated/);
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  assert.equal(checks, 1);
});

test('an old session check cannot reauthorize A after A to B to A navigation', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let completeOldCheck;
  let checks = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: () => {
      checks += 1;
      if (checks === 1) return new Promise((resolve) => { completeOldCheck = resolve; });
      return Promise.resolve({ authenticated: false });
    },
    fetchImpl: async () => new Response(new Blob(['image'])),
    createObjectURL: () => 'blob:old-session',
    revokeObjectURL: () => {},
    onSessionRejected: () => {},
  });
  registry.setSessionScope(session);
  await registry.load('/media/cover/a.png');
  route = '/library'; registry.invalidateRoute();
  const oldCheck = registry.load('/media/cover/a.png');
  route = '/settings'; registry.invalidateRoute();
  route = '/library'; registry.invalidateRoute();
  completeOldCheck(session);
  await assert.rejects(oldCheck, /route changed/);
  assert.equal(registry.getReadySource('/media/cover/a.png'), null);
  await assert.rejects(registry.load('/media/cover/a.png'), /invalidated/);
  assert.equal(checks, 2);
});

test('oversized private cover probe cancels its body and later displays use one direct request', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let requests = 0;
  let cancelled = 0;
  let read = 0;
  let signal;
  const registry = createImageLoadRegistry({
    fetchImpl: async (_url, init) => {
      requests += 1;
      signal = init.signal;
      return {
        ok: true,
        headers: new Headers({ 'Content-Length': String(PRIVATE_COVER_MAX_BYTES + 1) }),
        body: { cancel: async () => { cancelled += 1; } },
        blob: async () => { read += 1; return new Blob(['unexpected']); },
      };
    },
  });
  registry.setSessionScope(session);
  const first = await registry.load('/media/cover/huge.png');
  assert.equal(first.url, '/media/cover/huge.png');
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(read, 0);
  const again = await registry.load('/media/cover/huge.png');
  assert.equal(again.url, first.url);
  assert.equal(again.fromCache, true);
  assert.equal(requests, 1);
});

test('oversized marker is route checked and cleared when the session changes', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let checks = 0;
  let requests = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => { checks += 1; return session; },
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        headers: new Headers({ 'Content-Length': String(PRIVATE_COVER_MAX_BYTES + 1) }),
        body: { cancel: async () => {} },
      };
    },
  });
  registry.setSessionScope(session);
  await registry.load('/media/cover/huge.png');
  route = '/library';
  registry.invalidateRoute();
  assert.equal(registry.getReadySource('/media/cover/huge.png'), null);
  assert.equal((await registry.load('/media/cover/huge.png')).url, '/media/cover/huge.png');
  assert.equal(checks, 1);
  assert.equal(requests, 1);
  registry.setSessionScope({ ...session, csrfToken: 'two' });
  await registry.load('/media/cover/huge.png');
  assert.equal(requests, 2);
});

test('a revoked session blocks an oversized direct URL after navigation', async () => {
  const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
  let route = '/home';
  let requests = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => ({ authenticated: false }),
    onSessionRejected: () => {},
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        headers: new Headers({ 'Content-Length': String(PRIVATE_COVER_MAX_BYTES + 1) }),
        body: { cancel: async () => {} },
      };
    },
  });
  registry.setSessionScope(session);
  await registry.load('/media/cover/huge.png');
  route = '/library';
  registry.invalidateRoute();
  await assert.rejects(registry.load('/media/cover/huge.png'), /invalidated/);
  assert.equal(requests, 1);
  assert.equal(registry.shouldLoadPrivately('/media/cover/huge.png'), false);
});
