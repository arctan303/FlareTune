import test from 'node:test';
import assert from 'node:assert/strict';
import { getLyricKeyboardTarget, getSeekableLyricIndices } from './lyricKeyboardNavigation.js';

test('lyric navigation skips untimed rows and clamps arrows while Home/End reach both ends', () => {
    const indices = getSeekableLyricIndices([{ text: 'plain' }, { time: 0 }, { time: NaN }, { time: 4 }, { time: 9 }]);
    assert.deepEqual(indices, [1, 3, 4]);
    assert.equal(getLyricKeyboardTarget(indices, 1, 'ArrowUp'), 1);
    assert.equal(getLyricKeyboardTarget(indices, 1, 'ArrowDown'), 3);
    assert.equal(getLyricKeyboardTarget(indices, 3, 'ArrowDown'), 4);
    assert.equal(getLyricKeyboardTarget(indices, 4, 'ArrowDown'), 4);
    assert.equal(getLyricKeyboardTarget(indices, 4, 'Home'), 1);
    assert.equal(getLyricKeyboardTarget(indices, 1, 'End'), 4);
    assert.equal(getLyricKeyboardTarget(indices, 3, 'Enter'), null);
    assert.equal(getLyricKeyboardTarget([], 0, 'Home'), null);
});
