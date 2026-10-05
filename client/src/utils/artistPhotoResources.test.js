import assert from 'node:assert/strict';
import test from 'node:test';
import { ExpiringLruMap } from './artistPhotoResources.js';
import { createArtistPhotoHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

test('photo caches retain Map API with LRU capacity and expiring entries', () => {
  let now = 0;
  const cache = new ExpiringLruMap({ maxEntries: 2, ttlMs: 100, now: () => now });
  assert.ok(cache instanceof Map);
  assert.equal(cache.set('a', 1), cache);
  cache.set('b', 2); assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.size, 2);
  now = 100;
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('c'), undefined);
  assert.equal(cache.size, 0);
  cache.set('d', 4); cache.delete('d');
  assert.equal(cache.expiry.size, 0);
  cache.set('e', 5); cache.clear();
  assert.equal(cache.expiry.size, 0);
});

test('shared preload deduplicates URLs and limits concurrent load/decode jobs to two', async () => {
  const fixture = createArtistPhotoHarness();
  const preload = fixture.exports.preloadAndDecodeImage;
  const first = preload('first.jpg');
  assert.equal(preload('first.jpg'), first);
  const second = preload('second.jpg');
  const third = preload('third.jpg');
  assert.equal(fixture.images.size, 2);
  let completeDecode;
  fixture.images.get('first.jpg').decode = () => new Promise(resolve => { completeDecode = resolve; });
  const loading = fixture.images.get('first.jpg').onload();
  await flushBackgroundAsync();
  assert.equal(fixture.images.has('third.jpg'), false);
  completeDecode(); await loading; await first;
  assert.equal(fixture.images.has('third.jpg'), true);
  await fixture.succeed('second.jpg'); await fixture.succeed('third.jpg');
  assert.equal(await second, true); assert.equal(await third, true);
});

test('visible current requests take priority and stale queued prefetches never start', async () => {
  const fixture = createArtistPhotoHarness();
  const preload = fixture.exports.preloadAndDecodeImage;
  preload('active1.jpg'); preload('active2.jpg');
  let valid = true;
  const stale = preload('stale-next.jpg', { priority: 'prefetch', isCurrent: () => valid });
  preload('valid-next.jpg', { priority: 'prefetch' });
  valid = false;
  preload('current.jpg');
  assert.equal(await stale, false);
  await fixture.succeed('active1.jpg');
  assert.equal(fixture.images.has('current.jpg'), true);
  assert.equal(fixture.images.has('valid-next.jpg'), false);
  assert.equal(fixture.images.has('stale-next.jpg'), false);
  await fixture.succeed('active2.jpg');
  assert.equal(fixture.images.has('valid-next.jpg'), true);
});

test('hidden pages start no new image jobs and resume only still-current queued work', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.document.setVisible(false);
  const preload = fixture.exports.preloadAndDecodeImage;
  let valid = true;
  const old = preload('old.jpg', { isCurrent: () => valid });
  preload('new.jpg');
  assert.equal(fixture.images.size, 0);
  valid = false;
  fixture.document.setVisible(true);
  assert.equal(await old, false);
  assert.equal(fixture.images.has('old.jpg'), false);
  assert.equal(fixture.images.has('new.jpg'), true);
});

test('timed-out decode retains its concurrency slot until the actual decode settles', async () => {
  const fixture = createArtistPhotoHarness();
  const preload = fixture.exports.preloadAndDecodeImage;
  const first = preload('first.jpg');
  preload('second.jpg'); preload('third.jpg'); preload('fourth.jpg');
  let finishFirst, finishSecond;
  fixture.images.get('first.jpg').decode = () => new Promise(resolve => { finishFirst = resolve; });
  fixture.images.get('second.jpg').decode = () => new Promise(resolve => { finishSecond = resolve; });
  const firstDecode = fixture.images.get('first.jpg').onload();
  const secondDecode = fixture.images.get('second.jpg').onload();
  fixture.scheduler.expire(12000);
  assert.equal(await first, false);
  assert.equal(fixture.images.has('third.jpg'), false);
  finishFirst(); await firstDecode;
  assert.equal(fixture.images.has('third.jpg'), true);
  assert.equal(fixture.images.has('fourth.jpg'), false);
  finishSecond(); await secondDecode;
  assert.equal(fixture.images.has('fourth.jpg'), true);
});
