import { AuthError } from '../auth/local/index.js';
import { readBoundedJson } from '../instance/httpSecurity.js';
import { pluginDelivery } from '../plugins/delivery.js';

const failure = (error, json) => error instanceof AuthError ? json({ error: error.code, ...error.publicDetails }, error.status)
  : error?.name === 'RequestBodyError' ? json({ error: 'invalid_input' }, 400) : json({ error: 'service_unavailable' }, 503);

export async function handlePluginDelivery(request, path, env, session, json, { delivery = pluginDelivery } = {}) {
  if (!/^\/api\/admin\/plugin-delivery(?:\/|$)/.test(path)) return null;
  try {
    if (path === '/api/admin/plugin-delivery') {
      if (request.method === 'GET') return json(await delivery.get(env, session));
      if (request.method === 'PUT') return json(await delivery.configure(env, session, await readBoundedJson(request)));
    }
    if (path === '/api/admin/plugin-delivery/sources' && request.method === 'POST') return json(await delivery.addSource(env, session, await readBoundedJson(request)));
    const source = /^\/api\/admin\/plugin-delivery\/sources\/([a-zA-Z0-9-]{1,80})(\/refresh)?$/.exec(path);
    if (source && ((source[2] && request.method === 'POST') || (!source[2] && request.method === 'DELETE'))) {
      const input = await readBoundedJson(request);
      return json(await delivery[source[2] ? 'refreshSource' : 'removeSource'](env, session, source[1], input));
    }
    if (path === '/api/admin/plugin-delivery/selection' && request.method === 'PUT') return json(await delivery.select(env, session, await readBoundedJson(request),
      { uiLanguage: request.headers.get('Accept-Language') || 'en' }));
    if (path === '/api/admin/plugin-delivery/build' && request.method === 'POST') return json(await delivery.startBuild(env, session, await readBoundedJson(request)));
    if (path === '/api/admin/plugin-delivery/build/resolve' && request.method === 'POST') return json(await delivery.resolveBuild(env, session, await readBoundedJson(request)));
    if (path === '/api/admin/plugin-delivery/discard' && request.method === 'POST') return json(await delivery.discard(env, session, await readBoundedJson(request)));
    return json({ error: 'not_found' }, 404);
  } catch (error) { return failure(error, json); }
}

// This separate namespace accepts only the purpose-specific build token. It is
// never classified as public application data or as a cookie-authenticated API.
export async function handlePluginBuild(request, path, env, json, { delivery = pluginDelivery } = {}) {
  if (!path.startsWith('/api/plugin-build/')) return null;
  try {
    if (path === '/api/plugin-build/snapshot' && request.method === 'GET') return json(await delivery.snapshot(env, request));
    if (path === '/api/plugin-build/upgrade' && ['GET', 'POST'].includes(request.method)) return json(await delivery.upgrade(env, request,
      request.method === 'POST' ? await readBoundedJson(request) : undefined));
    if (path === '/api/plugin-build/report' && request.method === 'POST') return json(await delivery.report(env, request, await readBoundedJson(request)));
    return json({ error: 'not_found' }, 404);
  } catch (error) { return failure(error, json); }
}
