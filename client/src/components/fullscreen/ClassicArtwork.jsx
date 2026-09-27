import React from 'react';
import LazyImage from '../LazyImage.jsx';

export default function ClassicArtwork({ coverUrl, isPlaying, isBuffering, isExpandingToSong }) {
  return (
    <div
      style={{
        '--target-cover-scale': isPlaying && !isBuffering ? 1 : 0.95,
        '--target-cover-opacity': isPlaying && !isBuffering ? 1 : 0.85,
      }}
      className={`classic-player__cover relative w-full max-w-[min(100%,38vh)] sm:max-w-[min(440px,44vh)] lg:max-w-[392px] xl:max-w-[430px] 2xl:max-w-[470px] aspect-square rounded-xl md:rounded-2xl overflow-hidden active:scale-95 will-change-transform transform-gpu transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.25,1,0.5,1)] ${isExpandingToSong ? 'animate-large-cover-expand' : ''} ${isPlaying && !isBuffering ? 'scale-100 opacity-100' : 'scale-[0.95] opacity-85'}`}
    >
      <LazyImage src={coverUrl} fallback="/placeholder-album.svg" className="w-full h-full object-cover" />
      <div className="absolute inset-0 ring-1 ring-inset ring-white/10 rounded-xl md:rounded-2xl pointer-events-none" />
    </div>
  );
}
