import { readBoundedJson } from '../instance/httpSecurity.js';
import { AuthError } from '../auth/local/index.js';
import { pluginRegistry } from '../plugins/registry.js';
import { createPluginContext } from '../plugins/context.js';
import { deliveryPluginModules } from '../plugins/delivery.generated.js';
import { handleUserImages } from './userImages.js';

export async function handlePluginApi(request, path, env, session, json, {
  registry = pluginRegistry, handlers, modules = deliveryPluginModules, executionContext,
} = {}) {
  // Legacy URLs are aliases of the plugin endpoint, including every gate.
  try {
    if (path === '/api/songs/roam' && request.method === 'POST') path = '/api/account/plugins/roam/sample';
    if (path.startsWith('/api/ai/')) path = path.replace('/api/ai/', '/api/account/plugins/assistant/');
    if (path.startsWith('/api/admin/ai/')) path = path.replace('/api/admin/ai/', '/api/admin/plugins/ai-gateway/');
    if (path === '/api/admin/assistant') path = '/api/admin/plugins/assistant/config';
    if (path === '/api/lyrics/sources') path = '/api/account/plugins/lyrics-workbench/sources';
    if (path.startsWith('/api/lyrics/workspace/')) path = path.replace('/api/lyrics/workspace/', '/api/account/plugins/lyrics-workbench/workspace/');
    if (path === '/api/admin/lyrics/source-test') path = '/api/admin/plugins/lyrics-workbench/source-test';
    if (path === '/api/admin/settings' && request.method === 'PUT') {
      const body = await readBoundedJson(request.clone());
      const owner = { 'assistant.images_enabled': ['assistant', 'settings/images'],
        'ai.compatible_api_url': ['ai-gateway', 'legacy-setting'], 'lyrics.ai': ['lyrics-workbench', 'settings'],
        'lyrics.sources': ['lyrics-workbench', 'sources-settings'] }[body?.key];
      if (owner) {
        path = `/api/admin/plugins/${owner[0]}/${owner[1]}`;
        const { key, ...input } = body;
        request = new Request(request, { body: JSON.stringify(input) });
      }
    }
    if (!/^\/api\/(?:admin|account)\/plugins(?:\/|$)/.test(path)) return null;
    if (path === '/api/admin/plugins' && request.method === 'GET') return json(await registry.listPlugins(env, session, true));
    if (path === '/api/account/plugins' && request.method === 'GET') return json(await registry.listPlugins(env, session));
    const match = /^\/api\/(account|admin)\/plugins\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(path);
    if (match) {
      const [, scope, pluginId, relativePath = ''] = match;
      if (scope === 'admin' && relativePath === '' && request.method === 'PUT') {
        return json(await registry.setInstalled(env, session, pluginId, await readBoundedJson(request),
          { uiLanguage: request.headers.get('Accept-Language') || 'en' }));
      }
      const context = await createPluginContext({ env, session, pluginId, registry });
      if (scope === 'admin' && context.identity.role !== 'admin') return json({ error: 'forbidden' }, 403);
      const buildDigest = registry.getBuildDigest(pluginId);
      if ((['roam', 'ai-gateway', 'assistant', 'lyrics-workbench'].includes(pluginId) && !buildDigest)
        || (buildDigest && request.headers.get('X-FlareTune-Plugin-Build') !== buildDigest)) {
        return json({ error: 'PLUGIN_BUILD_MISMATCH' }, 409);
      }
      if (pluginId === 'assistant' && scope === 'account' && /^\/images\//.test(relativePath)) {
        const url = new URL(request.url); url.pathname = `/api/account${relativePath}`;
        return await handleUserImages(request, url, env.DB, env.MEDIA_BUCKET, session, { env, registry, context });
      }
      const sourceDependencies = Object.assign({}, ...Object.values(modules).map(module =>
        typeof module.createLyricDependencies === 'function' ? module.createLyricDependencies(env, session, executionContext) : {}));
      // Music identity resolution remains a host capability; a lyric source's
      // native fetching callback is not another lyric source's dependency.
      delete sourceDependencies.fetchNativeDocument;
      const handler = handlers ? handlers[pluginId]
        : typeof modules[pluginId]?.createHandler === 'function' ? modules[pluginId].createHandler(env, session, {
          registry, executionContext, dependencies: { ctx: executionContext, session, ...sourceDependencies },
        }) : null;
      if (!handler) return json({ error: 'not_found' }, 404);
      const response = await handler({ request, path: relativePath, scope, context, json });
      return response || json({ error: 'not_found' }, 404);
    }
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error?.name === 'YouTubeError' && /^YOUTUBE_[A-Z0-9_]{1,80}$/.test(error.code || '')
      && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) return json({ error: error.code }, error.status);
    if (error instanceof AuthError) return json({ error: error.code, ...error.publicDetails }, error.status);
    if (error?.name === 'RequestBodyError') return json({ error: 'invalid_input' }, 400);
    return json({ error: 'service_unavailable' }, 503);
  }
}
