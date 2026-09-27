import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const playerBar = readFileSync(new URL('./PlayerBar.jsx', import.meta.url), 'utf8');
const playerBarCss = readFileSync(new URL('../styles/player-bar.css', import.meta.url), 'utf8');

test('PlayerBar translation button consumes the source-agnostic lifecycle', () => {
  assert.match(playerBar, /translationState: state\.translationState/);
  assert.match(playerBar, /setTranslationEnabled: state\.setTranslationEnabled/);
  assert.match(playerBar, /showTranslationButton = translationState !== 'unavailable'/);
  assert.match(playerBar, /setTranslationEnabled\(true\)/);
  assert.match(playerBar, /requestLyricsTranslationCompletion\(\{/);
  assert.match(playerBar, /authenticated,[\s\S]*notify: showToast/);
  assert.match(playerBar, /aria-busy=\{translationPending \|\| undefined\}/);
  assert.match(playerBar, /disabled=\{translationPending\}/);
  assert.match(playerBar, /data-translation-state=\{translationState\}/);
  assert.match(playerBar, /data-active=\{translationReady && translationEnabled\}/);
  assert.match(playerBar, /translationState === 'failed'[\s\S]*歌词翻译补全失败，重试/);
  assert.match(playerBar, /lyrics-translation-action__warning/);
  assert.match(playerBar, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(playerBar, /translationStatusMessage/);
});

test('PlayerBar pending animation is confined to its outer ring and becomes static for reduced motion', () => {
  assert.match(playerBarCss, /lyrics-translation-action::after[\s\S]*inset: -4px/);
  assert.match(playerBarCss, /lyrics-translation-action\[data-translation-state='pending'\]::after[\s\S]*animation: lyrics-translation-breathe/);
  assert.doesNotMatch(playerBarCss, /lyrics-translation-action\[data-translation-state='pending'\]\s*\{[^}]*animation:/);
  const reducedMotionStart = playerBarCss.indexOf('@media (prefers-reduced-motion: reduce)');
  const reducedMotionBlock = playerBarCss.slice(reducedMotionStart, playerBarCss.indexOf('}', playerBarCss.indexOf('lyrics-translation-action', reducedMotionStart)) + 1);
  assert.match(reducedMotionBlock, /lyrics-translation-action\[data-translation-state='pending'\]::after[\s\S]*animation: none !important/);
});
