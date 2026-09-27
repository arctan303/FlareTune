import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
};

const {
    canClearBufferingAfterSeek,
    syncCurrentLyricIndex,
} = await import('./useAudioEngine.js');

test('seek completion clears buffering once the browser has current media data', () => {
    assert.equal(canClearBufferingAfterSeek({ readyState: 2 }), true);
    assert.equal(canClearBufferingAfterSeek({ readyState: 4 }), true);
});

test('seek completion keeps buffering while the browser only has metadata', () => {
    assert.equal(canClearBufferingAfterSeek({ readyState: 0 }), false);
    assert.equal(canClearBufferingAfterSeek({ readyState: 1 }), false);
    assert.equal(canClearBufferingAfterSeek(null), false);
});

test('shared lyric clock coordinator commits only real line-boundary changes in either seek direction', () => {
    const committed = [];
    const state = {
        lyrics: [
            { time: 2, text: 'first' },
            { time: 5, text: 'second' },
            { time: 8, text: 'third' },
        ],
        currentLyricIndex: 0,
        setCurrentLyricIndex(index) {
            committed.push(index);
            this.currentLyricIndex = index;
        },
    };

    assert.equal(syncCurrentLyricIndex(state, 8.25), true);
    assert.equal(syncCurrentLyricIndex(state, 8.75), false);
    assert.equal(syncCurrentLyricIndex(state, 5.25), true);
    assert.equal(syncCurrentLyricIndex(state, 0.5), true);
    assert.deepEqual(committed, [2, 1, 0]);
});

test('shared lyric clock coordinator ignores empty timelines', () => {
    const state = {
        lyrics: [],
        currentLyricIndex: 0,
        setCurrentLyricIndex() {
            throw new Error('must not commit');
        },
    };

    assert.equal(syncCurrentLyricIndex(state, 12), false);
});

test('word-mode coordinator does not advance on an early line timestamp before the next vocal', () => {
    const committed = [];
    const state = {
        lyrics: [
            {
                time: 10,
                endTime: 13,
                text: 'first',
                words: [{ text: 'first', startTime: 10, endTime: 13 }],
            },
            {
                time: 14,
                endTime: 21,
                text: 'second',
                words: [{ text: 'second', startTime: 20, endTime: 21 }],
            },
        ],
        lyricSyncMode: 'word',
        currentLyricIndex: 0,
        setCurrentLyricIndex(index) {
            committed.push(index);
            this.currentLyricIndex = index;
        },
    };

    assert.equal(syncCurrentLyricIndex(state, 15), false);
    assert.equal(syncCurrentLyricIndex(state, 20), true);
    assert.deepEqual(committed, [1]);
});
