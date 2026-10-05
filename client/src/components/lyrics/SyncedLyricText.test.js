import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./SyncedLyricText.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./synced-lyric-text.css', import.meta.url), 'utf8');

test('synced lyric text only subscribes an active visible word-timed projection', () => {
  assert.match(source, /active[\s\S]*?&& visible[\s\S]*?&& syncMode === 'word'[\s\S]*?&& projectionMatches[\s\S]*?&& hasReliableWordTiming/);
  assert.match(source, /resolveLineWordProgress\(line, 0\)\.hasWordTiming/);
  assert.match(source, /words\.map\(\(word\) => String\(word\?\.text \|\| ''\)\)\.join\(''\) === displayText/);
  assert.match(source, /clock\.subscribe\(\(snapshot\) => applySnapshot\(snapshot\), \{/);
  assert.match(source, /animationFrames: \(snapshot\) => !prefersReducedMotion/);
  assert.doesNotMatch(source, /usePlayerStore|setState|useState/);
});

test('the initial word state is applied before paint and malformed timing stays static', () => {
  assert.match(source, /React\.useLayoutEffect\(\(\) =>/);
  assert.match(source, /if \(!shouldSync\) return undefined/);
  assert.match(source, /data-synced=\{shouldSync \? 'word' : 'static'\}/);
});

test('timing spans are hidden from accessibility while the wrapper names the full line once', () => {
  assert.match(source, /className="synced-lyric-text__accessible">\{displayText\}<\/span>/);
  assert.match(source, /className="synced-lyric-text__visual" aria-hidden="true"/);
  assert.match(source, /className="synced-lyric-text__word"/);
  assert.match(css, /\.synced-lyric-text__accessible\s*\{[\s\S]*?clip: rect\(0, 0, 0, 0\)/);
});

test('normal motion only rewrites the active word between word boundaries', () => {
  assert.match(source, /if \(!prefersReducedMotion && !crossedBoundary && resolved\.activeWordIndex >= 0\)/);
  assert.match(source, /setWordState\(resolved\.activeWordIndex, resolved\.wordProgress, 'active'\)/);
  assert.match(source, /for \(let index = 0; index < words\.length; index \+= 1\)/);
});

test('each sampled word exposes a paused-animation timeline offset from real local progress', () => {
  assert.match(source, /const WORD_TIMELINE_DURATION_MS = 1000/);
  assert.match(source, /const timelineOffset = normalizedProgress === 0[\s\S]*?-normalizedProgress \* WORD_TIMELINE_DURATION_MS/);
  assert.match(source, /setProperty\('--synced-word-progress', `\$\{normalizedProgress \* 100\}%`\)/);
  assert.match(source, /setProperty\('--synced-word-timeline-offset', `\$\{timelineOffset\}ms`\)/);
  assert.match(css, /--synced-word-timeline-offset: 0ms/);
});

test('an optional translation ref receives grapheme-weighted line progress without another subscription', () => {
  assert.match(source, /lineProgressRef = null/);
  assert.match(source, /setLineProgress\(resolved\.lineProgress\)/);
  assert.match(source, /setProperty\?\.\('--synced-line-progress', `\$\{normalizedProgress \* 100\}%`\)/);
  assert.equal(source.match(/clock\.subscribe/g)?.length, 1);
  assert.doesNotMatch(source, /requestAnimationFrame|cancelAnimationFrame|audio\.addEventListener/);
});

test('line progress follows reduced-motion word boundaries and cleans old or unmounted ref targets', () => {
  assert.match(source, /if \(!prefersReducedMotion \|\| crossedBoundary\) \{\s*setLineProgress\(resolved\.lineProgress\);\s*\}/);
  assert.match(source, /if \(lineProgressTargetRef\.current !== nextTarget\) \{\s*clearLineProgressTarget\(\);/);
  assert.match(source, /removeProperty\?\.\('--synced-line-progress'\)/);
  assert.match(source, /lastLineProgressRef\.current = null;\s*clearLineProgressTarget\(\);/);
});

test('reduced motion changes words at their start without continuous local progress', () => {
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /const progress = prefersReducedMotion \? 1 : resolved\.wordProgress/);
  assert.match(source, /if \(!prefersReducedMotion && !crossedBoundary/);
  assert.doesNotMatch(css, /animation:/);
});

test('surface CSS preserves inline metrics and gives the player bar its own color tokens', () => {
  assert.match(css, /display: inline/);
  assert.match(css, /white-space: inherit/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /data-surface='playerbar'/);
  assert.match(css, /--player-lyric-current/);
  assert.match(css, /html\.dark[\s\S]*?\[data-surface='playerbar'\][\s\S]*?--synced-lyric-unheard:\s*var\(/);
  assert.match(css, /text-shadow:\s*none;/);
});

test('immersive surface uses adaptive lead-in entering animation and locks active words', () => {
  assert.match(source, /computeAdaptiveWordTiming/);
  assert.match(source, /currentTime >= \(word\.startTime - leadIn\) && currentTime < word\.startTime/);
  assert.match(source, /setWordState\(index, 0, isEntering \? 'entering' : 'pending'\)/);
  assert.match(source, /surface === 'immersive'/);
  assert.match(source, /word-slot/);
});

test('playerbar surface tracks word-by-word horizontal scroll offset via CSS variable without extra subscription', () => {
  assert.match(source, /updatePlayerBarScroll/);
  assert.match(source, /rootEl\.style\.setProperty\('--synced-scroll-x'/);
  assert.match(source, /surface === 'playerbar'/);
  assert.match(css, /\.synced-lyric-text\[data-surface='playerbar'\]\[data-synced='word'\]\s*\{[\s\S]*?transform:\s*translateX\(var\(--synced-scroll-x,\s*0px\)\)/);
  assert.match(css, /transition:\s*transform\s+120ms/);
});
