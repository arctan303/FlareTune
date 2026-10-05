import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDeviceFiles, excludeUnreviewedDuplicates, loadIngestCatalog } from './deviceIngestClassification.js';

const file = (id, title, artist = 'Singer', extra = {}) => ({ id, name: `${title}.mp3`,
  path: `music/${title}.mp3`, duration: '120', common: { title, artist }, ...extra });
test('source classification uses existing identity rules and retains one local representative', () => {
  const rows = classifyDeviceFiles([file('a', 'New'), file('b', 'NEW!'), file('c', 'New', 'Other'),
    file('d', 'Live'), file('e', 'Known')], [
    { id: 'live', title: 'Live', artist: 'Singer', duration: 180 },
    { id: 'known', title: 'Known', artist: 'Singer', duration: 120 },
  ]);
  assert.deepEqual(rows.map((row) => row.ingestStatus), ['new', 'duplicate', 'new', 'duplicate', 'duplicate']);
  assert.equal(rows[1].matches[0].source, 'device');
  assert.equal(rows[3].matches[0].strength, 'possible');
  assert.equal(rows[4].matches[0].strength, 'strong');
});
test('a transfer receipt is unfinished until the current catalog references its audio', () => {
  const recorded = file('a', 'Old tags', 'Singer', { ingest: { audio: { id: 'job', status: 'done', url: '/media/audio/a.mp3' } } });
  const catalog = [{ id: 'song', title: 'Edited in browser', audio_url: '/media/audio/a.mp3' }];
  assert.equal(classifyDeviceFiles([recorded], [])[0].ingestStatus, 'unfinished');
  assert.equal(classifyDeviceFiles([recorded], catalog)[0].ingestStatus, 'saved');
  assert.equal(classifyDeviceFiles([recorded], [{ ...catalog[0], audio_url: '/media/audio/b.mp3' }])[0].ingestStatus, 'unfinished');
});
test('changed files and failed uploads are distinguished from new candidates; queue identity includes device', () => {
  const files = [file('a', 'Changed', '', { ingest: { changed: true } }),
    file('b', 'Failed', '', { ingest: { audio: { status: 'error' } } }), file('c', 'Queued')];
  const queued = [{ agent: { deviceId: 'one', fileId: 'c' }, status: 'ready' }];
  const rows = classifyDeviceFiles(files, [], queued, 'one');
  assert.deepEqual(rows.map((row) => row.ingestStatus), ['changed', 'unfinished', 'new']);
  assert.equal(rows[2].inQueue, true);
  assert.equal(classifyDeviceFiles(files, [], queued, 'two')[2].inQueue, false);
});
test('complete catalog is read once per page and failures cannot produce a new classification', async () => {
  const calls = [];
  const songs = await loadIngestCatalog(async (options) => {
    calls.push(options);
    return { total: 2, songs: [{ id: `song-${options.page}` }] };
  });
  assert.equal(songs.length, 2);
  assert.deepEqual(calls, [{ page: 1, limit: 100 }, { page: 2, limit: 100 }]);
  await assert.rejects(loadIngestCatalog(async () => ({ songs: [], total: 1 })), /不完整/);
  await assert.rejects(loadIngestCatalog(async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(loadIngestCatalog(async ({ page }) => ({ songs: [{ id: 'same' }], total: page === 1 ? 2 : 3 })), /变化/);
});
test('bulk exclusion keeps uploaded songs and explicit alternate-version choices', () => {
  const entries = [
    { key: 'keep', status: 'ready', duplicateMatches: [] },
    { key: 'remove', status: 'duplicate', duplicateMatches: [{}] },
    { key: 'saved', status: 'saved', duplicateMatches: [{}] },
    { key: 'alternate', status: 'ready', duplicateMatches: [{}], allowDuplicate: true },
  ];
  assert.deepEqual(excludeUnreviewedDuplicates(entries).map((entry) => entry.key), ['keep', 'saved', 'alternate']);
});
