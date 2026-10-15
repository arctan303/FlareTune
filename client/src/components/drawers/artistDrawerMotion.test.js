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

test("artist header preserves pull-down expansion and scroll-driven collapse", () => {
  const start = getArtistDrawerMotion(-30);
  const compact = getArtistDrawerMotion(500);
  assert.ok(start.headerHeight > compact.headerHeight);
  assert.equal(compact.headerHeight, ARTIST_HEADER_MIN_HEIGHT);
  assert.match(start.photoTransform, /scale/);
  assert.notEqual(start.photoTransform, compact.photoTransform);
});
