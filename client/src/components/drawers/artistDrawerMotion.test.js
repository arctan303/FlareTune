import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIST_HEADER_MIN_HEIGHT, getArtistDrawerMotion } from './artistDrawerMotion.js';

test('artist drawer motion collapses progressively during ordinary scrolling', () => {
  const start = getArtistDrawerMotion(0, false);
  const end = getArtistDrawerMotion(500, false);
  assert.ok(start.headerHeight > end.headerHeight);
  assert.equal(end.headerHeight, ARTIST_HEADER_MIN_HEIGHT);
  assert.ok(end.avatarScale < start.avatarScale);
});

test('artist drawer uses one compact static state when reduced motion is requested', () => {
  const start = getArtistDrawerMotion(0, true);
  const scrolled = getArtistDrawerMotion(500, true);
  assert.deepEqual(scrolled, start);
  assert.equal(start.headerHeight, ARTIST_HEADER_MIN_HEIGHT);
  assert.equal(start.photoTransform, 'none');
});
