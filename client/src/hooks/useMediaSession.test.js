import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('useMediaSession handles metadata, playback state sync, and seek action handlers', () => {
    const source = readSource('./useMediaSession.js');

    // 验证 MediaSession 基础支持检查
    assert.match(source, /'mediaSession' in navigator/);

    // 验证多尺寸高清封面
    assert.match(source, /sizes: '512x512'/);
    assert.match(source, /sizes: '192x192'/);
    assert.match(source, /sizes: '96x96'/);

    // 验证 playbackState 同步
    assert.match(source, /navigator\.mediaSession\.playbackState/);
    assert.match(source, /'playing'/);
    assert.match(source, /'paused'/);
    assert.match(source, /'none'/);

    // 验证系统外设按键与拖拽进度支持
    assert.match(source, /setHandler\('play'/);
    assert.match(source, /setHandler\('pause'/);
    assert.match(source, /setHandler\('previoustrack'/);
    assert.match(source, /setHandler\('nexttrack'/);
    assert.match(source, /setHandler\('seekto'/);
    assert.match(source, /setHandler\('seekforward'/);
    assert.match(source, /setHandler\('seekbackward'/);
    assert.match(source, /setHandler\('stop'/);

    // 验证 seek 逻辑与 store 状态更新
    assert.match(source, /audio\.currentTime = details\.seekTime/);
    assert.match(source, /setProgress/);
});

test('useMediaSession exclusively owns playback state and preserves none when there is no song', () => {
    const mediaSession = readSource('./useMediaSession.js');
    const playbackPresentation = readSource('./usePlaybackPresentation.js');
    const playerStore = readSource('../store/usePlayerStore.js');

    assert.match(
        mediaSession,
        /navigator\.mediaSession\.playbackState = currentSong\s*\?\s*\(isPlaying \? 'playing' : 'paused'\)\s*:\s*'none'/,
    );
    assert.doesNotMatch(playbackPresentation, /mediaSession|playbackState/);
    assert.doesNotMatch(playerStore, /mediaSession|playbackState/);
});

test('media session action handlers stay registered across song and playback state changes', () => {
    const source = readSource('./useMediaSession.js');

    assert.match(source, /const state = usePlayerStore\.getState\(\);/);
    assert.match(source, /state\.togglePlay\(\)/);
    assert.match(source, /usePlayerStore\.getState\(\)\.playPrev\(\)/);
    assert.match(source, /usePlayerStore\.getState\(\)\.playNext\(\)/);
    assert.match(
        source,
        /actions\.forEach\(\(action\) => setHandler\(action, null\)\);[\s\S]*?}, \[\]\);/,
    );
    assert.doesNotMatch(
        source,
        /}, \[isPlaying, currentSong, playlist, togglePlay, playPrev, playNext\]\);/,
    );
});
