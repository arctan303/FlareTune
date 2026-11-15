import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from '../routes/localAssistant.fixture.js';
import { uploadOwnImage, readOwnImage, getOwnImageSlot, setOwnImageSlot, cleanupOwnImages, inspectUserWebp, readImageBody, deleteOwnImage } from './userImages.js';
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

test('slot JSON input errors return 400 and preserve the attached image', async t => {
  const f = setup(); t.after(() => f.sqlite.close());
  const image = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  const attached = await setOwnImageSlot(f.db, f.bucket, 'account-A', {
    purpose: 'avatar', targetId: 'avatar', imageId: image.id, revision: 0,
  });
  const valid = JSON.stringify({ imageId: image.id, revision: attached.revision });
  const cases = [
    { name: 'missing content type', body: valid },
    { name: 'wrong content type', type: 'text/plain', body: valid },
    { name: 'missing body', type: 'application/json' },
    { name: 'invalid JSON', type: 'application/json', body: '{' },
    { name: 'non-object JSON', type: 'application/json', body: '[]' },
    { name: 'null JSON', type: 'application/json', body: 'null' },
    { name: 'invalid UTF-8', type: 'application/json', body: new Uint8Array([0xff]) },
    { name: 'oversized JSON', type: 'application/json', body: JSON.stringify({ imageId: image.id, revision: 1, padding: 'x'.repeat(8192) }) },
  ];
  for (const item of cases) {
    const request = new Request('https://flare.test/api/account/images/slots/avatar/avatar', {
      method: 'PUT', headers: item.type ? { 'Content-Type': item.type } : {},
      ...(item.body === undefined ? {} : { body: item.body }),
    });
    const response = await handleUserImages(request, new URL(request.url), f.db, f.bucket, f.session('account-A'));
    assert.equal(response.status, 400, item.name);
    assert.deepEqual(await response.json(), { error: 'invalid_input' }, item.name);
    assert.deepEqual(await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar'), attached, item.name);
  }
  assert.equal(f.objects.size, 1);
  assert.deepEqual(f.deleted, []);
});

test('slot image IDs are null or bounded identifiers, with lookup and CAS preserved', async t => {
  const f = setup(); t.after(() => f.sqlite.close());
  const image = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  const attached = await setOwnImageSlot(f.db, f.bucket, 'account-A', {
    purpose: 'avatar', targetId: 'avatar', imageId: image.id, revision: 0,
  });
  const put = async body => {
    const request = new Request('https://flare.test/api/account/images/slots/avatar/avatar', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return handleUserImages(request, new URL(request.url), f.db, f.bucket, f.session('account-A'));
  };
  for (const imageId of [undefined, '', ' ', 'a/b', 'a.b', '%2F', 'https://image.test/a', '图', 'a'.repeat(161), 1, false, {}]) {
    const response = await put({ imageId, revision: attached.revision });
    assert.equal(response.status, 400, String(imageId));
    assert.deepEqual(await response.json(), { error: 'invalid_input' });
    assert.deepEqual(await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar'), attached);
  }
  for (const imageId of ['A_z-09', 'a'.repeat(160)]) {
    const response = await put({ imageId, revision: attached.revision });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'image_not_found' });
  }
  const stale = await put({ imageId: image.id, revision: 0 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'revision_conflict' });
  const cleared = await put({ imageId: null, revision: attached.revision });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { imageId: null, url: null, revision: 2 });
});

test('explicit image DELETE isolates owners, rejects references and completes both stores', async t => {
  const f = setup(); t.after(() => f.sqlite.close());
  const image = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  const remove = async (actor = 'account-A', bucket = f.bucket) => {
    const request = new Request(`https://flare.test${image.url}`, { method: 'DELETE' });
    return handleUserImages(request, new URL(request.url), f.db, bucket, f.session(actor));
  };
  f.sqlite.exec("UPDATE accounts SET role='admin' WHERE account_id='account-B'");
  const denied = await remove('account-B');
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: 'image_not_found' });
  assert.equal(f.objects.size, 1);
  await setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: image.id, revision: 0 });
  const used = await remove();
  assert.equal(used.status, 409);
  assert.deepEqual(await used.json(), { error: 'image_in_use' });
  assert.equal(f.objects.size, 1);
  assert.deepEqual(f.deleted, []);
  // Detach without opportunistic cleanup so the explicit deletion owns the work.
  await setOwnImageSlot(f.db, {}, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: null, revision: 1 });
  const removed = await remove();
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  assert.equal(f.objects.size, 0);
  assert.equal(f.sqlite.prepare('SELECT id FROM user_images WHERE id=?').get(image.id), undefined);
  assert.equal((await remove()).status, 404);
});

