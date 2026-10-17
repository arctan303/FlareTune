import React from 'react';
import { usePrivateMediaImage } from '../hooks/usePrivateMediaSource.js';

// Keep the native image layout used by small previews while sharing the
// session-scoped private media source with the rest of the UI.
export default function PrivateCoverImage({ src, fallback = '/placeholder-album.svg', ...props }) {
  const image = usePrivateMediaImage(src);
  return <img {...props} src={image.url || fallback} onError={event => {
    if (!image.onError()) props.onError?.(event);
  }} />;
}
