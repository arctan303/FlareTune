import test from 'node:test';
import assert from 'node:assert/strict';
import { insertLyricRow, parseLyricTime, serializeLyricEditorRows, validateLyricRows } from './LyricsManagementWorkspace.editor.js';

const row = (key, time, text = '歌词', originalTime = time) => ({
  key, time, originalTime, text, originalText: text, translation: '',
});

test('imported word timing keeps sub-millisecond precision until the final save', () => {
  const imported = { ...row('word', '00:01.001', 'Hello'), originalTimeValue: 1.0006,
    words: [{ text: 'Hello', startTime: 1.0006, endTime: 2.0006 }], endTime: 2.0006,
    translation: '你好' };
  const [unchanged] = serializeLyricEditorRows([imported]);
  assert.equal(unchanged.time, 1.0006);
  assert.equal(unchanged.words[0].startTime, 1.0006);
  const [shifted] = serializeLyricEditorRows([imported], 50);
  assert.equal(shifted.time, 1.051);
  assert.equal(shifted.words[0].startTime, 1.051);
  assert.equal(shifted.tlyric, '你好');
});

test('inline editor inserts an empty row directly after the active lyric', () => {
  const rows = [row('a', '00:20.000'), row('b', '00:25.000')];
  const next = insertLyricRow(rows, 'a', 'new-1');
  assert.deepEqual(next.map((item) => item.key), ['a', 'new-1', 'b']);
  assert.equal(next[1].text, '');
  assert.equal(next[1].time, '');
  assert.equal(rows.length, 2);
});

test('inline editor rejects a time outside adjacent lyric timestamps', () => {
  const rows = [row('a', '00:20.000'), row('new-1', '00:54.000'), row('b', '00:25.000')];
  const errors = validateLyricRows(rows);
  assert.match(errors['new-1'].time, /下一行/);
  assert.match(errors.b.time, /上一行/);
  assert.deepEqual(validateLyricRows([row('a', '00:20.000'), row('new-1', '00:22.500'), row('b', '00:25.000')]), {});
});

test('inline editor requires valid times for newly inserted timed rows', () => {
  const rows = [row('a', '00:20.000'), row('new-1', '', '', ''), row('b', '00:25.000')];
  const errors = validateLyricRows(rows);
  assert.equal(errors['new-1'].time, '请填写时间');
  assert.equal(errors['new-1'].text, '请填写歌词');
  assert.match(validateLyricRows([row('a', '00:20.000'), row('b', '00:99.000')]).b.time, /格式/);
  assert.equal(parseLyricTime('00:22.500'), 22.5);
  assert.equal(parseLyricTime('00:99.000'), null);
});

test('untimed lyrics can add another untimed row', () => {
  assert.deepEqual(validateLyricRows([row('a', '', '第一行'), row('new-1', '', '第二行', '')]), {});
});
