import test from 'node:test';
import assert from 'node:assert/strict';
import { getMobileLyricWindow, getPrimaryLyricLine } from './mobileLyricPreview.js';

test('mobile lyric preview uses the first non-empty lyric line', () => {
    assert.equal(getPrimaryLyricLine({ text: '\n  第一行  \n第二行' }), '第一行');
    assert.equal(getPrimaryLyricLine({ text: '   ' }), '');
    assert.equal(getPrimaryLyricLine(null), '');
    assert.equal(getPrimaryLyricLine({ text: '暂无歌词' }), '');
    assert.equal(getPrimaryLyricLine({ text: '纯音乐，请欣赏' }), '');
    assert.equal(getPrimaryLyricLine({ text: '歌词加载失败' }), '');
});

test('the preview window keeps absolute row positions and both boundary spacers', () => {
    for (const rowHeight of [40, 62]) {
        for (const index of [0, 1, 50, 98, 99]) {
            const window = getMobileLyricWindow(100, index, rowHeight);
            assert.ok(window.end - window.start <= 7);
            assert.ok(index >= window.start && index < window.end);
            assert.equal(window.beforeHeight + (window.end - window.start) * rowHeight
                + window.afterHeight, 100 * rowHeight);
            assert.equal(window.beforeHeight + (index - window.start) * rowHeight, index * rowHeight);
        }
    }
    assert.deepEqual(getMobileLyricWindow(0, 0, 40), { start: 0, end: 0, beforeHeight: 0, afterHeight: 0 });
});
