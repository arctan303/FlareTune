// Private user artwork is never exposed through the shared /media namespace.
import { readSchemaInventory } from '../instance/schemaInventory.js';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const folders = { avatar: 'avatars', playlist: 'playlist-covers', chat: 'chat-images' };
const rows = (r) => r?.results ?? [];
const changed = (r) => Number(r?.meta?.changes ?? r?.changes ?? 0);
export class UserImageError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const imageUrl = (id) => id ? `/api/account/images/${encodeURIComponent(id)}` : null;
export async function userImagesReady(db) {
  const inventory = await readSchemaInventory(db, Date.now(), true);
  const names = new Set(rows(inventory.schema).filter(row => row.type === 'table').map(row => row.name));
  return names.has('user_images') && names.has('user_image_refs');
}
async function requireReady(db) {
  if (!await userImagesReady(db)) throw new UserImageError('user_images_migration_required', 503);
}
async function requireAccount(db, accountId) {
  if (!await db.prepare("SELECT account_id FROM accounts WHERE account_id = ? AND status = 'active'").bind(accountId).first()) {
    throw new UserImageError('authentication_required', 401);
  }
}
const fourCC = (b, offset) => String.fromCharCode(...b.subarray(offset, offset + 4));
// Only browser re-encoded, static WebP reaches R2. This verifies container,
// dimensions and disallows animation/metadata; it is not a pixel decoder.
export function inspectUserWebp(value, purpose) {
  const b = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (!folders[purpose] || b.length < 20 || b.length > MAX_IMAGE_BYTES) throw new UserImageError('invalid_image');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (fourCC(b, 0) !== 'RIFF' || fourCC(b, 8) !== 'WEBP' || view.getUint32(4, true) + 8 !== b.length) throw new UserImageError('invalid_image');
  let width = 0; let height = 0; let frame = false; let extended = null;
  for (let at = 12; at < b.length;) {
    if (at + 8 > b.length) throw new UserImageError('invalid_image');
    const type = fourCC(b, at); const length = view.getUint32(at + 4, true); const p = at + 8;
    const end = p + length + (length % 2);
    if (end > b.length || !['VP8 ', 'VP8L', 'VP8X', 'ALPH'].includes(type)) throw new UserImageError('invalid_image');
    if (type === 'VP8X') {
      if (extended || length !== 10 || (b[p] & ~16) || b[p + 1] || b[p + 2] || b[p + 3]) throw new UserImageError('invalid_image');
      extended = [1 + b[p + 4] + (b[p + 5] << 8) + (b[p + 6] << 16), 1 + b[p + 7] + (b[p + 8] << 8) + (b[p + 9] << 16)];
    } else if (type === 'VP8 ') {
      if (frame || length < 10 || (b[p] & 1) || b[p + 3] !== 157 || b[p + 4] !== 1 || b[p + 5] !== 42) throw new UserImageError('invalid_image');
      width = view.getUint16(p + 6, true) & 16383; height = view.getUint16(p + 8, true) & 16383; frame = true;
    } else if (type === 'VP8L') {
      if (frame || length < 5 || b[p] !== 47 || (b[p + 4] & 224)) throw new UserImageError('invalid_image');
      const bits = view.getUint32(p + 1, true);
      width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; frame = true;
    }
    at = end;
  }
  if (!frame || !width || !height || width > 2048 || height > 2048
    || (extended && (extended[0] !== width || extended[1] !== height))
    || (purpose === 'avatar' && (width !== 512 || height !== 512))
    || (purpose === 'playlist' && (width !== 1024 || height !== 1024))) throw new UserImageError('invalid_image');
  return { width, height, byteSize: b.length };
}
export async function readImageBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'image/webp') throw new UserImageError('invalid_image');
  const length = Number(request.headers.get('Content-Length'));
  if (length > MAX_IMAGE_BYTES) throw new UserImageError('image_too_large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new UserImageError('invalid_image');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new UserImageError('image_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function cleanupOwnImages(db, bucket, accountId, { now = Date.now(), ids = [], purpose = null } = {}) {
  // Cleanup is opportunistic: a committed slot/thread change must still report
  // success when candidate selection or a deletion claim cannot reach D1.
  try {
  if (!bucket?.delete || !await userImagesReady(db)) return;
  // Claim exact rows first. Ref triggers prevent attaching an object after its
  // deletion claim, including during a failed R2 delete and subsequent retry.
  const candidates = rows(await db.prepare(`SELECT id, object_key FROM user_images i WHERE account_id = ? AND (? IS NULL OR purpose = ?)
    AND NOT EXISTS (SELECT 1 FROM user_image_refs r WHERE r.image_id = i.id)
    AND (status = 'deleting' OR created_at < ? OR id IN (SELECT value FROM json_each(?)))
    ORDER BY created_at LIMIT 10`).bind(accountId, purpose, purpose, now - 86400000, JSON.stringify(ids.slice(0, 10))).all());
  for (const item of candidates) {
    const claim = await db.prepare(`UPDATE user_images SET status = 'deleting' WHERE id = ? AND account_id = ?
      AND NOT EXISTS (SELECT 1 FROM user_image_refs WHERE image_id = ?)`)
      .bind(item.id, accountId, item.id).run();
    if (!changed(claim)) continue;
    try {
      await bucket.delete(item.object_key);
      await db.prepare("DELETE FROM user_images WHERE id = ? AND account_id = ? AND status = 'deleting'").bind(item.id, accountId).run();
    } catch { /* Keep the tombstone for bounded retries on the next image write. */ }
  }
  } catch { /* Unclaimed objects remain intact; retry on the next own write. */ }
}
export async function uploadOwnImage(db, bucket, accountId, purpose, bytes, now = Date.now()) {
  await requireReady(db); await requireAccount(db, accountId);
  if (!bucket?.put) throw new UserImageError('image_storage_unavailable', 503);
  const dimensions = inspectUserWebp(bytes, purpose);
  await cleanupOwnImages(db, bucket, accountId, { now });
  const id = crypto.randomUUID();
  const key = `users/${encodeURIComponent(accountId)}/${folders[purpose]}/${id}.webp`;
  const result = await db.prepare(`INSERT INTO user_images (id,account_id,purpose,object_key,byte_size,width,height,status,created_at)
    SELECT ?,?,?,?,?,?,?,'pending',? WHERE (SELECT COUNT(*) FROM user_images i WHERE account_id = ?
      AND NOT EXISTS (SELECT 1 FROM user_image_refs r WHERE r.image_id = i.id)) < 16
    AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND status = 'active')`)
    .bind(id, accountId, purpose, key, bytes.length, dimensions.width, dimensions.height, now, accountId, accountId).run();
  if (!changed(result)) throw new UserImageError('image_upload_limit', 429);
  try {
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'image/webp', cacheControl: 'private, no-store' } });
    const ready = await db.prepare("UPDATE user_images SET status = 'ready' WHERE id = ? AND account_id = ? AND status = 'pending'").bind(id, accountId).run();
    if (!changed(ready)) throw new Error('image_upload_expired');
  } catch {
    await cleanupOwnImages(db, bucket, accountId, { now, ids: [id] });
    throw new UserImageError('image_upload_failed', 503);
  }
  return { id, url: imageUrl(id), ...dimensions };
}
export async function getOwnImageSlot(db, accountId, purpose, targetId) {
  if (!await userImagesReady(db)) return { imageId: null, url: null, revision: 0 };
  const r = await db.prepare('SELECT image_id, revision FROM user_image_refs WHERE account_id = ? AND purpose = ? AND target_id = ?')
    .bind(accountId, purpose, targetId).first();
  return { imageId: r?.image_id ?? null, url: imageUrl(r?.image_id), revision: Number(r?.revision ?? 0) };
}
export async function setOwnImageSlot(db, bucket, accountId, { purpose, targetId, imageId, revision }, now = Date.now()) {
  await requireReady(db); await requireAccount(db, accountId);
  if (!['avatar','playlist'].includes(purpose) || !Number.isSafeInteger(revision) || revision < 0
    || (purpose === 'avatar' && targetId !== 'avatar') || typeof targetId !== 'string' || targetId.length > 160
    || (imageId !== null && typeof imageId !== 'string')) throw new UserImageError('invalid_input');
  if (purpose === 'playlist' && !await db.prepare("SELECT id FROM Member_Playlists WHERE id = ? AND account_id = ? AND kind = 'regular'")
    .bind(targetId, accountId).first()) throw new UserImageError('playlist_not_found', 404);
  if (imageId && !await db.prepare("SELECT id FROM user_images WHERE id = ? AND account_id = ? AND purpose = ? AND status = 'ready'")
    .bind(imageId, accountId, purpose).first()) throw new UserImageError('image_not_found', 404);
  const before = await getOwnImageSlot(db, accountId, purpose, targetId);
  if (before.revision !== revision) throw new UserImageError('revision_conflict', 409);
  let result;
  try {
    result = await db.prepare(`INSERT INTO user_image_refs (account_id,purpose,target_id,image_id,revision,playlist_id)
      SELECT ?,?,?,?,1,? WHERE EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND status = 'active')
        AND (? = 'avatar' OR EXISTS (SELECT 1 FROM Member_Playlists WHERE id = ? AND account_id = ? AND kind = 'regular'))
        AND (? = 0 OR EXISTS (SELECT 1 FROM user_image_refs WHERE account_id = ? AND purpose = ? AND target_id = ? AND revision = ?))
      ON CONFLICT(account_id,purpose,target_id) DO UPDATE SET image_id = excluded.image_id, revision = user_image_refs.revision + 1
        WHERE user_image_refs.revision = ?`)
      .bind(accountId, purpose, targetId, imageId, purpose === 'playlist' ? targetId : null, accountId, purpose,
        targetId, accountId, revision, accountId, purpose, targetId, revision, revision).run();
  } catch { throw new UserImageError('image_save_failed', 409); }
  if (!changed(result)) throw new UserImageError('revision_conflict', 409);
  if (before.imageId && before.imageId !== imageId) await cleanupOwnImages(db, bucket, accountId, { now, ids: [before.imageId] });
  return getOwnImageSlot(db, accountId, purpose, targetId);
}
export async function readOwnImage(db, bucket, accountId, id) {
  await requireReady(db);
  const item = await db.prepare("SELECT * FROM user_images WHERE id = ? AND account_id = ? AND status = 'ready'").bind(id, accountId).first();
  if (!item) throw new UserImageError('image_not_found', 404);
  const object = await bucket?.get(item.object_key);
  if (!object) throw new UserImageError('image_not_found', 404);
  return { object, item };
}
