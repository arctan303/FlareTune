import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogDuplicateMatches, duplicateMatches, fileIdentity, folderLanguage, replacementSongBody, targetUrl, validMediaSignature } from './core.mjs';

test('folder aliases and unmapped songs remain editable', () => {
  assert.equal(folderLanguage('music/jp/artist/song.mp3'), 'ja');
  assert.equal(folderLanguage('music/zh/song.mp3'), 'zh');
  assert.equal(folderLanguage('music/unknown/song.mp3'), '');
  assert.equal(folderLanguage('music/song.mp3'), '');
  assert.equal(folderLanguage('music/jp/song.mp3', { jp: 'instrumental' }), 'instrumental');
});

test('catalog and earlier batch duplicates use the same song identity', () => {
  const song = { title: 'Hello!', artist: 'A Artist', duration: 180 };
  const matches = duplicateMatches(song, [{ ...song, id: 'catalog' }], [song]);
  assert.deepEqual(matches.map((item) => item.source), ['batch', 'catalog']);
  assert.deepEqual(duplicateMatches(song, [{ ...song, artist: 'Other' }], []), []);
});

test('catalog duplicate groups are symmetric and keep strong and possible evidence', () => {
  const songs = [
    { id: 'one', title: 'Hello!', artist: 'A Artist', duration: 180 },
    { id: 'two', title: 'Ｈｅｌｌｏ', artist: 'A-Artist', duration: 182 },
    { id: 'three', title: 'Hello', artist: '', duration: 181 },
    { id: 'other', title: 'Hello', artist: 'Other', duration: 180 },
  ];
  const groups = catalogDuplicateMatches(songs);
  assert.deepEqual(groups.get('one').map((item) => [item.song.id, item.strength]),
    [['two', 'strong'], ['three', 'possible']]);
  assert.deepEqual(groups.get('two').map((item) => [item.song.id, item.strength]),
    [['one', 'strong'], ['three', 'possible']]);
  assert.equal(groups.has('other'), true); // Missing artist may still match on close duration.
  assert.equal(groups.get('other').some((item) => item.song.id === 'one'), false);
});

test('replacement body retains existing cover and never changes the song ID', () => {
  const body = replacementSongBody({ id: 'new-id', title: 'Song', artist: '', album: '',
    duration: '121', language: '' }, { id: 'old-id', version: 'a'.repeat(64),
    cover_url: '/media/cover/old.jpg' }, { audioUrl: '/media/audio/new.mp3', coverUrl: '', hasNewCover: false });
  assert.equal(body.id, undefined);
  assert.equal(body.audio_url, '/media/audio/new.mp3');
  assert.equal(body.cover_url, '/media/cover/old.jpg');
  assert.equal(body.expectedVersion, 'a'.repeat(64));
});

test('instance URLs and media signatures are checked before remote writes', () => {
  assert.equal(targetUrl('https://music.example.com'), 'https://music.example.com');
  assert.throws(() => targetUrl('http://music.example.com'));
  assert.throws(() => targetUrl('https://music.example.com/path'));
  assert.equal(validMediaSignature(Buffer.from('ID3\u0004\u0000\u0000'), 'mp3'), true);
  assert.equal(validMediaSignature(Buffer.from('not audio'), 'mp3'), false);
  assert.equal(validMediaSignature(Buffer.from([0xff, 0xe0, 0x00, 0x00]), 'mp3'), false);
  assert.equal(validMediaSignature(Buffer.from([0xff, 0xfb, 0x90, 0x64]), 'mp3'), true);
  assert.equal(fileIdentity('https://music.example.com', { webkitRelativePath: 'music/zh/a.mp3',
    size: 18, lastModified: 20 }), 'https://music.example.com|music/zh/a.mp3|18|20');
  const file = { webkitRelativePath: 'music/zh/a.mp3', size: 18, lastModified: 20 };
  assert.notEqual(fileIdentity('profile-1', { ...file, localRoot: 'C:\\one\\music' }),
    fileIdentity('profile-1', { ...file, localRoot: 'D:\\other\\music' }));
});
