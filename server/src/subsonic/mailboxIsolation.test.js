import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../flaretune.js';
import { fixture } from './test-support.js';

test('browser and Subsonic cannot read mailbox aliases; normal shared media and admin manifest API remain usable', async () => {
  const f = await fixture();
  const id = 'a'.repeat(32);
  const mailbox = `/media/ingest-devices/v1/${id}/manifest.json`;
  f.objects.set(mailbox.replace('/media/', 'media/'), { type: 'application/json',
    bytes: new TextEncoder().encode(JSON.stringify({ files: [{ name: 'private.mp3' }], scannedAt: 1 })) });
  f.objects.set(`media/ingest-devices/v1/registry/${id}.json`, { type: 'application/json',
    bytes: new TextEncoder().encode(JSON.stringify({ id, name: 'Device', roots: ['music'], lastSeenAt: Date.now() })) });
  try {
    await f.enable();
    assert.equal((await f.rest('stream', { id: 's1' })).status, 200);
    assert.equal((await f.api(`admin/ingest/devices/${id}/manifest`)).status, 200);
    for (const role of ['admin', 'member']) {
      const auth = role === 'admin' ? f.signed : await f.signIn('member');
      if (role === 'member') await f.enable(auth);
      const read = (path, method = 'GET') => worker.fetch(new Request(`https://test.example${path}`, {
        method, headers: { Cookie: auth.cookie, Range: 'bytes=0-4' },
      }), f.env);
      const before = f.mediaReads();
      for (const method of ['GET', 'HEAD']) assert.equal((await read(mailbox, method)).status, 404);
      assert.equal(f.mediaReads(), before);
      assert.equal((await read('/media/audio/one.mp3')).status, 206);
      assert.equal((await read('/media/cover/one.png')).status, 206);
      f.sqlite.prepare('UPDATE Songs SET audio_url=?,cover_url=? WHERE id=?').run(mailbox, mailbox, 's1');
      const beforeProtocol = f.mediaReads();
      for (const method of ['stream', 'download', 'getCoverArt']) {
        const response = await f.rest(method, { id: method === 'getCoverArt' ? 'cover_s1' : 's1' },
          { username: role === 'admin' ? 'owner' : 'member' });
        assert.equal(response.status, 404);
      }
      assert.equal(f.mediaReads(), beforeProtocol);
      f.sqlite.prepare('UPDATE Songs SET audio_url=?,cover_url=? WHERE id=?')
        .run('/media/audio/one.mp3', '/media/cover/one.png', 's1');
      if (role === 'member') assert.equal((await f.api(`admin/ingest/devices/${id}/manifest`, 'GET', undefined, auth)).status, 403);
    }
  } finally { await f.close(); }
});
