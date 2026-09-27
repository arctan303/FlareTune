import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sortLyricsCandidates, projectProviderWarnings } from './LyricsManagementWorkspace.state.js';

const source = readFileSync(new URL('./LyricsManagementWorkspace.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./lyrics-management-workspace.css', import.meta.url), 'utf8');
const menu = readFileSync(new URL('./PlayerMoreMenu.jsx', import.meta.url), 'utf8');
const entry = readFileSync(new URL('./LyricsWorkspaceEntry.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.jsx', import.meta.url), 'utf8');

test('both fullscreen entries open the same lyric workspace directly', () => {
  assert.match(menu, /openLyricsWorkspace\(currentSong\)/);
  assert.match(entry, /openLyricsWorkspace\(currentSong\)/);
  assert.doesNotMatch(app, /PlayerToolsDrawer/);
  assert.doesNotMatch(app, /<LyricsManagementWorkspace \/>/);
  assert.match(source, /className="lyric-studio app-page"/);
  assert.doesNotMatch(source, /aria-modal="true"/);
});

test('workspace edits and imports shared lyrics with visible word timing caveat', () => {
  assert.match(source, /managed\.saveDocument\(lines, editingEtagRef\.current, draftReceiptRef\.current\)/);
  assert.match(source, /managed\.shiftTimeline\(shift\)/);
  assert.match(source, /managed\.importLrc/);
  assert.match(source, /managed\.restoreBackup/);
  assert.match(source, /changedWordRows/);
  assert.match(source, /逐行同步/);
  assert.match(source, /managed\.completeTranslation\(\)/);
  assert.doesNotMatch(source, /managed\.adoptCandidate/);
  assert.match(source, /导入当前歌词草稿/);
  assert.match(source, /editingEtagRef\.current = managed\.etag/);
  assert.match(source, /isAdmin &&/);
});

test('workspace follows app page scrolling and light and dark themes', () => {
  assert.match(css, /\.lyric-studio \{/);
  assert.match(css, /html\.dark \.lyric-studio \{/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /\.lyric-studio__layout \{[\s\S]*display: block;/);
  assert.doesNotMatch(css, /position: fixed;/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('candidate quality ordering and safe warnings stay available', () => {
  const candidates = [{ source: 'kugou', providerLyricId: 'a', score: 100 },
    { source: 'lrclib', providerLyricId: 'b', score: 10 }];
  assert.equal(sortLyricsCandidates(candidates, {
    'kugou:a': { state: 'ready', syncMode: 'line' },
    'lrclib:b': { state: 'ready', syncMode: 'word' },
  })[0].providerLyricId, 'b');
  assert.equal(projectProviderWarnings([{ source: 'kugou', code: 'timeout' }])[0].text, '酷狗请求超时');
});
