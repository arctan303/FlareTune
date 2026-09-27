import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const readSource = (relativePath) => {
  const url = new URL(relativePath, import.meta.url);
  const content = readFileSync(url, 'utf8');
  if (relativePath.endsWith('.css')) {
    return content.replace(/@import\s+['"](\.[^'"]+)['"];/g, (_, importPath) => {
      const targetUrl = new URL(importPath, url);
      return readFileSync(targetUrl, 'utf8');
    });
  }
  return content;
};

test('lightweight side drawers keep the shared transform-only frame', () => {
  const frame = readSource('./drawers/DrawerFrame.jsx');
  const hook = readSource('./drawers/useDrawerTransition.js');
  const playlist = readSource('./PlaylistDrawer.jsx');
  const styles = readSource('../index.css');
  const drawers = [
    playlist,
    readSource('./AccountPlaylistDrawer.jsx'),
  ];

  assert.match(frame, /transition-transform duration-\[420ms\]/);
  assert.match(frame, /visible \? 'translate-x-0' : 'translate-x-full'/);
  assert.match(frame, /visible \? 'opacity-100' : 'opacity-0 pointer-events-none'/);
  assert.match(frame, /hidden = false/);
  assert.match(playlist, /hidden=\{!mounted && !isPlaylistOpen\}/);
  assert.match(playlist, /\{\(mounted \|\| isPlaylistOpen\) && \([\s\S]*?playlist\.map/);
  assert.doesNotMatch(playlist, /if \(!mounted\) return null/);
  assert.doesNotMatch(frame, /transition-opacity[^\n]*theme-drawer/);
  assert.match(hook, /requestAnimationFrame/);
  assert.match(hook, /secondFrameRef\.current = requestAnimationFrame\(\(\) => setVisible\(true\)\)/);
  assert.match(hook, /document\.body\.offsetHeight/);
  assert.match(hook, /setVisualMotionPhase\(VISUAL_MOTION_PHASE\.DRAWER\)/);
  assert.match(hook, /onPanelTransitionEnd/);
  assert.match(styles, /--drawer-bg: #[0-9a-f]{6};/i);
  assert.match(styles, /\.theme-drawer\s*\{[\s\S]*?--drawer-solid-bg: var\(--drawer-bg\)/);
  assert.match(styles, /\.dark \.theme-drawer,[\s\S]*?--drawer-solid-bg: color-mix\(in srgb, var\(--fullscreen-stage, var\(--drawer-bg-dark, #121216\)\) 60%, var\(--drawer-bg-dark, #121216\)\)/);
  assert.match(styles, /\.theme-drawer__header\s*\{[\s\S]*?background: var\(--drawer-solid-bg\)/);
  assert.doesNotMatch(styles, /\.theme-drawer::after/);

  for (const source of drawers) {
    assert.match(source, /<DrawerFrame/);
    assert.doesNotMatch(source, /slide-in-right|slide-out-right/);
  }
  const accountDrawer = drawers[1];
  assert.match(accountDrawer, /useDrawerTransition\(isOpen\)/);
  assert.match(accountDrawer, /panelClassName="account-playlist-drawer sm:w-\[440px\] max-w-full"/);
  assert.match(accountDrawer, /account-playlist-body custom-scrollbar/);
});

test('retired assistant drawer animation is absent while queue drawers still suspend player effects', () => {
  const styles = readSource('../index.css');
  const classicPlayer = readSource('./fullscreen/MobileClassicPlayer.jsx');
  const immersivePlayer = readSource('./fullscreen/DesktopImmersivePlayer.jsx');

  assert.equal(existsSync(new URL('./AiReviewDrawer.jsx', import.meta.url)), false);
  assert.doesNotMatch(styles, /xiaoa-drawer-(?:in|out|panel)/);
  for (const player of [classicPlayer, immersivePlayer]) {
    assert.match(player, /suspendPlayerEffects[\s\S]*?\|\| isPlaylistOpen/);
    assert.doesNotMatch(player, /isAiReviewOpen|setIsAiReviewOpen/);
  }
});

test('tablet-specific visual profile is absent from runtime sources and CSS', () => {
  const sources = [
    readSource('../utils/motionPerformance.js'),
    readSource('../hooks/useTheme.js'),
    readSource('../index.css'),
    readSource('./fullscreen/DesktopImmersivePlayer.jsx'),
    readSource('./fullscreen/ImmersiveBackground.jsx'),
    readSource('./fullscreen/ImmersiveAudioAura.jsx'),
  ];

  for (const source of sources) {
    assert.doesNotMatch(source, /tablet-in-place|TABLET_IN_PLACE|isTabletQuality/);
  }
});
