import React from 'react';
import { imageLoadRegistry } from '../utils/imageLoadRegistry.js';
import { usePrivateMediaRouteRevision } from './usePrivateMediaRouteRevision.js';
import { visibleImageSource } from '../utils/privateImageVisibility.js';

const currentSource = (src) => imageLoadRegistry.isPrivateMediaUrl(src)
  ? (imageLoadRegistry.shouldLoadPrivately(src) ? imageLoadRegistry.getReadySource(src) : null) : src;

// Preserve existing <img> layout and animation while resolving private media
// through the same session-scoped Blob URL as LazyImage.
export function usePrivateMediaSource(src) {
  const route = usePrivateMediaRouteRevision();
  const [resolved, setResolved] = React.useState(() => ({ src, route, url: currentSource(src) }));

  React.useEffect(() => {
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
      setResolved({ src, route, url: cached });
      return undefined;
    }
    let active = true;
    setResolved({ src, route, url: null });
    void imageLoadRegistry.load(src).then(({ url }) => {
      if (active) setResolved({ src, route, url });
    }).catch(() => {
      if (active) setResolved({ src, route, url: null });
    });
    return () => { active = false; };
  }, [src, route]);

  if (resolved.src !== src || resolved.route !== route) return null;
  if (imageLoadRegistry.isPrivateMediaUrl(src) && !imageLoadRegistry.shouldLoadPrivately(src)) return null;
  return visibleImageSource(src, resolved.url, '', imageLoadRegistry);
}
