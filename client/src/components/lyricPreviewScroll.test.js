import test from 'node:test';
import assert from 'node:assert/strict';
import { centeredLyricScrollTop } from './lyricPreviewScroll.js';

test('active lyric is centered in the preview instead of stopping at its lower edge', () => {
  assert.equal(centeredLyricScrollTop({
    scrollTop: 0, containerTop: 100, containerHeight: 600,
    scrollHeight: 1800, lineTop: 500, lineHeight: 60,
  }), 130);
});

test('centering only scrolls inside the available preview range', () => {
  assert.equal(centeredLyricScrollTop({
    scrollTop: 0, containerTop: 0, containerHeight: 600,
    scrollHeight: 900, lineTop: 900, lineHeight: 60,
  }), 300);
  assert.equal(centeredLyricScrollTop({
    scrollTop: 0, containerTop: 0, containerHeight: 600,
    scrollHeight: 900, lineTop: 40, lineHeight: 60,
  }), 0);
});
