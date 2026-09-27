import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('ArtistDrawer provides accessible frame, photo banner, play all action, and shared focus management', () => {
  const drawer = readSource('./ArtistDrawer.jsx');

  assert.match(drawer, /DrawerFrame/);
  assert.match(drawer, /useDrawerTransition/);
  assert.match(drawer, /labelledBy="artist-drawer-title"/);
  assert.match(drawer, /useUIStore/);
  assert.match(drawer, /usePlayerStore/);
  assert.match(drawer, /activeArtistData/);
  assert.match(drawer, /resolvedSongs/);
  assert.match(drawer, /handleQueueAll/);
  assert.match(drawer, /planQueueEdit/);
  assert.doesNotMatch(drawer, /usePlayerStore\.getState\(\)\.insertNext/);
  assert.match(drawer, /播放全部/);
  assert.match(drawer, /稍后播放/);
  assert.match(drawer, /歌曲列表/);
  assert.doesNotMatch(drawer, /全部作品列表/);
  assert.match(drawer, /useFavoriteSongAction/);
  assert.match(drawer, /openAddToPlaylist/);
  assert.match(drawer, /handleEscape|key === 'Escape'/);
  assert.match(drawer, /previousFocusRef/);
  assert.match(drawer, /closeButtonRef/);
  assert.match(drawer, /preloadAndDecodeImage/);
  assert.match(drawer, /handleKeyboardActivation/);
  assert.match(drawer, /group-focus-within:opacity-100/);
});

test('ArtistDrawer implements collapsible hero banner compressing smoothly to compact state on scroll', () => {
  const drawer = readSource('./ArtistDrawer.jsx');

  assert.match(drawer, /ARTIST_HEADER_MAX_HEIGHT/);
  assert.match(drawer, /ARTIST_HEADER_MIN_HEIGHT/);
  assert.match(drawer, /handleScroll/);
  assert.match(drawer, /onScroll=\{handleScroll\}/);
  assert.match(drawer, /headerRef/);
  assert.match(drawer, /avatarRef/);
  assert.match(drawer, /photoBgRef/);
  assert.match(drawer, /sticky/);
  assert.match(drawer, /prefers-reduced-motion: reduce/);
  assert.match(drawer, /getArtistDrawerMotion/);
});

test('useUIStore integrates isArtistDrawerOpen and openArtistDrawer with mutual exclusivity', () => {
  const store = readSource('../store/useUIStore.js');

  assert.match(store, /isArtistDrawerOpen: false/);
  assert.match(store, /activeArtistData: null/);
  assert.match(store, /setIsArtistDrawerOpen/);
  assert.match(store, /openArtistDrawer/);
  assert.match(store, /isArtistDrawerOpen: false[\s\S]*setIsAccountPlaylistOpen/);
});

test('MainContent renders ArtistDetailView when artist is active', () => {
  const main = readSource('./MainContent.jsx');

  assert.match(main, /import ArtistDetailView from '\.\/ArtistDetailView\.jsx'/);
  assert.match(main, /<ArtistDetailView/);
  assert.match(main, /artist=\{activeArtistData\}/);
});

test('HomeFeaturedSection wires spotlight card to openArtistDrawer', () => {
  const featured = readSource('./HomeFeaturedSection.jsx');

  assert.match(featured, /openArtistDrawer/);
  assert.match(featured, /featuredArtist/);
  assert.match(featured, /featuredArtistSongs/);
});

test('ArtistDrawer follows Rules of Hooks with all hooks called unconditionally before early return', () => {
  const drawer = readSource('./ArtistDrawer.jsx');

  const mountedCheckIndex = drawer.indexOf('if (!mounted) return null;');
  const useStateIndex = drawer.lastIndexOf('useState(');
  const useEffectIndex = drawer.lastIndexOf('useEffect(');
  const useMemoIndex = drawer.lastIndexOf('useMemo(');

  assert.ok(mountedCheckIndex > -1);
  assert.ok(useStateIndex > -1 && useStateIndex < mountedCheckIndex, 'useState must be called before if (!mounted) return null');
  assert.ok(useEffectIndex > -1 && useEffectIndex < mountedCheckIndex, 'useEffect must be called before if (!mounted) return null');
  assert.ok(useMemoIndex > -1 && useMemoIndex < mountedCheckIndex, 'useMemo must be called before if (!mounted) return null');
});
