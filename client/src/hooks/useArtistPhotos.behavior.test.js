import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtistPhotoHarness, flushBackgroundAsync } from '../test/fullscreenBackgroundHarness.js';

const staticProps = artistName => ({ artistName, prefersReducedMotion: true });
const top = result => result.photoLayers.at(-1)?.url;

test('cached first-photo decode cannot overwrite a newer artist', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Alpha', ['alpha.jpg']); fixture.cache('Beta', ['beta.jpg']);
  fixture.render(staticProps('Alpha')); fixture.render(staticProps('Beta'));
  await fixture.succeed('beta.jpg');
  assert.equal(top(fixture.render()), 'beta.jpg');
  await fixture.succeed('alpha.jpg');
  assert.equal(top(fixture.render()), 'beta.jpg');
  fixture.unmount();
});

test('network first-photo decode and metadata response cannot overwrite a newer artist', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.render(staticProps('Alpha'));
  await fixture.answer('Alpha', ['alpha.jpg']);
  fixture.render(staticProps('Beta'));
  await fixture.answer('Beta', ['beta.jpg']);
  await fixture.succeed('beta.jpg');
  await fixture.succeed('alpha.jpg');
  assert.equal(top(fixture.render()), 'beta.jpg');
  fixture.render(staticProps('Gamma'));
  fixture.render(staticProps('Beta'));
  await fixture.answer('Gamma', ['gamma.jpg']);
  assert.equal(fixture.images.has('gamma.jpg'), false);
  assert.equal(top(fixture.render()), 'beta.jpg');
  fixture.unmount();
});

test('failed first photo uses the next successful candidate and preserves its rotation index', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Artist', ['broken.jpg', 'good.jpg', 'later.jpg']);
  fixture.render(staticProps('Artist'));
  await fixture.fail('broken.jpg');
  assert.equal(fixture.render().showPhotos, false);
  assert.equal(fixture.images.has('good.jpg'), true);
  assert.equal(fixture.images.has('later.jpg'), false);
  await fixture.succeed('good.jpg');
  const result = fixture.render();
  assert.equal(top(result), 'good.jpg');
  assert.equal(result.photoIndex, 1);
  assert.equal(result.showPhotos, true);
  assert.equal(fixture.images.has('later.jpg'), true);
  fixture.unmount();
});

test('when every candidate fails, previous artist layers clear so the cover fallback is visible', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Previous', ['previous.jpg']);
  fixture.render(staticProps('Previous')); await fixture.succeed('previous.jpg');
  assert.equal(top(fixture.render()), 'previous.jpg');
  fixture.cache('Broken', ['404.jpg', '500.jpg']);
  fixture.render(staticProps('Broken'));
  await fixture.fail('404.jpg'); await fixture.fail('500.jpg');
  const result = fixture.render();
  assert.equal(result.showPhotos, false);
  assert.equal(result.photoLayers.length, 0);
  fixture.unmount();
});

test('switching artists while waiting for a fallback candidate prevents its late commit', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Alpha', ['broken.jpg', 'fallback.jpg']); fixture.cache('Beta', ['beta.jpg']);
  fixture.render(staticProps('Alpha')); await fixture.fail('broken.jpg');
  fixture.render(staticProps('Beta')); await fixture.succeed('beta.jpg');
  await fixture.succeed('fallback.jpg');
  assert.equal(top(fixture.render()), 'beta.jpg');
  fixture.unmount();
});

test('disabling photos or unmounting prevents a pending initial decode from committing', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Artist', ['photo.jpg']);
  fixture.render(staticProps('Artist'));
  fixture.render({ ...staticProps('Artist'), enabled: false });
  await fixture.succeed('photo.jpg');
  assert.equal(fixture.render().photoLayers.length, 0);
  const second = createArtistPhotoHarness();
  second.cache('Artist', ['photo.jpg']);
  second.render({ artistName: 'Artist', isPlaying: false });
  second.unmount(); await second.succeed('photo.jpg');
  assert.equal(second.scheduler.frames.size, 0);
  assert.equal([...second.scheduler.timeouts.values()].some(timer => timer.delay === 1600), false);
  fixture.unmount();
});

test('a pending rotation does not advance after pause or artist replacement', async () => {
  for (const changeArtist of [false, true]) {
    const fixture = createArtistPhotoHarness();
    fixture.cache('Alpha', ['first.jpg', 'next.jpg']); fixture.cache('Beta', ['beta.jpg']);
    fixture.render({ artistName: 'Alpha' });
    await fixture.succeed('first.jpg'); fixture.render();
    fixture.scheduler.rotate();
    if (changeArtist) {
      fixture.render({ artistName: 'Beta' }); await fixture.succeed('beta.jpg');
    } else fixture.render({ artistName: 'Alpha', isPlaying: false });
    await fixture.succeed('next.jpg');
    assert.equal(top(fixture.render()), changeArtist ? 'beta.jpg' : 'first.jpg');
    assert.equal(fixture.exports.ARTIST_PHOTO_PLAYBACK_PROGRESS.get('Alpha'), 0);
    fixture.unmount();
  }
});

