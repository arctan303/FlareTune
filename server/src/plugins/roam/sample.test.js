import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoamCatalog } from './catalog.js';
import { sampleRoam } from './sample.js';
import { roamFixture } from './test-support.js';

test('legacy sampling preserves language, exclusions, playable DTOs and exhaustion', async t => {
  const f = await roamFixture(t);
  f.sqlite.exec(`UPDATE Songs SET language='en'; UPDATE Songs SET language='ja' WHERE id='s2';
    INSERT INTO Songs(id,title,audio_url,language) VALUES('silent','Silent',NULL,'en');`);
  const catalog = createRoamCatalog(f.db);
  const result = await sampleRoam({ seenSongIds: ['s1', 'silent'], language: 'en', limit: 1 }, catalog);
  assert.deepEqual(result.songs.map(song => song.id), ['s3']);
  assert.deepEqual({ language: result.language, total: result.totalPlayable, seen: result.seenPlayable,
    remaining: result.remainingPlayable, exhausted: result.exhausted },
  { language: 'en', total: 2, seen: 1, remaining: 0, exhausted: true });
  assert.deepEqual(Object.keys(result.songs[0]).sort(),
    ['id', 'title', 'artist', 'album', 'duration', 'audio_url', 'cover_url', 'language'].sort());
  assert.doesNotMatch(JSON.stringify(result), /account_id|token_hash|password_hash/u);
  f.sqlite.exec('DELETE FROM Songs');
  assert.deepEqual(await sampleRoam({ seenSongIds: [] }, createRoamCatalog(f.db)),
    { songs: [], language: 'all', limit: 10, totalPlayable: 0, seenPlayable: 0, remainingPlayable: 0, exhausted: true });
});

test('recent sampling preserves queue exclusions and treats a full queue as temporary', async t => {
  const f = await roamFixture(t);
  const catalog = createRoamCatalog(f.db);
  const result = await sampleRoam({ strategy: 'recent', recentSongIds: [], queuedSongIds: ['s1', 's2', 's3'] }, catalog);
  assert.deepEqual(result.songs, []);
  assert.equal(result.exhausted, false);
  const refill = await sampleRoam({ strategy: 'recent', recentSongIds: [], queuedSongIds: ['s1'] }, catalog);
  assert.deepEqual(new Set(refill.songs.map(song => song.id)), new Set(['s2', 's3']));
});
