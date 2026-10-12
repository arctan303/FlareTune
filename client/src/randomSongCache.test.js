import test from 'node:test';
import assert from 'node:assert/strict';
import { RANDOM_SONGS_CACHE_KEY, localRecommendationDate, isValidRandomSongCache, loadRandomSongs, saveRandomSongs } from './randomSongCache.js';

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

test('daily cache stores the full batch, requested limit and local date in an instance/account scope', () => {
    const memory = {};
    withLocalStorageMock(memory);
    saveRandomSongs(MOCK_SONGS, { scope: '["instance-a","user-a"]', date: '2026-10-12' });
    assert.deepEqual(loadRandomSongs('["instance-a","user-a"]'), { songs: MOCK_SONGS, date: '2026-10-12', limit: 20 });
    assert.equal(loadRandomSongs('["instance-a","user-b"]'), null);
    assert.equal(loadRandomSongs('["instance-b","user-a"]'), null);
    assert.equal(loadRandomSongs(''), null);
});

test('load returns null when the cache is absent, corrupted or not an array', () => {
    const memory = {};
    withLocalStorageMock(memory);
    assert.equal(loadRandomSongs('a'), null);

    memory[`${RANDOM_SONGS_CACHE_KEY}:a`] = '{broken json';
    assert.equal(loadRandomSongs('a'), null);

    memory[`${RANDOM_SONGS_CACHE_KEY}:a`] = JSON.stringify({ songs: 'nope', date: '2026-10-12', limit: 20 });
    assert.equal(loadRandomSongs('a'), null);

    saveRandomSongs([], { scope: 'a', date: '2026-10-12' });
    assert.deepEqual(loadRandomSongs('a').songs, []);
});

test('undated previews, duplicates, nonplayable and oversized batches cannot be current daily data', () => {
    const memory = {};
    withLocalStorageMock(memory);
    memory[`${RANDOM_SONGS_CACHE_KEY}:a`] = JSON.stringify({ songs: MOCK_SONGS });
    assert.equal(loadRandomSongs('a'), null);
    assert.equal(isValidRandomSongCache([...MOCK_SONGS, MOCK_SONGS[0]]), false);
    assert.equal(isValidRandomSongCache([{ ...MOCK_SONGS[0], audio_url: '' }]), false);
    assert.equal(isValidRandomSongCache([{ ...MOCK_SONGS[0], language: null }]), false);
    assert.equal(isValidRandomSongCache(Array.from({ length: 21 }, (_, id) => ({ ...MOCK_SONGS[0], id }))), false);
});

test('load ignores retired cache keys instead of migrating or cleaning them', () => {
    const memory = {
        musicPlayer_xiaoa_random_songs_v2: JSON.stringify({ songs: MOCK_SONGS }),
    };
    withLocalStorageMock(memory);

    assert.equal(loadRandomSongs('a'), null);
    assert.equal('musicPlayer_xiaoa_random_songs_v2' in memory, true);
});

test('load falls back to the interface request when local storage throws', () => {
    globalThis.window = {
        localStorage: {
            getItem: () => { throw new Error('storage blocked'); },
            setItem: () => { throw new Error('storage blocked'); },
        },
    };
    assert.equal(loadRandomSongs('a'), null);
    assert.equal(saveRandomSongs(MOCK_SONGS, { scope: 'a', date: '2026-10-12' }), undefined);
});

test('daily dates follow the local calendar including the midnight boundary', () => {
    assert.equal(localRecommendationDate(new Date(2026, 9, 12, 23, 59)), '2026-10-12');
    assert.equal(localRecommendationDate(new Date(2026, 9, 13, 0, 0)), '2026-10-13');
});
