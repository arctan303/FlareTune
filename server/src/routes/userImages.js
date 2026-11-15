import { UserImageError, getOwnImageSlot, uploadOwnImage, setOwnImageSlot, readOwnImage, readImageBody, deleteOwnImage } from '../services/userImages.js';
import { readBoundedJson, RequestBodyError } from '../instance/httpSecurity.js';
import * as assistantImages from '../services/assistantImages.js';
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
      let lease, images;
      if (upload[1] === 'chat') {
        const pluginEnv = env || { DB: db, MEDIA_BUCKET: bucket };
        const authority = context || await createPluginContext({ env: pluginEnv, session, pluginId: 'assistant', registry });
        const build = registry.getBuildDigest('assistant');
        if (!build || request.headers.get('X-FlareTune-Plugin-Build') !== build) return json({ error: 'PLUGIN_BUILD_MISMATCH' }, 409);
        lease = await createPluginServiceLease({ env: pluginEnv, session, consumerId: 'assistant', providerId: 'ai-gateway', consumerContext: authority, registry });
        // A host upgrade inherits the exact installed package. API1 assistant
        // packages expose only the legacy policy; the new package owns the
        // configuration-bound access capability. Avoid a named import that
        // would prevent the inherited old package from linking at all.
        const createAccess = Reflect.get(assistantImages, 'createAssistantImageAccess');
        if (typeof createAccess === 'function') {
          images = await createAccess({ env: pluginEnv, session, consumerContext: authority, serviceLease: lease, registry });
        } else {
          const guardedDb = lease.guardedDb(pluginEnv.DB);
          const policy = Reflect.get(assistantImages, 'assistantImagePolicy');
          if (typeof policy !== 'function') throw new UserImageError('assistant_images_disabled', 403);
          images = { db: guardedDb, policy: () => policy(guardedDb) };
        }
        db = images.db;
        if (!(await images.policy()).enabled) throw new UserImageError('assistant_images_disabled', 403);
      }
      const result = await uploadOwnImage(db, bucket, owner, upload[1], await readImageBody(request));
      if (images && !(await images.policy()).enabled) throw new UserImageError('assistant_images_disabled', 403);
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
      return json(await deleteOwnImage(db, bucket, owner, image[1]));
    }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof RequestBodyError) return json({ error: 'invalid_input' }, 400);
    const known = error instanceof UserImageError || (typeof error?.code === 'string' && Number.isInteger(error?.status));
    return json({ error: known ? error.code : 'image_request_failed' }, known ? error.status : 503);
  }
}
