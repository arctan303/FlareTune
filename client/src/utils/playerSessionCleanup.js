export function stopSessionPlayback(playerStore, mediaSession = globalThis.navigator?.mediaSession) {
  const audio = playerStore.getState().audioRef?.current;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  playerStore.setState({ isPlaying: false, shouldAutoPlay: false });
  if (!mediaSession) return;
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
  try { mediaSession.setPositionState?.(); } catch { /* Optional browser support. */ }
  for (const action of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekforward', 'seekbackward', 'stop']) {
    try { mediaSession.setActionHandler(action, null); } catch { /* Optional actions. */ }
  }
}
