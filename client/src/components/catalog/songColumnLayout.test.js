import test from 'node:test';
import assert from 'node:assert/strict';
import { songColumnWidthForViewport, CONTENT_SHELF_GAP } from './songColumnLayout.js';

test('crossing the former third-column threshold does not resize existing song rows', () => {
  assert.equal(songColumnWidthForViewport(1179), 430);
  assert.equal(songColumnWidthForViewport(1180), 430);
});

test('extra desktop space exposes later columns instead of enlarging earlier columns', () => {
  const columnWidth = songColumnWidthForViewport(1000);
  const thirdColumnLeft = 2 * (columnWidth + CONTENT_SHELF_GAP);
  assert.equal(columnWidth, 430);
  assert.equal(songColumnWidthForViewport(1346), columnWidth);
  assert.equal(1346 - thirdColumnLeft, columnWidth, 'the third column fits at its natural width');
  assert.equal(songColumnWidthForViewport(2400), columnWidth, 'wide shelves do not stretch after four columns');
});

test('resizing changes row width continuously and never shrinks a row as the viewport grows', () => {
  let previous = songColumnWidthForViewport(240);
  for (let width = 241; width <= 2400; width += 1) {
    const current = songColumnWidthForViewport(width);
    assert.ok(current >= previous && current <= previous + 1, `discontinuous row width at ${width}px`);
    assert.ok(current <= 430);
    previous = current;
  }
});

test('narrow viewports show a complete column without reserving space for the next column', () => {
  for (const viewport of [284, 302, 372]) {
    const columnWidth = songColumnWidthForViewport(viewport);
    assert.ok(columnWidth > 200);
    assert.equal(columnWidth, viewport);
  }
});
