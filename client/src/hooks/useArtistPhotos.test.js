import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    ARTIST_PHOTO_ROTATE_INTERVAL,
    ARTIST_PHOTO_CACHE,
    ARTIST_PHOTO_IMAGE_CACHE,
    ARTIST_PHOTO_PLAYBACK_PROGRESS,
    preloadAndDecodeImage,
} from './useArtistPhotos.js';

const readSource = () => readFileSync(new URL('./useArtistPhotos.js', import.meta.url), 'utf8');

test('useArtistPhotos module exports required constants and preloader', () => {
    assert.equal(ARTIST_PHOTO_ROTATE_INTERVAL, 16000);
    assert.ok(ARTIST_PHOTO_CACHE instanceof Map);
    assert.ok(ARTIST_PHOTO_IMAGE_CACHE instanceof Map);
    assert.ok(ARTIST_PHOTO_PLAYBACK_PROGRESS instanceof Map);
    assert.equal(typeof preloadAndDecodeImage, 'function');
});

test('useArtistPhotos hook source implements preloading, crossfade stack and progress tracking', () => {
    const src = readSource();
    assert.match(src, /export function useArtistPhotos/);
    assert.match(src, /authenticatedFetch\(`\$\{apiBase\}\/api\/artist-photo\?name=/);
    assert.match(src, /ARTIST_PHOTO_PLAYBACK_PROGRESS\.set/);
    assert.match(src, /ARTIST_PHOTO_PLAYBACK_PROGRESS\.get/);
    assert.match(src, /fadeOutRafRef\.current = requestAnimationFrame/);
    assert.match(src, /preloadAndDecodeImage/);
});

test('preloadAndDecodeImage reuses an in-flight decode and clears it to ready state', async () => {
    const originalImage = globalThis.Image;
    const url = 'https://images.example.test/artist.jpg';
    let imageCount = 0;
    class TestImage {
        constructor() {
            imageCount += 1;
        }
        async decode() {}
        set src(value) {
            this.currentSrc = value;
            queueMicrotask(() => this.onload?.());
        }
    }

    ARTIST_PHOTO_IMAGE_CACHE.delete(url);
    globalThis.Image = TestImage;
    try {
        const first = preloadAndDecodeImage(url);
        const second = preloadAndDecodeImage(url);
        assert.equal(first, second);
        assert.equal(await first, true);
        assert.equal(imageCount, 1);
        assert.equal(ARTIST_PHOTO_IMAGE_CACHE.get(url), true);
    } finally {
        ARTIST_PHOTO_IMAGE_CACHE.delete(url);
        if (originalImage === undefined) delete globalThis.Image;
        else globalThis.Image = originalImage;
    }
});
