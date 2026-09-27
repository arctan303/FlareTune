import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricDraftReceipt, verifyLyricDraftReceipt } from './lyricDraftReceipt.js';

test('AI language receipt is bound to song, account, asset revision, lyric text, and expiry', async () => {
  const env = { SETUP_SECRET: 's'.repeat(48) };
  const context = { songId: 'song-1', accountId: 'admin', etag: null,
    textHash: 'a'.repeat(64) };
  const now = Date.parse('2026-09-26T00:00:00.000Z');
  const receipt = await createLyricDraftReceipt(env, { ...context, language: 'ja', now });
  assert.equal(await verifyLyricDraftReceipt(env, receipt, { ...context, now: now + 1000 }), 'ja');
  for (const changed of [
    { accountId: 'member' }, { songId: 'song-2' }, { etag: 'etag-2' },
    { textHash: 'b'.repeat(64) }, { now: now + 16 * 60_000 },
  ]) assert.equal(await verifyLyricDraftReceipt(env, receipt, { ...context, ...changed }), null);
  assert.equal(await verifyLyricDraftReceipt({ SETUP_SECRET: 't'.repeat(48) }, receipt,
    { ...context, now }), null);
  assert.equal(await verifyLyricDraftReceipt(env, `${receipt}x`, { ...context, now }), null);
});
