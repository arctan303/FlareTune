export function getFailedPlayerModuleUrl(error, baseUrl = globalThis.location?.href) {
  const match = String(error?.message || '').match(/(?:Failed to fetch dynamically imported module|error loading dynamically imported module):?\s*(https?:\/\/[^\s"'<>]+)/i);
  if (!match || !baseUrl) return null;
  try {
    const base = new URL(baseUrl);
    const url = new URL(match[1]);
    return url.origin === base.origin && /\.(?:m?js|jsx)$/.test(url.pathname) ? url : null;
  } catch { return null; }
}

// Retry a failed module fetch under a new URL: browsers can retain the original
// failed module-map entry. Once loaded, reuse that exact module forever so neither
// its side effects nor the player/store dependencies are instantiated again.
export function createRetryablePlayerImport(importPlayer, {
  importUrl = url => import(/* @vite-ignore */ url),
  baseUrl,
} = {}) {
  let pending = null;
  let failedUrl = null;
  let attempt = 0;
  return function loadPlayer() {
    if (pending) return pending;
    const target = failedUrl ? new URL(failedUrl) : null;
    if (target) target.searchParams.set('player_retry', String(++attempt));
    const operation = Promise.resolve().then(() => target ? importUrl(target.href) : importPlayer());
    pending = operation.catch(error => {
      pending = null;
      failedUrl = getFailedPlayerModuleUrl(error, baseUrl) || failedUrl;
      throw error;
    });
    return pending;
  };
}
