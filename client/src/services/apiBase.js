export const DEFAULT_API_BASE_URL = '';

const stripTrailingSlash = (value) => value.replace(/\/$/, '');

export function resolveApiBase({ configuredBase } = {}) {
  const envBase = typeof configuredBase === 'string' ? configuredBase.trim() : '';
  return envBase ? stripTrailingSlash(envBase) : DEFAULT_API_BASE_URL;
}

export function getApiBaseUrl() {
  return resolveApiBase({
    configuredBase: import.meta.env?.VITE_API_BASE_URL,
  });
}
