import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPlaylistCoverUrls, PLAYLIST_COVER_FALLBACK, COLLECTION_COVER } from '../utils/playlistCover.js';

const readSource = (path) => {
  const url = new URL(path, import.meta.url);
  const content = readFileSync(url, 'utf8');
  if (path.endsWith('.css')) {
    return content.replace(/@import\s+['"](\.[^'"]+)['"];/g, (_, importPath) => {
      const targetUrl = new URL(importPath, url);
      return readFileSync(targetUrl, 'utf8');
    });
  }
  return content;
};

test('playlist cover prefers own custom artwork but keeps favorite artwork fixed', () => {
  assert.deepEqual(getPlaylistCoverUrls({ customCoverUrl: '/api/account/images/own', songs: [] }), ['/api/account/images/own']);
  assert.deepEqual(getPlaylistCoverUrls({ kind: 'favorite', customCoverUrl: '/api/account/images/own' }), [COLLECTION_COVER]);
  // 0 首或空歌单：返回 fallback
  assert.deepEqual(getPlaylistCoverUrls(null), [PLAYLIST_COVER_FALLBACK]);
  assert.deepEqual(getPlaylistCoverUrls({ songs: [] }), [PLAYLIST_COVER_FALLBACK]);
  assert.deepEqual(getPlaylistCoverUrls({ kind: 'favorite', previewCovers: ['/media/song.jpg'] }), [COLLECTION_COVER]);
  assert.deepEqual(getPlaylistCoverUrls({ type: 'favorite', songs: [] }), [COLLECTION_COVER]);

  const mockSongsMap = new Map([
    ['s1', { id: 's1', cover_url: 'https://img.test/1.jpg' }],
    ['s2', { id: 's2', cover_url: 'https://img.test/2.jpg' }],
    ['s3', { id: 's3', cover_url: 'https://img.test/3.jpg' }],
    ['s4', { id: 's4', cover_url: 'https://img.test/4.jpg' }],
    ['s5', { id: 's5', cover_url: 'https://img.test/5.jpg' }],
  ]);

  // 1 首歌
  assert.deepEqual(
    getPlaylistCoverUrls({ songs: ['s1'] }, mockSongsMap),
    ['https://img.test/1.jpg'],
  );

  // More songs do not create a collage.
  assert.deepEqual(
    getPlaylistCoverUrls({ songs: ['s1', 's2'] }, mockSongsMap),
    ['https://img.test/1.jpg'],
  );

  // 3 首歌
  assert.deepEqual(
    getPlaylistCoverUrls({ songs: ['s1', 's2', 's3'] }, mockSongsMap),
    ['https://img.test/1.jpg'],
  );

  // 4 songs and more still use one cover.
  assert.deepEqual(
    getPlaylistCoverUrls({ songs: ['s1', 's2', 's3', 's4', 's5'] }, mockSongsMap),
    ['https://img.test/1.jpg'],
  );

  // Custom cover art is outside the current product rule.
  assert.deepEqual(
    getPlaylistCoverUrls({ cover_url: 'https://img.test/playlist-hero.jpg', songs: ['s1', 's2', 's3', 's4'] }, mockSongsMap),
    ['https://img.test/1.jpg'],
  );

  assert.deepEqual(
    getPlaylistCoverUrls({ cover_url: '/media/cover/playlist.jpg', previewCovers: ['/media/cover/song.jpg'] }),
    ['/media/cover/song.jpg'],
  );

  // 当前 DTO 只读取 snake_case 媒体字段，不再接受旧 coverKey。
  assert.deepEqual(
    getPlaylistCoverUrls({ coverKey: 'https://img.test/legacy.jpg', songs: [] }, mockSongsMap),
    [PLAYLIST_COVER_FALLBACK],
  );
});

test('PlaylistCover renders one square image without the retired vinyl stack', () => {
  const cover = readSource('./PlaylistCover.jsx');
  assert.match(cover, /getPlaylistCoverUrls\(playlist, songsMap\)\[0\]/);
  assert.match(cover, /<LazyImage/);
  assert.doesNotMatch(cover, /vinyl|stack-maincard|stack-card/);
});
