import { UserImageError, getOwnImageSlot, uploadOwnImage, setOwnImageSlot, readOwnImage, readImageBody, cleanupOwnImages } from '../services/userImages.js';
import { readBoundedJson } from '../instance/httpSecurity.js';
import { assistantImagePolicy } from '../services/assistantImages.js';
import { createPluginContext } from '../plugins/context.js';
import { pluginRegistry } from '../plugins/registry.js';
import { createPluginServiceLease } from '../plugins/services.js';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
export async function handleUserImages(request, url, db, bucket, session, { env, registry = pluginRegistry, context } = {}) {
  const path = url.pathname;
  if (!path.startsWith('/api/account/images')) return null;
  if (session?.mode !== 'normal' || !session?.account?.accountId) return json({ error: 'authentication_required' }, 401);
  const owner = session.account.accountId;
  try {
    const upload = path.match(/^\/api\/account\/images\/upload\/(avatar|playlist|chat)$/);
    if (upload && request.method === 'POST') {
      let lease;
      if (upload[1] === 'chat') {
        const pluginEnv = env || { DB: db, MEDIA_BUCKET: bucket };
        const authority = context || await createPluginContext({ env: pluginEnv, session, pluginId: 'assistant', registry });
        const build = registry.getBuildDigest('assistant');
        if (!build || request.headers.get('X-FlareTune-Plugin-Build') !== build) return json({ error: 'PLUGIN_BUILD_MISMATCH' }, 409);
        lease = await createPluginServiceLease({ env: pluginEnv, session, consumerId: 'assistant', providerId: 'ai-gateway', consumerContext: authority, registry });
        db = lease.guardedDb(db);
        if (!(await assistantImagePolicy(db)).enabled) throw new UserImageError('assistant_images_disabled', 403);
      }
      const result = await uploadOwnImage(db, bucket, owner, upload[1], await readImageBody(request));
      await lease?.assertCurrent();
      return json(result, 201);
    }
    const slot = path.match(/^\/api\/account\/images\/slots\/(avatar|playlist)\/([A-Za-z0-9_-]{1,160})$/);
    if (slot && request.method === 'GET') return json(await getOwnImageSlot(db, owner, slot[1], slot[2]));
    if (slot && request.method === 'PUT') {
      const body = await readBoundedJson(request);
      if (Object.keys(body).some(k => !['imageId','revision'].includes(k))) throw new UserImageError('invalid_input');
      return json(await setOwnImageSlot(db, bucket, owner, { ...body, purpose: slot[1], targetId: slot[2] }));
    }
    const image = path.match(/^\/api\/account\/images\/([a-zA-Z0-9_-]{1,160})$/);
    if (image && request.method === 'GET') {
      const { object } = await readOwnImage(db, bucket, owner, image[1]);
      return new Response(object.body, { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Disposition': 'inline' } });
    }
    if (image && request.method === 'DELETE') {
      const row = await db.prepare('SELECT id FROM user_images WHERE id = ? AND account_id = ?').bind(image[1], owner).first();
      if (!row) throw new UserImageError('image_not_found', 404);
      if (await db.prepare('SELECT image_id FROM user_image_refs WHERE image_id = ?').bind(image[1]).first()) throw new UserImageError('image_in_use', 409);
      await cleanupOwnImages(db, bucket, owner, { ids: [image[1]] });
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    const known = error instanceof UserImageError || (typeof error?.code === 'string' && Number.isInteger(error?.status));
    return json({ error: known ? error.code : 'image_request_failed' }, known ? error.status : 503);
  }
}
