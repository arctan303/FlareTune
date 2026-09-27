export const INSTANCE_STATES = new Set(['setup_required', 'ready', 'maintenance', 'recovery_required']);

export function normalizeInstanceStatus(value) {
  const state = value?.state;
  if (!INSTANCE_STATES.has(state)) return { state: 'unavailable' };
  return {
    state,
    schemaVersion: Number.isSafeInteger(value.schemaVersion) ? value.schemaVersion : null,
    targetVersion: Number.isSafeInteger(value.targetVersion) ? value.targetVersion : null,
    phase: typeof value.phase === 'string' ? value.phase : null,
  };
}

export function normalizeSession(value) {
  if (!value || value.authenticated !== true) return { authenticated: false, mustChangePassword: false, user: null, csrfToken: null };
  const user = value.user;
  if (typeof user?.accountId !== 'string' || !user.accountId || typeof user.username !== 'string' || !user.username) {
    return { authenticated: false, mustChangePassword: false, user: null, csrfToken: null };
  }
  return {
    authenticated: true,
    mustChangePassword: value.mustChangePassword === true,
    user: {
      accountId: user.accountId,
      username: user.username,
      displayName: typeof user.displayName === 'string' ? user.displayName : user.username,
      role: user.role === 'admin' ? 'admin' : 'member',
    },
    csrfToken: typeof value.csrfToken === 'string' && value.csrfToken.length > 0 ? value.csrfToken : null,
  };
}

export function toShellAuthSession(session) {
  return {
    authenticated: session?.authenticated === true && session.mustChangePassword !== true && Boolean(session.user?.accountId),
    user: session?.authenticated === true && session.mustChangePassword !== true ? session.user : null,
    initialized: true,
    csrfToken: session?.csrfToken || null,
    error: null,
  };
}

export function screenFor(status, session) {
  if (!status || status.state === 'unavailable') return 'unavailable';
  if (status.state === 'setup_required') return 'setup';
  if (status.state === 'maintenance') return 'maintenance';
  if (status.state === 'recovery_required') return 'instance_error';
  if (!session) return 'unavailable';
  if (!session.authenticated) return 'login';
  if (session.mustChangePassword) return 'change_password';
  return 'app';
}

export function validLocalPassword(value) {
  return typeof value === 'string'
    && [...value].length >= 15
    && new TextEncoder().encode(value).length <= 1024;
}
