import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sortLyricsCandidates, projectProviderWarnings } from './LyricsManagementWorkspace.state.js';

const menu = readFileSync(new URL('./PlayerMoreMenu.jsx', import.meta.url), 'utf8');
const entry = readFileSync(new URL('./LyricsWorkspaceEntry.jsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.jsx', import.meta.url), 'utf8');

test('both fullscreen entries open the same lyric workspace directly', () => {
  assert.match(menu, /openLyricsWorkspace\(currentSong\)/);
  assert.match(entry, /openLyricsWorkspace\(currentSong\)/);
  assert.doesNotMatch(app, /PlayerToolsDrawer/);
  assert.doesNotMatch(app, /<LyricsManagementWorkspace \/>/);
});

test('candidate quality ordering and safe warnings stay available', () => {
  const candidates = [{ source: 'custom_krc', providerLyricId: 'a', score: 100 },
    { source: 'lrclib', providerLyricId: 'b', score: 100 }];
  assert.equal(sortLyricsCandidates(candidates, {
    'custom_krc:a': { state: 'ready', syncMode: 'line' },
    'lrclib:b': { state: 'ready', syncMode: 'word' },
  })[0].providerLyricId, 'a');
  assert.deepEqual(projectProviderWarnings([{ source: 'custom_krc', code: 'timeout' }])[0], {
    key: 'provider-warning-0', source: 'custom_krc', reason: '请求超时',
  });
});
