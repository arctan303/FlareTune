import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = () => readFileSync(new URL('./ImmersiveBackground.jsx', import.meta.url), 'utf8');
const readHookSource = () => readFileSync(new URL('../../hooks/useArtistPhotos.js', import.meta.url), 'utf8');

test('artist photo layer preloads upcoming photos so rotation does not flash the fallback', () => {
  const src = readSource();
  const hookSrc = readHookSource();
  assert.match(src, /useArtistPhotos/);
  assert.match(hookSrc, /preloadAndDecodeImage/);
  assert.match(hookSrc, /artistPhotos\.forEach/);
  assert.match(hookSrc, /new Image\(\)/);
  assert.match(hookSrc, /referrerPolicy\s*=\s*'no-referrer'/);
});

test('artist photo rotation uses a real crossfade stack instead of a hard-coded opacity-0 old layer', () => {
  const src = readSource();
  const hookSrc = readHookSource();
  // 栈顶为当前、下层为正要淡出的上一张，旧图在新图进入时才淡出，杜绝底部专辑图穿透
  assert.match(src, /photoLayers\.map/);
  assert.match(hookSrc, /\{[\s\S]*?\.\.\.top,[\s\S]*?opacity: 0/);
  assert.match(src, /transition-all duration-\[1500ms\]/);
  assert.match(src, /opacity:\s*layer\.opacity/);
  assert.match(src, /transform:\s*layer\.transform/);
  assert.match(src, /filter:\s*layer\.filter/);
  assert.match(src, /cubic-bezier\(0\.16,1,0\.3,1\)/);
  // 双 rAF 保证 0→1 经历一次 paint 才触发过渡，而不是同帧合并
  assert.match(hookSrc, /requestAnimationFrame\(\(\) => requestAnimationFrame\(reveal\)\)/);
  // 不应再出现旧版写死 opacity-0 的 prev 层
  assert.doesNotMatch(src, /const \[prevPhotoUrl/);
  assert.doesNotMatch(src, /isCrossFading/);
});

test('reduces motion to a single static photo layer', () => {
  const hookSrc = readHookSource();
  assert.match(hookSrc, /if \(prefersReducedMotion\) \{/);
  assert.match(hookSrc, /setPhotoLayers\(\[\{[\s\S]*?id,[\s\S]*?url,[\s\S]*?opacity: 1/);
});

test('empty or failed photos use a darkened cover without starting scenery video', () => {
  const src = readSource();
  const hookSrc = readHookSource();
  assert.match(hookSrc, /if \(!photos \|\| photos\.length === 0\) \{[\s\S]*setPhotoLayers\(\[\]\)/);
  assert.match(hookSrc, /setPhotoLayers\(\[\]\)/);
  assert.match(src, /resolvedCoverUrl = usePrivateMediaSource\(coverUrl\)/);
  assert.match(src, /!showPhotos && resolvedCoverUrl && <img src=\{resolvedCoverUrl\}/);
  assert.doesNotMatch(src, /<video|videoSrc|onVideoReady/);
});

test('artist photo presentation keeps its crossfade over the static fallback', () => {
  const src = readSource();
  assert.match(src, /\{showPhotos && renderArtistPhotoLayer\(\)\}/);
  assert.match(src, /photoLayers\.map/);
});

test('artist photo rotation remembers progress per artist to avoid restarting from photo 0 on player reopen', () => {
  const hookSrc = readHookSource();
  assert.match(hookSrc, /ARTIST_PHOTO_PLAYBACK_PROGRESS = new Map\(\)/);
  assert.match(hookSrc, /ARTIST_PHOTO_PLAYBACK_PROGRESS\.get\(trimmedArtist\)/);
  assert.match(hookSrc, /ARTIST_PHOTO_PLAYBACK_PROGRESS\.set\(trimmedArtist, nextIdx\)/);
  assert.match(hookSrc, /applyInitialPhoto\(cached, initialIdx\)/);
  assert.match(hookSrc, /applyInitialPhoto\(photos, initialIdx\)/);
});

test('artist photo layers apply alternating Ken Burns zoom animations with active play state control', () => {
  const src = readSource();
  assert.match(src, /const animName = \(layer\.index % 2 === 0\) \? 'kenburnsZoomIn' : 'kenburnsZoomOut'/);
  assert.match(src, /prefersReducedMotion \? 'none' : `\$\{animName\} 20s infinite alternate ease-in-out`/);
  assert.match(src, /animationPlayState: isPhotoMotionActive \? 'running' : 'paused'/);
  assert.match(src, /will-change-transform/);
});
