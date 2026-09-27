import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('SearchView source contains major scope tabs, language subfilters, batch actions, keyboard nav, and zero-shift layout', () => {
  const source = readSource('./SearchView.jsx');
  const row = readSource('./search/SearchTrackRow.jsx');
  const globalPlaylistModal = readSource('./AddToPlaylistModal.jsx');
  const keyboard = readSource('../hooks/useKeyboard.js');
  const css = readSource('../styles/components.css');

  // Artist spotlight section & ArtistDrawer integration
  assert.match(source, /matchedArtists/);
  assert.match(source, /openArtistDrawer/);
  assert.match(source, /ArtistCard/);
  assert.match(source, /useCatalogPage\('artists'/);
  assert.match(source, /useCatalogPage\('albums'/);
  assert.doesNotMatch(source, /最佳结果/);
  assert.doesNotMatch(source, /查看专区/);
  assert.doesNotMatch(source, /search-scope-tabs/);
  assert.doesNotMatch(source, /majorCategory/);

  // Language filters are retired from search view per user request
  assert.doesNotMatch(source, /search-subfilter-bar/);
  assert.doesNotMatch(source, /search-subfilter-pill/);
  assert.match(source, /songSubCategory/);
  assert.match(source, /subFilterOptions/);
  assert.match(source, /languageParam/);
  assert.match(source, /language=\$\{encodeURIComponent\(songSubCategory\)\}/);
  assert.match(source, /offset=\$\{songs\.length\}/);
  assert.match(source, /setHasMore\(batch\.length === PAGE_SIZE\)/);
  assert.match(source, /searchGenerationRef/);
  assert.match(source, /loadMoreControllerRef\.current\?\.abort\(\)/);
  assert.match(source, /generation !== searchGenerationRef\.current/);
  assert.match(source, /resolveSongLanguage/);

  // Batch playback & queueing
  assert.match(source, /播放全部/);
  assert.match(source, /全部加为下一首/);
  assert.match(source, /handlePlayAll/);
  assert.match(source, /handleInsertAllNext/);

  // Batch playlist adding keeps selection in SearchView and delegates the actual
  // target loading/submission to the single global playlist modal.
  assert.match(source, /批量加入歌单/);
  assert.match(source, /toggleSearchBulkSelection/);
  assert.match(source, /resolveSelectedSearchSongs/);
  assert.match(source, /const addBulkSelectionToPlaylist = \(\) => \{[\s\S]*openAddToPlaylist\(selectedSongs\);\s*closeBulkSelection\(\);/);
  assert.match(row, /aria-pressed=\{isBulkSelected\}/);
  assert.doesNotMatch(source, /selectedTargetIds/);
  assert.doesNotMatch(source, /addSongs\(/);
  assert.match(globalPlaylistModal, /songIds\.length \* selectedTargetIds\.length > 500/);

  // Keyboard navigation & highlighting
  assert.match(source, /HighlightText/);
  assert.match(source, /is-active-nav/);
  assert.match(source, /handleInputKeyDown/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /ArrowUp/);
  assert.match(source, /Escape/);

  // Recent searches (popular tags removed)
  assert.match(source, /最近搜索/);
  assert.doesNotMatch(source, /热门探索/);
  assert.doesNotMatch(source, /POPULAR_TAGS/);
  assert.match(source, /search-tag-chip/);

  // Global shortcuts
  assert.match(keyboard, /Ctrl\+K \/ Cmd\+K/);
  assert.match(keyboard, /e\.key === 'k' \|\| e\.key === 'K'/);
  assert.match(keyboard, /e\.key === '\/'/);

  // Styles & Layout stability
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.match(css, /\.search-scope-tabs/);
  assert.match(css, /\.search-scope-tab/);
  assert.match(css, /\.search-subfilter-bar/);
  assert.match(css, /\.search-subfilter-pill/);
  assert.match(css, /\.search-type-badge--en/);
  assert.match(css, /\.search-type-badge--ja/);
  assert.match(css, /\.search-type-badge--ko/);
  assert.match(css, /\.search-type-badge--other/);
  assert.match(css, /\.search-highlight/);
  assert.match(css, /\.track-row\.is-active-nav/);
});
