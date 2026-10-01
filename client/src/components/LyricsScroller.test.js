import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./LyricsScroller.jsx', import.meta.url), 'utf8');

test('translation/line-wrap layout changes re-center the whole active row on the next frame', () => {
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(source, /const duration = 680/);
  assert.match(source, /const easeOutCubic = \(t\) => \(--t\) \* t \* t \+ 1/);
  assert.match(source, /activeEl\.offsetHeight \/ 2/);
  assert.match(
    source,
    /\[displayedLyricIndex, isFullScreen, currentSong\?\.id, isUserScrolling, lyrics, prefersReducedMotion, surfaceVisible, translationEnabled\]/,
  );
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /window\.cancelAnimationFrame/);
});

test('reduced motion cancels smooth lyric scrolling and positions every layout trigger directly', () => {
  assert.match(source, /useMediaQuery\('\(prefers-reduced-motion: reduce\)', false\)/);
  assert.match(source, /if \(scrollAnimRef\.current\) \{\s*window\.cancelAnimationFrame\(scrollAnimRef\.current\);\s*scrollAnimRef\.current = null;/);
  assert.match(source, /if \(scrollLayoutFrameRef\.current\) \{\s*window\.cancelAnimationFrame\(scrollLayoutFrameRef\.current\);\s*scrollLayoutFrameRef\.current = null;/);
  assert.match(source, /if \(prefersReducedMotion \|\| !hasPositionedOnEnterRef\.current\)[\s\S]*?container\.scrollTop = targetTop;[\s\S]*?return;/);
  assert.match(source, /const scheduleScrollToActive = \(\) => \{[\s\S]*?if \(prefersReducedMotion\) \{\s*scrollToActive\(\);\s*return;\s*\}[\s\S]*?scrollLayoutFrameRef\.current = window\.requestAnimationFrame/);
  assert.equal(source.match(/scheduleScrollToActive\(\)/g)?.length, 3);
});

test('reduced motion removes classic line transforms and filters without disabling synced word colors', () => {
  const classicCss = readFileSync(new URL('./fullscreen/classic-player.css', import.meta.url), 'utf8');
  const mobileCss = readFileSync(new URL('./fullscreen/classic-mobile.css', import.meta.url), 'utf8');
  const reducedMotionStart = classicCss.indexOf('@media (prefers-reduced-motion: reduce)');
  const reducedMotionEnd = classicCss.indexOf('/* =========================================================================', reducedMotionStart);
  const reducedMotionBlock = classicCss.slice(reducedMotionStart, reducedMotionEnd);
  const mobileReducedMotionBlock = mobileCss.slice(mobileCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  assert.ok(reducedMotionStart >= 0, 'classic CSS should define a reduced-motion media query');
  assert.match(reducedMotionBlock, /\.paper-classic-player \.classic-lyrics__line/);
  assert.match(mobileReducedMotionBlock, /\.paper-classic-player \.paper-mobile-lyric-preview__row/);
  assert.match(reducedMotionBlock, /transform: none !important;/);
  assert.match(reducedMotionBlock, /filter: none !important;/);
  assert.match(reducedMotionBlock, /transition: none !important;/);
  assert.doesNotMatch(reducedMotionBlock, /synced-lyric-text|synced-word-progress/);
});

test('classic loading indicators keep normal animation but stop spinner and shimmer in reduced motion', () => {
  const classicCss = readFileSync(new URL('./fullscreen/classic-player.css', import.meta.url), 'utf8');
  const reducedMotionStart = classicCss.indexOf('@media (prefers-reduced-motion: reduce)');
  const reducedMotionEnd = classicCss.indexOf('/* =========================================================================', reducedMotionStart);
  const reducedMotionBlock = classicCss.slice(reducedMotionStart, reducedMotionEnd);

  assert.match(source, /classic-lyrics__spinner[^"\n]*animate-spin/);
  assert.equal(source.match(/classic-lyrics__loading-shimmer/g)?.length, 2);
  assert.equal(source.match(/animate-\[shimmer_1\.5s_infinite\]/g)?.length, 2);
  assert.match(
    reducedMotionBlock,
    /\.paper-classic-player \.classic-lyrics__spinner,\s*\.paper-classic-player \.classic-lyrics__loading-shimmer \{\s*animation: none !important;/,
  );
});

test('classic lyrics keep the stable depth baseline without dynamic appearance buckets', () => {
  assert.doesNotMatch(source, /LINE_BUCKET|resolveLineBucket|ClassicLyricLine/);
  assert.match(source, /filter: 'blur\(2\.5px\) saturate\(0\.3\)'/);
  assert.match(source, /filter: 'blur\(1px\) saturate\(0\.4\)'/);
  assert.match(source, /filter: 'blur\(0\.6px\) saturate\(0\.5\)'/);
});

test('classic lyrics restore the reference viewport fade with stable line filters', () => {
  const viewportTag = source.match(/<div\s+className="classic-lyrics__viewport[\s\S]*?data-no-swipe\s*>/)?.[0] || '';

  assert.match(viewportTag, /maskImage|WebkitMaskImage/);
  assert.match(viewportTag, /transparent 0%, black 10%, black 82%, transparent 98%/);
  assert.doesNotMatch(source, /classic-lyrics__edge-blur/);
  assert.doesNotMatch(source, /from-black\/\d+/);
});

test('classic lyrics tool wrapper stops event propagation so tool clicks do not wake hidden controls', () => {
  assert.match(source, /classic-lyrics__tools-wrapper[\s\S]*?onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(source, /classic-lyrics__tools-wrapper[\s\S]*?onTouchStart=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(source, /handleVolumeButtonClick\s*=\s*React\.useCallback\(\(e\)\s*=>\s*\{[\s\S]*?e\?\.stopPropagation\?\.?\(\);/);
});

test('classic lyrics mounts InterludeHost in-place exclusively while other lyric components stay untouched', () => {
  // 1. 传统播放器引入了 InterludeHost 原地包裹组件
  assert.match(source, /import InterludeHost from '\.\/lyrics\/InterludeHost'/);
  assert.match(source, /<InterludeHost[\s\S]*?isUserScrolling=\{isUserScrolling\}/);
  assert.match(source, /<InterludeHost[\s\S]*?syncMode=\{lyricSyncMode\}/);

  // 2. 沉浸式全屏单行播放器保持纯净，绝不引入 InterludeHost 或 InterludeDots
  const immersiveSource = readFileSync(new URL('./fullscreen/ImmersiveLyrics.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(immersiveSource, /InterludeHost|InterludeDots/);

  // 3. 底部播放栏保持纯净，绝不引入 InterludeHost 或 InterludeDots
  const playerBarSource = readFileSync(new URL('./PlayerBar.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(playerBarSource, /InterludeHost|InterludeDots/);
});

test('classic lyrics uses the shared renderer only for original text and leaves translation static', () => {
  assert.match(source, /import SyncedLyricText from '\.\/lyrics\/SyncedLyricText'/);
  assert.match(source, /<SyncedLyricText[\s\S]*?line=\{displayLine\}[\s\S]*?active=\{isActive\}[\s\S]*?visible=\{surfaceVisible\}[\s\S]*?syncMode=\{lyricSyncMode\}/);
  const translationBlock = source.match(/\{\(!isIntroRow && lrc\.translation && translationEnabled\)[\s\S]*?\{lrc\.translation\}[\s\S]*?<\/p>/)?.[0] || '';
  assert.ok(translationBlock, 'translation should retain its dedicated static paragraph');
  assert.doesNotMatch(translationBlock, /SyncedLyricText|synced-word|--synced/);
});

test('classic lyrics presents intro in canonical row zero without inserting or shifting lyrics', () => {
  assert.match(source, /lyricPresentation\.kind === 'intro' && index === 0/);
  assert.match(source, /const sourceLine = isIntroRow \? lyricPresentation\.line : lrc/);
  assert.match(source, /const displayLine = LYRIC_STATUS_LINES\.has\(sourceLine\?\.text\)/);
  assert.match(source, /const canSeek = Number\.isFinite\(lrc\.time\)/);
  assert.doesNotMatch(source, /unshift|\[lyricIntro,\s*\.\.\.lyrics\]|lyrics\.splice/);
});

test('classic lyric clock work is explicitly gated by surface visibility', () => {
  assert.match(source, /if \(!isFullScreen \|\| !surfaceVisible\)/);
  assert.match(source, /surfaceVisible = true/);
  assert.match(source, /useLyricSurfacePresentation\(\{[\s\S]*?surfaceVisible,/);
  assert.match(source, /visible=\{surfaceVisible\}/);
});

test('untimed plain lyric lines cannot seek or advertise a clickable cursor', () => {
  assert.match(source, /if \(!Number\.isFinite\(time\)\) return;/);
  assert.match(source, /const canSeek = Number\.isFinite\(lrc\.time\)/);
  assert.match(source, /canSeek \? 'cursor-pointer' : 'cursor-default'/);
  assert.match(source, /onClick=\{canSeek \? \(\) => handleLineClick\(lrc\.time\) : undefined\}/);
});

test('classic translation action exposes the shared five-state waiting contract', () => {
  assert.match(source, /translationState/);
  assert.match(source, /data-translation-state=\{resolvedTranslationState\}/);
  assert.match(source, /aria-busy=\{translationPending \|\| undefined\}/);
  assert.match(source, /disabled=\{translationPending\}/);
  assert.match(source, /data-active=\{translationReady && translationEnabled\}/);
  assert.match(source, /resolvedTranslationState === 'failed'/);

  const classicCss = readFileSync(new URL('./fullscreen/classic-player.css', import.meta.url), 'utf8');
  assert.match(classicCss, /lyrics-translation-action\[data-translation-state='pending'\][\s\S]*lyrics-translation-breathe/);
  const reducedMotionStart = classicCss.indexOf('@media (prefers-reduced-motion: reduce)');
  const reducedMotionBlock = classicCss.slice(reducedMotionStart, classicCss.indexOf('/* =========================================================================', reducedMotionStart));
  assert.match(reducedMotionBlock, /lyrics-translation-action\[data-translation-state='pending'\][\s\S]*animation: none !important/);
});
