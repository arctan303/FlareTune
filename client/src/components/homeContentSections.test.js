import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('homepage overview is presentational and preserves playback, roam and navigation actions', () => {
  const main = readSource('./MainContent.jsx');
  const overview = readSource('./HomeOverview.jsx');

  assert.match(main, /import HomeOverview from '\.\/HomeOverview\.jsx'/);
  assert.match(main, /<HomeOverview/);
  assert.match(overview, /onClick=\{\(event\) => leadPlaylist && openPlaylist\(leadPlaylist, event\)\}/);
  assert.match(overview, /data-playlist-id=\{leadPlaylist\?\.id\}/);
  assert.match(overview, /onClick=\{handleLeadSongPlay\}/);
  assert.match(overview, /onNavigateRoam/);
  assert.match(overview, /onToggleRoam/);
  assert.doesNotMatch(overview, /quick-roam-banner/);
  assert.doesNotMatch(overview, /useUIStore|\bfetch\s*\(/);
});

test('homepage shelf sections render properly while MainContent retains navigation orchestration', () => {
  const main = readSource('./MainContent.jsx');
  const overview = readSource('./HomeOverview.jsx');
  const sections = readSource('./HomeCollectionSections.jsx');

  assert.match(main, /<HomeOverview/);
  assert.match(main, /<RoamOverview/);
  assert.match(main, /onToggleRoam=\{handleStartRandomRoam\}/);
  assert.match(main, /items=\{EXPLORE_CATEGORIES\}/);
  assert.match(overview, /home-empty-footprints/);
  assert.match(sections, /items\.map/);
  assert.match(sections, /HorizontalScrollButtons/);
  assert.match(sections, /ChevronRight/);
  assert.doesNotMatch(`${overview}\n${sections}`, /useUIStore|\bfetch\s*\(/);
});
