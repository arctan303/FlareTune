export const AUTH_SESSION_INVALIDATED_EVENT = 'tune-auth-session-invalidated';
export const AUTH_SESSION_UPDATED_EVENT = 'tune-auth-session-updated';
export const AUTH_SESSION_CHECK_FAILED_EVENT = 'tune-auth-session-check-failed';

export const requestAuthSessionCheck = (target = globalThis.window) => {
  target?.dispatchEvent?.(new CustomEvent('tune-auth-check-requested'));
};

export const notifyAuthenticationRequired = (response, target = globalThis.window) => {
  if (response?.status !== 401 || typeof target?.dispatchEvent !== 'function') return response;
  const EventConstructor = target.Event || globalThis.Event;
  if (typeof EventConstructor === 'function') {
    target.dispatchEvent(new EventConstructor(AUTH_SESSION_INVALIDATED_EVENT));
  }
  return response;
};
