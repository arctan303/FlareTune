import test from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeService } from './service.mjs';
const id = 'WqkrwFSFeAE';
const service = getLyrics => createYouTubeService({ env: {}, services: { player: {},
  manager: { guest: async () => ({ music: { getLyrics } }) } } });
test('native SDK descriptions retain line breaks without inventing a synced timeline', async () => {
  const result = await service(async () => ({ description: { toString: () => 'Line one\nLine two' }, footer: 'Attribution' })).lyrics(id);
  assert.equal(result.status, 'available');
  assert.equal(result.text, 'Line one\nLine two');
  assert.equal(result.syncMode, 'none');
  assert.equal(result.attribution, 'Attribution');
});
test('missing and empty native lyrics stay unavailable; SDK failures contain no raw upstream detail', async () => {
  for (const value of [undefined, {}, { description: '' }]) assert.equal((await service(async () => value).lyrics(id)).status, 'unavailable');
  assert.equal((await service(async () => { throw new Error('Lyrics not available.'); }).lyrics(id)).status, 'unavailable');
  await assert.rejects(service(async () => { throw new Error('private signed URL or bearer'); }).lyrics(id), error =>
    error.code === 'YOUTUBE_LYRICS_UNAVAILABLE' && !error.message.includes('private'));
});
