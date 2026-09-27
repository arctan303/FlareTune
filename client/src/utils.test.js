import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hydratePlaylistIndex,
  hydrateSong,
  mergeTranslations,
  resolveLatestSongCover,
} from './utils.js';

test('plain canonical lyrics merge untimed translations by order without inventing timestamps', () => {
  const result = mergeTranslations(
    [{ text: 'First' }, { text: 'Second' }],
    '第一句\n第二句',
  );

  assert.deepEqual(result, [
    { text: 'First', translation: '第一句' },
    { text: 'Second', translation: '第二句' },
  ]);
  assert.equal(Object.hasOwn(result[0], 'time'), false);
  assert.equal(Object.hasOwn(result[1], 'time'), false);
});

test('timed translations stay time-matched while canonical words remain intact', () => {
  const words = [
    { text: '僕ら', startTime: 1, endTime: 1.5 },
    { text: 'は今', startTime: 1.5, endTime: 2 },
  ];
  const result = mergeTranslations(
    [
      { time: 1, text: '僕らは今', words },
      { time: 2, text: 'Second timed line' },
    ],
    '[00:02.00]第二句\n[00:01.00]现在的我们\n无时间噪声',
  );

  assert.equal(result[0].translation, '现在的我们');
  assert.equal(result[1].translation, '第二句');
  assert.deepEqual(result[0].words, words);
  assert.notEqual(result[0].words, words);
  assert.equal(Object.hasOwn(result[0], 'time'), true);
});

test('media hydration accepts current snake_case DTO fields', () => {
  const song = hydrateSong({
    id: 'current-song',
    audio_url: 'audio/current.mp3',
    cover_url: 'cover/current.jpg',
  });
  assert.equal(song.audio_url, '/media/audio/current.mp3');
  assert.equal(song.cover_url, '/media/cover/current.jpg');

  const playlist = hydratePlaylistIndex({
    id: 'current-playlist',
    has_cover: 1,
    cover_url: 'playlists/current.jpg',
    preview_covers: ['cover/current-preview.jpg'],
  });
  assert.equal(playlist.cover_url, '/media/playlists/current.jpg');
  assert.deepEqual(playlist.previewCovers, ['/media/cover/current-preview.jpg']);
  assert.equal('preview_covers' in playlist, false);
});

test('media hydration preserves canonical same-origin media URLs', () => {
  const song = hydrateSong({ audio_url: '/media/audio/a.mp3', cover_url: '/media/cover/a.jpg' });
  assert.equal(song.audio_url, '/media/audio/a.mp3');
  assert.equal(song.cover_url, '/media/cover/a.jpg');
  const playlist = hydratePlaylistIndex({ has_cover: 1, cover_url: '/media/cover/a.jpg', preview_covers: ['/media/cover/a.jpg'] });
  assert.equal(playlist.cover_url, '/media/cover/a.jpg');
  assert.deepEqual(playlist.previewCovers, ['/media/cover/a.jpg']);
});

test('media hydration ignores retired audioKey and coverKey aliases', () => {
  const song = hydrateSong({
    id: 'legacy-song',
    audioKey: 'audio/legacy.mp3',
    coverKey: 'cover/legacy.jpg',
  });
  assert.equal(song.audio_url, '');
  assert.equal(song.cover_url, '/placeholder-album.svg');

  const playlist = hydratePlaylistIndex({
    id: 'legacy-playlist',
    has_cover: 0,
    coverKey: 'playlists/legacy.jpg',
  });
  assert.equal(playlist.cover_url, null);
});

test('playlist hydration only accepts the current Worker DTO shape', () => {
  const playlist = hydratePlaylistIndex({
    id: 'retired-shape',
    has_cover: '1',
    previewCovers: ['cover/retired.jpg'],
  });
  assert.equal(playlist.has_cover, 0);
  assert.deepEqual(playlist.previewCovers, []);

  const booleanAlias = hydratePlaylistIndex({
    id: 'retired-boolean-cover',
    has_cover: true,
  });
  assert.equal(booleanAlias.has_cover, 0);
  assert.equal(booleanAlias.cover_url, null);
});

test('resolveLatestSongCover: extracts newest song cover and skips empty covers', () => {
  // 1. 空或无效参数回退到 fallbackCover
  assert.equal(resolveLatestSongCover(null, 'default.jpg'), 'default.jpg');
  assert.equal(resolveLatestSongCover([], 'default.jpg'), 'default.jpg');

  // 2. 单首歌曲返回该封面
  assert.equal(resolveLatestSongCover([{ id: 's1', cover_url: 'c1.jpg' }]), 'c1.jpg');

  // 3. 多首歌曲优先取 addedAt 最新的一首
  const songsWithAddedAt = [
    { id: 's1', cover_url: 'c1.jpg', addedAt: 1000 },
    { id: 's2', cover_url: 'c2.jpg', addedAt: 3000 },
    { id: 's3', cover_url: 'c3.jpg', addedAt: 2000 },
  ];
  assert.equal(resolveLatestSongCover(songsWithAddedAt), 'c2.jpg');

  // 4. 最新歌曲若无封面，自动向前回溯跳过空封面
  const songsWithEmptyLatest = [
    { id: 's1', cover_url: 'c1.jpg', addedAt: 1000 },
    { id: 's2', cover_url: 'c2.jpg', addedAt: 2000 },
    { id: 's3', cover_url: '', addedAt: 3000 },
    { id: 's4', cover_url: null, addedAt: 4000 },
  ];
  assert.equal(resolveLatestSongCover(songsWithEmptyLatest), 'c2.jpg');

  // 5. 若缺少 addedAt 时间戳，默认取数组尾部（最后加入）的有效歌曲
  const songsWithoutTimestamps = [
    { id: 's1', cover_url: 'c1.jpg' },
    { id: 's2', cover_url: 'c2.jpg' },
    { id: 's3', cover_url: 'c3.jpg' },
  ];
  assert.equal(resolveLatestSongCover(songsWithoutTimestamps), 'c3.jpg');
});
