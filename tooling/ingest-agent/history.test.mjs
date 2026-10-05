import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openIngestHistory } from './history.mjs';

const files = [{ id: 'file', path: 'music/song.mp3', size: 8, name: 'song.mp3',
  localLocation: 'D:/music/song.mp3', common: { title: 'Song' } }];
test('a changed file is detected from scan history even before any media transfer', async () => {
  const history = await openIngestHistory(':memory:', 'https://one.example', 'owner', 'device');
  try {
    history.observe(files);
    assert.equal(history.filesWithHistory(files)[0].ingest.changed, false);
    const changed = [{ ...files[0], id: 'changed', size: 9 }];
    history.observe(changed);
    const restored = history.filesWithHistory(changed)[0];
    assert.equal(restored.ingest.changed, true);
    assert.equal(restored.ingest.audio, null);
    assert.equal(restored.ingest.cover, null);
    assert.equal(restored.localLocation, undefined);
    assert.equal(history.filesWithHistory([{ ...changed[0], localLocation: 'E:/music/song.mp3' }])[0].ingest.changed, false);
    assert.equal(history.filesWithHistory([{ ...changed[0], localLocation: undefined }])[0].ingest.changed, false);
  } finally { history.close(); }
});
test('history survives reopen, preserves media identity, isolates instance and account, and detects changed files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaretune-history-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  const path = join(directory, 'history.sqlite');
  let history;
  try {
    history = await openIngestHistory(path, 'https://one.example', 'owner');
    history.observe(files);
    history.record({ id: 'job', fileId: 'file', mediaId: 'fixed', kind: 'audio' },
      { status: 'done', url: '/media/audio/fixed.mp3' });
    assert.equal(history.filesWithHistory(files)[0].ingest.audio.songId, undefined);
    history.reconcile([{ id: 'cloud-song', audio_url: '/media/audio/fixed.mp3' }]);
    assert.equal(history.filesWithHistory(files)[0].ingest.audio.songId, 'cloud-song');
    history.close();
    history = await openIngestHistory(path, 'https://one.example/', 'owner');
    const restored = history.filesWithHistory(files)[0];
    assert.equal(restored.ingest.audio.id, 'job');
    assert.equal(restored.ingest.audio.mediaId, 'fixed');
    assert.equal(restored.ingest.audio.status, 'done');
    assert.equal(restored.ingest.audio.songId, 'cloud-song');
    history.reconcile([]);
    assert.equal(history.filesWithHistory(files)[0].ingest.audio.songId, null, 'deleted cloud song invalidates success');
    assert.equal(restored.localLocation, undefined, 'absolute path must not enter the remote manifest');
    const changed = [{ ...files[0], id: 'changed', size: 9 }];
    history.observe(changed);
    assert.equal(history.filesWithHistory(changed)[0].ingest.changed, true);
    assert.equal(history.filesWithHistory(changed)[0].ingest.audio, null);
    history.close();
    for (const [base, account] of [['https://two.example', 'owner'], ['https://one.example', 'other']]) {
      history = await openIngestHistory(path, base, account);
      assert.equal(history.filesWithHistory(files)[0].ingest.audio, null);
      assert.equal(history.filesWithHistory(changed)[0].ingest.changed, false);
      history.close(); history = null;
    }
    history = await openIngestHistory(path, 'https://one.example', 'owner', 'new-device');
    assert.equal(history.filesWithHistory(files)[0].ingest.audio, null);
  } finally { history?.close(); await rm(directory, { recursive: true, force: true }); }
});
test('failed media status can be updated by retrying the same job', async () => {
  const history = await openIngestHistory(':memory:', 'https://example.test', 'owner');
  try {
    const job = { id: 'job', fileId: 'file', kind: 'audio', mediaId: 'fixed' };
    history.record(job, { status: 'error', message: 'network failed' });
    assert.equal(history.filesWithHistory(files)[0].ingest.audio.message, 'network failed');
    history.record(job, { status: 'done', url: '/media/audio/fixed.mp3' });
    assert.equal(history.filesWithHistory(files)[0].ingest.audio.status, 'done');
  } finally { history.close(); }
});