test('explicit DELETE reports storage failures and retries the same tombstone', async t => {
  for (const stage of ['missing bucket delete', 'database lookup', 'database claim', 'R2 delete', 'database removal', 'unconfirmed removal']) {
    await t.test(stage, async t => {
      const f = setup(); t.after(() => f.sqlite.close());
      const image = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
      const failingDb = { prepare(sql) {
        if ((stage === 'database lookup' && sql.startsWith('SELECT id,object_key,status')) ||
            (stage === 'database claim' && sql.startsWith("UPDATE user_images SET status = 'deleting'")) ||
            (stage === 'database removal' && sql.startsWith('DELETE FROM user_images WHERE id = ?'))) throw new Error('D1 offline');
        if (stage === 'unconfirmed removal' && sql.startsWith('DELETE FROM user_images WHERE id = ?')) {
          return { bind() { return this; }, async run() { return { meta: { changes: 0 } }; } };
        }
        return f.db.prepare(sql);
      } };
      const bucket = stage === 'missing bucket delete' ? {} : stage === 'R2 delete'
        ? { ...f.bucket, delete: async () => { throw new Error('R2 offline'); } } : f.bucket;
      const request = new Request(`https://flare.test${image.url}`, { method: 'DELETE' });
      const response = await handleUserImages(request, new URL(request.url), failingDb, bucket, f.session('account-A'));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, stage === 'missing bucket delete' ? 'image_storage_unavailable' : 'image_delete_failed');
      const tombstone = ['R2 delete', 'database removal', 'unconfirmed removal'].includes(stage);
      assert.equal(f.sqlite.prepare('SELECT status FROM user_images WHERE id=?').get(image.id).status, tombstone ? 'deleting' : 'ready');
      assert.equal(f.objects.size, ['database removal', 'unconfirmed removal'].includes(stage) ? 0 : 1);
      if (tombstone) await assert.rejects(readOwnImage(f.db, f.bucket, 'account-A', image.id), error => error.code === 'image_not_found');
      assert.deepEqual(await deleteOwnImage(f.db, f.bucket, 'account-A', image.id), { ok: true });
      assert.equal(f.objects.size, 0);
      assert.equal(f.sqlite.prepare('SELECT id FROM user_images WHERE id=?').get(image.id), undefined);
    });
  }
});

test('explicit DELETE cannot claim an image referenced concurrently before its tombstone', async t => {
  const f = setup(); t.after(() => f.sqlite.close());
  const image = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  let raced = false;
  const racingDb = { prepare(sql) {
    const statement = f.db.prepare(sql);
    if (!sql.startsWith("UPDATE user_images SET status = 'deleting'")) return statement;
    return { bind(...args) { statement.bind(...args); return this; }, async run() {
      raced = true;
      await setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: image.id, revision: 0 });
      return statement.run();
    } };
  } };
  await assert.rejects(deleteOwnImage(racingDb, f.bucket, 'account-A', image.id), error => error.code === 'image_in_use' && error.status === 409);
  assert.equal(raced, true);
  assert.equal(f.sqlite.prepare('SELECT status FROM user_images WHERE id=?').get(image.id).status, 'ready');
  assert.equal((await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar')).imageId, image.id);
  assert.equal(f.objects.size, 1);
  assert.deepEqual(f.deleted, []);
});

test('a claimed explicit deletion prevents new references while R2 is pending', async t => {
  const f = setup(); t.after(() => f.sqlite.close());
  const image = await uploadOwnImage(f.db, f.bucket, 'account-A', 'avatar', webp());
  let checked = false;
  const bucket = { ...f.bucket, async delete(key) {
    assert.equal(f.sqlite.prepare('SELECT status FROM user_images WHERE id=?').get(image.id).status, 'deleting');
    await assert.rejects(setOwnImageSlot(f.db, f.bucket, 'account-A', { purpose: 'avatar', targetId: 'avatar', imageId: image.id, revision: 0 }), error => error.code === 'image_not_found');
    assert.throws(() => f.sqlite.prepare(`INSERT INTO user_image_refs(account_id,purpose,target_id,image_id,revision)
      VALUES ('account-A','avatar','avatar',?,1)`).run(image.id), /image_unavailable/);
    checked = true;
    await f.bucket.delete(key);
  } };
  assert.deepEqual(await deleteOwnImage(f.db, bucket, 'account-A', image.id), { ok: true });
  assert.equal(checked, true);
  assert.equal(f.objects.size, 0);
  assert.equal((await getOwnImageSlot(f.db, 'account-A', 'avatar', 'avatar')).imageId, null);
});
