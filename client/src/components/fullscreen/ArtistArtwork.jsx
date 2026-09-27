import React from 'react';
import ClassicArtwork from './ClassicArtwork.jsx';

export default function ArtistArtwork({ showPhotos, canShowLyrics, ...coverProps }) {
  if (!showPhotos) return <ClassicArtwork {...coverProps} />;

  return (
    <div
      className={`flex-1 w-full min-h-[32vh] sm:min-h-[38vh] flex items-center justify-center ${canShowLyrics ? 'cursor-pointer' : ''}`}
      title={canShowLyrics ? '点击切换多行歌词' : undefined}
    />
  );
}
