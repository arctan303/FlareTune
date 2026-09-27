import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('fullscreen players share one enter and close transition lifecycle', () => {
  const hook = read('./useFullscreenTransition.js');
  const desktop = read('../components/fullscreen/DesktopImmersivePlayer.jsx');
  const mobile = read('../components/fullscreen/MobileClassicPlayer.jsx');
  assert.match(desktop, /useFullscreenTransition\(\{/);
  assert.match(mobile, /useFullscreenTransition\(\{/);
  assert.match(hook, /FULLSCREEN_ENTER/);
  assert.match(hook, /FULLSCREEN_EXIT/);
  assert.match(hook, /event\.propertyName !== 'transform'/);
  assert.match(hook, /event\.key !== 'Escape'/);
  for (const player of [desktop, mobile]) {
    assert.doesNotMatch(player, /enterFallbackRef|closeFallbackRef|const completeEnter|const finishClose/);
  }
});

test('player controls share skip-button animation ownership', () => {
  const hook = read('./usePlaybackButtonAnimations.js');
  const bar = read('../components/PlayerBar.jsx');
  const controls = read('../components/PlayerControls.jsx');
  assert.match(bar, /usePlaybackButtonAnimations\(\{ playPrev, playNext \}\)/);
  assert.match(controls, /usePlaybackButtonAnimations\(\{ playPrev, playNext \}\)/);
  assert.match(hook, /PLAY_BUTTON_ANIMATION_MS = 1500/);
  for (const consumer of [bar, controls]) assert.doesNotMatch(consumer, /prevTimerRef|nextTimerRef/);
});

test('playlist and other images use the same viewport-aware image component', () => {
  const hook = read('./useImageInView.js');
  const lazy = read('../components/LazyImage.jsx');
  const playlist = read('../components/PlaylistCover.jsx');
  assert.match(lazy, /useImageInView\(\{[\s\S]*rootMargin: '300px'/);
  assert.match(playlist, /<LazyImage src=\{coverUrl\}/);
  assert.match(hook, /new IntersectionObserver/);
  assert.match(lazy, /onLoad=/);
  assert.match(lazy, /onError=/);
  assert.doesNotMatch(playlist, /loadGroup|useImageInView/);
});

test('grid and vertical drags share capture release and global pointer listeners', () => {
  const lifecycle = read('./usePointerDragLifecycle.js');
  const grid = read('./usePlaylistEditor.js');
  const vertical = read('./useVerticalReorderDrag.js');
  assert.match(grid, /preparePointerDragSettle\(drag, event\)/);
  assert.match(vertical, /preparePointerDragSettle\(drag, event\)/);
  assert.match(grid, /usePointerDragWindowEvents\(\{/);
  assert.match(vertical, /usePointerDragWindowEvents\(\{/);
  assert.match(lifecycle, /releasePointerCapture/);
  assert.match(lifecycle, /addEventListener\('pointercancel'/);
  assert.match(grid, /gridColumns/);
  assert.doesNotMatch(vertical, /gridColumns/);
});
