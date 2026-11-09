// Session-local source invalidation. Contains no credentials or private store access.
let revision = 0;
const listeners = new Set();
export const getMusicSourcesRevision = () => revision;
export function subscribeMusicSources(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function notifyMusicSourcesChanged(pluginId) {
  revision += 1;
  for (const listener of [...listeners]) listener(revision, pluginId);
}
export function assertMusicSourcesRevision(expected) {
  if (expected !== revision) throw new DOMException('Music sources changed', 'AbortError');
}