test('one-photo crossfade still uses two frames and cancels the second frame on unmount', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Artist', ['photo.jpg']);
  fixture.render({ artistName: 'Artist', isPlaying: false });
  await fixture.succeed('photo.jpg');
  assert.equal(fixture.render().photoLayers[0].opacity, 0);
  fixture.scheduler.frame();
  assert.equal(fixture.render().photoLayers[0].opacity, 0);
  assert.equal(fixture.scheduler.frames.size, 1);
  fixture.unmount();
  assert.equal(fixture.scheduler.frames.size, 0);
  assert.equal([...fixture.scheduler.timeouts.values()].some(timer => timer.delay === 1600), false);
  await flushBackgroundAsync();
});

test('successful first photo retains ordinary crossfade and only preloads the next candidate', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Artist', ['first.jpg', 'next.jpg', 'last.jpg']);
  fixture.render({ artistName: 'Artist', isPlaying: false });
  assert.equal(fixture.images.size, 1);
  await fixture.succeed('first.jpg');
  assert.equal(fixture.images.size, 2);
  fixture.scheduler.frame(); fixture.scheduler.frame();
  assert.equal(fixture.render().photoLayers[0].opacity, 1);
  fixture.scheduler.expire(1600);
  assert.equal(fixture.render().photoLayers.length, 1);
  fixture.unmount();
});

test('rotation retains the old picture until next decode completes and repeated ticks cannot overlap', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Artist', ['first.jpg', 'next.jpg', 'third.jpg', 'fourth.jpg']);
  fixture.render({ artistName: 'Artist' });
  assert.equal(fixture.images.size, 1);
  await fixture.succeed('first.jpg'); fixture.render();
  assert.equal(fixture.images.size, 2);
  fixture.scheduler.rotate(); fixture.scheduler.rotate(); fixture.scheduler.rotate();
  await flushBackgroundAsync();
  assert.equal(top(fixture.render()), 'first.jpg');
  assert.equal(fixture.requests.get('next.jpg'), 1);
  await fixture.succeed('next.jpg');
  assert.equal(top(fixture.render()), 'next.jpg');
  assert.equal(fixture.render().photoIndex, 1);
  assert.equal(fixture.images.has('third.jpg'), true);
  assert.equal(fixture.images.has('fourth.jpg'), false);
  fixture.unmount();
});

test('hidden pauses photo rotation and prefetch, then visible restores the current artist safely', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Alpha', ['first.jpg', 'next.jpg', 'third.jpg']);
  fixture.cache('Beta', ['beta.jpg', 'beta-next.jpg']);
  fixture.render({ artistName: 'Alpha' });
  await fixture.succeed('first.jpg'); fixture.render();
  fixture.scheduler.rotate();
  fixture.document.setVisible(false); fixture.render();
  assert.equal(fixture.scheduler.intervals.size, 0);
  await fixture.succeed('next.jpg');
  assert.equal(top(fixture.render()), 'first.jpg');
  assert.equal(fixture.images.has('third.jpg'), false);
  fixture.render({ artistName: 'Beta' });
  assert.equal(fixture.images.has('beta.jpg'), false);
  fixture.document.setVisible(true); fixture.render();
  await fixture.succeed('beta.jpg');
  assert.equal(top(fixture.render()), 'beta.jpg');
  assert.equal(fixture.images.has('beta-next.jpg'), true);
  assert.equal(fixture.scheduler.intervals.size, 1);
  fixture.unmount();
});

test('hidden initial decode may finish but cannot reveal or prefetch until visible', async () => {
  const fixture = createArtistPhotoHarness();
  fixture.cache('Artist', ['first.jpg', 'next.jpg']);
  fixture.render(staticProps('Artist'));
  fixture.document.setVisible(false); fixture.render();
  await fixture.succeed('first.jpg');
  assert.equal(fixture.render().showPhotos, false);
  assert.equal(fixture.images.has('next.jpg'), false);
  fixture.document.setVisible(true); fixture.render();
  await flushBackgroundAsync();
  assert.equal(top(fixture.render()), 'first.jpg');
  assert.equal(fixture.requests.get('first.jpg'), 1);
  assert.equal(fixture.images.has('next.jpg'), true);
  fixture.unmount();
});
