import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageLoadRegistry, PRIVATE_COVER_CACHE_TTL_MS, PRIVATE_COVER_CACHE_MAX_ENTRIES } from '../utils/imageLoadRegistry.js';
import { createAppleFluidHarness, createBackgroundModuleHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';
import { isTextureAuthorized } from '../utils/privateTextureAuthorization.js';

const session = { authenticated: true, user: { accountId: 'a' }, csrfToken: 'one' };
function setup(file, exportName) {
  let clock = 0, requests = 0;
  const registry = createImageLoadRegistry({
    now: () => clock, fetchImpl: async () => { requests++; return new Response(new Blob(['cover'])); },
    createObjectURL: () => `blob:cover-${requests}`, revokeObjectURL() {},
  });
  registry.setSessionScope(session);
  const fixture = createBackgroundModuleHarness({
    file: new URL(file, import.meta.url), exportName,
    modules: {
      '../utils/imageLoadRegistry': { imageLoadRegistry: registry },
      '../utils/imageLoadRegistry.js': { imageLoadRegistry: registry },
      '../hooks/usePrivateMediaRouteRevision.js': { usePrivateMediaRouteRevision: () => registry.getVisibilityRevision() },
      './usePrivateMediaRouteRevision.js': { usePrivateMediaRouteRevision: () => registry.getVisibilityRevision() },
      '../hooks/usePageActivity.js': { usePageActivity: () => true },
      './usePageActivity.js': { usePageActivity: () => true },
      '../hooks/useImageInView.js': { useImageInView: () => ({ containerRef: { current: null }, inView: true, setInView() {} }) },
      '../i18n/index.js': { t: text => text },
    },
    nodes: { img: { complete: true, naturalWidth: 10, naturalHeight: 10 } },
  });
  return { ...fixture, registry, advance: () => { clock = PRIVATE_COVER_CACHE_TTL_MS + 1; }, get requests() { return requests; } };
}
const imageSource = node => typeof node === 'string' ? node : node?.type === 'img' ? node.props.src
  : node?.props?.children?.map(imageSource).find(Boolean) || null;

for (const [name, file, exportName, props] of [
  ['LazyImage', './LazyImage.jsx', 'default', src => ({ src, eager: true })],
  ['HistoryImage', './HistoryCoverStack.jsx', 'HistoryImage', src => ({ src, isStaged: false })],
  ['private source hook', '../hooks/usePrivateMediaSource.js', 'usePrivateMediaSource', src => src],
]) {
  for (const eviction of ['ttl', 'capacity']) {
    test(`${name} keeps the same mounted source after ${eviction} without another download`, async () => {
      const fixture = setup(file, exportName);
      const src = '/media/cover/first.png';
      fixture.render(props(src)); await fixture.registry.load(src); await flushBackgroundAsync();
      const first = imageSource(fixture.render());
      assert.ok(first?.startsWith('blob:'));
      if (eviction === 'ttl') fixture.advance();
      else for (let i = 0; i < PRIVATE_COVER_CACHE_MAX_ENTRIES; i++) await fixture.registry.load(`/media/cover/${i}.png`);
      assert.equal(fixture.registry.getReadySource(src), null);
      const requests = fixture.requests;
      assert.equal(imageSource(fixture.render()), first);
      await flushBackgroundAsync();
      assert.equal(fixture.requests, requests);
      fixture.registry.setSessionScope(null);
      assert.equal(imageSource(fixture.render()), null);
      fixture.unmount();
    });
  }
}

test('uploaded fluid texture survives cache expiration, but not a session change or route revision', async () => {
  const fixture = setup('../hooks/usePrivateMediaSource.js', 'usePrivateMediaSource');
  const cover = '/media/cover/first.png';
  const loaded = await fixture.registry.load(cover);
  const auth = { coverUrl: cover, routeRevision: 1, source: loaded.url, displayAuthorization: loaded.displayAuthorization };
  fixture.advance();
  assert.equal(fixture.registry.getReadySource(cover), null);
  assert.equal(isTextureAuthorized(cover, 1, auth, fixture.registry), true);
  assert.equal(isTextureAuthorized(cover, 2, auth, fixture.registry), false);
  fixture.registry.setSessionScope({ ...session, csrfToken: 'renewed' });
  assert.equal(isTextureAuthorized(cover, 1, auth, fixture.registry), false);
});

test('a new image mount refetches an evicted cover rather than adopting an older display grant', async () => {
  const fixture = setup('./LazyImage.jsx', 'default');
  const src = '/media/cover/first.png';
  await fixture.registry.load(src);
  fixture.advance();
  assert.equal(imageSource(fixture.render({ src, eager: true })), null);
  await fixture.registry.load(src);
  await flushBackgroundAsync();
  assert.equal(imageSource(fixture.render()), 'blob:cover-2');
  assert.equal(fixture.requests, 2);
  fixture.unmount();
});

test('a late native image decode can recover an evicted Blob exactly once through its original private URL', async () => {
  const fixture = setup('../hooks/usePrivateMediaSource.js', 'usePrivateMediaImage');
  const src = '/media/cover/first.png';
  fixture.render(src); await fixture.registry.load(src); await flushBackgroundAsync();
  const loaded = fixture.render();
  assert.ok(loaded.url.startsWith('blob:'));
  fixture.advance();
  assert.equal(fixture.registry.getReadySource(src), null);
  assert.equal(loaded.onError(), true);
  const recovered = fixture.render();
  assert.equal(recovered.url, src);
  assert.equal(recovered.onError(), false, 'raw URL failure cannot create a retry loop');
  assert.equal(fixture.requests, 1, 'recovery does not refill the Blob cache');
  fixture.registry.setSessionScope(null);
  const loggedOut = fixture.render();
  assert.equal(loggedOut.url, null);
  assert.equal(loggedOut.onError(), false);
  fixture.unmount();
});

test('fluid image decode recovers after assignment-time eviction before using its palette fallback', async () => {
  const resource = setup('../hooks/usePrivateMediaSource.js', 'usePrivateMediaSource');
  const fixture = createAppleFluidHarness({ registry: resource.registry });
  const src = '/media/cover/first.png';
  fixture.render({ coverUrl: src });
  const loaded = await resource.registry.load(src); await flushBackgroundAsync();
  const image = fixture.images.get(loaded.url);
  assert.ok(image);
  resource.advance();
  assert.equal(resource.registry.getReadySource(src), null);
  image.onerror();
  assert.equal(fixture.images.get(src), image);
  image.onerror();
  assert.equal(fixture.images.size, 2, 'raw URL is tried once, then the existing palette fallback applies');
  assert.equal(resource.requests, 1);
  fixture.unmount();
});
