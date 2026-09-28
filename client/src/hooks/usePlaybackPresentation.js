import React from 'react';
import { resolveCoverUrl } from '../utils.js';
import { usePrivateMediaSource } from './usePrivateMediaSource.js';
import { imageLoadRegistry } from '../utils/imageLoadRegistry.js';

const DEFAULT_TITLE = 'FlareTune';
const DEFAULT_FAVICON = '/favicon.svg';

export function selectPlaybackFavicon(coverUrl, resolvedCoverUrl, isPlaying, registry = imageLoadRegistry) {
  if (!isPlaying || !coverUrl) return DEFAULT_FAVICON;
  if (!registry.isPrivateMediaUrl(coverUrl)) return coverUrl;
  return resolvedCoverUrl?.startsWith('blob:') && registry.getReadySource(coverUrl) === resolvedCoverUrl
    ? resolvedCoverUrl : DEFAULT_FAVICON;
}

function updateFavicon(iconUrl) {
  const iconLinks = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
  const isDefault = !iconUrl || iconUrl === DEFAULT_FAVICON;

  iconLinks.forEach((link) => {
    if (isDefault) {
      if (link.getAttribute('type') === 'image/svg+xml' || link.dataset.originalType === 'image/svg+xml') {
        link.href = '/favicon.svg';
        link.setAttribute('type', 'image/svg+xml');
      } else if (link.getAttribute('sizes') === '128x128' || link.dataset.originalType === 'image/png') {
        link.href = '/favicon.png';
        link.setAttribute('type', 'image/png');
      } else {
        link.href = '/favicon.ico';
        link.removeAttribute('type');
      }
      return;
    }

    if (!link.dataset.originalType && link.getAttribute('type')) {
      link.dataset.originalType = link.getAttribute('type');
    }
    link.href = iconUrl;
    link.removeAttribute('type');
  });
}

export function usePlaybackPresentation(currentSong, isPlaying) {
  const lastFaviconRef = React.useRef(DEFAULT_FAVICON);
  const coverUrl = resolveCoverUrl(currentSong?.cover_url || '');
  const resolvedCoverUrl = usePrivateMediaSource(coverUrl);

  React.useEffect(() => {
    const nextTitle = currentSong && isPlaying
      ? `${currentSong.title} - ${currentSong.artist}`
      : DEFAULT_TITLE;
    if (document.title !== nextTitle) {
      document.title = nextTitle;
    }

    const nextFavicon = selectPlaybackFavicon(coverUrl, resolvedCoverUrl, Boolean(currentSong && isPlaying));
    if (lastFaviconRef.current !== nextFavicon) {
      lastFaviconRef.current = nextFavicon;
      updateFavicon(nextFavicon);
    }
  }, [currentSong, isPlaying, coverUrl, resolvedCoverUrl]);

  React.useEffect(() => {
    return () => {
      document.title = DEFAULT_TITLE;
      updateFavicon(DEFAULT_FAVICON);
    };
  }, []);
}
