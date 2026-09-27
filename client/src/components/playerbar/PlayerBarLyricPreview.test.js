import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./PlayerBarLyricPreview.jsx', import.meta.url), 'utf8');
const playerBarCss = readFileSync(new URL('../../styles/player-bar.css', import.meta.url), 'utf8');
const animationsCss = readFileSync(new URL('../../styles/animations.css', import.meta.url), 'utf8');

test('player-bar preview keeps lyrics visible while paused or buffering', () => {
  assert.match(source, /if \(isHidden \|\| !hasLyricPresentation\)/);
  assert.doesNotMatch(source, /if \([^\n]*(?:!isPlaying|isBuffering)[^\n]*\) \{/);
});

test('player-bar preview consumes the shared original renderer and leaves translation static', () => {
  assert.match(source, /import SyncedLyricText from '\.\.\/lyrics\/SyncedLyricText\.jsx'/);
  assert.match(source, /<SyncedLyricText[\s\S]*?visible=\{surfaceVisible && !isHidden\}[\s\S]*?syncMode=\{lyricSyncMode\}[\s\S]*?surface="playerbar"/);
  assert.match(source, /const translationText = isIntroRow \? '' :/);
  assert.match(source, /\{translationText\}/);
  assert.doesNotMatch(source, /<SyncedLyricText[^>]*translation/);
});

test('player-bar bilingual translation line uses muted lyric color and never current highlight', () => {
  assert.match(
    source,
    /className=\{`player-console__lyric-row[\s\S]*?player-console__lyric \$\{isActive \? 'opacity-85' : 'opacity-60'\}`\}[\s\S]*?\{translationText\}/,
  );
  assert.doesNotMatch(
    source,
    /className=\{`player-console__lyric-row[^`]*player-console__lyric--current[^`]*`\}[\s\S]*?\{translationText\}/,
  );
});

test('player-bar preview presents intro without changing canonical lyric window indices', () => {
  assert.match(source, /lyricPresentation\.kind === 'intro' && index === 0/);
  assert.match(source, /const displayLine = isIntroRow \? lyricPresentation\.line : line/);
  assert.match(source, /currentLyricIndex: displayedLyricIndex/);
  assert.doesNotMatch(source, /unshift|splice|\[lyricIntro,\s*\.\.\./);
});

test('player-bar preview receives low-frequency lyric fields and visibility as explicit props', () => {
  assert.match(source, /lyricIntro = null/);
  assert.match(source, /lyricSyncMode = 'line'/);
  assert.match(source, /surfaceVisible = true/);
  assert.doesNotMatch(source, /usePlayerStore|useStore|zustand/);
});

test('player-bar reduced motion keeps the final roller position without row scale or transitions', () => {
  assert.match(source, /player-console__lyric-roller w-full transition-transform duration-300/);
  assert.match(source, /player-console__lyric-row h-\[18px\][\s\S]*?transition-all duration-300/);
  assert.equal(source.match(/player-console__lyric-row/g)?.length, 3);
  assert.match(source, /isActive \? 'player-console__lyric--current scale-100 opacity-100' : 'player-console__lyric scale-\[0\.88\] opacity-70'/);
  assert.match(source, /style=\{\{ transform: `translateY\(-\$\{translateY\}px\)` \}\}/);

  const reducedMotionBlock = playerBarCss.slice(
    playerBarCss.indexOf('@media (prefers-reduced-motion: reduce)'),
  );
  assert.match(
    reducedMotionBlock,
    /\.player-console__lyric-roller,[\s\S]*?\.player-console__lyric-row \{[\s\S]*?transition: none !important;/,
  );
  assert.match(
    reducedMotionBlock,
    /\.player-console__lyric-row \{[\s\S]*?transform: none !important;/,
  );
  assert.doesNotMatch(
    reducedMotionBlock,
    /\.player-console__lyric-roller\s*\{[\s\S]*?transform: none/,
  );
});

test('player-bar reduced motion skips keyed content drift and exposes its stable final state', () => {
  assert.equal(source.match(/player-console__lyric-content/g)?.length, 2);
  assert.match(
    source,
    /key=\{`\$\{currentSong\?\.id\}-lyrics`\}[\s\S]*?className="player-console__lyric-content[^"]*animate-player-content-drift-in/,
  );
  assert.match(
    source,
    /key=\{`\$\{currentSong\?\.id\}-meta`\}[\s\S]*?className="player-console__lyric-content[^"]*animate-player-content-drift-in/,
  );

  const reducedMotionBlock = playerBarCss.slice(
    playerBarCss.indexOf('@media (prefers-reduced-motion: reduce)'),
  );
  assert.match(
    reducedMotionBlock,
    /\.player-console__lyric-content \{[\s\S]*?animation: none !important;[\s\S]*?opacity: 1 !important;[\s\S]*?transform: none !important;[\s\S]*?filter: none !important;/,
  );

  assert.match(
    animationsCss,
    /\.animate-player-content-drift-in \{\s*animation: player-content-drift-in 700ms cubic-bezier\(0\.22, 1, 0\.36, 1\) both;/,
  );
});

test('player-bar console provides soft contrast fallbacks and color transition in dark mode', () => {
  assert.match(
    playerBarCss,
    /\.player-console__artist,\s*\.player-console__lyric\s*\{[\s\S]*?transition:\s*color\s+250ms\s+ease;/,
  );
  assert.match(
    playerBarCss,
    /html\.dark\s+\.player-console__artist,\s*html\.dark\s+\.player-console__lyric\s*\{[\s\S]*?color:\s*var\(--muted,\s*rgba\(255,\s*255,\s*255,\s*0\.65\)\);/,
  );
});

test('player-bar active lyric row clips text overflow smoothly and applies gradient mask during horizontal tracking', () => {
  assert.match(
    playerBarCss,
    /\.player-console__lyric-row\.player-console__lyric--current[\s\S]*?text-overflow:\s*clip;/,
  );
  assert.match(
    playerBarCss,
    /mask-image:\s*linear-gradient\(\s*90deg,\s*transparent\s+0%,\s*black\s+14px/,
  );
});

