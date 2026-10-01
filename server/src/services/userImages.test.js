import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from '../routes/localAssistant.fixture.js';
import { uploadOwnImage, readOwnImage, getOwnImageSlot, setOwnImageSlot, cleanupOwnImages, inspectUserWebp, readImageBody } from './userImages.js';
import { handleUserImages } from '../routes/userImages.js';
// Container-boundary fixture, not a decoder fixture. Browser pixel export is
// exercised separately; malformed compressed pixel data is never trusted as text.
function webp(size = 512) {
  const bytes = new Uint8Array(26); const v = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0); v.setUint32(4, 18, true);
  bytes.set(new TextEncoder().encode('WEBPVP8L'), 8); v.setUint32(16, 5, true);
  bytes[20] = 47; v.setUint32(21, (size - 1) | ((size - 1) << 14), true);
  return bytes;
}
function setup() {
  const f = fixture();
  f.sqlite.exec(readFileSync(new URL('../../db/migrations-flaretune/0010_user_images.sql', import.meta.url), 'utf8'));
  const objects = new Map(); const deleted = [];
  const bucket = { async put(k, bytes) { objects.set(k, bytes); }, async get(k) { return objects.has(k) ? { body: objects.get(k), arrayBuffer: async () => objects.get(k).buffer } : null; },
    async delete(k) { deleted.push(k); objects.delete(k); } };
  return { ...f, bucket, objects, deleted };
}
test('per-account random R2 keys, owner reads and cross-account/admin denial', async () => {
  const f = setup(); const img = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  assert.match([...f.objects.keys()][0], /^users\/account-A\/avatars\/[0-9a-f-]+\.webp$/);
  assert.equal((await readOwnImage(f.db, f.bucket, 'account-A', img.id)).item.account_id, 'account-A');
  await assert.rejects(readOwnImage(f.db, f.bucket, 'account-B', img.id), e => e.status === 404);
  f.sqlite.exec("UPDATE accounts SET role = 'admin' WHERE account_id = 'account-B'");
  const response = await handleUserImages(new Request(`https://flare.test${img.url}`), new URL(`https://flare.test${img.url}`), f.db, f.bucket, f.session('account-B'));
  assert.equal(response.status, 404);
  assert.equal((await handleUserImages(new Request(`https://flare.test${img.url}`), new URL(`https://flare.test${img.url}`), f.db, f.bucket, null)).status, 401);
  f.sqlite.close();
});
test('slot CAS, purpose and playlist isolation; failed replacement retains old image', async () => {
  const f = setup(); const a = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  const b = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  const first = await setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: a.id, revision: 0 });
  assert.equal(first.revision, 1);
  await assert.rejects(setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: b.id, revision: 0 }), e => e.status === 409);
  await assert.rejects(setOwnImageSlot(f.db, f.bucket, 'account-B', { purpose: 'avatar', targetId: 'avatar', imageId: a.id, revision: 0 }), e => e.status === 404);
  assert.equal((await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar')).imageId, a.id);
  await assert.rejects(uploadOwnImage(f.db, { ...f.bucket, put: async () => { throw new Error('R2 offline'); } }, 'account-A', 'avatar', webp()), e => e.code === 'image_upload_failed');
  assert.equal((await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar')).imageId, a.id);
  f.sqlite.prepare("INSERT INTO Member_Playlists(id,account_id,kind,name,created_at,updated_at) VALUES ('mine','account-A','regular','mine',1,1), ('other','account-B','regular','other',1,1), ('fav','account-A','favorite','fav',1,1)").run();
  const cover = await uploadOwnImage(f.db, f.bucket, 'account-A', 'playlist', webp(1024));
  for (const targetId of ['other','fav']) await assert.rejects(setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'playlist', targetId, imageId: cover.id, revision: 0 }), e => e.status === 404);
  await assert.rejects(setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: cover.id, revision: 1 }), e => e.status === 404);
  await setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'playlist', targetId: 'mine', imageId: cover.id, revision: 0 });
  assert.equal((await getOwnImageSlot(f.db, 'account-A', 'playlist', 'mine')).url, cover.url);
  f.sqlite.close();
});
test('cleanup protects referenced objects, retries tombstones, forbids reattachment and isolates owner', async () => {
  const f = setup(); const a = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  const b = await uploadOwnImage(f.db, f.bucket, 'account-B', 'avatar', webp());
  await setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: a.id, revision: 0 });
  await cleanupOwnImages(f.db, f.bucket, 'account-A', { now: Date.now() + 86400001, ids: [a.id,b.id] });
  assert.equal(f.objects.size, 2);
  const c = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  await setOwnImageSlot(f.db, { ...f.bucket, delete: async () => { throw new Error('offline'); } }, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: c.id, revision: 1 });
  assert.equal(f.sqlite.prepare('SELECT status FROM user_images WHERE id = ?').get(a.id).status, 'deleting');
  await assert.rejects(setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: a.id, revision: 2 }), e => e.status === 404);
  await cleanupOwnImages(f.db, f.bucket, 'account-A'); assert.equal(f.objects.size, 2);
  assert.equal((await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar')).imageId, c.id);
  await setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: null, revision: 2 });
  assert.equal((await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar')).revision, 3);
  f.sqlite.close();
});
test('post-commit cleanup query/claim failure preserves successful slot and never deletes unclaimed R2', async () => {
  for (const failure of ['SELECT id, object_key', "UPDATE user_images SET status = 'deleting'"]) {
    const f = setup(); const a = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
    const b = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
    await setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose:'avatar', targetId:'avatar', imageId:a.id, revision:0 });
    const failingDb = { prepare(sql) { if (sql.includes(failure)) throw new Error('D1 offline'); return f.db.prepare(sql); } };
    const saved = await setOwnImageSlot(failingDb, f.bucket, 'account-A', { purpose:'avatar', targetId:'avatar', imageId:b.id, revision:1 });
    assert.equal(saved.imageId, b.id); assert.equal(saved.revision, 2);
    assert.equal(f.deleted.length, 0); assert.equal(f.objects.size, 2);
    await cleanupOwnImages(f.db, f.bucket, 'account-A', { ids:[a.id] });
    assert.equal(f.objects.size, 1); f.sqlite.close();
  }
});

test('container, dimensions, SVG, oversize body and wrong content type are rejected', async () => {
  assert.deepEqual(inspectUserWebp(webp(), 'avatar'), { width: 512, height: 512, byteSize: 26 });
  for (const [bytes, purpose] of [[webp(1),'avatar'],[webp(4096),'chat'],[new TextEncoder().encode('<svg/>'),'chat'],[webp(),'unknown']]) assert.throws(() => inspectUserWebp(bytes, purpose));
  const bad = webp(); bad[4] = 0; assert.throws(() => inspectUserWebp(bad, 'avatar'));
  await assert.rejects(readImageBody(new Request('https://flare.test', { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' })));
  await assert.rejects(readImageBody(new Request('https://flare.test', { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: new Uint8Array(5242881) })), e => e.status === 413);
});
test('pre-migration reads fall back but writes clearly fail closed', async () => {
  const f = fixture(); assert.equal((await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar')).url, null);
  await assert.rejects(uploadOwnImage(f.db, {}, 'account-A', 'avatar', webp()), e => e.code === 'user_images_migration_required'); f.sqlite.close();
});
