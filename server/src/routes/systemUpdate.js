import { AuthError } from '../auth/local/index.js';
import { readBoundedJson } from '../instance/httpSecurity.js';
import { systemUpdate } from '../systemUpdate/service.js';

function failure(error, json) {
  if (error instanceof AuthError) return json({ error: error.code }, error.status);
  if (error?.name === 'RequestBodyError') return json({ error: 'SYSTEM_UPDATE_INVALID_INPUT' }, 400);
  if (error?.name === 'DatabaseUpgradeError') return json({ error: error.code }, error.status);
  return json({ error: 'SYSTEM_UPDATE_UNAVAILABLE' }, 503);
}
export async function handleSystemUpdate(request, path, env, session, json, { update = systemUpdate } = {}) {
  if (!/^\/api\/admin\/system-update(?:\/|$)/.test(path)) return null;
  try {
    if (path === '/api/admin/system-update') {
      if (request.method === 'GET') return json(await update.get(env, session));
      if (request.method === 'PUT') return json(await update.configure(env, session, await readBoundedJson(request)));
    }
    const action = /^\/api\/admin\/system-update\/(check|start|retry|recover)$/.exec(path)?.[1];
    if (action && request.method === 'POST') return json(await update[action](env, session, await readBoundedJson(request)));
    return json({ error: 'not_found' }, 404);
  } catch (error) { return failure(error, json); }
}
export async function handleSystemUpdatePipeline(request, path, env, instance, json, { update = systemUpdate } = {}) {
  if (!path.startsWith('/api/system-update/')) return null;
  // The build capability is useful only for a frozen update task. It is never
  // an administrator session or a general maintenance/SQL capability.
  if (!['ready', 'maintenance'].includes(instance.state)) return json({ error: instance.state }, 503);
  try {
    if (path === '/api/system-update/plan' && request.method === 'GET') return json(await update.plan(env, request));
    if (path === '/api/system-update/claim' && request.method === 'POST') return json(await update.claim(env, request, await readBoundedJson(request)));
    if (path === '/api/system-update/report' && request.method === 'POST') return json(await update.report(env, request, await readBoundedJson(request)));
    if (path === '/api/system-update/migration' && request.method === 'POST') return json(await update.migration(env, request, await readBoundedJson(request)));
    return json({ error: 'not_found' }, 404);
  } catch (error) { return failure(error, json); }
}
