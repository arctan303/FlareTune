import React from 'react';
import { imageLoadRegistry } from '../utils/imageLoadRegistry.js';

// The registry receives navigation events and session invalidations. One
// revision makes mounted images react to both without per-image DOM listeners.
export const subscribePrivateMediaRoute = (listener) => imageLoadRegistry.subscribeVisibility(listener);
export const getPrivateMediaRouteRevision = () => imageLoadRegistry.getVisibilityRevision();

export function usePrivateMediaRouteRevision() {
  return React.useSyncExternalStore(subscribePrivateMediaRoute, getPrivateMediaRouteRevision, () => 0);
}
