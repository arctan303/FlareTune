import test from 'node:test';
import assert from 'node:assert/strict';
import { WALLPAPER_PRESETS } from './wallpaperPresets.js';

test('bundled scenery wallpaper resolves through the authenticated media route on every page', () => {
  const poster = WALLPAPER_PRESETS.find((preset) => preset.id === 'natural-scenery');
  assert.equal(poster.url, '/media/background/natural-scenery-poster.jpg');
  for (const page of ['/settings', '/home', '/artist/周杰伦']) {
    assert.equal(new URL(poster.url, `http://127.0.0.1:3000${page}`).pathname,
      '/media/background/natural-scenery-poster.jpg');
  }
});
