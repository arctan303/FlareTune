import { handlePluginApi } from './plugins.js';

// Legacy workspace routes enter the same plugin dispatcher and every gate.
export async function handleLocalLyricsManageRoute(request, url, db, headers = {}, session, env = {}, deps = {}) {
  if (url.pathname !== '/api/lyrics/sources' && !/^\/api\/lyrics\/workspace\//u.test(url.pathname)) return null;
  return handlePluginApi(request, url.pathname, { ...env, DB: db }, session,
    (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: {
      ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } }),
    { executionContext: deps.ctx });
}
