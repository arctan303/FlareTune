import React from 'react';
import AppleFluidCanvas from './AppleFluidCanvas.jsx';

export default function MobileClassicBackground({
  showPhotos,
  photoLayers,
  isLyricsView,
  prefersReducedMotion,
  isPlaying,
  isBuffering,
  suspendPlayerEffects,
  coverUrl,
  hasEntered,
  palette,
}) {
  if (!showPhotos) {
    return coverUrl && hasEntered ? (
      <AppleFluidCanvas coverUrl={coverUrl} palette={palette} isPlaying={isPlaying} isBuffering={isBuffering} />
    ) : null;
  }

  const animationPlayState = isPlaying && !isBuffering && !suspendPlayerEffects ? 'running' : 'paused';
  return (
    <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none">
      {photoLayers.map((layer) => (
        <div key={`bg-blur-${layer.id}`} className="absolute inset-0 transition-opacity duration-[1500ms] ease-out pointer-events-none" style={{ opacity: layer.opacity }}>
          <img src={layer.url} alt="" className="w-full h-full object-cover scale-125 filter blur-[40px] brightness-[0.45]" />
        </div>
      ))}
      {photoLayers.map((layer) => {
        const animationName = layer.index % 2 === 0 ? 'kenburnsZoomIn' : 'kenburnsZoomOut';
        const animation = prefersReducedMotion ? 'none' : `${animationName} 20s infinite alternate ease-in-out`;
        return (
          <div key={`bg-main-${layer.id}`} className="absolute inset-0 transition-all duration-[1500ms]" style={{ opacity: layer.opacity, transform: layer.transform, filter: layer.filter, transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)' }}>
            {isLyricsView ? (
              <img src={layer.url} alt="" className="w-full h-full object-cover filter blur-[24px] brightness-[0.38] scale-110 will-change-transform" style={{ animation, animationPlayState }} />
            ) : (
              <div className="absolute top-[6vh] sm:top-[7vh] left-0 right-0 h-[54vh] sm:h-[58vh] pointer-events-none">
                <img
                  src={layer.url}
                  alt=""
                  className="w-full h-full object-cover object-center will-change-transform filter brightness-[0.92]"
                  style={{
                    animation,
                    animationPlayState,
                    maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.1) 4%, rgba(0,0,0,0.5) 10%, black 18%, black 40%, rgba(0,0,0,0.85) 54%, rgba(0,0,0,0.55) 68%, rgba(0,0,0,0.25) 82%, rgba(0,0,0,0.06) 93%, transparent 100%), linear-gradient(to right, transparent 0%, black 6%, black 94%, transparent 100%)',
                    WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.1) 4%, rgba(0,0,0,0.5) 10%, black 18%, black 40%, rgba(0,0,0,0.85) 54%, rgba(0,0,0,0.55) 68%, rgba(0,0,0,0.25) 82%, rgba(0,0,0,0.06) 93%, transparent 100%), linear-gradient(to right, transparent 0%, black 6%, black 94%, transparent 100%)',
                    maskComposite: 'intersect',
                    WebkitMaskComposite: 'destination-in',
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent via-20% via-transparent via-50% to-black/95 pointer-events-none" />
    </div>
  );
}
