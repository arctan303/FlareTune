import React from 'react';
import LazyImage from '../LazyImage.jsx';

export default function ClassicArtwork({ coverUrl, isPlaying, isBuffering, isExpandingToSong }) {
  const activePlaying = isPlaying && !isBuffering;

  return (
    <div
      style={{
        '--target-cover-scale': activePlaying ? 0.9 : 0.73,
        '--target-cover-opacity': activePlaying ? 1 : 0.85,
      }}
      className={`classic-player__cover relative w-full max-w-[min(100%,38vh)] sm:max-w-[min(440px,44vh)] lg:max-w-[var(--classic-cover-size)] aspect-square rounded-xl md:rounded-2xl overflow-hidden active:scale-95 will-change-transform transform-gpu ${
        activePlaying
          ? 'scale-[0.9] opacity-100 transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.76,0.665,0.37,1.35)]'
          : 'scale-[0.73] opacity-85 transition-[transform,opacity] duration-[350ms] ease-linear'
      } lg:scale-100 lg:opacity-100 lg:transition-none ${isExpandingToSong ? 'animate-large-cover-expand' : ''}`}
    >
      <LazyImage src={coverUrl} fallback="/placeholder-album.svg" className="w-full h-full object-cover" />
      <div className="absolute inset-0 ring-1 ring-inset ring-white/10 rounded-xl md:rounded-2xl pointer-events-none" />
    </div>
  );
}
