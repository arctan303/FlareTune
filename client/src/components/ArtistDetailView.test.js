import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('ArtistDetailView provides full-width hero, photos, playback actions, and tracklist without drawer wrappers', () => {
  const artist = readSource('./ArtistDetailView.jsx');

  // 页面化结构
  assert.match(artist, /app-page artist-detail-page/);
  assert.match(artist, /onBack/);
  assert.match(artist, /返回/);

  // 歌手写真与标题
  assert.match(artist, /displayAvatar/);
  assert.match(artist, /useArtistPhotos|getArtistPhotoApiBase/);
  assert.match(artist, /\{artistName\}/);
  assert.doesNotMatch(artist, /已关注歌手/);

  // 播放全部与队尾添加
  assert.match(artist, /handlePlayAll/);
  assert.match(artist, /handleQueueAll/);
  assert.match(artist, /播放全部/);
  assert.match(artist, /添加至队尾/);

  // 歌曲列表
  assert.match(artist, /TrackRow/);
  assert.match(artist, /onPlaySong/);
  assert.match(artist, /onInsertNext/);
  assert.match(artist, /onAddToPlaylist/);

  // 抽屉解耦：不使用 DrawerFrame 与抽屉过渡
  assert.doesNotMatch(artist, /DrawerFrame/);
  assert.doesNotMatch(artist, /useDrawerTransition/);

  // 统一二级页面与超量收敛
  assert.match(artist, /currentSubView === 'songs'/);
  assert.match(artist, /currentSubView === 'albums'/);
  assert.match(artist, /songs\.slice\(0,\s*20\)/);
  assert.match(artist, /albums\.slice\(0,\s*10\)/);
  assert.match(artist, /<SectionHeading id="artist-tracks-title"/);
  assert.match(artist, /<SectionHeading id="artist-albums-title"/);
  assert.match(artist, /onOverflowChange=\{setSongScrollOverflow\}/);
});

test('App.jsx does not treat isArtistDrawerOpen as secondaryModalOpen to prevent app-workspace inert lockup', () => {
  const app = readSource('../App.jsx');
  assert.doesNotMatch(app, /secondaryModalOpen =[\s\S]*isArtistDrawerOpen/);
});
