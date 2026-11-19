import { databaseIdentity } from './databaseIdentity.js';
import { AuthError } from '../auth/local/index.js';

const scopeKey = Symbol('authorizedHttpRequest');
const scopes = new WeakMap();

// The router creates this scope; SDK callers cannot mint an authenticated one.
export function createRequestEnvironment(env, request) {
  const key = {};
  const path = new URL(request.url).pathname;
  const lyrics = /^\/api\/(?:lyrics(?:\/|$)|account\/plugins\/lyrics-workbench(?:\/|$))/u.test(path)
    || /^\/rest\/getLyrics(?:BySongId)?(?:\.view)?$/u.test(path);
  scopes.set(key, { active: true, signal: request.signal, database: databaseIdentity(env.DB), identity: null,
    lyrics, responseFinished: false, backgroundTasks: new Set() });
  return { ...env, [scopeKey]: key };
}

export function authorizeRequestEnvironment(env, session) {
  const scope = scopes.get(env?.[scopeKey]);
  if (!scope || session?.mode !== 'normal' || !['admin', 'member'].includes(session.account?.role)) return;
  scope.identity = Object.freeze({ accountId: session.account.accountId, role: session.account.role });
  scope.tokenHash = session.tokenHash;
}

export function requestAuthorizationSnapshot(env, session) {
  const scope = scopes.get(env?.[scopeKey]);
  if (!scope?.identity) return null;
  const assertCurrent = () => {
    if (!scope.active || scope.signal?.aborted) throw new DOMException('Request ended', 'AbortError');
    if (scope.database !== databaseIdentity(env.DB) || scope.tokenHash !== session?.tokenHash
      || scope.identity.accountId !== session?.account?.accountId || session?.mode !== 'normal') {
      throw new AuthError('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
    }
    return scope.identity;
  };
  assertCurrent();
  return Object.freeze({ identity: scope.identity, assertCurrent });
}

export function requestLifetime(env) {
  const scope = scopes.get(env?.[scopeKey]);
  if (!scope) return null;
  const assertCurrent = () => {
    if (!scope.active || scope.signal?.aborted) throw new DOMException('Request ended', 'AbortError');
    if (scope.database !== databaseIdentity(env.DB)) throw new AuthError('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  };
  assertCurrent();
  return Object.freeze({ assertCurrent });
}

// Only the host's opaque protocol principal check calls this entry point.
export function authorizeProtocolRequestEnvironment(env) {
  const scope = scopes.get(env?.[scopeKey]);
  if (scope) { requestLifetime(env).assertCurrent(); scope.protocolAuthorized = true; }
}

// Normal response EOF releases the HTTP owner, while a finite, already accepted
// lyric task may settle during the platform's existing 30-second continuation.
// Repeated holds share the first deadline; callers cannot renew this authority.
export function retainRequestTask(env, { timeoutMs = 30_000 } = {}) {
  const scope = scopes.get(env?.[scopeKey]);
  if (!scope?.lyrics || !scope.identity && !scope.protocolAuthorized) return null;
  requestLifetime(env).assertCurrent();
  const duration = Math.min(30_000, Math.max(1, Number(timeoutMs) || 30_000));
  scope.backgroundDeadline ??= Date.now() + duration;
  const remaining = scope.backgroundDeadline - Date.now();
  if (remaining <= 0) return null;
  const abort = new AbortController();
  let released = false, timer;
  const release = () => {
    if (released) return;
    released = true; clearTimeout(timer);
    scope.backgroundTasks.delete(release);
    abort.abort(new DOMException('Lyric task ended', 'AbortError'));
    if (scope.responseFinished && !scope.backgroundTasks.size) scope.active = false;
  };
  scope.backgroundTasks.add(release);
  timer = setTimeout(release, remaining); timer?.unref?.();
  return Object.freeze({ release, expiresAt: scope.backgroundDeadline,
    deadlineAt: scope.backgroundDeadline - 2_000,
    signal: AbortSignal.any([scope.signal, abort.signal]) });
}

export function lyricRequestSnapshotKey(env) {
  const scope = scopes.get(env?.[scopeKey]);
  if (!scope?.lyrics) return null;
  requestLifetime(env).assertCurrent();
  return env[scopeKey];
}

export function bindRequestResponse(env, response) {
  const scope = scopes.get(env?.[scopeKey]);
  if (!scope) return response;
  const finish = (cancelled = false) => {
    scope.responseFinished = true;
    if (cancelled) {
      scope.active = false;
      for (const release of [...scope.backgroundTasks]) release();
    } else if (!scope.backgroundTasks.size) scope.active = false;
  };
  if (!response.body) { finish(); return response; }
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(target) {
      try {
        const next = await reader.read();
        if (next.done) { finish(); target.close(); } else target.enqueue(next.value);
      } catch (error) { finish(true); target.error(error); }
    },
    async cancel(reason) { finish(true); await reader.cancel(reason).catch(() => {}); },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
