import test from 'node:test';
import assert from 'node:assert/strict';
import { RANDOM_SONGS_CACHE_KEY, loadRandomSongs, saveRandomSongs } from './randomSongCache.js';

const withLocalStorageMock = (memory) => {
    globalThis.window = {
        localStorage: {
            getItem: (key) => (key in memory ? memory[key] : null),
            setItem: (key, value) => { memory[key] = String(value); },
            removeItem: (key) => { delete memory[key]; },
        },
    };
};

const MOCK_SONGS = [
    { id: 'a', title: 'A', artist: 'AA', audio_url: 'https://cdn.test/a.mp3', cover_url: 'https://cdn.test/a.jpg', language: 'zh' },
    { id: 'b', title: 'B', artist: 'BB', audio_url: 'https://cdn.test/b.mp3', cover_url: 'https://cdn.test/b.jpg', language: 'en' },
];

test('random songs cache key follows the musicPlayer_ convention', () => {
    assert.equal(RANDOM_SONGS_CACHE_KEY, 'musicPlayer_xiaoa_random_songs_v2');
});

test('save then load stores only the current songs payload', () => {
    const memory = {};
    withLocalStorageMock(memory);
    saveRandomSongs(MOCK_SONGS);
    const payload = JSON.parse(memory[RANDOM_SONGS_CACHE_KEY]);
    assert.deepEqual(payload, { songs: MOCK_SONGS });
    assert.deepEqual(loadRandomSongs(), MOCK_SONGS);
});

test('load returns null when the cache is absent, corrupted or not an array', () => {
    const memory = {};
    withLocalStorageMock(memory);
    assert.equal(loadRandomSongs(), null);

    memory[RANDOM_SONGS_CACHE_KEY] = '{broken json';
    assert.equal(loadRandomSongs(), null);

    memory[RANDOM_SONGS_CACHE_KEY] = JSON.stringify({ songs: 'nope' });
    assert.equal(loadRandomSongs(), null);

    memory[RANDOM_SONGS_CACHE_KEY] = JSON.stringify({ songs: [] });
    assert.deepEqual(loadRandomSongs(), []);
});

test('load removes cached songs without authoritative language metadata', () => {
    const memory = {
        [RANDOM_SONGS_CACHE_KEY]: JSON.stringify({
            songs: [{ id: 'legacy', title: 'Legacy', audio_url: '/legacy.mp3' }],
        }),
    };
    withLocalStorageMock(memory);

    assert.equal(loadRandomSongs(), null);
    assert.equal(RANDOM_SONGS_CACHE_KEY in memory, false);
});

test('load ignores retired cache keys instead of migrating or cleaning them', () => {
    const memory = {
        musicPlayer_xiaoa_random_songs_v1: JSON.stringify({ songs: MOCK_SONGS }),
    };
    withLocalStorageMock(memory);

    assert.equal(loadRandomSongs(), null);
    assert.equal('musicPlayer_xiaoa_random_songs_v1' in memory, true);
});

test('load falls back to the interface request when local storage throws', () => {
    globalThis.window = {
        localStorage: {
            getItem: () => { throw new Error('storage blocked'); },
            setItem: () => { throw new Error('storage blocked'); },
        },
    };
    assert.equal(loadRandomSongs(), null);
    assert.equal(saveRandomSongs(MOCK_SONGS), undefined);
});
