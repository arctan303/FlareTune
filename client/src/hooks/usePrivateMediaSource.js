import React from 'react';
import { imageLoadRegistry } from '../utils/imageLoadRegistry.js';
import { usePrivateMediaRouteRevision } from './usePrivateMediaRouteRevision.js';
import { visibleImageSource } from '../utils/privateImageVisibility.js';
import { usePageActivity } from './usePageActivity.js';

const currentSource = (src) => imageLoadRegistry.isPrivateMediaUrl(src)
  ? (imageLoadRegistry.shouldLoadPrivately(src) ? imageLoadRegistry.getReadySource(src) : null) : src;

// Preserve existing <img> layout and animation while resolving private media
// through the same session-scoped Blob URL as LazyImage.
export function usePrivateMediaImage(src) {
  const visible = usePageActivity();
  const route = usePrivateMediaRouteRevision();
  const [resolved, setResolved] = React.useState(() => {
    const url = currentSource(src);
    return { src, route, url, displayAuthorization: imageLoadRegistry.getDisplayAuthorization(src, url) };
  });

  React.useEffect(() => {
    if (!visible) return undefined;
    if (imageLoadRegistry.isPrivateMediaUrl(src) && !imageLoadRegistry.shouldLoadPrivately(src)) {
      setResolved({ src, route, url: null });
      return undefined;
    }
    if (!imageLoadRegistry.isPrivateMediaUrl(src)) {
      setResolved({ src, route, url: src });
      return undefined;
    }
    const cached = imageLoadRegistry.getReadySource(src);
    if (cached) {
      setResolved({ src, route, url: cached, displayAuthorization: imageLoadRegistry.getDisplayAuthorization(src, cached) });
      return undefined;
    }
    let active = true;
    setResolved((current) => current.src === src && imageLoadRegistry.canRetainSource(src, current.url, current.displayAuthorization)
      ? current : { src, route, url: null });
    void imageLoadRegistry.load(src).then((result) => {
      if (active) setResolved({ src, route, ...imageLoadRegistry.resolveDisplaySource(src, result) });
    }).catch(() => {
      if (active) setResolved({ src, route, url: null });
    });
    return () => { active = false; };
  }, [src, route, visible]);

  const onError = React.useCallback(() => {
    if (resolved.src !== src) return false;
    const recovery = imageLoadRegistry.resolveDisplaySource(src, resolved);
    if (recovery.url === resolved.url) return false;
    setResolved(current => current.src === src && current.url === resolved.url ? { src, route, ...recovery } : current);
    return true;
  }, [src, route, resolved]);
  const url = resolved.src !== src ? currentSource(src)
    : visibleImageSource(src, resolved.url, '', imageLoadRegistry, true, resolved.displayAuthorization);
  return { url, onError };
}

export function usePrivateMediaSource(src) {
  return usePrivateMediaImage(src).url;
}
