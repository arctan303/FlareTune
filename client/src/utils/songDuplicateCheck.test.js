import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSongIdentity, duplicateReviewSignature, findCatalogDuplicates, findQueueDuplicates } from './songDuplicateCheck.js';

test('same normalized title and artist is flagged, while another performer is not', () => {
  const candidate = { title: ' Ｈｅｌｌｏ！ ', artist: 'A-Artist', duration: 180 };
  assert.equal(compareSongIdentity(candidate, { title: 'hello', artist: 'A Artist', duration: 182 }), 'strong');
  assert.equal(compareSongIdentity(candidate, { title: 'hello', artist: 'A Artist', duration: 210 }), 'possible');
  assert.equal(compareSongIdentity(candidate, { title: 'hello', artist: 'B Artist', duration: 180 }), null);
});

test('missing artist needs matching duration or a nonempty matching album', () => {
  const candidate = { title: '昨日', artist: '', album: '', duration: '' };
  assert.equal(compareSongIdentity(candidate, { ...candidate }), null);
  assert.equal(compareSongIdentity({ ...candidate, duration: 120 }, { ...candidate, duration: 122 }), 'possible');
  assert.equal(compareSongIdentity({ ...candidate, album: '专辑 A' },
    { ...candidate, album: '专辑 A' }), 'possible');
});

test('earlier queued songs are checked without suppressing the first copy', () => {
  const draft = { title: '昨日', artist: '歌手', duration: 120 };
  const entries = [{ key: 'first', draft }, { key: 'second', draft: { ...draft } }];
  assert.deepEqual(findQueueDuplicates(draft, entries, 'first'), []);
  assert.equal(findQueueDuplicates(draft, entries, 'second')[0].key, 'first');
});

test('catalog lookup reads paginated results and falls back to a title prefix', async () => {
  const calls = [];
  const catalog = [
    { id: 'other', title: '昨日之歌', artist: '其他人', duration: 120 },
    { id: 'same', title: '昨日之歌 啊', artist: '歌手', duration: 121 },
  ];
  const listSongs = async ({ page, q }) => {
    calls.push([page, q]);
    const songs = q === '昨日之歌啊' ? [] : catalog.slice(page - 1, page);
    return { songs, total: q === '昨日之歌啊' ? 0 : 2 };
  };
  const matches = await findCatalogDuplicates({ title: '昨日之歌啊', artist: '歌手', duration: 120 }, listSongs);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'same');
  assert.deepEqual(calls, [[1, '昨日之歌啊'], [1, '昨日之歌'], [2, '昨日之歌']]);
});

test('review signature changes when the same strong queue match has edited details', () => {
  const before = { source: 'queue', key: 'first', id: 'song_1', strength: 'strong',
    title: 'Yesterday', artist: 'Singer', album: 'A', duration: 180, language: 'en' };
  assert.notEqual(duplicateReviewSignature([before]), duplicateReviewSignature([{ ...before, duration: 181 }]));
  assert.notEqual(duplicateReviewSignature([{ source: 'batch', song: before, strength: 'strong' }]),
    duplicateReviewSignature([{ source: 'batch', song: { ...before, album: 'B' }, strength: 'strong' }]));
  assert.equal(duplicateReviewSignature([before, { ...before, id: 'song_2' }]),
    duplicateReviewSignature([{ ...before, id: 'song_2' }, before]));
});
