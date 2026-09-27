import test from 'node:test';
import assert from 'node:assert/strict';
import { getPrimaryLyricLine } from './mobileLyricPreview.js';

test('mobile lyric preview uses the first non-empty lyric line', () => {
    assert.equal(getPrimaryLyricLine({ text: '\n  第一行  \n第二行' }), '第一行');
    assert.equal(getPrimaryLyricLine({ text: '   ' }), '');
    assert.equal(getPrimaryLyricLine(null), '');
    assert.equal(getPrimaryLyricLine({ text: '暂无歌词' }), '');
    assert.equal(getPrimaryLyricLine({ text: '纯音乐，请欣赏' }), '');
    assert.equal(getPrimaryLyricLine({ text: '歌词加载失败' }), '');
});
