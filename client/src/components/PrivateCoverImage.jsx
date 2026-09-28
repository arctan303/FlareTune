import React from 'react';
import { usePrivateMediaSource } from '../hooks/usePrivateMediaSource.js';

// Keep the native image layout used by small previews while sharing the
// session-scoped private media source with the rest of the UI.
export default function PrivateCoverImage({ src, fallback = '/placeholder-album.svg', ...props }) {
  const resolvedSrc = usePrivateMediaSource(src);
  return <img {...props} src={resolvedSrc || fallback} />;
}
