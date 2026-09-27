// This table is deliberately narrower than the route implementation. Unknown API
// paths are never public, even if a future handler is added without a policy row.
const PUBLIC_READS = new Set(['/api/instance/status', '/api/health']);
const AUTH_READS = new Set(['/api/auth/session']);
const AUTH_WRITES = new Map([
  ['/api/auth/verify-setup', 'setup_required'],
  ['/api/auth/setup', 'setup_required'],
  ['/api/auth/login', 'ready'],
  ['/api/auth/logout', 'ready'],
  ['/api/auth/change-password', 'ready'],
]);

export function classifyApiRequest(path, method) {
  if (method === 'GET' && PUBLIC_READS.has(path)) return 'public_read';
  if (method === 'GET' && AUTH_READS.has(path)) return 'session_read';
  if (method === 'POST' && AUTH_WRITES.has(path)) return path.slice('/api/auth/'.length);
  if (path === '/api/auth/recovery') return 'removed';
  if (path === '/api/instance/verify-maintenance' && method === 'POST') return 'maintenance_verify';
  if (path === '/api/instance/upgrade' && method === 'POST') return 'maintenance_upgrade';
  if (path === '/api/admin/system/migration' && ['GET', 'POST'].includes(method)) return 'admin_migration';
  if (path.startsWith('/api/admin/') || path.startsWith('/api/manage/')) return 'admin';
  return 'business';
}

export function decideApiAccess({ path, method, instanceState, session = null }) {
  const category = classifyApiRequest(path, method);
  if (category === 'public_read') return { allowed: true, category };
  if (category === 'session_read') return { allowed: true, category };
  if (category === 'setup' || category === 'verify-setup') return { allowed: instanceState === 'setup_required', category };
  if (category === 'maintenance_verify' || category === 'maintenance_upgrade') {
    return { allowed: instanceState === 'maintenance', category };
  }
  if (category === 'removed') return { allowed: false, category };
  if (instanceState !== 'ready') return { allowed: false, category };
  if (category === 'login') return { allowed: true, category };
  if (category === 'logout') return { allowed: true, category };
  if (!session) return { allowed: false, category };
  if (category === 'change-password') return { allowed: true, category };
  if (session.mode !== 'normal') return { allowed: false, category };
  if (category === 'admin_migration') return { allowed: session.account?.role === 'admin', category };
  if (category === 'admin') return { allowed: session.account?.role === 'admin', category };
  return { allowed: true, category };
}
