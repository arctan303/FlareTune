import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unwrapManagedLyricsAsset } from './useManagedLyricsAsset.js';

test('managed lyric response keeps song, asset, public lyrics and etag together', () => {
  const asset = { status: 'ready', original: { lines: [{ text: 'Night' }] } };
  const lyrics = { lines: [{ text: 'Night' }], translationState: 'missing' };
  assert.deepEqual(unwrapManagedLyricsAsset({ data: { song: { id: 's1' }, asset, lyrics, etag: 'e1' } }), {
    song: { id: 's1' }, asset, lyrics, etag: 'e1', aiCompletionEnabled: false,
  });
  assert.equal(unwrapManagedLyricsAsset({ data: { aiCompletionEnabled: true } }).aiCompletionEnabled, true);
});

test('managed mutations centralize cache invalidation, conflicts and current etag', () => {
  const source = readFileSync(new URL('./useManagedLyricsAsset.js', import.meta.url), 'utf8');
  assert.match(source, /invalidateLyricsCacheForSong/);
  assert.match(source, /requestLyricsRefresh/);
  assert.match(source, /error\?\.status === 409/);
  assert.match(source, /saveLyricsDocument\(songId, \{ lines, etag: baselineEtag, aiReceipt \}\)/);
  assert.match(source, /etag: state\.etag/);
});

test('managed lyrics asset hook includes native polling and exposes isAiCompleting', () => {
  const source = readFileSync(new URL('./useManagedLyricsAsset.js', import.meta.url), 'utf8');
  assert.match(source, /isAiCompleting/);
  assert.match(source, /startPolling/);
  assert.match(source, /stopPolling/);
  assert.match(source, /pollDeadlineRef/);
  assert.match(source, /aiCompletion\?\.status === 'pending'/);
  assert.match(source, /translationState === 'pending'/);
  assert.match(source, /AI 补全已完成/);
  assert.match(source, /refreshPlayback\(songId\)/);
  assert.match(source, /1800|2000/);
});
