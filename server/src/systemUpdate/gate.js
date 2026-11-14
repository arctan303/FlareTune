import { systemUpdateMaintenance } from './service.js';

const stateResponse = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function systemUpdateRequestGate(request, path, env, ctx, {
  maintenanceImpl = systemUpdateMaintenance, handleApiImpl,
} = {}) {
  // Static files remain available to render the existing maintenance surface.
  // Pipeline endpoints authenticate a purpose-limited capability themselves.
  if (path === '/api' || path === '/auth' || path.startsWith('/api/system-update/') || path.startsWith('/api/admin/system-update')
    || !/^\/(?:api|auth|media|rest|speaker-media)(?:\/|$)/.test(path)) return null;
  if (!await maintenanceImpl(env)) return null;
  // Recovery uses ordinary local authentication and the router's unchanged raw
  // schema, session, CSRF and role checks. No business route is reopened.
  if (request.method === 'GET' && path === '/api/auth/session'
    || request.method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(path)) return null;
  if (request.method === 'GET' && ['/api/health', '/api/instance/status'].includes(path)) {
    // Preserve actual schema information instead of inventing a current version.
    const response = await handleApiImpl(request, env, path, ctx);
    let body; try { body = await response.json(); } catch { return stateResponse({ error: 'service_unavailable' }, 503); }
    if (body.state === 'recovery_required') return stateResponse(body, response.status);
    return stateResponse({ ...body, state: 'maintenance', reason: 'system_update_running' }, response.status);
  }
  return stateResponse({ error: 'maintenance', reason: 'system_update_running' }, 503);
}
