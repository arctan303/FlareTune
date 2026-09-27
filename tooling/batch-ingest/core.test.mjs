import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicateMatches, fileIdentity, folderLanguage, targetUrl, validMediaSignature } from './core.mjs';

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
});
