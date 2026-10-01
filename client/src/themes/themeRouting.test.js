import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHELL_THEME } from '../constants/shellThemes.js';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('theme configuration keeps the fluid theme identifier', () => {
  assert.equal(SHELL_THEME.id, 'fluid');
});

test('fullscreen routing is driven by player mode and keeps responsive layout', () => {
  const router = readSource('../components/FullScreenPlayer.jsx');

  assert.match(router, /playerMode === PLAYER_MODES\.CINEMATIC && isDesktop/);
  assert.match(router, /<DesktopImmersivePlayer/);
  assert.match(router, /<MobileArtistPlayer instantEnter=\{instantEnter\} \/>/);
  assert.match(router, /<MobileClassicPlayer instantEnter=\{instantEnter\} \/>/);
  assert.match(router, /import \{ PLAYER_MODES \} from '\.\.\/constants\/playerModes'/);
  assert.match(router, /import \{ useMediaQuery \} from '\.\/fullscreen\/useMediaQuery'/);
  assert.match(router, /instantEnter=\{instantEnter\}/);
  assert.match(router, /prevModeRef\.current !== playerMode/);
});

test('player mode state is visible on desktop hover and selectable in mobile more menu', () => {
  const entry = readSource('../components/PlayerSkinEntry.jsx');
  const mobile = readSource('../components/fullscreen/MobilePlayerLayout.jsx');
  const panes = readSource('../components/fullscreen/MobileClassicPanes.jsx');
  assert.match(entry, /data-player-mode=\{playerMode\}/);
  assert.match(entry, /t\("当前："\)\}\{currentLabel\}/);
  assert.match(entry, /setPlayerMode\(nextMode\)/);
  assert.match(entry, /type="button"/);
  assert.doesNotMatch(mobile, /PlayerSkinEntry/);
  assert.match(panes, /<PlayerMoreMenu[\s\S]*?showPlayerModes \/>/);
});

test('classic fullscreen maintains responsive player layout baseline and styles', () => {
  const classicStyles = readSource('../components/fullscreen/classic-player.css');
  const mobileStyles = readSource('../components/fullscreen/classic-mobile.css');
  const classicPlayer = [
    readSource('../components/fullscreen/MobileClassicPlayer.jsx'),
    readSource('../components/fullscreen/ClassicDesktopLayout.jsx'),
    readSource('../components/fullscreen/ClassicMobileLayout.jsx'),
    readSource('../components/fullscreen/MobilePlayerLayout.jsx'),
    readSource('../components/fullscreen/MobileClassicPanes.jsx'),
  ].join('\n');
  const controls = readSource('../components/PlayerControls.jsx');
  const lyrics = readSource('../components/LyricsScroller.jsx');
  const playerBar = readSource('../components/PlayerBar.jsx');
  const app = readSource('../app.jsx');

  assert.match(classicPlayer, /lg:flex-row/);
  assert.match(classicPlayer, /<PlayerControls/);
  assert.match(classicPlayer, /<LyricsScroller/);
  assert.doesNotMatch(classicPlayer, /AudioSpectrumCanvas|classic-player__vinyl-container|isPaperTheme/);
  assert.doesNotMatch(classicPlayer, /cover-strip|paper-cover-spectrum/);
  assert.match(classicPlayer, /getPrimaryLyricLine/);
  assert.match(classicPlayer, /paper-mobile-lyric-preview/);
  assert.match(classicPlayer, /layoutRef: controlsRef/);
  assert.match(classicPlayer, /absolute top-6 left-6 z-30 hidden lg:flex/);
  assert.match(classicPlayer, /classic-player__toolbar/);
  assert.match(classicPlayer, /<PlayerSkinEntry variant="classic" \/>/);
  assert.match(app, /<PlayerBar motionProfile=\{motionProfile\}/);
  assert.match(playerBar, /isImmersiveMode = playerMode === 'cinematic'/);
  assert.doesNotMatch(playerBar, /portrait/);
  assert.match(playerBar, /isExpanded = activeFullScreen && isDesktop && isImmersiveMode/);
  assert.match(playerBar, /isHidden = \(activeFullScreen && \(!isDesktop \|\| !isImmersiveMode\)\) \|\| isSidebarPlayer/);
  assert.match(controls, /iconStrokeWidth = 1\.75/);
  assert.match(controls, /fill="currentColor"/);
  assert.match(lyrics, /iconStrokeWidth = 1\.75/);
  assert.match(classicStyles, /\.classic-controls__progress-fill \{[\s\S]*#ffffff/);
  assert.match(classicStyles, /\.paper-classic-player \.classic-controls__menu-icon \{[\s\S]*color: color-mix\(in srgb, var\(--ink\) 78%, transparent\);[\s\S]*opacity: 1/);
  assert.match(classicStyles, /\.classic-controls__menu-item\[data-active='true'\] \.classic-controls__menu-icon \{[\s\S]*color: var\(--accent\)/);
  assert.match(classicStyles, /\.classic-controls__icon\[data-active='true'\]/);
  assert.doesNotMatch(classicStyles, /paper-cover-spectrum/);
  assert.match(mobileStyles, /\.paper-mobile-lyric-preview__row \{[\s\S]*font-size: 18px/);
  assert.match(mobileStyles, /\.paper-mobile-lyric-preview__row \{[\s\S]*line-height: 28px/);
  assert.match(mobileStyles, /\.paper-mobile-lyric-preview__viewport \{[\s\S]*mask-image: linear-gradient/);
  assert.match(mobileStyles, /@media \(min-width: 1024px\)[\s\S]*\.paper-mobile-lyric-preview[\s\S]*display: none/);
  assert.match(classicStyles, /\.paper-classic-player \.classic-controls__play \{/);
  assert.doesNotMatch(classicStyles, /paper-classic__backdrop/);
});
