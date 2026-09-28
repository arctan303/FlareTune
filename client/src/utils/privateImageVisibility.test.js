import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageLoadRegistry, PRIVATE_COVER_MAX_BYTES } from './imageLoadRegistry.js';
import { visibleImageSource } from './privateImageVisibility.js';

const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };

test('persistent sidebar hides its Blob immediately after navigation and revoked session cannot restore it', async () => {
  let route = '/home';
  let checks = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => { checks += 1; return { authenticated: false }; },
    fetchImpl: async () => new Response(new Blob(['cover'])),
    createObjectURL: () => 'blob:private-cover',
    revokeObjectURL: () => {},
    onSessionRejected: () => {},
  });
  registry.setSessionScope(session);
  const src = '/media/cover/sidebar.png';
  const { url } = await registry.load(src);
  assert.equal(visibleImageSource(src, url, '/placeholder-album.svg', registry), url);
  route = '/library';
  registry.invalidateRoute();
  assert.equal(visibleImageSource(src, url, '/placeholder-album.svg', registry), null);
  await assert.rejects(registry.load(src), /invalidated/);
  assert.equal(visibleImageSource(src, url, '/placeholder-album.svg', registry), null);
  assert.equal(checks, 1);
});

test('known oversized relative cover displays only while its route is authorized', async () => {
  let route = '/home';
  let checks = 0;
  const registry = createImageLoadRegistry({
    routeKey: () => route,
    verifySession: async () => { checks += 1; return session; },
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ 'Content-Length': String(PRIVATE_COVER_MAX_BYTES + 1) }),
      body: { cancel: async () => {} },
    }),
  });
  registry.setSessionScope(session);
  const src = '/media/cover/large.png';
  const first = await registry.load(src);
  assert.equal(registry.getReadySource(src), src);
  assert.equal(visibleImageSource(src, first.url, '/placeholder-album.svg', registry), src);
  route = '/library';
  registry.invalidateRoute();
  assert.equal(registry.getReadySource(src), null);
  assert.equal(visibleImageSource(src, first.url, '/placeholder-album.svg', registry), null);
  const verified = await registry.load(src);
  assert.equal(visibleImageSource(src, verified.url, '/placeholder-album.svg', registry), src);
  assert.equal(checks, 1);
});

test('same-path session renewal notifies mounted covers and hides the former Blob', async () => {
  let objectId = 0;
  const registry = createImageLoadRegistry({
    fetchImpl: async () => new Response(new Blob(['cover'])),
    createObjectURL: () => `blob:cover-${++objectId}`,
    revokeObjectURL: () => {},
  });
  registry.setSessionScope(session);
  const src = '/media/cover/sidebar.png';
  const old = (await registry.load(src)).url;
  let notified = 0;
  const unsubscribe = registry.subscribeVisibility(() => { notified += 1; });
  const oldRevision = registry.getVisibilityRevision();
  registry.setSessionScope({ ...session, csrfToken: 'two' });
  assert.equal(notified, 1);
  assert.ok(registry.getVisibilityRevision() > oldRevision);
  assert.equal(visibleImageSource(src, old, '/placeholder-album.svg', registry), null);
  const current = (await registry.load(src)).url;
  assert.notEqual(current, old);
  assert.equal(visibleImageSource(src, current, '/placeholder-album.svg', registry), current);
  unsubscribe();
});

test('same-path account switch clears oversized marker and invalidates its raw URL', async () => {
  let downloads = 0;
  const registry = createImageLoadRegistry({
    fetchImpl: async () => {
      downloads += 1;
      return {
        ok: true,
        headers: new Headers({ 'Content-Length': String(PRIVATE_COVER_MAX_BYTES + 1) }),
        body: { cancel: async () => {} },
      };
    },
  });
  registry.setSessionScope(session);
  const src = '/media/cover/large.png';
  const old = (await registry.load(src)).url;
  assert.equal(visibleImageSource(src, old, '/placeholder-album.svg', registry), src);
  let notified = 0;
  const unsubscribe = registry.subscribeVisibility(() => { notified += 1; });
  registry.setSessionScope({ authenticated: true, user: { accountId: 'b' }, csrfToken: 'two' });
  assert.equal(notified, 1);
  assert.equal(registry.getReadySource(src), null);
  assert.equal(visibleImageSource(src, old, '/placeholder-album.svg', registry), null);
  await registry.load(src);
  assert.equal(downloads, 2);
  unsubscribe();
});
