import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLyricEffect } from '../../constants/lyricEffects.js';

const immersive = readFileSync(new URL('./ImmersiveLyrics.jsx', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('./DesktopImmersivePlayer.jsx', import.meta.url), 'utf8');
const debuggerSource = readFileSync(new URL('./ThemeDebugger.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../theme-animations.css', import.meta.url), 'utf8');

test('immersive lyrics reuse the shared presentation, clock, and precise renderer', () => {
  assert.match(immersive, /useLyricSurfacePresentation/);
  assert.match(immersive, /lyricPlaybackClock/);
  assert.match(immersive, /<SyncedLyricText/);
  assert.match(immersive, /surface="immersive"/);
  assert.match(immersive, /lineProgressRef=\{canTrackLineProgress \? translationProgressRef : null\}/);
  assert.doesNotMatch(immersive, /requestAnimationFrame|cancelAnimationFrame|audio\.addEventListener|audio\.currentTime/);
});

test('legacy character staggering and timer-owned ghost paths are removed', () => {
  assert.doesNotMatch(immersive, /CharByChar|lyric-char|--char-i|--lyric-char-delay/);
  assert.doesNotMatch(immersive, /setTimeout|clearTimeout|getGhostStyle|getAnimationScale/);
  assert.doesNotMatch(css, /lyric-char|--char-i|--lyric-char-delay|lyric-single-ghost/);
});

test('translation stays one text node and only declared effects consume original line progress', () => {
  assert.match(immersive, /\{layer\.translation\}/);
  assert.match(immersive, /effect\.translationProgress === 'line'/);
  assert.match(immersive, /const canRenderWordEffect = lyricSyncMode === 'word'/);
  assert.match(immersive, /data-word-event=\{canRenderWordEffect \? effect\.wordEvent : 'none'\}/);
  assert.match(immersive, /!prefersReducedMotion/);
  assert.match(immersive, /data-translation-progress=\{translationProgress\}/);
  assert.doesNotMatch(immersive, /words\.map[\s\S]{0,180}translation|SyncedLyricText[\s\S]{0,120}translation/);
  assert.match(css, /\.immersive-lyrics__translation\[data-translation-progress='line'\]/);
});

test('active and exit layers are reducer-owned and stale animation events carry identity', () => {
  assert.match(immersive, /React\.useReducer\(\s*reduceImmersiveLyricState/);
  assert.match(immersive, /React\.useLayoutEffect\(\(\) => \{\s*dispatch\(syncAction\)/);
  assert.match(immersive, /data-layer="active"/);
  assert.match(immersive, /data-layer="exit"/);
  assert.match(immersive, /event\.target !== event\.currentTarget/);
  assert.match(immersive, /token: lyricState\.exiting\.token/);
  assert.match(immersive, /identity: lyricState\.exiting\.identity/);
  assert.match(immersive, /animationName: event\.animationName/);
});

test('random resolution is seeded by stable song identity and exposes diagnostics', () => {
  assert.match(immersive, /resolveLyricEffect\(lyricTransition, songKey, presentation\.index\)/);
  assert.match(immersive, /getImmersiveSongKey\(currentSong\)/);
  const effect0 = resolveLyricEffect('random', 'song-demo', 0);
  const effect1 = resolveLyricEffect('random', 'song-demo', 1);
  assert.notEqual(effect0.id, effect1.id);
  const songKeyBody = immersive.slice(
    immersive.indexOf('export function getImmersiveSongKey'),
    immersive.indexOf('const getClockGateKey'),
  );
  assert.match(songKeyBody, /if \(id\) return `id:\$\{id\}`/);
  assert.match(songKeyBody, /if \(audioUrl\) return `audio:\$\{audioUrl\}`/);
  assert.doesNotMatch(songKeyBody, /id:\$\{id\}\|audio:/);
  assert.doesNotMatch(songKeyBody, /currentLyricIndex|Date\.now|Math\.random/);
  assert.match(immersive, /data-effect=\{activeEffect\.id\}/);
  assert.match(immersive, /data-effect-group=\{activeEffect\.group\}/);
  assert.match(immersive, /data-sync-mode=\{lyricSyncMode\}/);
  assert.match(immersive, /data-motion-running=\{motionRunning \? 'true' : 'false'\}/);
});

test('grand stage schemes use adaptive timing variables and 3D momentum transitions', () => {
  assert.match(css, /--word-anim-ms/);
  assert.match(css, /--line-enter-ms/);
  assert.match(css, /--line-exit-ms/);
  for (const scheme of ['scheme-warp', 'scheme-thunder', 'scheme-tornado', 'scheme-matrix', 'scheme-sonic']) {
    assert.match(css, new RegExp(`\\.${scheme}`));
  }
  assert.match(css, /data-motion-running='true'/);
  assert.match(css, /html\[data-page-hidden='true'\]/);
  assert.match(css, /perspective:\s*1400px/);
  assert.match(css, /transform-style:\s*preserve-3d/);
});

test('layout preserves full text, wraps long tokens, and keeps a readable floor', () => {
  assert.match(css, /white-space: pre-wrap/);
  assert.match(css, /text-wrap: balance/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /font-size: clamp\(1\.25rem,/);
  assert.match(css, /height: clamp\(17rem, 40vh, 23rem\)/);
  assert.doesNotMatch(immersive, /whitespace-nowrap|truncate|calcFontSize/);
});

test('reduced motion stabilizes wrappers, word decoration, loading, and translation', () => {
  const reducedBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reducedBlock, /\.immersive-lyrics__line/);
  assert.match(reducedBlock, /\.synced-lyric-text__word/);
  assert.match(reducedBlock, /animation: none !important/);
  assert.match(reducedBlock, /filter: none !important/);
  assert.match(reducedBlock, /transform: none !important/);
  assert.match(reducedBlock, /\.immersive-lyrics__translation\[data-translation-progress='line'\][\s\S]*background: none/);
});

test('desktop cinematic wiring resolves transition state before use and preserves user effect choice', () => {
  assert.ok(
    desktop.indexOf('} = useFullscreenTransition({') < desktop.indexOf('const shouldMountAudioAura'),
    'fullscreen transition state must be declared before it is read',
  );
  for (const prop of [
    'lyricSyncMode={lyricSyncMode}',
    'lyricIntro={lyricIntro}',
    'isPlaying={isPlaying}',
    'isBuffering={isBuffering}',
    'prefersReducedMotion={prefersReducedMotion}',
    'surfaceVisible={Boolean(isFullScreen && hasEntered && !isClosing)}',
  ]) {
    assert.ok(desktop.includes(prop), `missing immersive prop: ${prop}`);
  }
  assert.doesNotMatch(desktop, /setLyricTransition\(activeTheme\.defaultSettings\.lyricTransition\)/);
});

test('theme debugger reports the resolved effect contract', () => {
  assert.match(debuggerSource, /data-resolved-lyric-effect=\{resolvedEffect\.id\}/);
  assert.match(debuggerSource, /resolvedEffect\.group/);
  assert.match(debuggerSource, /resolvedEffect\.wordEvent/);
  assert.match(debuggerSource, /resolvedEffect\.translationProgress/);
});

test('slot reservation architecture, four-phase word lifecycle, and uniform gray translation are enforced', () => {
  const syncedCss = readFileSync(new URL('../lyrics/synced-lyric-text.css', import.meta.url), 'utf8');
  assert.match(syncedCss, /\.synced-lyric-text\[data-surface='immersive'\][\s\S]*background:\s*none/);
  assert.match(css, /\.word-slot/);
  assert.match(css, /\.word-char/);
  assert.match(css, /data-word-state='pending'/);
  assert.match(css, /data-word-state='entering'/);
  assert.match(css, /data-word-state='active'/);
  assert.match(css, /data-word-state='complete'/);
  assert.match(css, /@keyframes immersive-exit-space/);
  for (const scheme of ['warp', 'thunder', 'tornado', 'matrix', 'sonic']) {
    assert.match(css, new RegExp(`@keyframes trans-micro-${scheme}`));
  }
  assert.match(css, /color:\s*rgba\(203,\s*213,\s*225,\s*0\.55\)\s*!important/);
});
