import React from 'react';

const PLAY_BUTTON_ANIMATION_MS = 1500;

export function usePlaybackButtonAnimations({ playPrev, playNext }) {
  const [prevAnimNonce, setPrevAnimNonce] = React.useState(0);
  const [nextAnimNonce, setNextAnimNonce] = React.useState(0);
  const [isPrevAnimating, setIsPrevAnimating] = React.useState(false);
  const [isNextAnimating, setIsNextAnimating] = React.useState(false);
  const prevTimerRef = React.useRef(null);
  const nextTimerRef = React.useRef(null);

  const handlePlayPrev = React.useCallback((event) => {
    setIsPrevAnimating(true);
    setPrevAnimNonce((nonce) => nonce + 1);
    if (prevTimerRef.current) clearTimeout(prevTimerRef.current);
    prevTimerRef.current = setTimeout(() => setIsPrevAnimating(false), PLAY_BUTTON_ANIMATION_MS);
    playPrev(event);
  }, [playPrev]);

  const handlePlayNext = React.useCallback((event) => {
    setIsNextAnimating(true);
    setNextAnimNonce((nonce) => nonce + 1);
    if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
    nextTimerRef.current = setTimeout(() => setIsNextAnimating(false), PLAY_BUTTON_ANIMATION_MS);
    playNext(event);
  }, [playNext]);

  React.useEffect(() => () => {
    if (prevTimerRef.current) clearTimeout(prevTimerRef.current);
    if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
  }, []);

  return {
    prevAnimNonce,
    nextAnimNonce,
    isPrevAnimating,
    isNextAnimating,
    handlePlayPrev,
    handlePlayNext,
  };
}
